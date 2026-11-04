import { useState, useCallback, useRef } from 'react'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import { useWalletStore } from '@/store/wallet-store'
import { accountManager } from '@/core/wallet/account-manager'
import type { AddressType, TransactionType, Transaction, QuoteBinding } from '@/types/wallet'
import type { TrackOptions } from '@/lib/analytics/types'
import { WALLET_CONFIG } from '@/config/wallet'
import type { FeeTier } from '@/config/fee'
import { classifyError } from '@/lib/errors'
import { isValidAddTransactionResponse } from '@/lib/transaction-record-response'
import { sanitizeMemoForRecipient } from '@/lib/zcash-memo'
import { loadTransactions } from '@/lib/indexed-db'
import { TimeoutError } from '@/lib/async-utils'
import { TRANSACTION_PENDING_MESSAGE } from '@/lib/transaction-status-copy'

export type TransactionStep = 'idle' | 'pending' | 'submitted' | 'confirming' | 'success' | 'failed'

export interface TxAnalyticsSpec {
  onSuccess?: { name: string; options: TrackOptions }
  onFail?: { name: string; options: TrackOptions }
}

export interface SendTransactionParams {
  to: string
  amount: string
  from: string
  fromType: AddressType
  txType?: TransactionType
  memo?: string
  fee: string
  /** Confirmed ZIP-317 rate paired with the worker-issued quote ID. */
  marginalFeeZats?: number
  feeQuoteId?: string
  feeTier?: FeeTier
  /** Expired transaction being retried by this send. */
  replacesTransactionId?: string
  displayTo?: string
  quoteBinding?: QuoteBinding
  monitorParams?: {
    kind: 'swap'
    direction: 'from_zcash'
    depositAddress: string
    tokenInSymbol: string
    tokenOutSymbol: string
    amountOut: string
    usdAmount?: string
    actionName: string
    originChain?: string
    destinationChain?: string
    originAsset?: string
    destinationAsset?: string
    quoteExpiresAt?: number
  }
  /** Analytics events to fire from background when tx broadcast succeeds/fails. */
  analytics?: TxAnalyticsSpec
  onCreated?: (transaction: Transaction, accountKey: string) => void
}

export interface TransactionResult {
  step: 'success' | 'pending' | 'failed'
  txHash?: string
  error?: string
  accountKey?: string
  transactionId?: string
  timestamp?: number
}

export interface UseTransactionReturn {
  step: TransactionStep
  txHash: string
  error: string | null
  currentTx: Transaction | null
  sendTransaction: (params: SendTransactionParams) => Promise<TransactionResult>
  reset: () => void
}

function waitForZcashTxCompleted(
  accountKey: string,
  transactionId: string,
  timeoutMs: number,
  start: () => Promise<{ success?: boolean; error?: string }>
): Promise<{ txHash: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (reason: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(listener)
      reject(reason)
    }
    const timer = setTimeout(() => {
      fail(new TimeoutError('Transaction completion is still pending'))
    }, timeoutMs)

    const listener = (message: {
      type?: string
      accountKey?: string
      transactionId?: string
      txHash?: string
      error?: string
      completionPending?: boolean
    }) => {
      if (
        message.type !== 'ZCASH_TX_COMPLETED' ||
        message.accountKey !== accountKey ||
        message.transactionId !== transactionId
      ) {
        return
      }

      if (settled) return

      if (message.error) {
        fail(
          message.completionPending === true
            ? new TimeoutError(message.error)
            : new Error(message.error)
        )
        return
      }
      if (message.txHash) {
        settled = true
        clearTimeout(timer)
        chrome.runtime.onMessage.removeListener(listener)
        resolve({ txHash: message.txHash })
        return
      }
      fail(new Error('Transaction completed without tx hash'))
    }

    chrome.runtime.onMessage.addListener(listener)
    void Promise.resolve()
      .then(start)
      .then(response => {
        if (response?.success !== true) {
          fail(new Error(response?.error || 'Failed to start transaction'))
        }
      })
      .catch(fail)
  })
}

/**
 * Hook for managing transaction lifecycle: create -> send -> update status
 */
