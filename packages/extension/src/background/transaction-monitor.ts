import {
  fetchSwapStatus,
  getCachedTokens,
  refreshSwapTokenCatalog,
  evaluateIntentsStatusQuoteBinding,
  type SwapStatus
} from '@/core/services/intents-api'
import { transactionRecorder } from './transaction-recorder'
import { zcashTxMonitor } from './zcash-tx-monitor'
import { formatChainName } from '@/lib/format'
import { loadTransactions } from '@/lib/indexed-db'
import { safeBig } from '@/lib/big'
import { ANALYTICS_EVENTS, trackEvent } from '@/background/analytics/reporter'
import {
  getCrossChainCompletionStatus,
  needsRelayStatusRecovery
} from '@/lib/cross-chain-transaction'
import type { QuoteBinding, Transaction } from '@/types'
import type { AccountScope } from '@/core/wallet/account-scope'
import { resolveAccountScope } from '@/core/wallet/account-scope'
import { useWalletStore } from '@/store/wallet-store'
import {
  INTENTS_PROGRESS_STALE_MS,
  isIntentsProgressStale,
  normalizeIntentsProgressEntry,
  registerIntentsProgress,
  updateIntentsProgressStatus,
  type IntentsProgressEntry,
  type IntentsProgressInput
} from '@/lib/intents-progress'
import {
  markNativeZecIntentsSwapTerminal,
  readNativeZecIntentsSwapMetadata,
  readNativeZecIntentsSwapStatus
} from './native-zec-intents-swap'

export type PendingTransaction = IntentsProgressEntry &
  Partial<Pick<AccountScope, 'walletId' | 'accountId'>>

type PendingTransactionInput = IntentsProgressInput &
  Partial<Pick<AccountScope, 'walletId' | 'accountId'>>

const STORAGE_KEY = 'pending_transactions'

const ALARM_NAME = 'transaction-monitor-alarm'
const POLL_DELAY_MIN = 0.5 // Chrome production minimum: 30 seconds

export class TransactionMonitor {
  private pendingTransactions: Map<string, PendingTransaction> = new Map()
  private confidentialBalanceRefresher?: (
    scope: Readonly<{
      walletId: string
      accountId: string
    }>
  ) => Promise<unknown>

  setConfidentialBalanceRefresher(refresh: typeof this.confidentialBalanceRefresher): void {
    this.confidentialBalanceRefresher = refresh
  }

  async init() {
    await this.loadFromStorage()
    this.scheduleNextCheck()
  }

  async addTransaction(tx: PendingTransactionInput) {
    const accountScope = resolveAccountScope(tx, useWalletStore.getState().wallets)
    if (!accountScope) {
      throw new Error('Pending transaction requires a valid wallet and account identity')
    }
    const entry = {
      ...registerIntentsProgress(tx, this.pendingTransactions.get(tx.depositAddress)),
      ...accountScope
    }
    this.pendingTransactions.set(tx.depositAddress, entry)
    await this.saveToStorage()
    this.scheduleNextCheck()
    this.notifyProgressUpdated(entry.accountKey)
  }

  async removeTransaction(depositAddress: string) {
    const entry = this.pendingTransactions.get(depositAddress)
    if (!entry || !this.pendingTransactions.delete(depositAddress)) return
    await this.saveToStorage()
    this.scheduleNextCheck()
    this.notifyProgressUpdated(entry.accountKey)
  }

