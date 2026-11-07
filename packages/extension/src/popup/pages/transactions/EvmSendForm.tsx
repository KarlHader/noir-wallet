import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { InlineError } from '@/popup/components/common/InlineError'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { Button } from '@/popup/components/ui/button'
import { Switch } from '@/popup/components/ui/switch'
import nearLogo from '@/images/figma-near-confidential.svg'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import {
  EvmWalletClientError,
  evmWalletClient,
  type EvmTransferReview,
  type EvmTransferSubmission
} from '@/popup/services/evm-wallet-client'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  formatTokenQuantity,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import { openHardwareEvmSignTab } from '@/lib/hardware-tab'
import { openModal } from '@/popup/provider/ModalManager'
import { useNavigate } from '@/popup/provider/Router'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import {
  SendAmountInputCard,
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
  buildPublicPrivateEvmSendPath,
  resolveEvmNativeMaximumAmount,
  type EvmSendSourceMode
} from './evm-send-validation'
import {
  resolveEvmAccountAvailability,
  resolvePortfolioTransferAvailability
} from '@/popup/services/transfer-availability'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import {
  ExecutionAccountBadge,
  ExecutionAccountSelectorDialog
} from '@/popup/components/account/ExecutionAccountSelector'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'
import { useEvmSendSupport } from '@/popup/hooks/useEvmSendSupport'
import { resolveEvmAddressRole } from '@/core/accounts/evm-address-role'
import {
  createEvmSendIntentKey,
  getEvmSendRecipientError,
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
  walletMode,
  onSelectAsset,
  selection,
  portfolio,
  priceUsd,
  sourceMode,
  sourceSelectorOpen,
  onSourceModeChange,
  onSourceSelectorOpenChange,
  onFundPrivate,
  initialRecipient,
  initialDraft,
  onSubmitted
}: {
  walletMode: 'public' | 'private'
  onSelectAsset: () => void
  selection: EvmSendAsset
  portfolio: PortfolioReadModel
  priceUsd: string | null
  sourceMode: EvmSendSourceMode
  sourceSelectorOpen: boolean
  onSourceModeChange: (mode: EvmSendSourceMode) => void
  onSourceSelectorOpenChange: (open: boolean) => void
  onFundPrivate?: () => void
  initialRecipient?: string
  initialDraft?: Readonly<{
    recipient: string
    amount: string
    maximum: boolean
    sendPrivately: true
  }>
  onSubmitted: (submission: EvmTransferSubmission) => void
}) {
  const [amount, setAmount] = useState('')
  const [privacyProviderOpen, setPrivacyProviderOpen] = useState(false)
  const [privateSendScope, setPrivateSendScope] = useState<string | null>(null)
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
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
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
  const accountDisplayName =
    activeAccount && walletId && accountId
      ? getAccountDisplayName(
          walletId,
          accountId,
          activeAccount.accountDisplayName,
          accountDisplayNames
        )
      : 'Account'
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
    privateDisplay: privateSourceBalance
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
  const privacyScope = `${accountContextKey}:${asset.asset.id}`
  const sendPrivately = sourceMode === 'main' && privateSendScope === privacyScope
  const route = resolveEvmSendRoute(sourceMode, support.support, sendPrivately)
  const recipientRole = resolveEvmAddressRole(
    recipient,
    chain.chain.id,
    activeAccount ? catalog?.accounts : []
  )
  const restoredDraft = useRef<string | null>(null)
  useEffect(() => {
    if (!initialDraft || sourceMode !== 'main') return
    const key = JSON.stringify([privacyScope, initialDraft])
    if (restoredDraft.current === key) return
    restoredDraft.current = key
    setAmount(initialDraft.amount)
    setRecipient(initialDraft.recipient)
    setMaxSelected(initialDraft.maximum)
    setPrivateSendScope(privacyScope)
  }, [initialDraft, privacyScope, sourceMode])

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
  const recipientPolicyError = getEvmSendRecipientError(sourceMode, recipientRole, sendPrivately)
  const validRecipient =
    /^0x[0-9a-fA-F]{40}$/.test(recipient) && !/^0x0{40}$/i.test(recipient) && !recipientPolicyError
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
            executionMode: sourceMode
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
  const maximumPending =
    maxSelected && asset.asset.kind === 'native' && (maximum.loading || !maximum.value)
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

  const changeSourceMode = (mode: EvmSendSourceMode) => {
    if (mode === sourceMode || (mode === 'private' && !privateSourceAvailable)) return
    invalidateMaximum()
    onSourceModeChange(mode)
    setAmount('')
    setError(null)
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
    setAmount('')
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
      maximumPending ||
      preparing
    )
      return
    if (tokenFeeBalanceError) {
      setError(tokenFeeBalanceError)
      return
    }
    if (route === 'confidential') {
      if (sendPrivately) {
        if (!walletId || !accountId) return
        navigate(
          buildPublicPrivateEvmSendPath({
            assetId: asset.asset.id,
            recipient,
            amount,
            maximum: maxSelected,
            walletId,
            accountId,
            network: networkMode
          })
        )
        return
      }
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
    if (Date.now() >= review.value.review.expiresAt) {
      pendingReview.current = null
      setReview(null)
      setError('The review expired. Prepare the transfer again.')
      return
    }
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
      if (
        approveError instanceof EvmWalletClientError &&
        (approveError.code === 'expired' || approveError.code === 'review-unavailable')
      ) {
        pendingReview.current = null
        setReview(null)
      }
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
      <div className="page-content min-h-0 space-y-3 !px-4 pt-4">
        <div className="!mb-[5px] pb-2 pt-1 text-center">
          <button
            type="button"
            onClick={onSelectAsset}
            aria-label="Select send asset"
            className="mt-2 inline-flex h-9 max-w-full items-center gap-2 rounded-full bg-wallet-surface px-2 text-base font-medium leading-[21px]"
          >
            <TokenIcon
              assetId={asset.asset.id}
              symbol={asset.metadata.symbol}
              icon={asset.metadata.iconUrl}
              blockchain={
                asset.asset.kind === 'token'
                  ? resolveChainIconAlias(chain.chain.family, chain.chain.displayName)
                  : undefined
              }
              size={26}
            />
            <span className="max-w-32 truncate">{asset.metadata.symbol}</span>
            <Icon icon="lucide:chevron-down" width={14} height={14} />
          </button>
          <p className="mt-1 text-xs text-muted">{chain.chain.displayName}</p>
        </div>

        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium leading-[18px] text-muted">Send from</p>
          </div>
          <div className="flex min-h-[72px] items-start gap-2 rounded-[10px] border border-white/10 bg-wallet-surface px-[11px] pb-2 pt-[14px]">
            <button
              type="button"
              onClick={() => onSourceSelectorOpenChange(true)}
              aria-label={`Choose source account, current ${sourceMode}`}
              aria-haspopup="dialog"
              className="min-w-0 flex-1 text-left"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium leading-[18px]">
                <span className="truncate">{accountDisplayName}</span>
                <span
                  className={
                    sourceMode === 'private'
                      ? 'shrink-0 rounded bg-warning/10 px-1.5 py-px text-[11px] leading-4 text-warning'
                      : 'shrink-0 rounded bg-white/10 px-1.5 py-px text-[11px] leading-4 text-muted'
                  }
                >
                  {sourceMode === 'private' ? 'Private' : 'Public'}
                </span>
                <Icon icon="lucide:chevron-down" width={14} height={14} className="shrink-0" />
              </span>
              <span
                className="mt-[11px] block truncate text-xs font-medium leading-4 text-muted"
                title={sourceAddress}
              >
                {formatSortAddress(sourceAddress)}
              </span>
            </button>
            <div className="flex max-w-[38%] min-w-0 flex-col items-end gap-2">
              <span
                className="max-w-full truncate text-right text-sm font-medium leading-[18px]"
                title={transferAvailability.display}
              >
                {formatTokenQuantity(transferAvailability.display)}
              </span>
            </div>
          </div>
        </div>

        <div className="!mt-[18px]">
          <SendRecipientInputCard
            id="evm-send-recipient"
            value={recipient}
            onChange={value => {
              invalidateMaximum()
              if (maxSelected) setAmount('')
              setRecipient(value.trim())
            }}
            placeholder="0x address"
            variant="filled"
            onSelectRecipient={() => void handleSelectRecipient()}
          />
          {recipient && !validRecipient && (
            <p className="mt-2 px-1 text-xs text-danger">
              {recipientPolicyError ?? 'Enter a valid non-zero EVM address.'}
            </p>
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
          onMax={
            asset.asset.kind === 'token'
              ? () => {
                  setError(null)
                  setMaxSelected(true)
                  setAmount(transferAvailability.display)
                }
              : handleMaximum
          }
          maxDisabledReason={
            route === 'pending'
              ? 'Checking transfer route…'
              : !sourceAddress
                ? 'Source account unavailable'
                : BigInt(availableRaw) <= 0n
                  ? 'No available balance'
                  : asset.asset.kind === 'native' && !validRecipient
                    ? 'Enter a valid recipient to calculate Max'
                    : undefined
          }
          maxLoading={maximum.loading}
        />

        {route === 'onchain' && (
          <div className="flex min-h-6 items-center justify-between gap-2 text-xs">
            <span className="text-muted">Fee</span>
            <NetworkFeeTierPicker
              chainFamily="evm"
              tier={feeSelection.kind === 'tier' ? feeSelection.tier : 'standard'}
              selection={feeSelection}
              amount={previewFee}
              symbol={nativeSymbol}
              onTierChange={tier => handleFormFeeSelectionChange({ kind: 'tier', tier })}
              onSelectionChange={handleFormFeeSelectionChange}
            />
          </div>
        )}
        <div className="flex min-h-6 items-center justify-between text-xs">
          <span className="text-muted">Est. time</span>
          <span>—</span>
        </div>

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
              message={
                support.support === 'unsupported'
                  ? 'Confidential transfers are unavailable for this asset.'
                  : 'Unable to check Confidential availability.'
              }
              onRetry={support.retry}
              className="px-1"
            />
          ))}
      </div>

      <div className="page-footer">
        <button
          type="button"
          role="switch"
          aria-label="Send privately"
          aria-checked={sendPrivately}
          onClick={() => (sendPrivately ? setPrivateSendScope(null) : setPrivacyProviderOpen(true))}
          className={`mb-4 flex w-full items-center justify-center gap-1.5 text-sm ${sendPrivately ? 'text-primary' : 'text-muted'}`}
        >
          <Icon icon="lucide:shield-check" width={15} height={15} className="text-primary" />
          Send privately
          <Switch checked={sendPrivately} size="sm" />
        </button>
        <Button
          size="wallet"
          className="h-[45px] w-full"
          disabled={
            !validAmount ||
            !validRecipient ||
            maximumPending ||
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
          data-wallet-mode={walletMode}
          className="flex h-dvh max-h-dvh flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-none"
          showCloseButton={false}
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
              title="Sending"
              titleId="evm-send-review-title"
              variant="figma"
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
                  label: 'From',
                  content: (
                    <span className="inline-flex min-w-0 max-w-full items-center justify-end gap-1.5">
                      <span className="min-w-0 text-right">
                        <span className="block truncate">{accountDisplayName}</span>
                        <span
                          className="block truncate font-mono text-xs text-muted"
                          title={summary.fields.from}
                        >
                          {formatSortAddress(summary.fields.from)}
                        </span>
                      </span>
                      <ExecutionAccountBadge mode={review.sourceMode} />
                    </span>
                  )
                },
                {
                  label: 'To',
                  content: (
                    <span className="font-mono text-muted" title={review.recipient}>
                      {formatSortAddress(review.recipient)}
                    </span>
                  )
                },
                { label: 'Network', content: evmSendNetworkLabel(chain) },
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
                    <span className="font-sans tabular-nums">
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
                    <span className="font-sans tabular-nums">
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

      <Dialog open={privacyProviderOpen} onOpenChange={setPrivacyProviderOpen}>
        <DialogContent
          position="bottom"
          aria-label="Choose Shield provider"
          showCloseButton={false}
          className="gap-0 rounded-t-2xl border-0 bg-wallet-surface p-0"
        >
          <DialogTitle className="sr-only">Choose Shield provider</DialogTitle>
          <DialogDescription className="sr-only">
            Available Shield providers for this asset.
          </DialogDescription>
          <div className="relative flex h-11 items-center justify-end px-4">
            <button
              type="button"
              aria-label="Close"
              onClick={() => setPrivacyProviderOpen(false)}
              className="flex size-8 items-center justify-center"
            >
              <Icon icon="lucide:x" width={18} height={18} />
            </button>
          </div>
          <div className="flex flex-col items-center pb-5 pt-1">
            <TokenIcon
              assetId={asset.asset.id}
              symbol={asset.metadata.symbol}
              icon={asset.metadata.iconUrl}
              size={40}
            />
            <span className="mt-1 text-base font-medium">{asset.metadata.symbol}</span>
          </div>
          <div className="px-4 pb-8">
            <button
              type="button"
              disabled={sourceMode !== 'main' || support.support !== 'supported'}
              aria-label="Use NEAR Confidential Intents"
              onClick={() => {
                setPrivateSendScope(privacyScope)
                setPrivacyProviderOpen(false)
                setError(null)
              }}
              className="flex min-h-[60px] w-full items-center gap-3 rounded-lg border border-white/10 bg-wallet-selected px-3 text-left text-sm hover:bg-wallet-surface disabled:opacity-40"
            >
              <img src={nearLogo} alt="" className="size-6 shrink-0 rounded" />
              <span className="min-w-0 flex-1 truncate">NEAR Confidential Intents</span>
              <Icon icon="lucide:chevron-right" width={18} height={18} />
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <ExecutionAccountSelectorDialog
        open={sourceSelectorOpen}
        onOpenChange={onSourceSelectorOpenChange}
        value={sourceMode}
        onSelect={changeSourceMode}
        privateAvailable={privateSourceAvailable}
        mainAddress={mainSourceAddress}
        privateAddress={privateSourceAddress}
        mainBalance={mainSourceBalance}
        privateBalance={privateSourceBalance}
        symbol={asset.metadata.symbol}
        onFundPrivate={onFundPrivate}
      />
    </>
  )
}
