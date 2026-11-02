import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import { formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { InlineError } from '@/popup/components/common/InlineError'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { Button } from '@/popup/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import {
  evmWalletClient,
  type EvmTransferReview,
  type EvmTransferSubmission
} from '@/popup/services/evm-wallet-client'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import { openHardwareEvmSignTab } from '@/lib/hardware-tab'
import { openModal } from '@/popup/provider/ModalManager'
import { useNavigate } from '@/popup/provider/Router'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import {
  SendAssetHeader,
  SendAmountInputCard,
  SendNetworkFeeCard,
  SendRecipientInputCard
} from '@/popup/components/transaction/SendInputCards'
import { DEFAULT_NETWORK_FEE_TIER } from '@/core/transactions/domain'
import {
  areEvmFeeSelectionsEqual,
  formatEvmWeiAsGwei,
  type EvmFeeSelection
} from '@/infrastructure/chains/evm'
import { useTransferFeePreview } from '@/popup/hooks/useTransferFeePreview'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import {
  createNativeTransferSource,
  estimateNativeTransferMaximum,
  estimateConfidentialTransferMaximum,
  fallbackTransferMaximum,
  isTransferAmountSpendable
} from '@/popup/services/transfer-maximum'
import {
  getEvmTransferBalanceError,
  getEvmSendPrepareError,
  getEvmTokenFeeBalanceError,
  buildPrivateEvmTransferPath,
  resolveEvmNativeMaximumAmount,
  type EvmSendSourceMode
} from './evm-send-validation'
import {
  resolveAccountAvailableRaw,
  resolveEvmAccountAvailability,
  resolvePortfolioTransferAvailability
} from '@/popup/services/transfer-availability'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import {
  ExecutionAccountBadge,
  AccountAddressSelectorButton,
  ExecutionAccountSelectorDialog
} from '@/popup/components/account/ExecutionAccountSelector'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import { PrivateBalanceTransferDialog } from '@/popup/components/portfolio/PrivateBalanceTransferDialog'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'
import { useEvmSendSupport } from '@/popup/hooks/useEvmSendSupport'
import { resolveEvmAddressRole } from '@/core/accounts/evm-address-role'
import {
  createEvmSendIntentKey,
  getEvmSendPrivacyWarning,
  resolveEvmSendAvailableRaw,
  resolveEvmSendRoute
} from '@/popup/services/evm-send-routing'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { LatestAttempt } from '@/lib/async-utils'
import { getRheaSwapErrorMessage } from '@/popup/services/rhea-swap-client'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'

export interface EvmSendAsset {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
}

interface PreparedReview {
  readonly intentKey: string
  readonly sourceMode: EvmSendSourceMode
  readonly sourceAddress: string
  readonly privacyWarning: string | null
  readonly amount: string
  readonly amountRaw: string
  readonly recipient: string
  readonly feeSelection: EvmFeeSelection
  readonly value: EvmTransferReview
}

export function evmSendNetworkLabel(chain: PortfolioChainView): string {
  return formatPortfolioNetworkName(chain)
}

