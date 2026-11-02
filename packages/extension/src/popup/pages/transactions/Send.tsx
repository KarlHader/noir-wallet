import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Switch } from '../../components/ui/switch'
import { PageHeader } from '../../components/common/PageHeader'
import { openModal } from '../../provider/ModalManager'
import { MyAddressSelector } from '../../components/transaction/MyAddressSelector'
import {
  SendAssetHeader,
  SendAmountInputCard,
  SendNetworkFeeCard,
  SendRecipientInputCard
} from '../../components/transaction/SendInputCards'
import { FundingSourceSelector } from '../../components/transaction/FundingSourceSelector'
import { openHardwareSignAndWait, openHardwareSignTab } from '@/lib/hardware-tab'
import { isSidePanelSurface } from '@/config/extension-display'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent } from '@/lib/analytics'
import type { TrackOptions } from '@/lib/analytics'
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
import { useContactsStore } from '@/store/contacts-store'
import { useNavigate, useLocation } from '../../provider/Router'
import { formatNumber, formatPrice, formatSortAddress } from '@/lib/format'
import { DetailRow } from '../../components/common/DetailRow'
import { AddressTypeLabel, AddressTypeSwitch } from '../../components/account/AddressType'
import { TokenIcon } from '../../components/tokens/TokenIcon'
import { useTransaction } from '../../hooks/useTransaction'
import { accountManager } from '@/core/wallet/account-manager'
import { useShieldFunds } from '../../hooks/useShieldFunds'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '../../hooks/useMaxTransferEstimate'
import { FeeTierPicker } from '../../components/transaction/FeeTierPicker'
import { NetworkFeeRow } from '../../components/transaction/NetworkFeeRow'
import { useSettingsStore } from '@/store/settings-store'
import { marginalFeeForTier } from '@/config/fee'
import { ZEC_DECIMALS } from '@/config/wallet'
import { safeBig } from '@/lib/big'
import Big from 'big.js'
import { useZnsResolve } from '../../hooks/useZnsResolve'
import { isTransparentZcashAddress, sanitizeMemoForRecipient } from '@/lib/zcash-memo'
import { canShieldTransparentFunds, getShieldableTransparentBalance } from '@/core/zcash/shielding'
import type { FundingSource } from '@/types'
import { getFundingSourceUnavailableReason } from '@/lib/funding-source'
import { isHardwareKeySource } from '@/lib/hardware-capabilities'
import { getFundingAmountError, getFundingBalance } from '@/lib/funding-balance'
import { HardwareSigningPending } from '../../components/hardware/HardwareSigningPending'
import { toast } from '@/store/toast-store'
import { classifyError } from '@/lib/errors'
import { ShieldFundsBanner } from '../../components/transaction/ShieldFundsBanner'

