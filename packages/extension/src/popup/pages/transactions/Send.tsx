import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { ShieldFundsBanner } from '../../components/transaction/ShieldFundsBanner'
import { openModal } from '../../provider/ModalManager'
import { RecipientSelector } from '../../components/transaction/RecipientSelector'
import { InlineError } from '@/popup/components/common/InlineError'
import {
  SendAmountInputCard,
  SendRecipientInputCard
} from '../../components/transaction/SendInputCards'
import { openHardwareSignAndWait, openHardwareSignTab } from '@/lib/hardware-tab'
import { isSidePanelSurface } from '@/lib/extension-display-mode'
import { toast } from '@/store/toast-store'
import { classifyError } from '@/lib/errors'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent, type TrackOptions } from '@/lib/analytics'

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../components/ui/dialog'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { useLocation, useNavigate } from '../../provider/Router'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import {
  formatFiatAmount,
  formatBaseUnitDecimalAmount,
  formatTokenQuantity
} from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TokenIcon } from '../../components/tokens/TokenIcon'
import { Switch } from '../../components/ui/switch'
import nearLogo from '@/images/figma-near-confidential.svg'
import zcashShieldLogo from '@/images/figma-zcash-shield.svg'
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
  const walletMode =
    new URLSearchParams(location.search).get('mode') === 'private' ? 'private' : 'public'
  const [selectedFundingSource, setFundingSource] = useState<FundingSource>(() => {
    const source = new URLSearchParams(location.search).get('from')
    return source === 'shielded' || (source !== 'transparent' && walletMode === 'private')
      ? 'shielded'
      : 'transparent'
  })
  const [sourcePickerKind, setSourcePickerKind] = useState<'source' | 'privacy' | null>(null)
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
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
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
  const accountDisplayName = getAccountDisplayName(
    currentWalletId ?? currentWallet?.id ?? '',
    currentAccountId ?? currentAccount?.id ?? '',
    currentAccount?.name ?? 'Account',
    accountDisplayNames
  )
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
  const fundingOptions = getFundingSourceOptions(
    balance,
    currentAccount?.addresses ?? {},
    currentWallet?.keySource
  )
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
    setSourcePickerKind(null)
    setToAddress('')
    setAmount('')
    setMaxSelected(false)
    setMemo('')
    setFundingSource('shielded')
  }, [currentWalletId, currentAccountId])

  const handleSelectFundingSource = (source: FundingSource) => {
    if (
      getFundingSourceUnavailableReason(
        useWalletStore.getState().getCurrentWallet()?.keySource,
        source
      )
    )
      return
    setFundingSource(source)
    setSourcePickerKind(null)
    setAmount('')
    setMaxSelected(false)
    setShowReview(false)
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
    <div className="page-container" data-wallet-mode={walletMode}>
      <PageHeader title="Send" showBack onBack={goBack} />
      <div className="page-content min-h-0 !px-4 pt-4">
        <div className="space-y-2">
          <div className="pb-1 pt-1 text-center">
            <SendAmountInputCard
              hero
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
              symbol="ZEC"
              priceUsd={zecPrice}
              maxSelected={maxSelected}
              invalid={reviewInsufficient}
              error={amountErrorCopy}
            />
            <span className="mt-2 inline-flex h-9 items-center gap-2 rounded-full bg-wallet-surface px-2 text-base font-medium leading-[21px]">
              <TokenIcon symbol="ZEC" nativeChain="zcash" size={26} />
              ZEC
            </span>
            {currentNetwork === 'testnet' && (
              <p className="mt-1 text-xs text-muted">Zcash Testnet</p>
            )}
          </div>

          <div className="space-y-2.5 pt-[21px]">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium leading-[18px] text-muted">Send from</p>
              <button
                type="button"
                role="switch"
                aria-label="Send privately"
                aria-checked={fundingSource === 'shielded' || sourcePickerKind === 'privacy'}
                disabled={
                  fundingSource === 'shielded' &&
                  Boolean(
                    fundingOptions.find(option => option.type === 'transparent')?.disabledReason
                  )
                }
                onClick={() => {
                  if (fundingSource === 'shielded') handleSelectFundingSource('transparent')
                  else setSourcePickerKind('privacy')
                }}
                className="flex items-center gap-1 text-sm font-normal leading-[18px] text-muted disabled:opacity-40"
              >
                <Icon icon="lucide:shield-check" width={15} height={15} className="text-primary" />
                Send privately
                <Switch
                  checked={fundingSource === 'shielded' || sourcePickerKind === 'privacy'}
                  size="sm"
                />
              </button>
            </div>
            <div className="flex min-h-[72px] items-start gap-2 rounded-[10px] border border-white/10 bg-wallet-surface px-[11px] pb-2 pt-[14px]">
              <button
                type="button"
                aria-label="Choose send source"
                aria-haspopup="dialog"
                onClick={() => setSourcePickerKind('source')}
                className="min-w-0 flex-1 text-left"
              >
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium leading-[18px]">
                  <span className="truncate">{accountDisplayName}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-px text-[11px] leading-4',
                      fundingSource === 'shielded'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-white/10 text-muted'
                    )}
                  >
                    {fundingSource === 'shielded' ? 'Shield' : 'Public'}
                  </span>
                  <Icon icon="lucide:chevron-down" width={14} height={14} className="shrink-0" />
                </span>
                <span className="mt-[11px] flex min-w-0 items-center gap-1.5 text-xs font-medium leading-4 text-muted">
                  {fundingSource === 'shielded' && (
                    <img src={zcashShieldLogo} alt="" className="size-4 shrink-0 rounded" />
                  )}
                  <span className="truncate" title={fromAddress}>
                    {fundingSource === 'shielded' ? 'Zcash shield' : formatSortAddress(fromAddress)}
                  </span>
                </span>
              </button>
              <span className="flex max-w-[38%] shrink-0 flex-col items-end gap-2">
                <span
                  className="max-w-full break-all text-right text-sm font-medium leading-[18px]"
                  title={sourceBalance.available}
                >
                  {formatTokenQuantity(sourceBalance.available)}
                </span>
                <button
                  type="button"
                  aria-label="Max"
                  onClick={() => {
                    setMaxSelected(true)
                    setAmount(effectiveMaxStr)
                    void maxTransfer.request()
                  }}
                  disabled={
                    !effectiveToAddress ||
                    !fromAddress ||
                    safeBig(effectiveMaxStr).lte(0) ||
                    maxTransfer.loading
                  }
                  className="rounded bg-white/10 px-2 py-0.5 text-[11px] leading-4 text-muted disabled:opacity-40"
                >
                  Max
                </button>
              </span>
            </div>
          </div>

          {fundingSource === 'shielded' && currentWallet?.keySource !== 'keystone' && (
            <ShieldFundsBanner
              transparentBalance={transparentBalance}
              action="send"
              isShielding={isMigrating}
              onShield={handleMigrateNow}
            />
          )}

          <div className="!mt-[30px]">
            <SendRecipientInputCard
              id="zcash-send-recipient"
              value={toAddress}
              onChange={setToAddress}
              placeholder="Enter address"
              variant="filled"
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

          <div className="flex min-h-5 items-center justify-between gap-2 text-xs">
            <span className="text-muted">Fee</span>
            <FeeTierPicker
              tier={feeTier}
              onTierChange={setFeeTier}
              feeByTier={displayedFeeByTier}
              loading={displayedFeeLoading}
              allowFallback={!feeRequired}
              hideLabel
            />
          </div>
          <div className="flex min-h-5 items-center justify-between text-xs">
            <span className="text-muted">Est. time</span>
            <span>—</span>
          </div>
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
          size="wallet"
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

      <Dialog
        open={sourcePickerKind !== null}
        onOpenChange={open => {
          if (!open) setSourcePickerKind(null)
        }}
      >
        <DialogContent
          position="bottom"
          aria-label="Choose send source"
          showCloseButton={false}
          className="gap-0 rounded-t-2xl border-0 bg-wallet-surface p-0"
        >
          <DialogTitle className="sr-only">Choose send source</DialogTitle>
          <DialogDescription className="sr-only">
            Select the balance to send from.
          </DialogDescription>
          <div className="relative flex h-11 items-center justify-end px-4">
            <button
              type="button"
              aria-label="Close"
              onClick={() => setSourcePickerKind(null)}
              className="flex size-8 items-center justify-center"
            >
              <Icon icon="lucide:x" width={18} height={18} />
            </button>
          </div>
          <div className="flex flex-col items-center pb-5 pt-1">
            <TokenIcon symbol="ZEC" nativeChain="zcash" size={40} />
            <span className="mt-1 text-base font-medium">ZEC</span>
          </div>
          <div className="space-y-2 px-4 pb-8">
            {sourcePickerKind === 'source' &&
              fundingOptions
                .filter(option => option.type === 'transparent')
                .map(option => (
                  <button
                    key={option.type}
                    type="button"
                    disabled={Boolean(option.disabledReason)}
                    onClick={() => handleSelectFundingSource('transparent')}
                    className={cn(
                      'flex min-h-[60px] w-full items-center gap-3 rounded-lg border px-3 text-left text-sm disabled:opacity-40',
                      fundingSource === 'transparent'
                        ? 'border-primary bg-[var(--color-wallet-selected)]'
                        : 'border-white/10 bg-[var(--color-wallet-selected)]'
                    )}
                  >
                    <Icon icon="lucide:eye" width={18} height={18} />
                    <span className="flex-1">Public</span>
                    <span className="max-w-[35%] break-all text-right">
                      {formatTokenQuantity(option.available)}
                    </span>
                  </button>
                ))}
            <button
              type="button"
              disabled
              aria-label="NEAR Confidential Intents unavailable"
              className="flex min-h-[60px] w-full items-center gap-3 rounded-lg border border-white/10 bg-[var(--color-wallet-selected)] px-3 text-left text-sm opacity-40"
            >
              <img src={nearLogo} alt="" className="size-6 shrink-0 rounded" />
              <span className="min-w-0 flex-1 truncate">NEAR Confidential Intents</span>
              <span>—</span>
            </button>
            {fundingOptions
              .filter(option => option.type === 'shielded')
              .map(option => (
                <button
                  key={option.type}
                  type="button"
                  disabled={Boolean(option.disabledReason)}
                  onClick={() => handleSelectFundingSource('shielded')}
                  className={cn(
                    'flex min-h-[60px] w-full items-center gap-3 rounded-lg border px-3 text-left text-sm disabled:opacity-40',
                    fundingSource === 'shielded'
                      ? 'border-primary bg-[var(--color-wallet-selected)]'
                      : 'border-white/10 bg-[var(--color-wallet-selected)]'
                  )}
                >
                  <img src={zcashShieldLogo} alt="" className="size-6 shrink-0 rounded" />
                  <span className="min-w-0 flex-1 truncate">Zcash shield</span>
                  <span className="max-w-[35%] break-all text-right">
                    {formatTokenQuantity(option.available)}
                  </span>
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showReview} onOpenChange={setShowReview}>
        <DialogContent
          position="bottom"
          showCloseButton={false}
          aria-label="Review Send"
          data-wallet-mode={walletMode}
          className="flex h-dvh max-h-dvh flex-col gap-0 rounded-none border-0 bg-background p-0 shadow-none"
        >
          <DialogTitle className="sr-only">Review Send</DialogTitle>
          <DialogDescription className="sr-only">
            Review the amount, destination, and fee before sending.
          </DialogDescription>
          <div className="relative flex h-14 shrink-0 items-center justify-center">
            <button
              type="button"
              aria-label="Back to Send"
              onClick={() => setShowReview(false)}
              className="absolute left-4 flex size-7 items-center justify-center"
            >
              <Icon icon="lucide:chevron-left" width={22} height={22} />
            </button>
            <span className="text-lg font-medium leading-[23px]">Sending</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            <div className="flex h-32 flex-col items-center justify-center">
              <div className="max-w-full text-center text-[40px] font-semibold leading-[37.4px] tracking-[-0.015em]">
                <AmountDisplay
                  value={amount}
                  symbol="ZEC"
                  className="gap-[0.25em] font-sans normal-nums"
                />
              </div>
              <p className="mt-3 text-base leading-[21px] text-muted">
                {formatFiatAmount(
                  safeBig(amount || '0')
                    .times(zecPrice || 0)
                    .toFixed(),
                  { showSign: true }
                )}
              </p>
            </div>
            <div className="mt-1 divide-y divide-white/10 text-sm font-medium leading-[18px]">
              <div className="flex min-h-16 items-center justify-between gap-3">
                <span className="text-muted">Send from</span>
                <span className="min-w-0 text-right">
                  <span className="flex items-center justify-end gap-1.5">
                    {accountDisplayName}
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs',
                        fundingSource === 'shielded'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-white/10 text-muted'
                      )}
                    >
                      {fundingSource === 'shielded' ? 'Shield' : 'Public'}
                    </span>
                  </span>
                  <span
                    className="block truncate text-xs font-normal leading-4 text-muted"
                    title={fromAddress}
                  >
                    {formatSortAddress(fromAddress)}
                  </span>
                </span>
              </div>
              <div className="flex min-h-16 items-center justify-between gap-3">
                <span className="text-muted">To</span>
                <span className="min-w-0 max-w-[70%] text-right">
                  {zns.name && <span className="block text-sm">{zns.name}</span>}
                  <span
                    className="block truncate text-xs font-normal leading-4 text-muted"
                    title={effectiveToAddress}
                  >
                    {formatSortAddress(effectiveToAddress)}
                  </span>
                </span>
              </div>
              <div className="flex min-h-12 items-center justify-between">
                <span className="text-muted">Network</span>
                <span>{currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'}</span>
              </div>
              {effectiveMemo && (
                <div className="flex min-h-12 items-center justify-between gap-3">
                  <span className="text-muted">Memo</span>
                  <span className="max-w-[65%] break-all text-right text-xs">{effectiveMemo}</span>
                </div>
              )}
              <div className="flex min-h-12 items-center justify-between gap-2">
                <span className="text-muted">Network fee</span>
                <FeeTierPicker
                  tier={feeTier}
                  onTierChange={setFeeTier}
                  feeByTier={displayedFeeByTier}
                  loading={displayedFeeLoading}
                  allowFallback={false}
                  hideLabel
                />
              </div>
              <div className="flex min-h-12 items-center justify-between">
                <span className="text-muted">Est. time</span>
                <span>—</span>
              </div>
            </div>
            {feeError && (
              <InlineError
                className="mt-3"
                message="Could not estimate network fee"
                onRetry={retryFeeEstimate}
              />
            )}
          </div>
          <div className="flex shrink-0 gap-2.5 px-4 pb-5 pt-2">
            <Button
              variant="outline"
              size="wallet"
              onClick={() => setShowReview(false)}
              className="h-[45px] flex-1"
            >
              Cancel
            </Button>
            <Button
              size="wallet"
              onClick={handleConfirm}
              disabled={reviewInsufficient || !feeReady || isHardwareSigning}
              className="h-[45px] flex-1"
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