export function EvmSendForm({
  selection,
  portfolio,
  priceUsd,
  sourceMode,
  sourceSelectorOpen,
  onSourceModeChange,
  onSourceSelectorOpenChange,
  onFundPrivate,
  initialRecipient,
  onSubmitted
}: {
  selection: EvmSendAsset
  portfolio: PortfolioReadModel
  priceUsd: string | null
  sourceMode: EvmSendSourceMode
  sourceSelectorOpen: boolean
  onSourceModeChange: (mode: EvmSendSourceMode) => void
  onSourceSelectorOpenChange: (open: boolean) => void
  onFundPrivate?: (amount: string, maximum?: boolean) => void
  initialRecipient?: string
  onSubmitted: (submission: EvmTransferSubmission) => void
}) {
  const [amount, setAmount] = useState('')
  const [fundingDialogOpen, setFundingDialogOpen] = useState(false)
  const [recipient, setRecipient] = useState(initialRecipient ?? '')
  const [feeSelection, setFeeSelection] = useState<EvmFeeSelection>({
    kind: 'tier',
    tier: DEFAULT_NETWORK_FEE_TIER
  })
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [maxSelected, setMaxSelected] = useState(false)
  const [approving, setApproving] = useState(false)
  const [updatingFee, setUpdatingFee] = useState(false)
  const [review, setReview] = useState<PreparedReview | null>(null)
  const pendingReview = useRef<EvmTransferReview | null>(null)
  const reviewAttempt = useRef(new LatestAttempt())
  const { navigate } = useNavigate()
  const asset = selection.asset
  const chain = selection.chain
  const { activeAccount: catalogAccount, catalog } = useActiveAccountNetworks()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const networkMode = useWalletStore(state => state.currentNetwork)
  const endpoints = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: catalogAccount
  })
  const walletId = effectiveAccount?.walletId ?? null
  const accountId = effectiveAccount?.accountId ?? null
  const activeAccount =
    catalogAccount?.walletId === walletId && catalogAccount.accountId === accountId
      ? catalogAccount
      : null
  const accountNetwork = activeAccount?.networks.find(
    network => network.chain.id === chain.chain.id
  )
  const mainSourceAddress = accountNetwork?.addresses.find(
    address => address.preferredForReceive
  )?.value
  const privateSourceAddress = accountNetwork?.privateExecutionAddress
  const bundledAsset = asset.source !== 'user-added'
  const availableRaw = resolveEvmSendAvailableRaw(asset.balance, sourceMode)
  const {
    privateSourceAvailable,
    mainDisplay: mainSourceBalance,
    privateDisplay: privateSourceBalance,
    confidentialDisplay: privateUnavailableBalance
  } = resolveEvmAccountAvailability(asset.balance, asset.metadata.decimals, privateSourceAddress)
  const evmNative = portfolio.assets.find(
    candidate =>
      candidate.asset.chainId === asset.asset.chainId && candidate.asset.kind === 'native'
  )
  const nativeSymbol = evmNative?.metadata.symbol ?? 'Native asset'
  const nativeDecimals = evmNative?.metadata.decimals ?? 18
  const nativeAvailableRaw = resolveEvmSendAvailableRaw(evmNative?.balance, sourceMode)
  const tokenFeeBalanceError = getEvmTokenFeeBalanceError(
    asset.asset.kind,
    nativeAvailableRaw,
    nativeSymbol
  )
  const sourceAddress = sourceMode === 'private' ? privateSourceAddress : mainSourceAddress
  const accountContextKey = JSON.stringify([
    walletId,
    accountId,
    networkMode,
    endpoints,
    chain.chain.id,
    sourceMode,
    sourceAddress
  ])
  const support = useEvmSendSupport(chain.chain, asset.asset, accountContextKey)
  const route = resolveEvmSendRoute(sourceMode, support.support)
  const recipientRole = resolveEvmAddressRole(
    recipient,
    chain.chain.id,
    activeAccount ? catalog?.accounts : []
  )

  useEffect(() => {
    if (initialRecipient && /^0x[0-9a-fA-F]{40}$/.test(initialRecipient)) {
      setRecipient(initialRecipient)
    }
  }, [asset.asset.id, initialRecipient])

  useEffect(
    () => () => {
      reviewAttempt.current.invalidate()
      currentIntent.current = null
      const pending = pendingReview.current
      if (pending) void evmWalletClient.rejectTransfer(pending.graph.root.id).catch(() => {})
    },
    []
  )

  const amountRaw = useMemo(() => {
    try {
      return parseDisplayUnitAmount(amount, asset.metadata.decimals)
    } catch {
      return null
    }
  }, [amount, asset.metadata.decimals])
  const validRecipient = /^0x[0-9a-fA-F]{40}$/.test(recipient) && !/^0x0{40}$/i.test(recipient)
  const reviewContext = {
    contextKey: accountContextKey,
    assetId: asset.asset.id,
    assetReference: asset.asset.reference,
    decimals: asset.metadata.decimals,
    route,
    recipientRole
  }
  const intentKey = createEvmSendIntentKey({ ...reviewContext, recipient, amountRaw })
  const currentIntent = useRef<string | null>(intentKey)
  currentIntent.current = intentKey
  useEffect(() => {
    reviewAttempt.current.invalidate()
    setPreparing(false)
    setUpdatingFee(false)
    setError(null)
  }, [accountContextKey, asset.asset.id, route])
  useEffect(() => {
    if (review && review.intentKey !== intentKey) {
      reviewAttempt.current.invalidate()
      const pending = pendingReview.current
      pendingReview.current = null
      setReview(null)
      if (pending) void evmWalletClient.rejectTransfer(pending.graph.root.id).catch(() => {})
    }
  }, [intentKey, review])
  const maximum = useTransferMaximum({
    enabled:
      route !== 'pending' &&
      asset.asset.kind === 'native' &&
      validRecipient &&
      Boolean(sourceAddress) &&
      BigInt(availableRaw) > 0n,
    requestKey: `${accountContextKey}:${asset.asset.id}:${recipient}:${availableRaw}:${JSON.stringify(feeSelection)}:${route}`,
    fallback:
      route === 'confidential'
        ? undefined
        : () =>
            fallbackTransferMaximum(
              createNativeTransferSource({
                asset,
                chain,
                availableRaw,
                sender: sourceAddress ?? ''
              })
            ),
    estimate: () =>
      route === 'confidential'
        ? estimateConfidentialTransferMaximum({
            asset,
            chain,
            availableRaw,
            sender: sourceAddress ?? '',
            recipient,
            executionMode: 'private'
          })
        : estimateNativeTransferMaximum({
            source: createNativeTransferSource({
              asset,
              chain,
              availableRaw,
              sender: sourceAddress ?? ''
            }),
            recipient,
            feeSelection,
            executionMode: sourceMode
          })
  })
  const transferAvailability = resolvePortfolioTransferAvailability({
    balanceRaw: availableRaw,
    decimals: asset.metadata.decimals,
    isNative: asset.asset.kind === 'native',
    maximumRaw: maximum.value?.amountRaw ?? null
  })
  const spendableRaw = transferAvailability.amountRaw
  const validAmount = isTransferAmountSpendable(amountRaw, spendableRaw)
  useEffect(() => {
    if (maxSelected && maximum.value)
      setAmount(formatBaseUnitDecimalAmount(maximum.value.amountRaw, asset.metadata.decimals))
  }, [maxSelected, maximum.value, asset.metadata.decimals])

  const rejectPrepared = async (value: EvmTransferReview) => {
    if (pendingReview.current?.graph.root.id === value.graph.root.id) pendingReview.current = null
    await evmWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
  }

  const invalidateMaximum = () => {
    setMaxSelected(false)
  }

  const handleSelectRecipient = async () => {
    await openModal<string | undefined>({
      title: 'Select Recipient',
      showCloseButton: true,
      body: resolve => (
        <RecipientSelector
          chainId={chain.chain.id}
          excludeAddresses={sourceAddress ? [sourceAddress] : []}
          onSelect={address => {
            invalidateMaximum()
            if (maxSelected) setAmount('')
            setRecipient(address)
            resolve(address)
          }}
        />
      )
    })
  }

  const handleMaximum = () => {
    if (!validRecipient || route === 'pending' || !sourceAddress) return
    setError(null)
    setMaxSelected(true)
    void maximum.request()
  }

  const estimateFee = useCallback(async () => {
    if (route !== 'onchain' || !amountRaw || !validAmount || !validRecipient) {
      throw new Error('Incomplete EVM transfer')
    }
    let value: EvmTransferReview | null = null
    try {
      value = await evmWalletClient.prepareTransfer(
        { assetId: asset.asset.id, recipient, amountRaw },
        { feeSelection, executionMode: sourceMode }
      )
      const feeLimit = value.graph.root.intent?.feeLimit
      if (!feeLimit || !/^(?:0|[1-9][0-9]*)$/.test(feeLimit.amountRaw)) {
        throw new Error('Invalid EVM fee estimate')
      }
      return feeLimit.amountRaw
    } finally {
      if (value) await evmWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
    }
  }, [
    amountRaw,
    asset.asset.id,
    feeSelection,
    recipient,
    sourceMode,
    route,
    validAmount,
    validRecipient
  ])
  const feePreview = useTransferFeePreview({
    enabled:
      route === 'onchain' &&
      Boolean(sourceAddress) &&
      validAmount &&
      validRecipient &&
      tokenFeeBalanceError === null &&
      !preparing &&
      !maximum.loading &&
      review === null,
    requestKey: `${intentKey}:${JSON.stringify(feeSelection)}`,
    estimate: estimateFee
  })
  const previewFee = feePreview.amountRaw
    ? formatBaseUnitAmount(feePreview.amountRaw, nativeDecimals)
    : '—'
  const maximumError =
    route === 'confidential' && maximum.error ? getRheaSwapErrorMessage(maximum.error) : null
  const displayedError = error ?? tokenFeeBalanceError ?? maximumError

  const handleFormFeeSelectionChange = async (nextFeeSelection: EvmFeeSelection) => {
    if (areEvmFeeSelectionsEqual(nextFeeSelection, feeSelection)) return
    setFeeSelection(nextFeeSelection)
    if (asset.asset.kind === 'native' && maxSelected) {
      setAmount('')
      setMaxSelected(false)
    }
  }

  const handleContinue = async () => {
    if (
      route === 'pending' ||
      !sourceAddress ||
      !amountRaw ||
      !validAmount ||
      !validRecipient ||
      preparing
    )
      return
    if (tokenFeeBalanceError) {
      setError(tokenFeeBalanceError)
      return
    }
    if (route === 'confidential') {
      navigate(
        buildPrivateEvmTransferPath({
          assetId: asset.asset.id,
          recipient,
          amount,
          maximum: maxSelected
        })
      )
      return
    }
    setPreparing(true)
    setError(null)
    const attempt = reviewAttempt.current.begin()
    try {
      const value = await evmWalletClient.prepareTransfer(
        {
          assetId: asset.asset.id,
          recipient,
          amountRaw
        },
        { feeSelection, executionMode: sourceMode }
      )
      if (!reviewAttempt.current.isCurrent(attempt) || currentIntent.current !== intentKey) {
        await rejectPrepared(value)
        return
      }
      const summary = value.review.summary
      if (
        summary.schema !== 'evm.transaction.v1' ||
        summary.fields.from.toLowerCase() !== sourceAddress.toLowerCase()
      ) {
        await rejectPrepared(value)
        setError('The wallet returned an invalid EVM review.')
        return
      }
      const feeRaw = summary.fields.maximumFeeWei
      const balanceError = getEvmTransferBalanceError({
        assetKind: asset.asset.kind,
        transferAmountRaw: amountRaw,
        maximumFeeRaw: feeRaw,
        assetAvailableRaw: availableRaw,
        nativeAvailableRaw,
        nativeSymbol
      })
      if (balanceError) {
        await rejectPrepared(value)
        setError(balanceError)
        return
      }
      pendingReview.current = value
      setReview({
        intentKey,
        sourceMode,
        sourceAddress,
        privacyWarning: getEvmSendPrivacyWarning(sourceMode, recipientRole),
        amount,
        amountRaw,
        recipient,
        feeSelection,
        value
      })
    } catch (prepareError) {
      if (reviewAttempt.current.isCurrent(attempt) && currentIntent.current === intentKey)
        setError(getEvmSendPrepareError(prepareError, sourceMode))
    } finally {
      if (reviewAttempt.current.isCurrent(attempt)) setPreparing(false)
    }
  }

  const handleCloseReview = async () => {
    reviewAttempt.current.invalidate()
    setUpdatingFee(false)
    const current = review
    setReview(null)
    if (current) await rejectPrepared(current.value)
  }

  const handleReviewFeeSelectionChange = async (nextFeeSelection: EvmFeeSelection) => {
    const current = review
    if (
      !current ||
      current.intentKey !== currentIntent.current ||
      areEvmFeeSelectionsEqual(nextFeeSelection, current.feeSelection)
    )
      return

    setUpdatingFee(true)
    setError(null)
    const attempt = reviewAttempt.current.begin()
    let probe: EvmTransferReview | null = null
    let replacement: EvmTransferReview | null = null
    try {
      let nextAmountRaw = current.amountRaw
      if (asset.asset.kind === 'native' && maxSelected) {
        const availableAmountRaw = BigInt(availableRaw)
        const probeAmountRaw =
          availableAmountRaw / 2n > 0n ? availableAmountRaw / 2n : availableAmountRaw
        probe = await evmWalletClient.prepareTransfer(
          {
            assetId: asset.asset.id,
            recipient: current.recipient,
            amountRaw: probeAmountRaw.toString()
          },
          { feeSelection: nextFeeSelection, executionMode: current.sourceMode }
        )
        if (probe.review.summary.schema !== 'evm.transaction.v1') {
          throw new Error('The wallet returned an invalid EVM review.')
        }
        nextAmountRaw = resolveEvmNativeMaximumAmount(
          availableRaw,
          probe.review.summary.fields.maximumFeeWei
        )
      }

      replacement = await evmWalletClient.prepareTransfer(
        { assetId: asset.asset.id, recipient: current.recipient, amountRaw: nextAmountRaw },
        { feeSelection: nextFeeSelection, executionMode: current.sourceMode }
      )
      const nextSummary = replacement.review.summary
      if (
        nextSummary.schema !== 'evm.transaction.v1' ||
        nextSummary.fields.from.toLowerCase() !== current.sourceAddress.toLowerCase()
      ) {
        throw new Error('The wallet returned an invalid EVM review.')
      }
      const balanceError = getEvmTransferBalanceError({
        assetKind: asset.asset.kind,
        transferAmountRaw: nextAmountRaw,
        maximumFeeRaw: nextSummary.fields.maximumFeeWei,
        assetAvailableRaw: availableRaw,
        nativeAvailableRaw,
        nativeSymbol
      })
      if (balanceError) throw new Error(balanceError)

      if (probe) {
        await evmWalletClient.rejectTransfer(probe.graph.root.id).catch(() => {})
        probe = null
      }
      await rejectPrepared(current.value)
      if (
        !reviewAttempt.current.isCurrent(attempt) ||
        currentIntent.current !== current.intentKey
      ) {
        await rejectPrepared(replacement)
        replacement = null
        return
      }
      pendingReview.current = replacement
      const nextAmount = formatBaseUnitDecimalAmount(nextAmountRaw, asset.metadata.decimals)
      setAmount(nextAmount)
      setFeeSelection(nextFeeSelection)
      setReview({
        ...current,
        intentKey: createEvmSendIntentKey({
          ...reviewContext,
          recipient: current.recipient,
          amountRaw: nextAmountRaw
        }),
        amount: nextAmount,
        amountRaw: nextAmountRaw,
        recipient: current.recipient,
        feeSelection: nextFeeSelection,
        value: replacement
      })
      replacement = null
    } catch (cause) {
      if (probe) await evmWalletClient.rejectTransfer(probe.graph.root.id).catch(() => {})
      if (replacement) {
        await evmWalletClient.rejectTransfer(replacement.graph.root.id).catch(() => {})
      }
      const message =
        cause instanceof Error ? cause.message : getEvmSendPrepareError(cause, sourceMode)
      if (reviewAttempt.current.isCurrent(attempt) && currentIntent.current === current.intentKey) {
        setError(message)
        throw new Error(message)
      }
    } finally {
      if (reviewAttempt.current.isCurrent(attempt)) setUpdatingFee(false)
    }
  }

  const handleApprove = async () => {
    if (!review || review.intentKey !== currentIntent.current || updatingFee || approving) return
    setApproving(true)
    setError(null)
    recordSendSubmission(review.value.graph, selection.asset.metadata.symbol, review.sourceMode)
    try {
      const submission = await evmWalletClient.approveTransfer(
        review.value.graph.root.id,
        review.value.review.payloadFingerprint.digestHex
      )
      pendingReview.current = null
      setReview(null)
      if (submission.status === 'external-signature-required') {
        try {
          await openHardwareEvmSignTab(submission.transactionId)
        } catch (handoffError) {
          await evmWalletClient.rejectTransfer(submission.transactionId).catch(() => {})
          throw handoffError
        }
        window.close()
        return
      }
      recordSendResult(submission.graph, selection.asset.metadata.symbol, review.sourceMode)
      onSubmitted(submission)
    } catch (approveError) {
      recordSendApprovalFailure(
        review.value.graph,
        selection.asset.metadata.symbol,
        review.sourceMode
      )
      setError(getEvmSendPrepareError(approveError, review.sourceMode))
    } finally {
      setApproving(false)
    }
  }

  const summary = review?.value.review.summary
  const feeRaw = summary?.schema === 'evm.transaction.v1' ? summary.fields.maximumFeeWei : '0'
  const fee = formatBaseUnitAmount(feeRaw, nativeDecimals)
  const maximumTotal =
    review && asset.asset.kind === 'native'
      ? formatBaseUnitAmount((BigInt(review.amountRaw) + BigInt(feeRaw)).toString(), nativeDecimals)
      : null

  return (
    <>
      <div className="page-content space-y-4">
        <SendAssetHeader
          assetId={asset.asset.id}
          symbol={asset.metadata.symbol}
          icon={asset.metadata.iconUrl}
          networkName={`To ${chain.chain.displayName}`}
          blockchain={
            asset.asset.kind === 'token'
              ? resolveChainIconAlias(chain.chain.family, chain.chain.displayName)
              : undefined
          }
        />

        <div className="flex min-w-0 items-center gap-2 px-1 text-sm">
          <span className="shrink-0 text-muted">From</span>
          <AccountAddressSelectorButton
            mode={sourceMode}
            address={sourceAddress}
            ariaLabel={`Choose source account, current ${sourceMode}`}
            onClick={() => onSourceSelectorOpenChange(true)}
          />
        </div>

        <div>
          <SendRecipientInputCard
            id="evm-send-recipient"
            value={recipient}
            onChange={value => {
              invalidateMaximum()
              if (maxSelected) setAmount('')
              setRecipient(value.trim())
            }}
            placeholder="0x address"
            autoFocus
            onSelectRecipient={() => void handleSelectRecipient()}
          />
          {recipient && !validRecipient && (
            <p className="mt-2 px-1 text-xs text-danger">Enter a valid non-zero EVM address.</p>
          )}
        </div>

        <SendAmountInputCard
          ariaLabel={`${asset.metadata.symbol} amount`}
          value={amount}
          onChange={value => {
            if (/^\d*\.?\d*$/.test(value)) {
              invalidateMaximum()
              setAmount(value)
            }
          }}
          available={transferAvailability.display}
          availableLabel={transferAvailability.label}
          symbol={asset.metadata.symbol}
          priceUsd={priceUsd}
          maxSelected={maxSelected}
          maxDisabled={
            route === 'pending' ||
            !sourceAddress ||
            (asset.asset.kind === 'native' && (!validRecipient || BigInt(availableRaw) <= 0n))
          }
          maxLoading={maximum.loading}
          onMax={
            asset.asset.kind === 'token'
              ? () => setAmount(transferAvailability.display)
              : () => void handleMaximum()
          }
        />

        {route === 'onchain' && (
          <SendNetworkFeeCard label="Network fee" loading={feePreview.loading}>
            <NetworkFeeTierPicker
              chainFamily="evm"
              tier={feeSelection.kind === 'tier' ? feeSelection.tier : 'standard'}
              selection={feeSelection}
              amount={previewFee}
              symbol={nativeSymbol}
              onTierChange={tier => handleFormFeeSelectionChange({ kind: 'tier', tier })}
              onSelectionChange={handleFormFeeSelectionChange}
            />
          </SendNetworkFeeCard>
        )}

        {amountRaw !== null && BigInt(amountRaw) > BigInt(availableRaw) && (
          <p role="alert" className="mt-3 text-xs text-danger">
            Insufficient {asset.metadata.symbol} balance.
          </p>
        )}
        {displayedError && (
          <InlineError
            message={displayedError}
            onRetry={maximumError ? handleMaximum : undefined}
            className="mt-3 px-1"
          />
        )}
        {route === 'pending' &&
          (support.loading ? (
            <p role="status" className="px-1 text-xs text-muted">
              Checking Confidential availability…
            </p>
          ) : (
            <InlineError
              message="Unable to check Confidential availability."
              onRetry={support.retry}
              className="px-1"
            />
          ))}
      </div>

      <div className="page-footer">
        <Button
          className="h-[45px] w-full"
          disabled={
            !validAmount ||
            !validRecipient ||
            !sourceAddress ||
            route === 'pending' ||
            tokenFeeBalanceError !== null ||
            (route === 'onchain' && feePreview.loading)
          }
          isLoading={preparing || (route === 'onchain' && feePreview.loading)}
          onClick={handleContinue}
        >
          Continue
        </Button>
      </div>

      <Dialog
        open={review !== null}
        onOpenChange={open => {
          if (!open && !approving) void handleCloseReview()
        }}
      >
        <DialogContent
          position="bottom"
          className="flex max-h-[calc(100dvh-12px)] flex-col gap-0 overflow-hidden p-0"
          showCloseButton={!approving}
          aria-labelledby="evm-send-review-title"
        >
          <DialogTitle className="sr-only" aria-hidden="true">
            Review Send
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review the asset, recipient, and maximum network fee before sending.
          </DialogDescription>

          {review && summary?.schema === 'evm.transaction.v1' && (
            <TransactionReviewView
              title="Review Send"
              titleId="evm-send-review-title"
              asset={{
                assetId: asset.asset.id,
                symbol: asset.metadata.symbol,
                icon: asset.metadata.iconUrl
              }}
              amount={review.amount}
              network={evmSendNetworkLabel(chain)}
              notice={
                review.privacyWarning || (summary.review.level === 'caution' && !bundledAsset) ? (
                  <div className="mb-3 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning/10 px-3 py-2.5 text-xs leading-5 text-warning">
                    <Icon
                      icon="lucide:triangle-alert"
                      width={15}
                      height={15}
                      className="mt-0.5 shrink-0"
                    />
                    <span>
                      {review.privacyWarning}
                      {summary.review.level === 'caution' && !bundledAsset && (
                        <>
                          {review.privacyWarning ? ' ' : ''}This transfer calls a custom Token
                          contract you added. Verify the network, Token, and recipient.
                        </>
                      )}
                    </span>
                  </div>
                ) : undefined
              }
              rows={[
                {
                  label: 'Send To',
                  content: (
                    <span className="font-mono text-muted" title={review.recipient}>
                      {formatSortAddress(review.recipient)}
                    </span>
                  )
                },
                { label: 'Network', content: evmSendNetworkLabel(chain) },
                {
                  label: 'From',
                  content: (
                    <span className="inline-flex min-w-0 max-w-full items-center justify-end gap-1.5">
                      <span className="truncate font-mono text-muted" title={summary.fields.from}>
                        {formatSortAddress(summary.fields.from)}
                      </span>
                      <ExecutionAccountBadge mode={review.sourceMode} />
                    </span>
                  )
                },
                { label: 'Send method', content: 'On-chain transfer' },
                {
                  label: 'Network fee',
                  content: (
                    <NetworkFeeTierPicker
                      chainFamily="evm"
                      tier={
                        review.feeSelection.kind === 'tier' ? review.feeSelection.tier : 'standard'
                      }
                      selection={review.feeSelection}
                      amount={fee}
                      symbol={nativeSymbol}
                      onTierChange={tier => handleReviewFeeSelectionChange({ kind: 'tier', tier })}
                      onSelectionChange={handleReviewFeeSelectionChange}
                      disabled={updatingFee || approving}
                    />
                  )
                },
                {
                  label: 'Max fee per gas',
                  content: (
                    <span className="font-mono">
                      <AmountDisplay
                        value={formatEvmWeiAsGwei(summary.fields.maxFeePerGasWei ?? '0')}
                        symbol="GWEI"
                        profile="fee"
                      />
                    </span>
                  )
                },
                {
                  label: 'Priority fee per gas',
                  content: (
                    <span className="font-mono">
                      <AmountDisplay
                        value={formatEvmWeiAsGwei(summary.fields.maxPriorityFeePerGasWei ?? '0')}
                        symbol="GWEI"
                        profile="fee"
                      />
                    </span>
                  )
                },
                ...(maximumTotal
                  ? [
                      {
                        label: 'Maximum total',
                        content: <AmountDisplay value={maximumTotal} symbol={nativeSymbol} />
                      }
                    ]
                  : []),
                {
                  label: 'Transaction type',
                  content: asset.asset.kind === 'native' ? 'Native transfer' : 'Token transfer'
                }
              ]}
              confirmLabel={review.privacyWarning ? 'Send anyway' : 'Send'}
              confirming={approving}
              preparing={updatingFee}
              confirmDisabled={review.intentKey !== intentKey}
              error={error ? <InlineError message={error} className="mt-3" /> : undefined}
              cancelDisabled={approving}
              onCancel={() => void handleCloseReview()}
              onConfirm={handleApprove}
            />
          )}
        </DialogContent>
      </Dialog>

      <ExecutionAccountSelectorDialog
        open={sourceSelectorOpen}
        onOpenChange={onSourceSelectorOpenChange}
        value={sourceMode}
        onSelect={mode => {
          if (mode === sourceMode) return
          invalidateMaximum()
          onSourceModeChange(mode)
          setAmount('')
          setError(null)
        }}
        privateAvailable={privateSourceAvailable}
        mainAddress={mainSourceAddress}
        privateAddress={privateSourceAddress}
        mainBalance={mainSourceBalance}
        privateBalance={privateSourceBalance}
        privateUnavailableBalance={privateUnavailableBalance}
        symbol={asset.metadata.symbol}
        onFundPrivate={onFundPrivate ? () => setFundingDialogOpen(true) : undefined}
      />
      {onFundPrivate && (
        <PrivateBalanceTransferDialog
          open={fundingDialogOpen}
          onOpenChange={setFundingDialogOpen}
          defaultDirection="main-to-private"
          lockDirection
          assetId={asset.asset.id}
          symbol={asset.metadata.symbol}
          icon={asset.metadata.iconUrl}
          blockchain={resolveChainIconAlias(chain.chain.family, chain.chain.displayName)}
          decimals={asset.metadata.decimals}
          priceUsd={priceUsd}
          mainBalanceRaw={resolveAccountAvailableRaw(asset.balance, 'main')}
          privateBalanceRaw={resolveAccountAvailableRaw(asset.balance, 'private')}
          unavailableReason={privateSourceAvailable ? null : 'Confidential transfer is unavailable'}
          asset={asset}
          chain={chain}
          mainAddress={mainSourceAddress ?? ''}
          privateAddress={privateSourceAddress ?? ''}
          onContinue={(_direction, transferAmount, maximum) => {
            setFundingDialogOpen(false)
            onFundPrivate(transferAmount, maximum)
          }}
        />
      )}
    </>
  )
}