export function useTransaction(): UseTransactionReturn {
  const [step, setStep] = useState<TransactionStep>('idle')
  const [txHash, setTxHash] = useState('')
  const [error, setError] = useState<string | null>(null)
  const currentTxRef = useRef<Transaction | null>(null)

  const network = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)

  const sendTransaction = useCallback(
    async (params: SendTransactionParams): Promise<TransactionResult> => {
      const {
        to,
        amount,
        from,
        fromType: _fromType,
        txType = 'send',
        memo: _memo,
        fee,
        marginalFeeZats,
        feeQuoteId,
        feeTier,
        replacesTransactionId,
        displayTo,
        quoteBinding,
        monitorParams,
        analytics,
        onCreated
      } = params
      const fromType: AddressType = _fromType
      const memo = _memo ?? ''

      setStep('pending')
      setError(null)

      const capturedWalletId = currentWalletId
      const capturedAccountId = currentAccountId
      if (!capturedWalletId || !capturedAccountId) {
        const errorMessage = 'No active account selected'
        setError(errorMessage)
        setStep('failed')
        return { step: 'failed', error: errorMessage }
      }

      const accountKey = buildAccountKey(network, capturedWalletId, capturedAccountId)

      let tx: Transaction | null = null
      let hash: string | undefined
      try {
        const onChainMemo = sanitizeMemoForRecipient(to, _memo)
        const response = await chrome.runtime.sendMessage({
          type: 'ADD_TRANSACTION',
          accountKey,
          transaction: {
            txHash: '',
            status: 'pending',
            type: txType,
            amount,
            to: displayTo || to,
            from,
            fromType,
            memo,
            fee,
            timestamp: Date.now(),
            network,
            notified: false,
            ...(replacesTransactionId ? { replacesTransactionId } : {}),
            ...(quoteBinding ? { quoteBinding } : {}),
            ...(monitorParams?.depositAddress
              ? { depositAddress: monitorParams.depositAddress }
              : {})
          }
        })

        if (!isValidAddTransactionResponse(response)) {
          throw new Error(response?.error || 'Failed to add transaction')
        }

        const recordedTx = response.transaction as Transaction
        tx = recordedTx
        currentTxRef.current = recordedTx
        onCreated?.(recordedTx, accountKey)

        const completion = waitForZcashTxCompleted(
          accountKey,
          recordedTx.id,
          WALLET_CONFIG.SYNC.RPC_TIMEOUT_MS.TRANSACTION,
          () =>
            chrome.runtime.sendMessage({
              type: 'BACKGROUND_ZCASH_TX',
              action: 'send',
              walletId: capturedWalletId,
              accountId: capturedAccountId,
              accountKey,
              transactionId: recordedTx.id,
              txType,
              sendParams: { to, amount, memo: onChainMemo, fundingSource: fromType },
              marginalFeeZats,
              feeQuoteId,
              feeTier,
              monitorParams: monitorParams
                ? {
                    kind: monitorParams.kind,
                    direction: monitorParams.direction,
                    depositAddress: monitorParams.depositAddress,
                    tokenInSymbol: monitorParams.tokenInSymbol,
                    tokenOutSymbol: monitorParams.tokenOutSymbol,
                    amountIn: amount,
                    amountOut: monitorParams.amountOut,
                    usdAmount: monitorParams.usdAmount,
                    actionName: monitorParams.actionName,
                    originChain: monitorParams.originChain,
                    destinationChain: monitorParams.destinationChain,
                    originAsset: monitorParams.originAsset,
                    destinationAsset: monitorParams.destinationAsset,
                    quoteExpiresAt: monitorParams.quoteExpiresAt
                  }
                : undefined,
              analytics
            })
        )

        hash = (await completion).txHash

        try {
          accountManager.requestSync('transaction')
        } catch (syncError) {
          console.warn('Post-broadcast sync request failed:', syncError)
        }

        setTxHash(hash)
        setStep('submitted')
        return {
          step: 'success',
          txHash: hash,
          accountKey,
          transactionId: tx.id,
          timestamp: tx.timestamp
        }
      } catch (err) {
        if (hash && tx) {
          setTxHash(hash)
          setStep('submitted')
          return {
            step: 'success',
            txHash: hash,
            accountKey,
            transactionId: tx.id,
            timestamp: tx.timestamp
          }
        }
        const persisted = tx
          ? await loadTransactions(accountKey)
              .then(records => records.find(record => record.id === tx?.id))
              .catch(() => undefined)
          : undefined
        if (persisted?.txHash && tx) {
          setTxHash(persisted.txHash)
          setStep('submitted')
          return {
            step: 'success',
            txHash: persisted.txHash,
            accountKey,
            transactionId: tx.id,
            timestamp: tx.timestamp
          }
        }
        if (err instanceof TimeoutError && tx) {
          const errorMessage = TRANSACTION_PENDING_MESSAGE
          setError(errorMessage)
          setStep('pending')
          return {
            step: 'pending',
            error: errorMessage,
            accountKey,
            transactionId: tx.id,
            timestamp: tx.timestamp
          }
        }
        console.error('Transaction failed:', err)
        const errorMessage = classifyError(err).userMessage

        if (tx)
          await chrome.runtime
            .sendMessage({
              type: 'UPDATE_TRANSACTION',
              accountKey,
              transactionId: tx.id,
              updates: {
                status: 'failed',
                notified: true
              }
            })
            .catch(() => {})

        setError(errorMessage)
        setStep('failed')
        return { step: 'failed', error: errorMessage, accountKey, transactionId: tx?.id }
      }
    },
    [network, currentWalletId, currentAccountId]
  )

  const reset = useCallback(() => {
    setStep('idle')
    setTxHash('')
    setError(null)
    currentTxRef.current = null
  }, [])

  return {
    step,
    txHash,
    error,
    currentTx: currentTxRef.current,
    sendTransaction,
    reset
  }
}
