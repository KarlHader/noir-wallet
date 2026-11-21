import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import { getAccountDisplayName } from '@/lib/format'
import { formatSendFiatValue } from '@/popup/services/send-transfer-model'
import {
  EvmWalletClientError,
  evmWalletClient,
  type EvmTransferReview,
  type EvmTransferSubmission
} from '@/popup/services/evm-wallet-client'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { openMultichainHardwareSignTab } from '@/lib/hardware-tab'
import { openModal } from '@/popup/provider/ModalManager'
import { useNavigate } from '@/popup/provider/Router'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import { DEFAULT_NETWORK_FEE_TIER, NETWORK_FEE_TIERS } from '@/core/transactions/domain'
import type { NetworkFeePreviews } from '@/popup/services/network-fee-presentation'
import { areEvmFeeSelectionsEqual, type EvmFeeSelection } from '@/infrastructure/chains/evm'
import { useTransferFeePreview } from '@/popup/hooks/useTransferFeePreview'
import { useEvmConfirmationEstimate } from '@/popup/hooks/useEvmConfirmationEstimate'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import {
  createNativeTransferSource,
  estimateNativeTransferMaximum,
  resolveNativeRouteMaximum,
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
} from '@/popup/services/evm-send-validation'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'
import { useEvmSendSupport } from '@/popup/hooks/useEvmSendSupport'
import { carryQuotePreview } from '@/popup/hooks/useQuoteReview'
import { rheaQuoteTerms } from '@/popup/services/quote-review'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import {
  isCurrentAccountPrivateEvmAddress,
  resolveEvmAddressRole
} from '@/core/accounts/evm-address-role'
import {
  createEvmSendIntentKey,
  getEvmSendRecipientError,
  getEvmSendPrivacyWarning,
  resolveEvmSendAvailableRaw,
  resolveEvmSendRoute
} from '@/popup/services/evm-send-routing'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useSwapPreferences } from '@/store/swap-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { LatestAttempt } from '@/lib/async-utils'
import { getRheaSwapErrorMessage, rheaSwapClient } from '@/popup/services/rhea-swap-client'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import {
  accountNetworksClient,
  type AccountNetworksCatalogView,
  type AccountNetworksView
} from '@/popup/services/account-networks-client'
import { receiveTargetsClient } from '@/popup/services/receive-targets-client'
import { getEnabledSwapChains } from '@/popup/services/swap-catalog-loading'
import { getRheaSwapQuoteDeadline, isRheaSwapQuoteFresh } from '@/popup/services/swap-page-model'
import {
  buildPublicPrivateSendPreviewRequest,
  createPublicPrivateSendPreviewKey,
  getPublicPrivateSendRouteCost,
  resolvePublicPrivateSendQuotePair
} from '@/popup/services/public-private-send-preview'
import type { RheaSwapQuoteView } from '@/core/services/rhea-swap'
import { readEvmSendDestinationSupport } from '@/popup/services/evm-send-catalog'

