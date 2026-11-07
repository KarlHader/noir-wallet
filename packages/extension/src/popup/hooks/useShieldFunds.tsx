import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useState, useCallback } from 'react'
import { useRef } from 'react'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { useWalletStore } from '@/store/wallet-store'
import { useNavigate } from '../provider/Router'
import { openHardwareSignAndWait, openHardwareSignTab } from '@/lib/hardware-tab'
import { ShieldConfirmSheet } from '../components/transaction/ShieldConfirmSheet'
import { PAGE_IDS } from '@/lib/analytics'
import type { Transaction } from '@/types/wallet'
import { safeBig } from '@/lib/big'
import { classifyError, getResponseErrorMessage } from '@/lib/errors'
import { isValidAddTransactionResponse } from '@/lib/transaction-record-response'
import {
  getShieldableTransparentBalance,
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'
import { getStandardTransactionResultCopy } from '@/lib/transaction-status-copy'
import { isSidePanelSurface } from '@/lib/extension-display-mode'
import { toast } from '@/store/toast-store'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import type { FeeTier } from '@/config/fee'

const SHIELD_FAILED_COPY = getStandardTransactionResultCopy('failed', { shield: true })
const SHIELD_SUCCESS_COPY = getStandardTransactionResultCopy('submitted', { shield: true })

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
  const [sheetBalance, setSheetBalance] = useState('0')
  const [feeRefreshRevision, setFeeRefreshRevision] = useState(0)
  const confirmationInFlight = useRef(false)
  const sheetRevision = useRef(0)
  const { navigate } = useNavigate()
  const { setResult } = useTransactionResultStore()

  const handleShieldFunds = useCallback(() => {
    if (isShielding) return
    sheetRevision.current += 1
    const balance = useAccountDataStore.getState().getCurrentBalance()
    setSheetBalance(getShieldableTransparentBalance(balance))
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
      const context = JSON.stringify([
        useWalletStore.getState().currentWalletId,
        useWalletStore.getState().currentAccountId,
        useWalletStore.getState().currentNetwork,
        useSettingsStore.getState().rpcEndpointPreferences.zcash,
        getChainEndpointRuntimeKey(useSettingsStore.getState().chainEndpointSettings)
      ])
      setIsShielding(true)
      try {
        try {
          const currentQuote = await zcashWalletRuntimeClient.getFeeQuote()
          const currentContext = JSON.stringify([
            useWalletStore.getState().currentWalletId,
            useWalletStore.getState().currentAccountId,
            useWalletStore.getState().currentNetwork,
            useSettingsStore.getState().rpcEndpointPreferences.zcash,
            getChainEndpointRuntimeKey(useSettingsStore.getState().chainEndpointSettings)
          ])
          if (revision !== sheetRevision.current || context !== currentContext) return
          if (currentQuote.id !== feeQuoteId || currentQuote.expiresAt <= Date.now()) {
            setFeeRefreshRevision(value => value + 1)
            return
          }
          const updatedEstimate = await zcashWalletRuntimeClient.estimateShieldFee(
            marginalFeeZats,
            feeQuoteId
          )
          if (
            revision !== sheetRevision.current ||
            updatedEstimate.feeQuote.id !== feeQuoteId ||
            updatedEstimate.feeQuote.expiresAt <= Date.now() ||
            updatedEstimate.feeZats !== String(feeZats) ||
            Number(updatedEstimate.marginalFeeZats) !== marginalFeeZats ||
            context !==
              JSON.stringify([
                useWalletStore.getState().currentWalletId,
                useWalletStore.getState().currentAccountId,
                useWalletStore.getState().currentNetwork,
                useSettingsStore.getState().rpcEndpointPreferences.zcash,
                getChainEndpointRuntimeKey(useSettingsStore.getState().chainEndpointSettings)
              ])
          ) {
            setFeeRefreshRevision(value => value + 1)
            return
          }
        } catch {
          if (revision === sheetRevision.current) setFeeRefreshRevision(value => value + 1)
          return
        }
        const currentBalance = getShieldableTransparentBalance(
          useAccountDataStore.getState().getCurrentBalance()
        )
        if (currentBalance !== sheetBalance) {
          setSheetBalance(currentBalance)
          setFeeRefreshRevision(value => value + 1)
          return
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
          return
        }

        // Hardware wallets sign via QR codes in a dedicated tab
        const currentWallet = walletStore.getCurrentWallet()
        if (isZcashHardwareKeySource(currentWallet?.keySource)) {
          if (!currentWalletId || !currentAccountId) return
          const request = {
            kind: 'shield' as const,
            walletId: currentWalletId,
            accountId: currentAccountId,
            amount: transparentBalance,
            marginalFeeZats,
            feeQuoteId,
            feeTier
          }
          if (!isSidePanelSurface(window.location.search)) {
            await openHardwareSignTab(request)
            window.close()
            return
          }

          setIsShielding(true)
          try {
            const result = await openHardwareSignAndWait(request, { presentation: 'window' })
            if (result.status === 'success') {
              setResult(
                {
                  type: 'zcash',
                  step: 'submitted',
                  amount: result.amount,
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

        setIsShielding(true)

        let pendingTx: Transaction | null = null

        try {
          const syncState = accountDataStore.getCurrentSyncState()

          const now = Date.now()
          const lastSyncTime = syncState.lastSyncTime || 0
          const syncStuckTimeout = 5 * 60 * 1000

          if (syncState.isSyncing && now - lastSyncTime > syncStuckTimeout) {
            console.warn('[useShieldFunds] Sync state appears stuck, forcing reset')
            accountDataStore.setIsSyncing(false)
          } else if (syncState.isSyncing) {
            throw new Error(
              'Blockchain sync is still in progress. Please wait for sync to complete before shielding funds.'
            )
          }

          const fromAddress = currentAccount?.addresses.transparent || ''
          const toAddress = currentAccount?.addresses.shielded || ''

          const accountKey =
            currentWalletId && currentAccountId
              ? buildAccountKey(network, currentWalletId, currentAccountId)
              : ''

          // Cosmetic fee for the pending record; the chain reports the real fee later.
          const feeZec = safeBig(feeZats).div(1e8).toFixed()

          const response: unknown = await chrome.runtime.sendMessage({
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
            throw new Error('Failed to add transaction')
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
            analytics: { pageId: PAGE_IDS.SEND }
          })
          if (startResponse?.success !== true) {
            throw new Error(
              getResponseErrorMessage(startResponse) || 'Failed to start shield transaction'
            )
          }
        } catch (error) {
          console.error('[useShieldFunds] Shield funds failed:', error)

          if (pendingTx && currentWalletId && currentAccountId) {
            const accountKey = buildAccountKey(network, currentWalletId, currentAccountId)
            await useAccountDataStore.getState().reloadTransactions(accountKey)
            const stored = useAccountDataStore
              .getState()
              .getTransactions(accountKey)
              .find(record => record.id === pendingTx?.id)
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
            await chrome.runtime
              .sendMessage({
                type: 'UPDATE_TRANSACTION',
                accountKey,
                transactionId: pendingTx.id,
                updates: { status: 'failed', notified: true }
              })
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
        }
      } finally {
        confirmationInFlight.current = false
        setIsShielding(false)
      }
    },
    [navigate, setResult, sheetBalance]
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
