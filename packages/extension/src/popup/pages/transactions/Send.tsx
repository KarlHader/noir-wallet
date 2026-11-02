import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { ShieldFundsBanner } from '../../components/transaction/ShieldFundsBanner'
import { FundingSourceSelector } from '../../components/transaction/FundingSourceSelector'
import { openModal } from '../../provider/ModalManager'
import { RecipientSelector } from '../../components/transaction/RecipientSelector'
import { InlineError } from '@/popup/components/common/InlineError'
import {
  SendAssetHeader,
  SendAmountInputCard,
  SendNetworkFeeCard,
  SendRecipientInputCard
} from '../../components/transaction/SendInputCards'
import { openHardwareSignAndWait, openHardwareSignTab } from '@/lib/hardware-tab'
import { isSidePanelSurface } from '@/lib/extension-display-mode'
import { toast } from '@/store/toast-store'
import { classifyError } from '@/lib/errors'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent, type TrackOptions } from '@/lib/analytics'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '../../components/ui/dialog'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { useLocation, useNavigate } from '../../provider/Router'
import { formatSortAddress } from '@/lib/format'
import { formatFiatAmount, formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { DetailRow } from '../../components/common/DetailRow'
import { AddressTypeLabel, AddressTypeSwitch } from '../../components/account/AddressType'
import { TokenIcon } from '../../components/tokens/TokenIcon'
import { useTransaction } from '../../hooks/useTransaction'
import { useShieldFunds } from '../../hooks/useShieldFunds'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '../../hooks/useMaxTransferEstimate'
import { FeeTierPicker } from '../../components/transaction/FeeTierPicker'
import { useSettingsStore } from '@/store/settings-store'
import {
  deriveFeeByTier,
  deriveFeeByTierFromEstimate,
  marginalFeeForTier,
  staticFeeFallbackZats
} from '@/core/zcash/fee-policy'
import { resolveZcashFundingAvailability } from '@/popup/services/transfer-availability'
import {
  getFundingBalance,
  getFundingAmountError,
  getFundingAmountErrorCopy
} from '@/core/wallet/funding-balance'
import {
  getFundingSourceOptions,
  getFundingSourceUnavailableReason
} from '@/core/wallet/funding-source'
import type { FundingSource } from '@/types'
import { safeBig } from '@/lib/big'

import { ZEC_DECIMALS } from '@/config/wallet'
import { useZnsResolve } from '../../hooks/useZnsResolve'
import { isTransparentZcashAddress, sanitizeMemoForRecipient } from '@/lib/zcash-memo'
import { getShieldableTransparentBalance } from '@/core/zcash/shielding'
import {
  assertActiveAccountScope,
  getActiveAccountScopeKey
} from '@/popup/lib/active-account-scope'
import { getZcashChainId } from '@/core/chains/registry'

export function Send() {
  const { goBack, navigate } = useNavigate()
  const location = useLocation()
  const [selectedFundingSource, setFundingSource] = useState<FundingSource>(() =>
    new URLSearchParams(location.search).get('from') === 'transparent' ? 'transparent' : 'shielded'
  )
  const [toAddress, setToAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [maxSelected, setMaxSelected] = useState(false)
  const [memo, setMemo] = useState('')
  const [showMemo, setShowMemo] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [isHardwareSigning, setIsHardwareSigning] = useState(false)
  const {
    isShielding: isMigrating,
    handleShieldFunds: handleMigrateNow,
    shieldSheet: migrateSheet
  } = useShieldFunds()

  const currentAccount = useWalletStore(state => state.getCurrentAccount())
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const activeScopeRef = useRef<string | null | undefined>(undefined)
  const balance = useAccountDataStore(state => state.getCurrentBalance())
  const syncState = useAccountDataStore(state =>
    currentWalletId
      ? state.getWalletSyncState(currentNetwork, currentWalletId)
      : { isSyncing: false, currentHeight: 0, latestHeight: 0 }
  )
  const zecPrice = useWalletStore(state => state.zecPrice)
  const { setResult, updateStep } = useTransactionResultStore()

  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const isHardwareWallet = isZcashHardwareKeySource(currentWallet?.keySource)
  const fundingSource = getFundingSourceUnavailableReason(
    currentWallet?.keySource,
    selectedFundingSource
  )
    ? 'shielded'
    : selectedFundingSource

  const { sendTransaction } = useTransaction()

  const zns = useZnsResolve(toAddress)
  const effectiveToAddress = zns.address || toAddress

  const feeTier = useSettingsStore(state => state.feeTier)
  const setFeeTier = useSettingsStore(state => state.setFeeTier)

  const fromAddress = currentAccount?.addresses[fundingSource] || ''
  const sourceBalance = getFundingBalance(balance, fundingSource)
  const transparentBalance = safeBig(getShieldableTransparentBalance(balance)).toNumber()

  const isTransparentRecipient = isTransparentZcashAddress(effectiveToAddress)
  const effectiveMemo = sanitizeMemoForRecipient(effectiveToAddress, memo)

  const maxTransfer = useMaxTransferEstimate({
    to: effectiveToAddress,
    memo: effectiveMemo,
    feeTier,
    fundingSource,
    enabled: !!effectiveToAddress && !!fromAddress
  })
  const isMaxTransferAmount =
    !!maxTransfer.maxAmount && safeBig(amount || '0').eq(maxTransfer.maxAmount)
  const feeEstimate = useFeeEstimate({
    type: 'send',
    to: effectiveToAddress,
    amount,
    memo: effectiveMemo,
    fundingSource,
    scopeKey: JSON.stringify([
      currentNetwork,
      currentWalletId,
      currentAccountId,
      sourceBalance.available,
      sourceBalance.pending
    ]),
    enabled:
      safeBig(amount || '0').gt(0) && !!effectiveToAddress && !maxSelected && !isMaxTransferAmount
  })

  const feeByTier = deriveFeeByTier(feeEstimate.feeZats, false)
  const maxFeeByTier = deriveFeeByTierFromEstimate(
    maxTransfer.fee ? safeBig(maxTransfer.fee).mul(1e8).toNumber() : null,
    feeTier,
    false
  )
  const isMaxFeeMode = maxSelected || isMaxTransferAmount
  const displayedFeeByTier = isMaxFeeMode ? maxFeeByTier : feeByTier
  const feeRequired = !!effectiveToAddress && safeBig(amount || '0').gt(0)
  const feeError = feeRequired && (isMaxFeeMode ? maxTransfer.error : feeEstimate.error)
  const feeReady =
    feeRequired &&
    !feeError &&
    (isMaxFeeMode
      ? !maxTransfer.loading && !!maxTransfer.fee && safeBig(maxTransfer.fee).gt(0)
      : !feeEstimate.loading && feeEstimate.feeZats !== null)
  const displayedFeeLoading = feeRequired && !feeReady && !feeError
  const retryFeeEstimate = () => {
    if (isMaxFeeMode) void maxTransfer.request()
    else feeEstimate.retry()
  }

  const selectedFeeZats = feeByTier[feeTier] ?? staticFeeFallbackZats(feeTier)
  const standardFeeZats = feeByTier.standard ?? staticFeeFallbackZats('standard')
  const estimatedFeeZec = formatBaseUnitDecimalAmount(String(selectedFeeZats), ZEC_DECIMALS)
  const { amount: effectiveMaxStr } = resolveZcashFundingAvailability({
    balance,
    fundingSource,
    selectedFeeZats,
    standardFeeZats,
    maximumAmount: maxTransfer.maxAmount
  })
  const amountError = getFundingAmountError(amount, sourceBalance, effectiveMaxStr)
  const amountErrorCopy = getFundingAmountErrorCopy(amountError)
  const reviewInsufficient = amountError !== null
  const isValidAmount = !!fromAddress && safeBig(amount || '0').gt(0) && !reviewInsufficient
  const selectedFeeZec = maxTransfer.fee && isMaxTransferAmount ? maxTransfer.fee : estimatedFeeZec

  useEffect(() => {
    if (maxSelected) {
      setAmount(effectiveMaxStr)
    }
  }, [maxSelected, effectiveMaxStr])

  useEffect(() => {
    const activeScope = getActiveAccountScopeKey()
    const previousScope = activeScopeRef.current
    activeScopeRef.current = activeScope
    if (previousScope === undefined || previousScope === activeScope) return

    setShowReview(false)
    setToAddress('')
    setAmount('')
    setMaxSelected(false)
    setMemo('')
    setFundingSource('shielded')
  }, [currentWalletId, currentAccountId])

  const handleSelectFundingSource = () => {
    if (!currentAccount) return
    const scope = getActiveAccountScopeKey()
    void openModal<FundingSource>({
      title: 'Funding source',
      body: resolve => (
        <FundingSourceSelector
          options={getFundingSourceOptions(
            balance,
            currentAccount.addresses,
            currentWallet?.keySource
          )}
          selectedType={fundingSource}
          zecPrice={zecPrice}
          onSelect={source => {
            if (scope !== getActiveAccountScopeKey()) return
            if (
              getFundingSourceUnavailableReason(
                useWalletStore.getState().getCurrentWallet()?.keySource,
                source
              )
            )
              return
            setFundingSource(source)
            setAmount('')
            setMaxSelected(false)
            setShowReview(false)
            resolve(source)
          }}
        />
      )
    })
  }

  const handleSelectMyAddress = async () => {
    await openModal<string>({
      title: 'Select Recipient',
      showCloseButton: true,
      body: (resolve: (value: any) => void, close: () => void) => (
        <RecipientSelector
          chainId={getZcashChainId(currentNetwork)}
          excludeAddresses={fromAddress ? [fromAddress] : []}
          onSelect={address => {
            setToAddress(address)
            close()
            resolve(address)
          }}
        />
      )
    })
  }

  const handleContinue = () => {
    if (toAddress && isValidAmount && !reviewInsufficient && feeReady && !zns.loading) {
      setShowReview(true)
    }
  }

  const sendEventBase: TrackOptions = {
    pageId: PAGE_IDS.SEND,
    hasTransaction: 1,
    inputSymbol: 'ZEC'
  }

  const handleConfirm = async () => {
    if (isHardwareSigning) return
    if (!isValidAmount || reviewInsufficient || !feeReady || !fromAddress || !currentAccount) return
    const activeScope = getActiveAccountScopeKey()
    if (!activeScope) return
    assertActiveAccountScope(activeScope)

    sendAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, {
      ...sendEventBase,
      extra: { fee_tier: feeTier, hardware: isHardwareWallet, funding_source: fundingSource }
    })

    // Hardware wallets sign via QR codes in a dedicated tab (camera access
    // and the multi-step flow don't survive in a popup)
    if (isHardwareWallet) {
      assertActiveAccountScope(activeScope)
      if (!currentWallet || !currentAccount) return
      setShowReview(false)
      const request = {
        kind: 'send' as const,
        walletId: currentWallet.id,
        accountId: currentAccount.id,
        to: effectiveToAddress,
        amount,
        fundingSource,
        maxTransfer: maxSelected || isMaxTransferAmount,
        memo: effectiveMemo,
        marginalFeeZats: marginalFeeForTier(feeTier)
      }
      if (!isSidePanelSurface(window.location.search)) {
        await openHardwareSignTab(request)
        window.close()
        return
      }

      setIsHardwareSigning(true)
      try {
        const result = await openHardwareSignAndWait(request, { presentation: 'window' })
        if (result.status === 'success') {
          setResult(
            {
              type: 'zcash',
              step: 'submitted',
              amount: result.amount,
              toAddress: effectiveToAddress,
              txHash: result.txHash,
              accountKey: result.accountKey,
              transactionId: result.transactionId,
              showTo: true
            },
            '/'
          )
          navigate('/transaction-result')
        } else if (result.status === 'timeout') {
          toast.error('Hardware signing timed out', 'The transaction form has been restored.')
        } else {
          toast.info('Hardware signing cancelled')
        }
      } catch (cause) {
        toast.error('Could not open hardware signing', classifyError(cause).userMessage)
      } finally {
        setIsHardwareSigning(false)
      }
      return
    }

    setShowReview(false)

    assertActiveAccountScope(activeScope)

    const pendingResult = {
      type: 'zcash',
      step: 'pending',
      amount,
      toAddress: effectiveToAddress,
      showTo: true,
      saveRecipient: {
        chainId: getZcashChainId(currentNetwork),
        chainFamily: 'zcash',
        network: currentNetwork,
        networkName: currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash',
        address: effectiveToAddress,
        name: zns.name ?? 'Recipient',
        znsName: zns.name || undefined,
        selfTransfer: Object.values(currentAccount.addresses).includes(effectiveToAddress)
      }
    } as const
    setResult(pendingResult, '/')
    navigate('/transaction-result')

    const result = await sendTransaction({
      to: effectiveToAddress,
      amount,
      from: fromAddress,
      fromType: fundingSource,
      memo: effectiveMemo,
      fee: selectedFeeZec,
      marginalFeeZats: marginalFeeForTier(feeTier),
      onCreated: (transaction, accountKey) => {
        if (useTransactionResultStore.getState().data !== pendingResult) return
        updateStep('pending', {
          accountKey,
          transactionId: transaction.id,
          timestamp: transaction.timestamp
        })
      },
      analytics: {
        pageId: PAGE_IDS.SEND,
        fundingSource
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
  }

  if (!currentAccount) {
    return (
      <div className="page-container">
        <PageHeader title="Send" showBack />
        <div className="flex-1 flex items-center justify-center px-5">
          <p className="text-muted text-center">No account available</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <PageHeader title="Send" showBack onBack={goBack} />
      <div className="page-content">
        {fundingSource === 'shielded' && currentWallet?.keySource !== 'keystone' && (
          <ShieldFundsBanner
            transparentBalance={transparentBalance}
            action="send"
            isShielding={isMigrating}
            onShield={handleMigrateNow}
          />
        )}

        <div className="space-y-3">
          <SendAssetHeader
            symbol="ZEC"
            networkName={currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'}
            nativeChain="zcash"
          />

          <div>
            <SendRecipientInputCard
              id="zcash-send-recipient"
              value={toAddress}
              onChange={setToAddress}
              placeholder="Enter address"
              autoFocus
              onSelectRecipient={handleSelectMyAddress}
            />
            {zns.loading && (
              <p className="text-muted text-xs mt-1.5 px-1 flex items-center gap-1.5">
                <Icon icon="lucide:loader-2" width={12} height={12} className="animate-spin" />
                Resolving name...
              </p>
            )}
            {zns.address && (
              <p className="text-primary text-xs mt-1.5 px-1 flex items-center gap-1.5">
                <Icon icon="lucide:check-circle" width={12} height={12} />
                {formatSortAddress(zns.address)}
              </p>
            )}
            {zns.error && (
              <InlineError
                className="mt-1.5 px-1"
                message={zns.error}
                onRetry={zns.retryable ? zns.retry : undefined}
                retrying={zns.loading}
              />
            )}
          </div>

          <SendAmountInputCard
            testId="zcash-amount-card"
            ariaLabel="ZEC amount"
            value={amount}
            onChange={nextAmount => {
              if (!/^\d*\.?\d*$/.test(nextAmount)) return
              setMaxSelected(false)
              setAmount(nextAmount)
            }}
            available={sourceBalance.available}
            pending={sourceBalance.pending}
            showBalanceHelp
            symbol="ZEC"
            priceUsd={zecPrice}
            maxSelected={maxSelected}
            maxLoading={maxTransfer.loading}
            maxDisabled={!effectiveToAddress || !fromAddress || safeBig(effectiveMaxStr).lte(0)}
            onMax={() => {
              setMaxSelected(true)
              setAmount(effectiveMaxStr)
              void maxTransfer.request()
            }}
            invalid={reviewInsufficient}
            error={amountErrorCopy}
            headerAction={
              <AddressTypeSwitch
                type={fundingSource}
                onClick={handleSelectFundingSource}
                size="md"
                ariaLabel="Select funding source"
              />
            }
          />

          <SendNetworkFeeCard>
            <FeeTierPicker
              tier={feeTier}
              onTierChange={setFeeTier}
              feeByTier={displayedFeeByTier}
              loading={displayedFeeLoading}
              allowFallback={!feeRequired}
              hideLabel
            />
          </SendNetworkFeeCard>
          {feeError && (
            <InlineError
              className="px-1"
              message="Could not estimate network fee"
              onRetry={retryFeeEstimate}
            />
          )}

          {showMemo ? (
            <div>
              <label htmlFor="zcash-send-memo" className="mb-1.5 block px-1 text-xs text-muted">
                Memo (optional)
              </label>
              <textarea
                id="zcash-send-memo"
                autoFocus
                value={memo}
                onChange={event => {
                  const encoded = new TextEncoder().encode(event.target.value)
                  if (encoded.length <= 512) setMemo(event.target.value)
                }}
                placeholder={
                  isTransparentRecipient
                    ? 'Memo not available for transparent addresses'
                    : 'Add a private memo'
                }
                rows={2}
                disabled={isTransparentRecipient}
                className="w-full resize-none rounded-xl border border-border/60 bg-card/50 px-4 py-3 text-sm placeholder:text-muted/50 focus:border-primary/50 focus:outline-none disabled:opacity-40"
              />
              {memo && !isTransparentRecipient && (
                <p className="mt-1 px-1 text-right text-xs text-muted">
                  {new TextEncoder().encode(memo).length}/512 bytes
                </p>
              )}
            </div>
          ) : (
            <button
              type="button"
              aria-expanded="false"
              disabled={isTransparentRecipient}
              onClick={() => setShowMemo(true)}
              className="flex min-h-11 w-full items-center justify-between rounded-xl bg-card/45 px-4 text-xs text-muted transition-colors hover:bg-card/70 disabled:pointer-events-none disabled:opacity-40"
            >
              <span>Memo (optional)</span>
              <Icon icon="lucide:plus" width={16} height={16} />
            </button>
          )}

          {syncState.isSyncing && (
            <p role="status" className="text-muted text-xs px-1">
              Syncing wallet. Send will start after the current batch.
            </p>
          )}
        </div>
      </div>

      <div className="page-footer">
        <Button
          disabled={
            !effectiveToAddress ||
            !amount ||
            !isValidAmount ||
            reviewInsufficient ||
            !feeReady ||
            zns.loading
          }
          onClick={handleContinue}
          className="w-full h-[45px]"
        >
          Continue
        </Button>
      </div>

      <Dialog open={showReview} onOpenChange={setShowReview}>
        <DialogContent position="bottom" showCloseButton={false} className="p-0 gap-0">
          <DialogHeader className="px-5 pt-5 pb-4">
            <DialogTitle className="text-center">Review Send</DialogTitle>
            <DialogDescription className="sr-only">
              Review your transaction details before confirming
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center pb-4">
            <div className="relative mb-3">
              <TokenIcon symbol="ZEC" nativeChain="zcash" size="xl" />
            </div>
            <div className="max-w-full text-center text-2xl font-bold">
              <AmountDisplay value={amount} symbol="ZEC" />
            </div>
            <p className="text-sm text-muted mt-0.5">
              ≈{' '}
              {formatFiatAmount(
                safeBig(amount || '0')
                  .times(zecPrice || 0)
                  .toFixed(),
                { showSign: true }
              )}
            </p>
          </div>

          <div className="mx-5 bg-card rounded-xl p-4 space-y-3">
            <DetailRow label="From">
              <div className="flex items-center gap-2">
                <AddressTypeLabel type={fundingSource} />
                <span className="font-mono text-xs text-muted">
                  {formatSortAddress(fromAddress)}
                </span>
              </div>
            </DetailRow>

            <DetailRow label="To">
              <div className="text-right">
                {zns.name && <span className="text-xs text-primary block">{zns.name}</span>}
                <span className="font-mono text-xs text-muted">
                  {formatSortAddress(effectiveToAddress)}
                </span>
              </div>
            </DetailRow>

            {effectiveMemo && (
              <DetailRow label="Memo">
                <span className="text-xs text-right break-all max-w-[180px]">{effectiveMemo}</span>
              </DetailRow>
            )}

            <FeeTierPicker
              tier={feeTier}
              onTierChange={setFeeTier}
              feeByTier={displayedFeeByTier}
              loading={displayedFeeLoading}
              allowFallback={false}
            />
          </div>
          {feeError && (
            <InlineError
              className="mx-5 mt-3"
              message="Could not estimate network fee"
              onRetry={retryFeeEstimate}
            />
          )}

          <div className="p-5 flex gap-3">
            <Button
              variant="outline"
              onClick={() => setShowReview(false)}
              className="flex-1 h-[45px]"
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={reviewInsufficient || !feeReady || isHardwareSigning}
              className="flex-1 h-[45px]"
            >
              {isHardwareSigning ? 'Waiting for hardware wallet...' : 'Confirm'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {migrateSheet}
    </div>
  )
}