export function Send() {
  const { goBack, navigate } = useNavigate()
  const location = useLocation()
  const initialFrom = new URLSearchParams(location.search).get('from')

  const [toAddress, setToAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [maxSelected, setMaxSelected] = useState(false)
  const [memo, setMemo] = useState('')
  const [showReview, setShowReview] = useState(false)
  const [isConfirming, setIsConfirming] = useState(false)
  const confirmation = useRef({ revision: 0, pending: false })
  const changeReviewOpen = (open: boolean) => {
    confirmation.current.revision++
    confirmation.current.pending = false
    setIsConfirming(false)
    setShowReview(open)
  }
  useEffect(
    () => () => {
      confirmation.current.revision++
    },
    []
  )
  const [fundingSource, setFundingSource] = useState<FundingSource>(
    initialFrom === 'transparent' ? 'transparent' : 'shielded'
  )
  const [saveContact, setSaveContact] = useState(false)
  const [contactName, setContactName] = useState('')
  const [isHardwareSigning, setIsHardwareSigning] = useState(false)
  const {
    isShielding: isMigrating,
    handleShieldFunds: handleMigrateNow,
    shieldSheet: migrateSheet
  } = useShieldFunds()

  const currentAccount = useWalletStore(state => state.getCurrentAccount())
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const balance = useAccountDataStore(state => state.getCurrentBalance())
  const syncState = useAccountDataStore(state =>
    currentWalletId
      ? state.getWalletSyncState(currentNetwork, currentWalletId)
      : { isSyncing: false, currentHeight: 0, latestHeight: 0 }
  )
  const zecPrice = useWalletStore(state => state.zecPrice)
  const { setResult, updateStep } = useTransactionResultStore()
  const { addContact, getContact } = useContactsStore()

  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const isHardwareWallet = isHardwareKeySource(currentWallet?.keySource)
  const fundingSourceUnavailableReason = getFundingSourceUnavailableReason(
    currentWallet?.keySource,
    fundingSource
  )

  const { sendTransaction } = useTransaction()

  const zns = useZnsResolve(toAddress)
  const effectiveToAddress = zns.address || toAddress

  const feeTier = useSettingsStore(state => state.feeTier)
  const setFeeTier = useSettingsStore(state => state.setFeeTier)

  const fromAddress = currentAccount?.addresses[fundingSource] || ''
  const transparentAvailableBalance = safeBig(getShieldableTransparentBalance(balance))
    .round(ZEC_DECIMALS, Big.roundDown)
    .toFixed()
  const canShield = canShieldTransparentFunds(balance)
  const sourceBalance = getFundingBalance(balance, fundingSource)

  const isTransparentRecipient = isTransparentZcashAddress(effectiveToAddress)
  const effectiveMemo = sanitizeMemoForRecipient(effectiveToAddress, memo)

  const maxTransfer = useMaxTransferEstimate({
    to: effectiveToAddress,
    memo: effectiveMemo,
    feeTier,
    fundingSource,
    enabled: !!effectiveToAddress
  })
  const isMaxTransferAmount =
    !!maxTransfer.maxAmount && safeBig(amount || '0').eq(maxTransfer.maxAmount)
  const feeEstimate = useFeeEstimate({
    type: 'send',
    to: effectiveToAddress,
    amount,
    memo: effectiveMemo,
    fundingSource,
    feeTier,
    enabled:
      safeBig(amount || '0').gt(0) && !!effectiveToAddress && !maxSelected && !isMaxTransferAmount
  })

  const isMaxFeeMode = maxSelected || isMaxTransferAmount
  const displayedFeeByTier = isMaxFeeMode ? maxTransfer.feeByTier : feeEstimate.feeByTier
  const displayedFeeLoadingByTier = isMaxFeeMode
    ? maxTransfer.loadingByTier
    : feeEstimate.loadingByTier
  const displayedFeeLoading = isMaxFeeMode ? maxTransfer.loading : feeEstimate.loading

  const selectedFeeZats = isMaxFeeMode
    ? maxTransfer.fee
      ? safeBig(maxTransfer.fee).mul(1e8).toNumber()
      : null
    : feeEstimate.feeZats
  const estimatedFeeZec =
    selectedFeeZats == null ? '0' : safeBig(selectedFeeZats).div(1e8).toFixed()
  const effectiveMaxStr = safeBig(maxTransfer.maxAmount ?? '0')
    .round(ZEC_DECIMALS, Big.roundDown)
    .toFixed()
  const canSelectMax =
    !!effectiveToAddress && !!maxTransfer.feeQuote && safeBig(effectiveMaxStr).gt(0)
  const amountBig = safeBig(amount || '0')
  const amountError = getFundingAmountError(amount, sourceBalance, maxTransfer.maxAmount)
  const amountErrorCopy =
    amountError === 'pending'
      ? 'Wait for pending funds or lower the amount.'
      : amountError === 'fee'
        ? 'Lower the amount or select Max to include the network fee.'
        : amountError === 'insufficient'
          ? 'Amount exceeds available balance.'
          : undefined
  const isValidAmount = amountBig.gt(0) && !amountError && !fundingSourceUnavailableReason
  const selectedFeeZec = isMaxFeeMode ? (maxTransfer.fee ?? estimatedFeeZec) : estimatedFeeZec
  const selectedFeeQuote = isMaxFeeMode ? maxTransfer.feeQuote : feeEstimate.feeQuote
  const feeReady =
    !!selectedFeeQuote &&
    selectedFeeQuote.expiresAt > Date.now() &&
    !displayedFeeLoading &&
    !(isMaxFeeMode ? maxTransfer.error : feeEstimate.error)

  const confirmationContext = JSON.stringify([
    currentWalletId,
    currentAccount?.id,
    currentNetwork,
    effectiveToAddress,
    amount,
    effectiveMemo,
    fundingSource,
    feeTier,
    maxSelected,
    selectedFeeQuote?.id,
    showReview
  ])
  const latestConfirmationContext = useRef(confirmationContext)
  latestConfirmationContext.current = confirmationContext

  useEffect(() => {
    if (maxSelected && maxTransfer.maxAmount) {
      setAmount(effectiveMaxStr)
    }
  }, [maxSelected, maxTransfer.maxAmount, effectiveMaxStr])

  const isExistingContact = !!getContact(effectiveToAddress)

  const handleSelectMyAddress = async () => {
    await openModal<string>({
      title: 'Select Address',
      showCloseButton: true,
      body: (resolve: (value: any) => void, close: () => void) => (
        <MyAddressSelector
          currentAccountId={currentAccount?.id}
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

  const handleSelectFundingSource = async () => {
    if (!currentAccount) return
    await openModal<FundingSource>({
      title: 'Funding Source',
      showCloseButton: true,
      body: (resolve, close) => (
        <FundingSourceSelector
          selectedType={fundingSource}
          zecPrice={zecPrice}
          options={[
            {
              type: 'shielded',
              address: currentAccount.addresses.shielded,
              available: balance?.confirmed.shielded || '0',
              pending: balance?.pending.shielded || '0'
            },
            {
              type: 'transparent',
              address: currentAccount.addresses.transparent,
              available: balance?.confirmed.transparent || '0',
              pending: balance?.pending.transparent || '0',
              disabledReason: getFundingSourceUnavailableReason(
                currentWallet?.keySource,
                'transparent'
              )
            }
          ]}
          onSelect={source => {
            if (source !== fundingSource) {
              setFundingSource(source)
              setAmount('')
              setMaxSelected(false)
            }
            close()
            resolve(source)
          }}
        />
      )
    })
  }

  const handleContinue = () => {
    if (toAddress && isValidAmount) {
      setSaveContact(false)
      setContactName('')
      changeReviewOpen(true)
    }
  }

  const sendEventBase: TrackOptions = {
    pageId: PAGE_IDS.SEND,
    hasTransaction: 1,
    inputAmount: amount,
    inputSymbol: 'ZEC',
    usdAmount:
      zecPrice > 0
        ? safeBig(amount || '0')
            .mul(zecPrice)
            .toFixed(2)
        : undefined
  }

  const handleConfirm = async () => {
    if (
      confirmation.current.pending ||
      !showReview ||
      !isValidAmount ||
      !fromAddress ||
      fundingSourceUnavailableReason ||
      !feeReady ||
      !selectedFeeQuote
    ) {
      return
    }
    const revision = ++confirmation.current.revision
    confirmation.current.pending = true
    setIsConfirming(true)
    const settings = useSettingsStore.getState()
    const rpcContext = JSON.stringify([
      settings.rpcEndpointModes.zcash,
      settings.rpcEndpointPreferences.zcash,
      settings.customRpcEndpoints.zcash
    ])
    const isCurrent = () => {
      const wallet = useWalletStore.getState()
      const settings = useSettingsStore.getState()
      return (
        confirmation.current.revision === revision &&
        latestConfirmationContext.current === confirmationContext &&
        wallet.currentWalletId === currentWalletId &&
        wallet.currentAccountId === currentAccount?.id &&
        wallet.currentNetwork === currentNetwork &&
        rpcContext ===
          JSON.stringify([
            settings.rpcEndpointModes.zcash,
            settings.rpcEndpointPreferences.zcash,
            settings.customRpcEndpoints.zcash
          ])
      )
    }
    try {
      try {
        const currentQuote = await accountManager.getFeeQuote()
        if (!isCurrent()) return
        if (currentQuote.id !== selectedFeeQuote.id || selectedFeeQuote.expiresAt <= Date.now()) {
          if (isMaxFeeMode) maxTransfer.refresh()
          else feeEstimate.refresh()
          return
        }
      } catch {
        if (!isCurrent()) return
        if (isMaxFeeMode) maxTransfer.refresh()
        else feeEstimate.refresh()
        return
      }
      const marginalFeeZats = marginalFeeForTier(feeTier, selectedFeeQuote.standardMarginalFeeZats)

      if (saveContact && contactName.trim() && !isExistingContact) {
        addContact(effectiveToAddress, contactName.trim(), zns.name || undefined)
      }

      sendAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, {
        ...sendEventBase,
        extra: { fee_tier: feeTier, hardware: isHardwareWallet, funding_source: fundingSource }
      })

      // Hardware wallets sign in a dedicated tab because device permission
      // prompts and the multi-step flow do not survive reliably in a popup.
      if (isHardwareWallet) {
        if (!currentWallet || !currentAccount) return
        setShowReview(false)
        const request = {
          kind: 'send' as const,
          walletId: currentWallet.id,
          accountId: currentAccount.id,
          to: effectiveToAddress,
          amount,
          // Only an explicit Max action may authorize the hardware flow to
          // recalculate and replace the entered amount after refreshing UTXOs.
          maxTransfer: maxSelected,
          memo: effectiveMemo,
          fundingSource,
          marginalFeeZats,
          feeQuoteId: selectedFeeQuote.id,
          feeTier
        }
        const isSidePanel = isSidePanelSurface(window.location.search)

        if (!isSidePanel) {
          await openHardwareSignTab(request)
          window.close()
          return
        }

        setIsHardwareSigning(true)
        try {
          const result = await openHardwareSignAndWait(request)
          if (result.status === 'success') {
            setResult(
              {
                type: 'zcash',
                step: 'submitted',
                amount: result.amount ?? amount,
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
            toast.error('Ledger signing timed out', 'The transaction form has been restored.')
          } else {
            toast.info('Ledger signing cancelled')
          }
        } catch (cause) {
          toast.error('Could not open Ledger signing', classifyError(cause).userMessage)
        } finally {
          setIsHardwareSigning(false)
        }
        return
      }

      setShowReview(false)

      const pendingResult = {
        type: 'zcash' as const,
        step: 'pending' as const,
        amount,
        toAddress: effectiveToAddress,
        showTo: true
      }
      setResult(pendingResult, '/')
      navigate('/transaction-result')

      const result = await sendTransaction({
        to: effectiveToAddress,
        amount,
        from: fromAddress,
        fromType: fundingSource,
        memo: effectiveMemo,
        fee: selectedFeeZec,
        marginalFeeZats,
        feeQuoteId: selectedFeeQuote.id,
        feeTier,
        onCreated: (transaction, accountKey) => {
          if (useTransactionResultStore.getState().data !== pendingResult) return
          updateStep('pending', {
            accountKey,
            transactionId: transaction.id,
            timestamp: transaction.timestamp
          })
        },
        analytics: {
          onSuccess: {
            name: ANALYTICS_EVENTS.SEND_SUCCEEDED,
            options: {
              ...sendEventBase,
              extra: { fee: selectedFeeZec, funding_source: fundingSource }
            }
          },
          onFail: {
            name: ANALYTICS_EVENTS.SEND_FAILED,
            options: { ...sendEventBase, extra: { funding_source: fundingSource } }
          }
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
    } finally {
      if (confirmation.current.revision === revision) {
        confirmation.current.pending = false
        setIsConfirming(false)
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

  if (isHardwareSigning) {
    return (
      <HardwareSigningPending
        signerName={currentWallet?.keySource === 'keystone' ? 'Keystone' : 'Ledger'}
      />
    )
  }

  return (
    <div className="page-container">
      <PageHeader title="Send" showBack onBack={goBack} />
      <div className="page-content">
        <div className="space-y-3">
          <SendAssetHeader
            symbol="ZEC"
            networkName={currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'}
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
            {zns.error && <p className="text-danger text-xs mt-1.5 px-1">{zns.error}</p>}
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
            available={formatNumber(sourceBalance.available, { rm: Big.roundDown })}
            pending={sourceBalance.pending}
            symbol="ZEC"
            priceUsd={zecPrice}
            maxSelected={maxSelected}
            maxLoading={maxTransfer.loading}
            maxDisabled={!canSelectMax}
            onMax={() => {
              if (!canSelectMax) return
              setMaxSelected(true)
              setAmount(effectiveMaxStr)
            }}
            invalid={!!amountError}
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

          {fundingSource === 'shielded' && (
            <div className="flex items-start gap-2 px-1 text-warning/90" role="status">
              <Icon icon="lucide:triangle-alert" className="mt-0.5 size-3.5 shrink-0" />
              <p className="min-w-0 text-[11px] leading-4">
                Some CEXs do not support shield deposits. Please confirm before transferring.
              </p>
            </div>
          )}

          <SendNetworkFeeCard>
            <FeeTierPicker
              tier={feeTier}
              onTierChange={setFeeTier}
              feeByTier={displayedFeeByTier}
              loadingByTier={displayedFeeLoadingByTier}
              loading={displayedFeeLoading}
              hideLabel
            />
            {(isMaxFeeMode ? maxTransfer.error : feeEstimate.error) && (
              <button
                type="button"
                className="mt-2 text-xs text-destructive"
                onClick={isMaxFeeMode ? maxTransfer.refresh : feeEstimate.refresh}
              >
                Fee estimate unavailable. Retry
              </button>
            )}
          </SendNetworkFeeCard>

          <div>
            <label htmlFor="zcash-send-memo" className="mb-1.5 block px-1 text-xs text-muted">
              Memo (optional)
            </label>
            <textarea
              id="zcash-send-memo"
              value={memo}
              onChange={e => {
                const encoded = new TextEncoder().encode(e.target.value)
                if (encoded.length <= 512) setMemo(e.target.value)
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

          {syncState.isSyncing && (
            <p className="px-1 text-[11px] text-muted">
              Syncing wallet. Send will start after the current batch.
            </p>
          )}
        </div>
      </div>

      <div className="page-footer">
        {fundingSource === 'shielded' && canShield && (
          <ShieldFundsBanner
            transparentBalance={transparentAvailableBalance}
            isShielding={isMigrating}
            onShield={handleMigrateNow}
          />
        )}
        <Button
          disabled={!effectiveToAddress || !amount || !isValidAmount || zns.loading}
          onClick={handleContinue}
          className="w-full h-[45px]"
        >
          Continue
        </Button>
      </div>

      <Dialog open={showReview} onOpenChange={changeReviewOpen}>
        <DialogContent position="bottom" showCloseButton={false} className="p-0 gap-0">
          <DialogHeader className="px-5 pt-5 pb-4">
            <DialogTitle className="text-center">Review Send</DialogTitle>
            <DialogDescription className="sr-only">
              Review your transaction details before confirming
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center pb-4">
            <div className="relative mb-3">
              <TokenIcon symbol="ZEC" size="xl" />
            </div>
            <p className="text-2xl font-bold">{formatNumber(amount, { rm: Big.roundDown })} ZEC</p>
            <p className="text-sm text-muted mt-0.5">
              ≈{' '}
              {formatPrice(
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

            <NetworkFeeRow
              tier={feeTier}
              feeZec={selectedFeeZec}
              loading={displayedFeeLoading || isConfirming}
              unavailable={!feeReady}
            />
            {(isMaxFeeMode ? maxTransfer.error : feeEstimate.error) && (
              <button
                type="button"
                className="text-xs text-destructive"
                onClick={isMaxFeeMode ? maxTransfer.refresh : feeEstimate.refresh}
              >
                Fee estimate unavailable. Retry
              </button>
            )}
          </div>

          {!isExistingContact && (
            <div className="mx-5 mt-3 bg-card rounded-xl p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm">Save to contacts</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={saveContact}
                  onClick={() => setSaveContact(!saveContact)}
                  className="flex shrink-0 cursor-pointer rounded-full"
                >
                  <Switch checked={saveContact} size="sm" />
                </button>
              </div>
              {saveContact && (
                <Input
                  value={contactName}
                  onChange={e => setContactName(e.target.value)}
                  placeholder="Contact name"
                  className="mt-3 h-10 bg-background border-none rounded-lg text-sm"
                  autoFocus
                />
              )}
            </div>
          )}

          <div className="p-5 flex gap-3">
            <Button
              variant="outline"
              onClick={() => changeReviewOpen(false)}
              className="flex-1 h-[45px]"
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!feeReady}
              isLoading={isConfirming}
              className="flex-1 h-[45px]"
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {migrateSheet}
    </div>
  )
}
