import { useState, useCallback, useEffect, useRef } from 'react'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { useWalletStore } from '@/store/wallet-store'
import { useNavigate } from '../provider/Router'
import { openHardwareSignAndWait, openHardwareSignTab } from '@/lib/hardware-tab'
import { ShieldConfirmSheet } from '../components/transaction/ShieldConfirmSheet'
import { accountManager } from '@/core/wallet/account-manager'
import { ANALYTICS_EVENTS, PAGE_IDS } from '@/lib/analytics'
import type { FeeTier } from '@/config/fee'
import type { Transaction } from '@/types/wallet'
import { safeBig } from '@/lib/big'
import { classifyError } from '@/lib/errors'
import { loadTransactions } from '@/lib/indexed-db'
import { isValidAddTransactionResponse } from '@/lib/transaction-record-response'
import {
  getShieldableTransparentBalance,
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'
import { isHardwareKeySource } from '@/lib/hardware-capabilities'
import { getStandardTransactionResultCopy } from '@/lib/transaction-status-copy'
import { isSidePanelSurface } from '@/config/extension-display'
import { toast } from '@/store/toast-store'
import { useSettingsStore } from '@/store/settings-store'

const SHIELD_FAILED_COPY = getStandardTransactionResultCopy('failed', { shield: true })
const SHIELD_SUCCESS_COPY = getStandardTransactionResultCopy('submitted', { shield: true })

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

interface UseShieldFundsResult {
  isShielding: boolean
  handleShieldFunds: () => void
  /** Bottom sheet element to render in the consuming page. */
  shieldSheet: React.ReactNode
}

/**
 * Custom hook for shielding transparent funds.
 *
 * Opens a confirmation sheet with a fee-tier selector, then delegates the WASM
 * operation to the background service worker so it completes even if the popup
 * closes.
 */
export function useShieldFunds(): UseShieldFundsResult {
  const [isShielding, setIsShielding] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetBalance, setSheetBalance] = useState(0)
  const [feeRefreshRevision, setFeeRefreshRevision] = useState(0)
  const confirmationInFlight = useRef(false)
  const sheetRevision = useRef(0)

  useEffect(
    () => () => {
      sheetRevision.current += 1
    },
    []
  )
  const { navigate } = useNavigate()
  const { setResult } = useTransactionResultStore()

  const handleShieldFunds = useCallback(() => {
    if (isShielding) return
    sheetRevision.current += 1
    const balance = useAccountDataStore.getState().getCurrentBalance()
    setSheetBalance(safeBig(getShieldableTransparentBalance(balance)).toNumber())
    setSheetOpen(true)
  }, [isShielding])

  const handleSheetOpenChange = useCallback((open: boolean) => {
    if (!open) sheetRevision.current += 1
    setSheetOpen(open)
  }, [])

  const executeShield = useCallback(
    async ({
      marginalFeeZats,
      feeQuoteId,
      feeTier,
      feeZats
    }: {
      marginalFeeZats: number
      feeQuoteId: string
      feeTier: FeeTier
      feeZats: number
    }) => {
      if (confirmationInFlight.current) return
      confirmationInFlight.current = true
      const revision = sheetRevision.current
      const contextKey = feeContextKey()
      setIsShielding(true)
      let quoteAccepted = false
      try {
        const currentQuote = await accountManager.getFeeQuote()
        if (revision !== sheetRevision.current || contextKey !== feeContextKey()) return
        if (currentQuote.id !== feeQuoteId || currentQuote.expiresAt <= Date.now()) {
          throw new Error('Fee estimate changed')
        }
        quoteAccepted = true
      } catch {
        if (revision === sheetRevision.current) setFeeRefreshRevision(value => value + 1)
        return
      } finally {
        if (!quoteAccepted) setIsShielding(false)
        confirmationInFlight.current = false
      }
      setSheetOpen(false)

      const accountDataStore = useAccountDataStore.getState()
      const walletStore = useWalletStore.getState()
      const network = walletStore.currentNetwork
      const currentWalletId = walletStore.currentWalletId
      const currentAccountId = walletStore.currentAccountId
      const currentAccount = walletStore.getCurrentAccount()

      const balance = accountDataStore.getCurrentBalance()
      const transparentBalance = getShieldableTransparentBalance(balance)

      if (!hasEnoughTransparentBalanceToShield(transparentBalance)) {
        setResult(
          {
            type: 'zcash',
            step: 'failed',
            amount: transparentBalance,
            error: MIN_SHIELDING_BALANCE_MESSAGE,
            customTitle: SHIELD_FAILED_COPY.title
          },
          '/'
        )
        navigate('/transaction-result')
        setIsShielding(false)
        return
      }

      // Hardware wallets sign in a dedicated tab.
      const currentWallet = walletStore.getCurrentWallet()
      if (isHardwareKeySource(currentWallet?.keySource)) {
        if (!currentWalletId || !currentAccountId) {
          setIsShielding(false)
          return
        }
        const request = {
          kind: 'shield' as const,
          walletId: currentWalletId,
          accountId: currentAccountId,
          amount: transparentBalance,
          marginalFeeZats,
          feeQuoteId,
          feeTier
        }
        const isSidePanel = isSidePanelSurface(window.location.search)

        if (!isSidePanel) {
          try {
            await openHardwareSignTab(request)
            window.close()
          } catch (cause) {
            toast.error('Could not open hardware signing', classifyError(cause).userMessage)
          } finally {
            setIsShielding(false)
          }
          return
        }

        try {
          const result = await openHardwareSignAndWait(request)
          if (result.status === 'success') {
            setResult(
              {
                type: 'zcash',
                step: 'submitted',
                amount: transparentBalance,
                fromAddress: currentAccount?.addresses.transparent,
                toAddress: currentAccount?.addresses.shielded,
                txHash: result.txHash,
                accountKey: result.accountKey,
                transactionId: result.transactionId,
                customTitle: SHIELD_SUCCESS_COPY.title,
                showFrom: true,
                showTo: true
              },
              '/'
            )
            navigate('/transaction-result')
          } else if (result.status === 'timeout') {
            toast.error('Hardware signing timed out', 'The shield action is available again.')
          } else {
            toast.info('Hardware signing cancelled')
          }
        } catch (cause) {
          toast.error('Could not open hardware signing', classifyError(cause).userMessage)
        } finally {
          setIsShielding(false)
        }
        return
      }

      let pendingTx: Transaction | null = null

      try {
        const fromAddress = currentAccount?.addresses.transparent || ''
        const toAddress = currentAccount?.addresses.shielded || ''

        const accountKey =
          currentWalletId && currentAccountId
            ? buildAccountKey(network, currentWalletId, currentAccountId)
            : ''

        // Cosmetic fee for the pending record; the chain reports the real fee later.
        const feeZec = safeBig(feeZats).div(1e8).toFixed()

        const response = await chrome.runtime.sendMessage({
          type: 'ADD_TRANSACTION',
          accountKey,
          transaction: {
            txHash: '',
            status: 'pending',
            type: 'shield',
            amount: transparentBalance,
            to: toAddress,
            from: fromAddress,
            fromType: 'transparent',
            memo: 'Shielding transparent funds',
            fee: feeZec,
            timestamp: Date.now(),
            network,
            notified: false
          }
        })

        if (!isValidAddTransactionResponse(response)) {
          throw new Error(response?.error || 'Failed to add transaction')
        }
        pendingTx = response.transaction
        if (!pendingTx) {
          throw new Error('Failed to create transaction')
        }

        setResult(
          {
            type: 'zcash',
            step: 'pending',
            amount: transparentBalance,
            fromAddress,
            toAddress,
            customTitle: 'Building Shield Transaction',
            showFrom: true,
            showTo: true,
            timestamp: pendingTx.timestamp,
            accountKey,
            transactionId: pendingTx.id
          },
          '/'
        )
        navigate('/transaction-result')

        const shieldAnalyticsBase = {
          pageId: PAGE_IDS.SEND,
          hasTransaction: 1,
          inputAmount: transparentBalance,
          inputSymbol: 'ZEC'
        }

        const startResponse = await chrome.runtime.sendMessage({
          type: 'BACKGROUND_ZCASH_TX',
          action: 'shield',
          walletId: currentWalletId,
          accountId: currentAccountId,
          accountKey,
          transactionId: pendingTx.id,
          marginalFeeZats,
          feeQuoteId,
          feeTier,
          analytics: {
            onSuccess: {
              name: ANALYTICS_EVENTS.SHIELD_SUCCEEDED,
              options: shieldAnalyticsBase
            },
            onFail: {
              name: ANALYTICS_EVENTS.SHIELD_FAILED,
              options: shieldAnalyticsBase
            }
          }
        })
        if (startResponse?.success !== true) {
          throw new Error(startResponse?.error || 'Failed to start shield transaction')
        }
      } catch (error) {
        console.error('[useShieldFunds] Shield funds failed:', error)

        if (pendingTx && currentWalletId && currentAccountId) {
          const accountKey = buildAccountKey(network, currentWalletId, currentAccountId)
          const stored = await loadTransactions(accountKey)
            .then(records => records.find(record => record.id === pendingTx?.id))
            .catch(() => undefined)
          const currentResult = useTransactionResultStore.getState().data
          const resultHash =
            currentResult?.type === 'zcash' &&
            currentResult.accountKey === accountKey &&
            currentResult.transactionId === pendingTx.id
              ? currentResult.txHash
              : undefined
          const knownHash = stored?.txHash || resultHash
          if (knownHash) {
            useTransactionResultStore.getState().updateStep(
              'submitted',
              {
                txHash: knownHash,
                customTitle: SHIELD_SUCCESS_COPY.title,
                customDescription: SHIELD_SUCCESS_COPY.description
              },
              accountKey,
              pendingTx.id
            )
            return
          }

          const transactionId = pendingTx.id
          void Promise.resolve()
            .then(() =>
              chrome.runtime.sendMessage({
                type: 'UPDATE_TRANSACTION',
                accountKey,
                transactionId,
                updates: {
                  status: 'failed',
                  notified: true
                }
              })
            )
            .catch(() => {})
        }

        setResult(
          {
            type: 'zcash',
            step: 'failed',
            amount: transparentBalance,
            error: classifyError(error).userMessage,
            customTitle: SHIELD_FAILED_COPY.title
          },
          '/'
        )
        navigate('/transaction-result')
      } finally {
        setIsShielding(false)
      }
    },
    [navigate, setResult]
  )

  const shieldSheet = (
    <ShieldConfirmSheet
      open={sheetOpen}
      onOpenChange={handleSheetOpenChange}
      transparentBalance={sheetBalance}
      feeRefreshRevision={feeRefreshRevision}
      isShielding={isShielding}
      onConfirm={executeShield}
    />
  )

  return {
    isShielding,
    handleShieldFunds,
    shieldSheet
  }
}
