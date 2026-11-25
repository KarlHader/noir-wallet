import { ZEC_DECIMALS, WALLET_CONFIG } from '@/config/wallet'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { prepareTransparentSpend } from '@/core/wallet/transparent-spend-preflight'
import {
  isTransactionSubmissionUnknown,
  requireSuccessfulTransfer
} from '@/core/zcash/transfer-result'
import { marginalFeeForTier } from '@/core/zcash/fee-policy'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { loadTransactions } from '@/lib/indexed-db'
import { logger } from '@/lib/logger'
import { buildAccountKey } from '@/store/account-data-store'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { syncScheduler } from './sync-scheduler'
import { transactionRecorder } from './transaction-recorder'
import { catchUpAfterOnChainTx } from './tx-sync'
import { computeExpiryHeight, zcashTxMonitor } from './zcash-tx-monitor'
import { TimeoutError, withTimeout } from '@/lib/async-utils'

export async function broadcastShieldZcashDeposit(input: {
  readonly walletId: string
  readonly accountId: string
  readonly depositAddress: string
  readonly amountRaw: string
  readonly refundAddress: string
}): Promise<{ txHash: string }> {
  await rehydrateWalletStore()
  const walletState = useWalletStore.getState()
  if (
    walletState.currentNetwork !== backgroundZcashWalletRuntime.getNetwork() ||
    walletState.currentWalletId !== input.walletId ||
    walletState.currentAccountId !== input.accountId
  ) {
    throw new Error('Active Wallet Account changed')
  }
  const wallet = walletState.getWallet(input.walletId)
  const account = walletState.getAccount(input.walletId, input.accountId)
  if (!wallet || !account) throw new Error('Wallet account no longer available')
  if (isZcashHardwareKeySource(wallet.keySource)) {
    throw new Error('Transparent ZEC funding is not available for this hardware wallet.')
  }
  const fromAddress = account.addresses.transparent
  if (!fromAddress || fromAddress !== input.refundAddress) {
    throw new Error('Shield quote refund address is invalid.')
  }
  const amount = formatBaseUnitDecimalAmount(input.amountRaw, ZEC_DECIMALS)
  const accountKey = buildAccountKey(walletState.currentNetwork, input.walletId, input.accountId)
  const recorded = await loadTransactions(accountKey)
  const alreadyBroadcast = recorded.find(
    tx =>
      tx.type === 'send' &&
      tx.fromType === 'transparent' &&
      tx.to === input.depositAddress &&
      tx.amount === amount &&
      typeof tx.txHash === 'string' &&
      /^[0-9a-fA-F]{64}$/.test(tx.txHash) &&
      tx.status !== 'failed'
  )
  if (alreadyBroadcast?.txHash) return { txHash: alreadyBroadcast.txHash }
  if (
    recorded.some(
      tx =>
        tx.type === 'send' &&
        tx.fromType === 'transparent' &&
        tx.to === input.depositAddress &&
        tx.amount === amount &&
        tx.status === 'pending' &&
        !tx.txHash
    )
  ) {
    throw new Error('ZEC deposit payment is already being submitted')
  }

  let txPaused = false
  let transactionId: string | undefined
  let broadcastHash: string | undefined
  try {
    syncScheduler.pauseForTx()
    txPaused = true
    const syncIdle = await syncScheduler.waitForWalletSyncIdle(
      input.walletId,
      WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS
    )
    if (!syncIdle) throw new Error('Wallet is syncing. Please try again after sync completes.')
    const walletCore = await backgroundZcashWalletRuntime.getWalletCore(
      input.walletId,
      input.accountId
    )
    await prepareTransparentSpend(walletCore, amount, account.derivationIndex)
    const feeQuote = await walletCore.getFeeQuote()
    const marginalFeeZats = marginalFeeForTier('standard', feeQuote.standardMarginalFeeZats)
    const feeEstimate = await walletCore.estimateTransferFee(
      input.depositAddress,
      amount,
      undefined,
      marginalFeeZats,
      'transparent',
      undefined,
      feeQuote.id
    )
    const fee = formatBaseUnitDecimalAmount(feeEstimate.feeZats, ZEC_DECIMALS)
    const tx = await transactionRecorder.addTransaction({
      accountKey,
      transaction: {
        txHash: '',
        status: 'pending',
        type: 'send',
        amount,
        to: input.depositAddress,
        from: fromAddress,
        fromType: 'transparent',
        memo: '',
        fee,
        timestamp: Date.now(),
        network: walletState.currentNetwork,
        notified: false,
        depositAddress: input.depositAddress
      }
    })
    transactionId = tx.id
    let transferResult: Awaited<ReturnType<typeof walletCore.sendTransaction>> | null
    try {
      transferResult = await walletCore.sendTransaction(
        {
          to: input.depositAddress,
          amount,
          fundingSource: 'transparent',
          marginalFeeZats,
          feeQuoteId: feeQuote.id
        },
        undefined,
        account.derivationIndex
      )
    } catch (error) {
      if (!isTransactionSubmissionUnknown(error)) throw error
      broadcastHash = error.txId
      transferResult = null
    }
    if (!broadcastHash) {
      const successful = requireSuccessfulTransfer(transferResult!)
      broadcastHash = successful.txHash
    }
    const expiryHeight = await computeExpiryHeight(() =>
      withTimeout(walletCore.getLatestBlock(), 3_000, 'Transaction expiry height')
    ).catch(() => undefined)
    await transactionRecorder
      .updateTransaction(accountKey, tx.id, {
        txHash: broadcastHash,
        ...(expiryHeight !== undefined ? { expiryHeight } : {})
      })
      .catch(() => undefined)
    await zcashTxMonitor
      .addTransaction({
        txHash: broadcastHash,
        accountKey,
        walletId: input.walletId,
        accountId: input.accountId,
        transactionId: tx.id,
        amount,
        type: 'send',
        ...(expiryHeight !== undefined ? { expiryHeight } : {})
      })
      .catch(() => undefined)
    void catchUpAfterOnChainTx(input.walletId, input.accountId).catch(error => {
      logger.warn('Shield ZEC deposit catch-up failed', input.walletId, input.accountId)
      console.error('[ShieldZcashDeposit] catchUpAfterOnChainTx failed:', error)
      backgroundZcashWalletRuntime.requestSync()
    })
    return { txHash: broadcastHash }
  } catch (error) {
    if (broadcastHash) return { txHash: broadcastHash }
    if (transactionId && !(error instanceof TimeoutError)) {
      await transactionRecorder
        .updateTransaction(accountKey, transactionId, { status: 'failed', notified: true })
        .catch(() => undefined)
    }
    throw error instanceof Error ? error : new Error('ZEC deposit payment failed')
  } finally {
    if (txPaused) syncScheduler.resumeAfterTx()
  }
}