  async getProgress(accountKey: string): Promise<IntentsProgressEntry[]> {
    await this.loadFromStorage()
    return Array.from(this.pendingTransactions.values())
      .filter(entry => entry.accountKey === accountKey)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async removeAccount(walletId: string, accountId?: string): Promise<void> {
    await this.loadFromStorage()
    for (const [depositAddress, transaction] of this.pendingTransactions) {
      const scope = resolveAccountScope(transaction, useWalletStore.getState().wallets)
      if (
        scope?.walletId === walletId &&
        (accountId === undefined || scope.accountId === accountId)
      ) {
        this.pendingTransactions.delete(depositAddress)
      }
    }
    await this.saveToStorage()
    this.scheduleNextCheck()
  }

  async clear(): Promise<void> {
    this.pendingTransactions.clear()
    await this.saveToStorage()
    this.scheduleNextCheck()
  }

  async restorePendingWithdrawals(accountScopes: AccountScope[]): Promise<void> {
    await this.loadFromStorage()
    const alreadyMonitored = new Set(this.pendingTransactions.keys())
    let added = 0

    for (const accountScope of accountScopes) {
      try {
        const { accountKey } = accountScope
        const transactions = await loadTransactions(accountKey)
        for (const transaction of transactions) {
          const depositAddress =
            transaction.depositAddress ??
            (transaction.quoteBinding?.provider === 'near-intents' && transaction.type === 'swap'
              ? transaction.quoteBinding.depositAddress
              : undefined)
          const needsConfidentialSettlement =
            transaction.status === 'relay_confirmed' &&
            transaction.quoteBinding?.recipientType === 'CONFIDENTIAL_INTENTS'
          if (
            !needsRelayStatusRecovery({ ...transaction, depositAddress }) ||
            !depositAddress ||
            (!needsConfidentialSettlement &&
              Date.now() - transaction.timestamp >= INTENTS_PROGRESS_STALE_MS) ||
            alreadyMonitored.has(depositAddress)
          ) {
            continue
          }

          const nativeSwap =
            transaction.type === 'swap' && transaction.quoteBinding?.provider === 'near-intents'
          const nativeQuote =
            nativeSwap && transaction.quoteBinding
              ? await readNativeZecIntentsSwapMetadata(transaction.quoteBinding).catch(() => null)
              : null
          const boundNativeQuote =
            nativeQuote?.walletId === accountScope.walletId &&
            nativeQuote.accountId === accountScope.accountId &&
            nativeQuote.depositAddress === depositAddress
              ? nativeQuote
              : null
          const destinationToken = nativeSwap
            ? getCachedTokens().find(
                token => token.assetId === transaction.quoteBinding?.destinationAsset
              )
            : undefined
          const restored = registerIntentsProgress(
            {
              depositAddress,
              tokenInSymbol: 'ZEC',
              tokenOutSymbol:
                boundNativeQuote?.destinationSymbol ??
                destinationToken?.symbol ??
                (nativeSwap ? 'Token' : 'ZEC'),
              amountIn: transaction.amount,
              amountOut: nativeSwap
                ? transaction.quoteBinding?.expectedAmountOut &&
                  (boundNativeQuote || destinationToken)
                  ? safeBig(transaction.quoteBinding.expectedAmountOut)
                      .div(
                        safeBig(10).pow(
                          boundNativeQuote?.destinationDecimals ?? destinationToken!.decimals
                        )
                      )
                      .toString()
                  : '?'
                : transaction.amount,
              actionName: nativeSwap ? 'Swap' : transaction.type === 'claim' ? 'Claim' : 'Withdraw',
              accountKey,
              transactionId: transaction.id,
              originChain: nativeSwap ? 'zcash' : 'near',
              destinationChain: nativeSwap
                ? (boundNativeQuote?.destinationBlockchain ??
                  destinationToken?.blockchain ??
                  transaction.quoteBinding?.destinationChain)
                : 'zec'
            },
            this.pendingTransactions.get(depositAddress),
            transaction.timestamp
          )
          this.pendingTransactions.set(depositAddress, { ...restored, ...accountScope })
          alreadyMonitored.add(depositAddress)
          added++
        }
      } catch {
        // Skip account keys whose transaction store is unavailable.
      }
    }

    if (added > 0) {
      await this.saveToStorage()
      this.scheduleNextCheck()
      console.log('[TransactionMonitor]', `Restored ${added} pending withdraw monitor(s)`)
    }
  }

  async recheckNow() {
    await this.loadFromStorage()
    if (this.pendingTransactions.size === 0) return
    await this.runCheck()
  }

  async hasPendingTransactions(): Promise<boolean> {
    await this.loadFromStorage()
    return this.pendingTransactions.size > 0
  }

  async handleAlarm() {
    await this.loadFromStorage()
    if (this.pendingTransactions.size === 0) {
      chrome.alarms.clear(ALARM_NAME)
      return
    }
    await this.runCheck()
    this.scheduleNextCheck()
  }

  private scheduleNextCheck() {
    if (this.pendingTransactions.size === 0) {
      chrome.alarms.clear(ALARM_NAME)
      return
    }
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: POLL_DELAY_MIN })
  }

  private async runCheck() {
    for (const tx of Array.from(this.pendingTransactions.values())) {
      await this.checkTransactionStatus(tx)
    }
  }

  private async loadFromStorage() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY)
      this.pendingTransactions.clear()
      let migrated = false
      if (Array.isArray(result[STORAGE_KEY])) {
        for (const value of result[STORAGE_KEY]) {
          const entry = normalizeIntentsProgressEntry(value)
          if (entry) {
            const accountScope = resolveAccountScope(
              value as Partial<AccountScope>,
              useWalletStore.getState().wallets
            )
            this.pendingTransactions.set(entry.depositAddress, {
              ...entry,
              ...(accountScope ?? {})
            })
            if (
              typeof value !== 'object' ||
              value === null ||
              typeof (value as Record<string, unknown>).createdAt !== 'number' ||
              typeof (value as Record<string, unknown>).lastStatusChangeAt !== 'number'
            ) {
              migrated = true
            }
          }
        }
      }
      if (migrated) await this.saveToStorage()
    } catch (error) {
      console.error('[TransactionMonitor] Failed to load pending transactions:', error)
    }
  }

  private async saveToStorage() {
    try {
      const txs = Array.from(this.pendingTransactions.values())
      await chrome.storage.local.set({ [STORAGE_KEY]: txs })
    } catch (error) {
      console.error('[TransactionMonitor] Failed to save pending transactions:', error)
      throw error
    }
  }

  private async checkTransactionStatus(tx: PendingTransaction) {
    try {
      const transaction = tx.transactionId
        ? (await loadTransactions(tx.accountKey)).find(
            candidate => candidate.id === tx.transactionId
          )
        : undefined
      if (tx.transactionId && !transaction) {
        await this.handleStale(tx)
        return
      }
      const binding = transaction?.quoteBinding
      if (
        binding?.provider === 'near-intents' &&
        binding.quoteHandle &&
        binding.depositAddress !== tx.depositAddress
      ) {
        throw new Error('Native ZEC Intents monitor deposit address changed')
      }
      const status =
        binding?.provider === 'near-intents' && binding.quoteHandle
          ? await readNativeZecIntentsSwapStatus(binding)
          : await fetchSwapStatus(tx.depositAddress)

      if (!status) {
        if (isIntentsProgressStale(tx)) await this.handleStale(tx)
        return
      }

      const updated = updateIntentsProgressStatus(tx, status.status)
      const isTerminal =
        status.status === 'SUCCESS' || status.status === 'REFUNDED' || status.status === 'FAILED'
      if (updated !== tx && !isTerminal) {
        this.pendingTransactions.set(tx.depositAddress, updated)
        await this.saveToStorage()
        this.notifyProgressUpdated(tx.accountKey)
      }

      if (isTerminal) {
        await this.handleCompletion(updated, status)
      } else if (isIntentsProgressStale(updated)) {
        await this.handleStale(updated)
      }
    } catch (error) {
      console.error('[TransactionMonitor] Failed to check Intents status:', error)
    }
  }

  private async handleCompletion(pendingTx: PendingTransaction, providerStatus: SwapStatus) {
    let status = providerStatus
    let waitsForZcashConfirmations = false
    const originChain = pendingTx.originChain || 'zcash'
    const destinationChain = pendingTx.destinationChain || ''

    const newChainHashes: { hash: string; chain: string }[] = []
    status.swapDetails?.originChainTxHashes?.forEach(tx => {
      newChainHashes.push({ hash: tx.hash, chain: formatChainName(originChain) })
    })
    status.swapDetails?.destinationChainTxHashes?.forEach(tx => {
      newChainHashes.push({ hash: tx.hash, chain: formatChainName(destinationChain) })
    })

    try {
      const accountKey = pendingTx.accountKey
      const transactionId = pendingTx.transactionId

      if (!transactionId) {
        this.pendingTransactions.delete(pendingTx.depositAddress)
        await this.saveToStorage()
        this.notifyProgressUpdated(pendingTx.accountKey)
        this.notifyCompletion(pendingTx, status)
        return
      }

      const txs = await loadTransactions(accountKey)
      const tx = txs.find(t => t.id === transactionId)

      if (!tx) {
        console.warn('[TransactionMonitor] Transaction not found:', transactionId)
        this.pendingTransactions.delete(pendingTx.depositAddress)
        await this.saveToStorage()
        this.notifyProgressUpdated(pendingTx.accountKey)
        return
      }

      const chainHashes = [...(tx.chainHashes || []), ...newChainHashes].filter(
        (entry, index, entries) =>
          entries.findIndex(
            candidate => candidate.hash === entry.hash && candidate.chain === entry.chain
          ) === index
      )

      let updates: Partial<Transaction> = {}
      if (status.status === 'SUCCESS') {
        const bindingCheck = tx.quoteBinding
          ? await this.checkStatusQuoteBinding(tx.quoteBinding, status)
          : 'valid'
        if (bindingCheck === 'unknown') {
          this.scheduleNextCheck()
          return
        }
        if (bindingCheck === 'mismatch') {
          status = { ...status, status: 'FAILED' }
          updates = {
            status: 'failed',
            memo: 'Provider settlement did not match the reviewed quote',
            notified: true,
            chainHashes
          }
        }
      }
      if (status.status === 'SUCCESS') {
        const realAmount = status.swapDetails?.amountOutFormatted
        const shouldUpdateAmount = (tx.type === 'withdraw' || tx.type === 'claim') && realAmount

        const destHashes = status.swapDetails?.destinationChainTxHashes
        const destinationHash = destHashes?.[0]?.hash

        const completionStatus = getCrossChainCompletionStatus(tx.type, {
          destinationAsset: status.destinationAsset,
          destinationChain: pendingTx.destinationChain,
          recipientType: tx.quoteBinding?.recipientType
        })
        waitsForZcashConfirmations = completionStatus === 'relay_confirmed'
        updates = {
          status: completionStatus,
          ...(shouldUpdateAmount ? { amount: realAmount } : {}),
          ...(completionStatus === 'relay_confirmed' && destinationHash
            ? { destinationTxHash: destinationHash }
            : {}),
          notified: completionStatus === 'success',
          chainHashes
        }

        // A Zcash destination is not final until its transaction is available
        // and reaches the required spendability depth.
        if (completionStatus === 'relay_confirmed' && !destinationHash) {
          console.warn(
            '[TransactionMonitor] Relay succeeded without a destination transaction hash; polling will continue',
            transactionId
          )
          await transactionRecorder.updateTransaction(accountKey, transactionId, updates)
          if (isIntentsProgressStale(pendingTx)) await this.handleStale(pendingTx)
          return
        }
      } else if (status.status === 'FAILED') {
        if (!updates.status) {
          updates = { status: 'failed' as const, notified: true, chainHashes }
        }
      } else if (status.status === 'REFUNDED') {
        updates = {
          status: 'failed' as const,
          memo: 'Refunded',
          notified: true,
          chainHashes
        }
      }

      await transactionRecorder.updateTransaction(accountKey, transactionId, updates)
      if (
        tx.quoteBinding?.recipientType === 'CONFIDENTIAL_INTENTS' &&
        (status.status === 'SUCCESS' || status.status === 'REFUNDED' || status.status === 'FAILED')
      ) {
        await markNativeZecIntentsSwapTerminal(tx.quoteBinding, transactionId, status.status).catch(
          () => {}
        )
      }
      if (
        status.status === 'SUCCESS' &&
        tx.quoteBinding?.recipientType === 'CONFIDENTIAL_INTENTS' &&
        pendingTx.walletId &&
        pendingTx.accountId
      ) {
        const refresh = this.confidentialBalanceRefresher
        if (refresh) {
          void Promise.resolve()
            .then(() => refresh({ walletId: pendingTx.walletId!, accountId: pendingTx.accountId! }))
            .catch(() => {})
        }
      }
      if (waitsForZcashConfirmations) {
        await this.registerZcashDestinationMonitor(tx, pendingTx, status)
      }
    } catch (error) {
      console.error('[TransactionMonitor] Failed to update transaction:', error)
      return
    }

    if (pendingTx.actionName === 'Swap') {
      trackEvent(ANALYTICS_EVENTS.SWAP_COMPLETED, {
        chain: 'zcash',
        hasTransaction: 1,
        idempotencyKey: `intents-terminal:${pendingTx.accountKey}:${pendingTx.transactionId}:${status.status}`,
        inputSymbol: pendingTx.tokenInSymbol,
        outputSymbol: pendingTx.tokenOutSymbol,
        extra: { status: status.status, action: 'Swap' }
      })
    }
    const currentEntry = this.pendingTransactions.get(pendingTx.depositAddress)
    this.pendingTransactions.delete(pendingTx.depositAddress)
    try {
      await this.saveToStorage()
    } catch (error) {
      if (currentEntry) this.pendingTransactions.set(pendingTx.depositAddress, currentEntry)
      this.scheduleNextCheck()
      throw error
    }
    this.notifyProgressUpdated(pendingTx.accountKey)

    this.notifyCompletion(pendingTx, status)
  }

  private async handleStale(pendingTx: PendingTransaction): Promise<void> {
    this.pendingTransactions.delete(pendingTx.depositAddress)
    await this.saveToStorage()
    this.scheduleNextCheck()
    this.notifyProgressUpdated(pendingTx.accountKey)
  }

  private notifyProgressUpdated(accountKey: string): void {
    chrome.runtime.sendMessage({ type: 'INTENTS_PROGRESS_UPDATED', accountKey }).catch(() => {})
  }

  private notifyCompletion(pendingTx: PendingTransaction, status: SwapStatus): void {
    chrome.runtime
      .sendMessage({
        type: 'CROSS_CHAIN_STATUS_UPDATED',
        depositAddress: pendingTx.depositAddress,
        transactionId: pendingTx.transactionId,
        accountKey: pendingTx.accountKey,
        status
      })
      .catch(() => {})
  }

  private async checkStatusQuoteBinding(
    binding: QuoteBinding,
    status: SwapStatus
  ): Promise<'valid' | 'mismatch' | 'unknown'> {
    const preliminary = evaluateIntentsStatusQuoteBinding(binding, status)
    if (preliminary === 'mismatch') return 'mismatch'
    const actualAmount = status.swapDetails?.amountOutFormatted
    if (binding.recipientType === 'CONFIDENTIAL_INTENTS' && !actualAmount) return 'unknown'
    if (binding.minAmountOut && actualAmount) {
      const nativeQuote = await readNativeZecIntentsSwapMetadata(binding).catch(() => null)
      let destinationToken = getCachedTokens().find(
        token => token.assetId === binding.destinationAsset
      )
      if (
        !nativeQuote &&
        !destinationToken &&
        binding.provider === 'near-intents' &&
        binding.quoteHandle
      ) {
        destinationToken = (await refreshSwapTokenCatalog().catch(() => [])).find(
          token => token.assetId === binding.destinationAsset
        )
      }
      const decimals = nativeQuote?.destinationDecimals ?? destinationToken?.decimals
      if (decimals === undefined) {
        return binding.provider === 'near-intents' && binding.quoteHandle ? 'unknown' : 'valid'
      }
      return evaluateIntentsStatusQuoteBinding(binding, status, decimals)
    }
    return evaluateIntentsStatusQuoteBinding(binding, status)
  }

  private async registerZcashDestinationMonitor(
    tx: Transaction,
    pendingTx: PendingTransaction,
    status: SwapStatus
  ): Promise<void> {
    const destHashes = status.swapDetails?.destinationChainTxHashes
    const zecHash = destHashes?.[0]?.hash
    if (!zecHash || !pendingTx.transactionId) return
    const accountScope = resolveAccountScope(pendingTx, useWalletStore.getState().wallets)
    if (!accountScope) {
      console.warn(
        '[TransactionMonitor] Cannot monitor Zcash destination with unresolved account identity:',
        pendingTx.transactionId
      )
      return
    }

    await zcashTxMonitor.addTransaction(
      {
        txHash: zecHash,
        ...accountScope,
        transactionId: pendingTx.transactionId,
        amount: status.swapDetails?.amountOutFormatted || tx.amount,
        type: tx.type === 'withdraw' || tx.type === 'claim' ? tx.type : 'receive'
      },
      { checkImmediately: true }
    )
  }
}

export const transactionMonitor = new TransactionMonitor()
