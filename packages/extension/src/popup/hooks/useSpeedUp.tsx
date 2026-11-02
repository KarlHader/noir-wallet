import { useCallback, useEffect, useRef, useState } from 'react'
import { useTransaction } from './useTransaction'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { useNavigate } from '../provider/Router'
import { accountManager } from '@/core/wallet/account-manager'
import { SpeedUpConfirmSheet } from '../components/transaction/SpeedUpConfirmSheet'
import type { Transaction } from '@/types/wallet'
import { getTransactionRecoveryAction } from '@/lib/transaction-replacement'
import type { FeeTier } from '@/config/fee'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'

function feeContextKey() {
  const wallet = useWalletStore.getState()
  const settings = useSettingsStore.getState()
  return JSON.stringify([
    wallet.currentWalletId,
    wallet.currentAccountId,
    wallet.currentNetwork,
    settings.rpcEndpointModes.zcash,
    settings.rpcEndpointPreferences.zcash,
    settings.customRpcEndpoints.zcash
  ])
}

/**
 * Drives the Speed Up flow: a confirm sheet (default Fast tier) plus the resend.
 *
 * Re-broadcasts a failed send as a fresh transaction (Zcash has no RBF, so it is
 * a new txid reusing the original recipient/amount). Gating on `failed` ensures
 * the original is dead (expired) so its notes are free; a sync is requested first
 * to reconcile the expired tx before the wallet re-selects inputs.
 *
 * Host `speedUpSheet` on a persistent page (e.g. Home) and call `requestSpeedUp`
 * from transient surfaces like the transaction-detail modal.
 */
export function useSpeedUp() {
  const { sendTransaction } = useTransaction()
  const { setResult, updateStep } = useTransactionResultStore()
  const { navigate } = useNavigate()
  const [sheetTx, setSheetTx] = useState<Transaction | null>(null)
  const [sheetRevision, setSheetRevision] = useState(0)
  const confirmationInFlight = useRef(false)
  const openRevision = useRef(0)
  const [isConfirming, setIsConfirming] = useState(false)

  useEffect(
    () => () => {
      openRevision.current += 1
    },
    []
  )

  const requestSpeedUp = useCallback((tx: Transaction) => {
    if (getTransactionRecoveryAction(tx) === 'speed_up') {
      openRevision.current += 1
      setSheetTx(tx)
    }
  }, [])

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      openRevision.current += 1
      setSheetTx(null)
    }
  }, [])

  const executeSpeedUp = useCallback(
    async ({
      amount,
      fee,
      marginalFeeZats,
      feeQuoteId,
      feeTier
    }: {
      amount: string
      fee: string
      marginalFeeZats: number
      feeQuoteId: string
      feeTier: FeeTier
    }) => {
      const tx = sheetTx
      if (!tx || confirmationInFlight.current) return
      confirmationInFlight.current = true
      const revision = openRevision.current
      const contextKey = feeContextKey()
      setIsConfirming(true)
      try {
        const currentQuote = await accountManager.getFeeQuote()
        if (revision !== openRevision.current || contextKey !== feeContextKey()) return
        if (currentQuote.id !== feeQuoteId || currentQuote.expiresAt <= Date.now()) {
          throw new Error('Fee estimate changed')
        }
      } catch {
        if (revision === openRevision.current) setSheetRevision(value => value + 1)
        return
      } finally {
        confirmationInFlight.current = false
        setIsConfirming(false)
      }
      setSheetTx(null)

      accountManager.requestSync('transaction')

      const pendingResult = {
        type: 'zcash' as const,
        step: 'pending' as const,
        amount,
        toAddress: tx.to,
        showTo: true
      }
      setResult(pendingResult, '/')
      navigate('/transaction-result')

      const result = await sendTransaction({
        to: tx.to,
        amount,
        from: tx.from,
        fromType: tx.fromType,
        memo: tx.memo,
        fee,
        marginalFeeZats,
        feeQuoteId,
        feeTier,
        replacesTransactionId: tx.id,
        onCreated: (transaction, accountKey) => {
          if (useTransactionResultStore.getState().data !== pendingResult) return
          updateStep('pending', {
            accountKey,
            transactionId: transaction.id,
            timestamp: transaction.timestamp
          })
        }
      })

      if (result.step === 'success') {
        updateStep(
          'submitted',
          { txHash: result.txHash, timestamp: result.timestamp },
          result.accountKey,
          result.transactionId
        )
      } else if (result.step === 'pending') {
        updateStep('pending', { error: result.error }, result.accountKey, result.transactionId)
      } else {
        if (result.transactionId) {
          updateStep('failed', { error: result.error }, result.accountKey, result.transactionId)
        } else if (useTransactionResultStore.getState().data === pendingResult) {
          updateStep('failed', { error: result.error })
        }
      }
    },
    [sheetTx, sendTransaction, setResult, updateStep, navigate]
  )

  const speedUpSheet = (
    <SpeedUpConfirmSheet
      key={sheetRevision}
      open={!!sheetTx}
      onOpenChange={handleOpenChange}
      tx={sheetTx}
      isConfirming={isConfirming}
      onConfirm={executeSpeedUp}
    />
  )

  return { requestSpeedUp, speedUpSheet }
}