interface EvmSendAsset {
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

interface PrivateSendPreview {
  readonly key: string
  readonly quote: RheaSwapQuoteView
  readonly routeCost: string | null
  readonly estimatedReceive: string
}

export function useEvmSendTransfer({
  active,
  walletMode,
  onSelectAsset,
  onSelectShield,
  destinationNetworks,
  onOpenDestinationNetworks,
  onSelectDestinationNetwork,
  catalogAccount,
  catalog,
  selection,
  portfolio,
  priceUsd,
  sourceMode,
  onFundPrivate,
  initialRecipient,
  initialAmount,
  initialDraft,
  onSubmitted
}: {
  active: boolean
  walletMode: 'public' | 'private'
  onSelectAsset: (draft: Readonly<{ recipient: string; amount: string }>) => void
  onSelectShield: (recipient: string, amount: string) => void
  destinationNetworks: readonly {
    chainId: string
    name: string
    icon: string
  }[]
  onOpenDestinationNetworks: () => void
  onSelectDestinationNetwork: (
    destinationChainId: string,
    draft: Readonly<{ recipient: string; amount: string }>
  ) => void | Promise<void>
  catalogAccount: AccountNetworksView
  catalog: AccountNetworksCatalogView | null
  selection: EvmSendAsset
  portfolio: PortfolioReadModel
  priceUsd: string | null
  sourceMode: EvmSendSourceMode
  onFundPrivate?: () => void
  initialRecipient?: string
  initialAmount?: string
  initialDraft?: Readonly<{
    recipient: string
    amount: string
    maximum: boolean
    sendPrivately: true
  }>
  onSubmitted: (submission: EvmTransferSubmission) => void
}) {
  const [amount, setAmount] = useState(initialAmount ?? '')
  const [privateSendScope, setPrivateSendScope] = useState<string | null>(null)
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const [recipient, setRecipient] = useState(initialRecipient ?? '')
  const [selectedRecipient, setSelectedRecipient] = useState<{
    address: string
    name: string
  } | null>(null)
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
  const [privatePreview, setPrivatePreview] = useState<PrivateSendPreview | null>(null)
  const [privatePreviewLoading, setPrivatePreviewLoading] = useState(false)
  const [privatePreviewError, setPrivatePreviewError] = useState<string | null>(null)
  const [privatePreviewRetry, setPrivatePreviewRetry] = useState(0)
  const pendingReview = useRef<EvmTransferReview | null>(null)
  const reviewAttempt = useRef(new LatestAttempt())
  const { navigate } = useNavigate()
  const asset = selection.asset
  const chain = selection.chain
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const networkMode = useWalletStore(state => state.currentNetwork)
  const slippage = useSwapPreferences(state => state.slippage)
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
  const shieldSourceAvailable =
    getPrivateTransferChainIds(activeAccount, networkMode === 'mainnet').length > 0
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
  const domainAvailableRaw = resolveEvmSendAvailableRaw(asset.balance, sourceMode)
  const availableRaw = domainAvailableRaw ?? '0'
  const evmNative = portfolio.assets.find(
    candidate =>
      candidate.asset.chainId === asset.asset.chainId && candidate.asset.kind === 'native'
  )
  const nativeSymbol = evmNative?.metadata.symbol ?? 'Native asset'
  const nativeDecimals = evmNative?.metadata.decimals ?? 18
  const domainNativeAvailableRaw = resolveEvmSendAvailableRaw(evmNative?.balance, sourceMode)
  const nativeAvailableRaw = domainNativeAvailableRaw ?? '0'
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
  const support = useEvmSendSupport(chain.chain, asset.asset, accountContextKey, active)
  const destinationNetworkOptions = useMemo(
    () =>
      networkPickerOpen
        ? destinationNetworks.map(option => {
            const availability = readEvmSendDestinationSupport({
              sourceAssetId: asset.asset.id,
              destinationChainId: option.chainId
            })
            return {
              id: option.chainId,
              name: option.name,
              icon: option.icon,
              disabled: availability.status === 'unavailable',
              priority:
                availability.status === 'available' ? 0 : availability.status === 'unknown' ? 1 : 2,
              note: availability.disabledReason
            }
          })
        : [],
    [networkPickerOpen, destinationNetworks, asset.asset.id, support.loading]
  )
  const privacyScope = `${accountContextKey}:${asset.asset.id}`
  const sendPrivately = sourceMode === 'main' && privateSendScope === privacyScope
  const route = resolveEvmSendRoute(sourceMode, support.support, sendPrivately)
  const recipientRole = resolveEvmAddressRole(
    recipient,
    chain.chain.id,
    activeAccount ? catalog?.accounts : []
  )
  const reviewRecipientRole = review
    ? resolveEvmAddressRole(
        review.recipient,
        chain.chain.id,
        activeAccount ? catalog?.accounts : []
      )
    : 'unknown'
  const canMoveRecipient =
    Boolean(onFundPrivate) &&
    isCurrentAccountPrivateEvmAddress(recipient, chain.chain.id, activeAccount)
  const recipientContactName =
    selectedRecipient?.address === recipient ? selectedRecipient.name : undefined
  const restoredDraft = useRef<string | null>(null)
  useEffect(() => {
    if (!initialDraft || sourceMode !== 'main') return
    const key = JSON.stringify([privacyScope, initialDraft])
    if (restoredDraft.current === key) return
    restoredDraft.current = key
    setAmount(initialDraft.amount)
    setRecipient(initialDraft.recipient)
    setSelectedRecipient(null)
    setMaxSelected(initialDraft.maximum)
    setPrivateSendScope(privacyScope)
  }, [initialDraft, privacyScope, sourceMode])

  useEffect(() => {
    if (initialRecipient && /^0x[0-9a-fA-F]{40}$/.test(initialRecipient)) {
      setRecipient(initialRecipient)
      setSelectedRecipient(null)
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
  const recipientPolicyError = getEvmSendRecipientError(
    sourceMode,
    recipientRole,
    sendPrivately,
    canMoveRecipient
  )
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
  currentIntent.current = active ? intentKey : null
  useEffect(() => {
    if (active) return
    reviewAttempt.current.invalidate()
    setPreparing(false)
    setUpdatingFee(false)
    setReview(null)
    lastMaximumRequestKey.current = null
    const pending = pendingReview.current
    pendingReview.current = null
    if (pending) void evmWalletClient.rejectTransfer(pending.graph.root.id).catch(() => {})
  }, [active])
  const handleMoveRecipient = async (targetAddress = recipient) => {
    if (
      !onFundPrivate ||
      !isCurrentAccountPrivateEvmAddress(targetAddress, chain.chain.id, activeAccount) ||
      currentIntent.current !== intentKey
    )
      return
    try {
      const latestCatalog = await accountNetworksClient.getCatalog()
      if (!latestCatalog) throw new Error('Account directory unavailable')
      const current = useWalletStore.getState()
      const latestIdentity = resolveEffectiveActiveAccountIdentity({
        currentWalletId: current.currentWalletId,
        currentAccountId: current.currentAccountId,
        nativeAccount: latestCatalog.accounts.find(account => account.active) ?? null
      })
      const latestAccount = latestCatalog.accounts.find(
        account =>
          account.walletId === latestIdentity?.walletId &&
          account.accountId === latestIdentity.accountId
      )
      if (
        currentIntent.current !== intentKey ||
        current.currentNetwork !== networkMode ||
        latestIdentity?.walletId !== walletId ||
        latestIdentity.accountId !== accountId ||
        !latestAccount?.active ||
        !isCurrentAccountPrivateEvmAddress(targetAddress, chain.chain.id, latestAccount)
      ) {
        return
      }
      onFundPrivate?.()
    } catch {
      if (currentIntent.current === intentKey) setError('Unable to verify the current account.')
    }
  }
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
  const confidentialMaximumRaw =
    route === 'confidential' && asset.asset.kind === 'native'
      ? resolveNativeRouteMaximum({
          family: 'evm',
          chainId: chain.chain.id,
          availableRaw,
          decimals: asset.metadata.decimals,
          priceUsd
        })
      : null
  const maximumRequestKey = `${accountContextKey}:${asset.asset.id}:${recipient}:${availableRaw}:${JSON.stringify(feeSelection)}:${route}`
  const maximum = useTransferMaximum({
    prefetch: true,
    refreshOnExpiry: false,
    enabled:
      active &&
      route === 'onchain' &&
      asset.asset.kind === 'native' &&
      validRecipient &&
      Boolean(sourceAddress) &&
      BigInt(availableRaw) > 0n,
    requestKey: maximumRequestKey,
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
      estimateNativeTransferMaximum({
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
  const lastMaximumRequestKey = useRef<string | null>(null)
  const requestMaximum = () => {
    lastMaximumRequestKey.current = maximumRequestKey
    void maximum.request()
  }
  const transferAvailability = resolvePortfolioTransferAvailability({
    balanceRaw: availableRaw,
    decimals: asset.metadata.decimals,
    isNative: asset.asset.kind === 'native',
    maximumRaw: maximum.value?.amountRaw ?? null
  })
  const spendableRaw = transferAvailability.amountRaw
  const maxHighlighted =
    maxSelected ||
    (amountRaw !== null &&
      BigInt(amountRaw) > 0n &&
      amountRaw === spendableRaw &&
      (asset.asset.kind === 'token' || maximum.value !== null))
  const validAmount =
    domainAvailableRaw !== null &&
    domainNativeAvailableRaw !== null &&
    isTransferAmountSpendable(amountRaw, spendableRaw)
  const privatePreviewInputs = {
    network: networkMode,
    walletId: walletId ?? '',
    accountId: accountId ?? '',
    endpointKey: endpoints,
    portfolioWalletId: portfolio.scope.keyDomainId,
    portfolioAccountId: portfolio.scope.accountId,
    assetId: asset.asset.id,
    assetReference: asset.asset.reference,
    assetDecimals: asset.metadata.decimals,
    chainId: chain.chain.id,
    sender: sourceAddress ?? '',
    recipient,
    amountRaw: amountRaw ?? '',
    amount,
    slippage,
    feeSelectionKey: JSON.stringify(feeSelection),
    portfolio,
    chain,
    asset
  } as const
  const privatePreviewKey =
    active &&
    sendPrivately &&
    route === 'confidential' &&
    networkMode === 'mainnet' &&
    validAmount &&
    validRecipient &&
    sourceAddress &&
    walletId &&
    accountId &&
    amountRaw
      ? createPublicPrivateSendPreviewKey(privatePreviewInputs)
      : null
  const latestPrivatePreviewInputs = useRef(privatePreviewInputs)
  latestPrivatePreviewInputs.current = privatePreviewInputs
  const currentPrivatePreviewKey = useRef(privatePreviewKey)
  currentPrivatePreviewKey.current = privatePreviewKey
  const privatePreviewReady = Boolean(
    privatePreviewKey &&
    privatePreview?.key === privatePreviewKey &&
    isRheaSwapQuoteFresh(privatePreview.quote)
  )
  useEffect(() => {
    if (!privatePreviewKey) {
      setPrivatePreview(null)
      setPrivatePreviewLoading(false)
      setPrivatePreviewError(null)
      return
    }
    let cancelled = false
    let heldQuoteHandle: string | null = null
    let expiryTimer: number | undefined
    setPrivatePreview(null)
    setPrivatePreviewLoading(true)
    setPrivatePreviewError(null)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const {
            walletId,
            accountId,
            sender,
            portfolio,
            chain,
            asset,
            network,
            endpointKey,
            recipient,
            amount,
            amountRaw,
            slippage,
            feeSelectionKey
          } = latestPrivatePreviewInputs.current
          const descriptor = getEnabledSwapChains([chain.chain])[0]
          if (!descriptor) throw new Error('Confidential route unavailable')
          const [catalog, targets] = await Promise.all([
            rheaSwapClient
              .listTokens({
                direction: 'from',
                tokenListChainIds: [descriptor.tokenListChainId]
              })
              .catch(() => null),
            receiveTargetsClient.getAdditionalTargets({ keyDomainId: walletId, accountId })
          ])
          if (cancelled || currentPrivatePreviewKey.current !== privatePreviewKey) return
          if (!targets) throw new Error('Confidential route unavailable')
          const pair = resolvePublicPrivateSendQuotePair({
            assetId: asset.asset.id,
            chainId: chain.chain.id,
            sender,
            portfolio,
            receiveTargets: targets,
            sourceTokens: catalog?.tokens ?? [],
            destinationTokens: catalog?.tokens ?? []
          })
          if (!pair) throw new Error('Wallet asset could not be mapped to a Swap quote.')
          const request = buildPublicPrivateSendPreviewRequest({
            network,
            walletId,
            accountId,
            endpointKey,
            portfolioWalletId: portfolio.scope.keyDomainId,
            portfolioAccountId: portfolio.scope.accountId,
            assetId: asset.asset.id,
            assetReference: asset.asset.reference,
            assetDecimals: asset.metadata.decimals,
            chainId: chain.chain.id,
            sender,
            recipient,
            amount,
            amountRaw,
            slippage,
            feeSelectionKey,
            sourceToken: pair.sourceToken,
            destinationToken: pair.destinationToken
          })
          if (!request || request.key !== privatePreviewKey) {
            throw new Error('Confidential route unavailable')
          }
          const quote = await rheaSwapClient.quote(request.request, 'public-private-send')
          if (cancelled || currentPrivatePreviewKey.current !== privatePreviewKey) {
            void rheaSwapClient.discard(quote.quoteHandle).catch(() => {})
            return
          }
          if (
            !isRheaSwapQuoteFresh(quote) ||
            quote.recipient.toLowerCase() !== recipient.toLowerCase()
          ) {
            void rheaSwapClient.discard(quote.quoteHandle).catch(() => {})
            throw new Error('Quote expired. Try again.')
          }
          heldQuoteHandle = quote.quoteHandle
          setPrivatePreview({
            key: request.key,
            quote,
            routeCost: getPublicPrivateSendRouteCost({
              amountInRaw: request.amountRaw,
              estimatedOutRaw: quote.estimatedOut,
              decimals: asset.metadata.decimals
            }),
            estimatedReceive: formatBaseUnitDecimalAmount(
              quote.estimatedOut,
              asset.metadata.decimals
            )
          })
          setPrivatePreviewLoading(false)
          expiryTimer = window.setTimeout(
            () => {
              if (cancelled || currentPrivatePreviewKey.current !== privatePreviewKey) return
              setPrivatePreview(null)
              setPrivatePreviewError('Quote expired. Try again.')
              if (heldQuoteHandle) void rheaSwapClient.discard(heldQuoteHandle).catch(() => {})
              heldQuoteHandle = null
            },
            Math.max(0, getRheaSwapQuoteDeadline(quote) - Date.now())
          )
        } catch (cause) {
          if (cancelled || currentPrivatePreviewKey.current !== privatePreviewKey) return
          setPrivatePreview(null)
          setPrivatePreviewLoading(false)
          setPrivatePreviewError(getRheaSwapErrorMessage(cause))
        }
      })()
    }, 800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
      if (heldQuoteHandle) void rheaSwapClient.discard(heldQuoteHandle).catch(() => {})
    }
  }, [privatePreviewKey, privatePreviewRetry])
  const maximumPending =
    maxSelected &&
    route === 'onchain' &&
    asset.asset.kind === 'native' &&
    (maximum.loading || !maximum.value)
  useEffect(() => {
    if (
      active &&
      maxSelected &&
      !review &&
      asset.asset.kind === 'native' &&
      route === 'onchain' &&
      validRecipient &&
      sourceAddress &&
      lastMaximumRequestKey.current !== maximumRequestKey
    )
      requestMaximum()
  }, [
    active,
    maxSelected,
    review,
    asset.asset.kind,
    maximumRequestKey,
    route,
    validRecipient,
    sourceAddress
  ])
  useEffect(() => {
    const maximumRaw = confidentialMaximumRaw ?? maximum.value?.amountRaw
    if (active && maxSelected && !review && maximumRaw !== undefined)
      setAmount(formatBaseUnitDecimalAmount(maximumRaw, asset.metadata.decimals))
  }, [active, maxSelected, review, confidentialMaximumRaw, maximum.value, asset.metadata.decimals])

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
          sendingAddress={sourceAddress}
          disablePrivateExecutionAddresses={sourceMode === 'main'}
          recipientExecutionMode={sourceMode}
          onSelect={(address, name) => {
            invalidateMaximum()
            if (maxSelected) setAmount('')
            setRecipient(address)
            setSelectedRecipient(name ? { address, name } : null)
            resolve(address)
          }}
        />
      )
    })
  }

  const handleMaximum = () => {
    if (!validRecipient || route === 'pending' || !sourceAddress) return
    setError(null)
    if (confidentialMaximumRaw !== null) {
      if (confidentialMaximumRaw === '0') return
      setMaxSelected(true)
      setAmount(formatBaseUnitDecimalAmount(confidentialMaximumRaw, asset.metadata.decimals))
      return
    }
    setAmount('')
    setMaxSelected(true)
    requestMaximum()
  }

  const estimateSelectedFee = useCallback(
    async (selection: EvmFeeSelection) => {
      if (route !== 'onchain' || !amountRaw || !validAmount || !validRecipient) {
        throw new Error('Incomplete EVM transfer')
      }
      const estimate = await evmWalletClient.estimateTransferFee(
        { assetId: asset.asset.id, recipient, amountRaw },
        { feeSelection: selection, executionMode: sourceMode }
      )
      return { amountRaw: estimate.maximumFeeWei, details: estimate }
    },
    [amountRaw, asset.asset.id, recipient, sourceMode, route, validAmount, validRecipient]
  )
  const estimateFee = useCallback(
    () => estimateSelectedFee(feeSelection),
    [estimateSelectedFee, feeSelection]
  )
  const loadTierPreviews = useCallback(async (): Promise<NetworkFeePreviews> => {
    const previews: NetworkFeePreviews = {}
    await Promise.allSettled(
      NETWORK_FEE_TIERS.filter(
        tier => feeSelection.kind !== 'tier' || tier !== feeSelection.tier
      ).map(async tier => {
        const { amountRaw } = await estimateSelectedFee({ kind: 'tier', tier })
        previews[tier] = {
          amount: formatBaseUnitAmount(amountRaw, nativeDecimals),
          symbol: nativeSymbol,
          approximate: true
        }
      })
    )
    return previews
  }, [estimateSelectedFee, feeSelection, nativeDecimals, nativeSymbol])
  const maximumFeeEstimate =
    route === 'onchain' &&
    maxSelected &&
    !maximum.fallbackUsed &&
    maximum.value?.evmFeeEstimate?.amountIndependent === true &&
    maximum.value?.amountRaw === amountRaw
      ? maximum.value.evmFeeEstimate
      : undefined
  const calculatedFeePreview = useTransferFeePreview({
    enabled:
      active &&
      !maximumFeeEstimate &&
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
  const feePreview = maximumFeeEstimate
    ? {
        amountRaw: maximumFeeEstimate.maximumFeeWei,
        details: maximumFeeEstimate,
        loading: false
      }
    : calculatedFeePreview
  const previewFee = feePreview.amountRaw
    ? formatBaseUnitAmount(feePreview.amountRaw, nativeDecimals)
    : '—'
  const reviewedSummary = review?.value.review.summary
  const reviewedFeeEstimate =
    reviewedSummary?.schema === 'evm.transaction.v1'
      ? {
          chainId: reviewedSummary.chainId,
          maxFeePerGasWei: reviewedSummary.fields.maxFeePerGasWei,
          maxPriorityFeePerGasWei: reviewedSummary.fields.maxPriorityFeePerGasWei
        }
      : null
  const confirmationTime = useEvmConfirmationEstimate({
    enabled:
      active &&
      route === 'onchain' &&
      (review !== null
        ? review.intentKey === intentKey && !updatingFee
        : !feePreview.loading && feePreview.details !== null),
    fallbackEnabled: active && (route === 'onchain' || sendPrivately),
    chainId: chain.chain.id,
    requestKey: `${accountContextKey}:${intentKey}:${JSON.stringify(feeSelection)}:${review?.value.graph.root.id ?? 'preview'}`,
    feeEstimate: review ? reviewedFeeEstimate : feePreview.details
  })
  const maximumError =
    route === 'confidential' && maximum.error ? getRheaSwapErrorMessage(maximum.error) : null
  const displayedError = error ?? tokenFeeBalanceError ?? maximumError

  const handleFormFeeSelectionChange = async (nextFeeSelection: EvmFeeSelection) => {
    if (areEvmFeeSelectionsEqual(nextFeeSelection, feeSelection)) return
    if (nextFeeSelection.kind !== 'tier' && !(asset.asset.kind === 'native' && maxSelected)) {
      await estimateSelectedFee(nextFeeSelection)
    }
    setFeeSelection(nextFeeSelection)
    if (asset.asset.kind === 'native' && maxSelected) {
      setAmount('')
      setMaxSelected(false)
    }
  }

  const handleContinue = async () => {
    if (
      !active ||
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
        if (
          !privatePreview ||
          privatePreview.key !== privatePreviewKey ||
          !isRheaSwapQuoteFresh(privatePreview.quote)
        ) {
          setPrivatePreviewError('Quote unavailable. Try again.')
          return
        }
        if (!walletId || !accountId) return
        navigate(
          carryQuotePreview(
            buildPublicPrivateEvmSendPath({
              assetId: asset.asset.id,
              recipient,
              amount,
              maximum: maxSelected,
              walletId,
              accountId,
              network: networkMode
            }),
            { ...rheaQuoteTerms(privatePreview.quote), sourceAmount: amountRaw }
          ),
          { replace: true }
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
          await openMultichainHardwareSignTab(submission.transactionId, 'evm')
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
  const reviewFiat = review ? formatSendFiatValue(review.amount, priceUsd) : null
  const privateRouteCostFiat =
    privatePreviewReady && privatePreview && privatePreview.routeCost !== null
      ? formatSendFiatValue(privatePreview.routeCost, priceUsd)
      : null

  const changePrivacyRoute = (scope: string | null) => {
    if (maxSelected && asset.asset.kind === 'native') setAmount('')
    setPrivateSendScope(scope)
    setError(null)
  }

  const setInputAmount = (value: string) => {
    if (!/^\d*\.?\d*$/.test(value)) return
    invalidateMaximum()
    setAmount(value)
  }
  const setInputRecipient = (value: string) => {
    invalidateMaximum()
    if (maxSelected) setAmount('')
    setRecipient(value.trim())
    setSelectedRecipient(null)
  }
  const selectMaximum = () => {
    if (asset.asset.kind !== 'token') {
      handleMaximum()
      return
    }
    setError(null)
    setMaxSelected(true)
    setAmount(transferAvailability.display)
  }
  const selectShield = (domain: string) => {
    if (domain === 'shield') onSelectShield(validRecipient ? recipient : '', amount)
  }
  const selectAsset = () => onSelectAsset({ recipient, amount: maxSelected ? '' : amount })
  const openDestinationNetworks = () => {
    setNetworkPickerOpen(true)
    onOpenDestinationNetworks()
  }
  const selectDestinationNetwork = (destinationChainId: string) =>
    onSelectDestinationNetwork(destinationChainId, {
      recipient,
      amount: maxSelected ? '' : amount
    })
  const togglePrivacyRoute = () => changePrivacyRoute(sendPrivately ? null : privacyScope)
  const retryPrivatePreview = () => setPrivatePreviewRetry(current => current + 1)

  return {
    active,
    walletMode,
    destinationNetworks,
    priceUsd,
    sourceMode,
    feeSelection,
    amount,
    recipient,
    error,
    preparing,
    approving,
    updatingFee,
    review,
    networkPickerOpen,
    setNetworkPickerOpen,
    asset,
    chain,
    networkMode,
    shieldSourceAvailable,
    accountDisplayName,
    bundledAsset,
    nativeSymbol,
    domainAvailableRaw,
    availableRaw,
    tokenFeeBalanceError,
    sourceAddress,
    destinationNetworkOptions,
    privacyScope,
    sendPrivately,
    route,
    support,
    reviewRecipientRole,
    canMoveRecipient,
    recipientContactName,
    validRecipient,
    recipientPolicyError,
    intentKey,
    amountRaw,
    maximum,
    maxSelected,
    maxHighlighted,
    transferAvailability,
    maximumPending,
    privatePreview,
    privatePreviewReady,
    privatePreviewLoading,
    privatePreviewError,
    privatePreviewKey,
    feePreview,
    loadTierPreviews,
    previewFee,
    confirmationTime,
    displayedError,
    maximumError,
    validAmount,
    handleSelectRecipient,
    handleMoveRecipient,
    handleMaximum,
    handleFormFeeSelectionChange,
    handleContinue,
    handleCloseReview,
    handleReviewFeeSelectionChange,
    handleApprove,
    summary,
    fee,
    maximumTotal,
    reviewFiat,
    privateRouteCostFiat,
    setInputAmount,
    setInputRecipient,
    selectMaximum,
    selectShield,
    selectAsset,
    openDestinationNetworks,
    selectDestinationNetwork,
    togglePrivacyRoute,
    retryPrivatePreview
  }
}
export type EvmSendTransferState = ReturnType<typeof useEvmSendTransfer>
