import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import type { PortfolioReadModel, PortfolioAssetView } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import { Icon } from '@iconify/react'
import nearLogo from '@/images/figma-near-confidential.svg'
import { resolveEvmChainIconAlias } from '@/config/icons'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import { getCachedTokens, type SwapToken } from '@/core/services/intents-api'
import type { ConfidentialFundingReview } from '@/core/services/confidential-funding'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  formatTokenQuantity,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatSymbol } from '@/lib/format'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useConfidentialFundingPreview } from '@/popup/hooks/useConfidentialFundingPreview'
import { useShieldBalances } from '@/popup/hooks/useShieldBalances'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { findAssetPrice } from '@/core/prices'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { useNavigate } from '@/popup/provider/Router'
import { SlippageSettingContent } from '@/popup/components/swap/SlippageSetting'
import {
  SendFormView,
  SendFormActions,
  SendFieldLabel,
  SendAmountInputCard,
  SendRouteInfoCard,
  SendRecipientInputCard
} from '@/popup/components/transaction/SendInputCards'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { ChainSelector, type ChainSelectorOption } from '@/popup/components/common/ChainSelector'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import type { ShieldSourceTokenPickerItem } from '@/popup/components/tokens/ShieldSourceTokenPickerRows'
import {
  sortSendAssetsByBalanceValue,
  sortSendNetworks
} from '@/popup/pages/transactions/send-asset-order'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import {
  TransactionReviewExchangeSummary,
  TransactionReviewView
} from '@/popup/components/transaction/TransactionReviewView'
import { openConfidentialActivity } from '@/popup/components/transaction/ConfidentialActivitySheet'
import { Button } from '@/popup/components/ui/button'
import { InlineError } from '@/popup/components/common/InlineError'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import {
  CONFIDENTIAL_PREVIEW_CONNECTION_ERROR,
  confidentialFundingClient,
  type PrepareConfidentialFundingRequest
} from '@/popup/services/confidential-funding-client'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import {
  buildExternalShieldWithdrawRequest,
  hasShieldTransferStarted,
  isUnsignedShieldTerminal,
  matchesExternalShieldWithdrawReview,
  listShieldFundingAssets,
  listShieldSendDestinations,
  estimateShieldSendRouteFee,
  isShieldWithdrawRecipient,
  shieldPortfolioBalances,
  shieldFundingAvailableRaw,
  shieldFundingSources,
  selectDefaultShieldWithdrawSource,
  resolveShieldManagedAsset,
  selectShieldWithdrawDestinationForNetwork,
  type ShieldFundingAsset
} from '@/popup/services/shield-transfer'
import {
  normalizePrivateBalanceTransferInput,
  resolvePrivateBalanceTransferAmount
} from '@/popup/services/private-balance-transfer'
import { estimateConfidentialSendTime } from '@/popup/services/send-time-estimate'
import {
  ZcashMoveLayout,
  ZcashMoveAccountCard
} from '@/popup/components/transaction/ZcashMoveLayout'
import { getConfidentialZcashMoveRecipients } from '@/popup/services/zcash-self-move'

function withdrawChainIconAlias(chain: ShieldFundingAsset['chain']['chain']): string {
  return chain.family === 'evm'
    ? resolveEvmChainIconAlias(chain.id)
    : resolveChainIconAlias(chain.family, chain.displayName)
}

export function ShieldWithdrawPage() {
  const [params] = useSearchParams()
  const location = useLocation()
  const target = new URLSearchParams(params)
  target.set('sourceMode', 'shield')
  return (
    <Navigate to={`/send?${target}`} replace state={{ ...location.state, sendEntry: 'shield' }} />
  )
}

export interface ShieldWithdrawEntry {
  readonly assetId: string | null
  readonly networkId: string | null
  readonly recipient: string
  readonly amount?: string
  readonly provider: string | null
}

export interface ShieldWithdrawSourcePickerState {
  readonly items: readonly ShieldSourceTokenPickerItem[]
  readonly selectedAssetId?: string
  readonly balancesHidden: boolean
  readonly onSelect: (assetId: string) => void
}

export function ShieldWithdrawForm({
  active,
  entry,
  onStateChange,
  model,
  initialAsset,
  refresh,
  readProjection,
  onSelectPublic,
  onOpenSourcePicker,
  onSourcePickerState,
  onMoveSourceSelect,
  onMoveDestinationSelect,
  onMoveReverse,
  sourceSelectorActive = false,
  moveToOwnZcash = false
}: {
  readonly active: boolean
  readonly entry: Readonly<ShieldWithdrawEntry>
  readonly onStateChange: (state: { readonly reviewing: boolean; readonly busy: boolean }) => void
  readonly model: PortfolioReadModel | null
  readonly initialAsset: PortfolioAssetView | null
  readonly refresh: (force?: boolean) => Promise<void>
  readonly readProjection: () => Promise<void>
  readonly onSelectPublic: (
    assetId: string | null,
    recipient: string,
    amount: string,
    destinationAssetId: string | null
  ) => void
  readonly onOpenSourcePicker: () => void
  readonly onSourcePickerState?: (state: ShieldWithdrawSourcePickerState) => void
  readonly onMoveSourceSelect?: () => void
  readonly onMoveDestinationSelect?: () => void
  readonly onMoveReverse?: () => void
  readonly sourceSelectorActive?: boolean
  readonly moveToOwnZcash?: boolean
}) {
  const { navigate } = useNavigate()
  const actionLabel = moveToOwnZcash ? 'Move' : 'Send'
  const providerIsNear = entry.provider === null || entry.provider === 'near-confidential'
  const routeAssetId = entry.assetId ?? ''
  const routeNetworkId = entry.networkId
  const routeRecipient = entry.recipient
  const routeAmount = entry.amount ?? ''
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const { activeAccount } = useActiveAccountNetworks()
  const ownZcashRecipients = getConfidentialZcashMoveRecipients(activeAccount, network)
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const canManageNear =
    providerIsNear &&
    getPrivateTransferChainIds(activeAccount, network === 'mainnet').length > 0 &&
    (!moveToOwnZcash || ownZcashRecipients.length > 0)
  const scopeKey = `${network}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`
  const latestScope = useRef(scopeKey)
  latestScope.current = scopeKey
  const entryKey = JSON.stringify([
    routeAssetId,
    routeNetworkId,
    routeRecipient,
    routeAmount,
    entry.provider,
    moveToOwnZcash
  ])
  const latestEntry = useRef(entryKey)
  latestEntry.current = entryKey
  const activeRef = useRef(active)
  activeRef.current = active
  const formRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const [catalogTokens, setCatalogTokens] = useState<readonly SwapToken[]>(getCachedTokens)
  const [managedAssets, setManagedAssets] = useState<readonly IntentsManagedAsset[]>(() =>
    resolveManagedIntentsCatalog(getCachedTokens())
  )
  const [catalogResolved, setCatalogResolved] = useState(false)
  const [priceSnapshot, setPriceSnapshot] = useState<{
    scopeKey: string
    value: AssetPriceReadModel
  } | null>(null)
  const [sourceId, setSourceId] = useState(routeAssetId)
  const [destinationNetworkId, setDestinationNetworkId] = useState<string | null>(routeNetworkId)
  const [amount, setAmount] = useState(routeAmount)
  const [recipientDraft, setRecipient] = useState(routeRecipient)
  const recipient = moveToOwnZcash
    ? (ownZcashRecipients.find(item => item.address === recipientDraft)?.address ??
      ownZcashRecipients[0]?.address ??
      '')
    : recipientDraft
  const [picker, setPicker] = useState<'recipient' | 'slippage' | 'move-destination' | null>(null)
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const [slippage, setSlippage] = useState(0.5)
  const [prepared, setPrepared] = useState<Readonly<{
    review: ConfidentialFundingReview
    request: PrepareConfidentialFundingRequest
    source: ShieldFundingAsset
    destination: ShieldFundingAsset
    amount: string
  }> | null>(null)
  const preparedRef = useRef(prepared)
  preparedRef.current = prepared
  const [previewGeneration, setPreviewGeneration] = useState(0)
  const [recoveryPending, setRecoveryPending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftKey = JSON.stringify([
    scopeKey,
    sourceId,
    destinationNetworkId,
    recipient,
    amount,
    slippage
  ])
  const latestDraftKey = useRef(draftKey)
  latestDraftKey.current = draftKey
  const confirmationAttempt = useRef<string | null>(null)
  const pendingSourceNetworkCheck = useRef<{
    sourceAssetId: string
    networkId: string
    previousFamily?: string
  } | null>(null)
  const {
    balances: currentBalances,
    connecting,
    error: balanceError,
    refreshBalances: loadBalances
  } = useShieldBalances({
    active,
    enabled: canManageNear,
    scopeKey,
    scope: account
      ? { network, keyDomainId: account.walletId, accountId: account.accountId }
      : null,
    refreshPortfolio: refresh,
    readProjection
  })

  useLayoutEffect(() => {
    onStateChange({ reviewing: active && Boolean(prepared), busy: active && busy })
  }, [active, prepared, busy, onStateChange])

  useLayoutEffect(() => () => onStateChange({ reviewing: false, busy: false }), [onStateChange])

  useLayoutEffect(() => {
    if (active || !formRef.current?.contains(document.activeElement)) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }, [active])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const pending = preparedRef.current
      if (pending && confirmationAttempt.current !== pending.review.planId)
        void confidentialFundingClient.cancel(pending.review.planId).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (active && !providerIsNear) navigate('/shield-funds', { replace: true })
  }, [active, providerIsNear, navigate])

  useEffect(() => {
    if (!active) {
      setPicker(null)
      setNetworkPickerOpen(false)
      setRecoveryPending(false)
    }
  }, [active])

  useEffect(() => {
    if (!active && prepared && confirmationAttempt.current) setUncertain(true)
  }, [active, prepared])

  useEffect(() => {
    const pending = preparedRef.current
    if (pending && confirmationAttempt.current !== pending.review.planId)
      void confidentialFundingClient.cancel(pending.review.planId).catch(() => {})
    preparedRef.current = null
    setSourceId(routeAssetId)
    setDestinationNetworkId(routeNetworkId)
    setAmount(routeAmount)
    setRecipient(routeRecipient)
    setPicker(null)
    setNetworkPickerOpen(false)
    setPrepared(null)
    setRecoveryPending(false)
    setBusy(false)
    setUncertain(false)
    setError(null)
    pendingSourceNetworkCheck.current = null
    confirmationAttempt.current = null
  }, [scopeKey, routeAssetId, routeNetworkId, routeRecipient, routeAmount])

  useEffect(() => {
    setError(null)
    setRecoveryPending(false)
  }, [draftKey])

  useEffect(() => {
    if (!active && !sourceSelectorActive) return
    let current = true
    let directoryAvailable = catalogTokens.length > 0
    setCatalogResolved(false)
    const load = async () => {
      try {
        const cached = await swapTokenCatalogClient.readCached()
        if (!current) return
        if (cached.length > 0) directoryAvailable = true
        if (cached.length > 0 && catalogTokens.length === 0) {
          setCatalogTokens(cached)
          setManagedAssets(resolveManagedIntentsCatalog(cached))
        }
        if (
          !sourceSelectorActive &&
          !routeAssetId &&
          (cached.length > 0 || catalogTokens.length > 0)
        )
          return
        const refreshed = await swapTokenCatalogClient.refresh()
        if (current && refreshed.length) {
          directoryAvailable = true
          setCatalogTokens(refreshed)
          setManagedAssets(resolveManagedIntentsCatalog(refreshed))
        }
      } catch {
        // Cached portfolio remains visible while the token catalog is unavailable.
      } finally {
        if (current) setCatalogResolved(directoryAvailable)
      }
    }
    void load()
    return () => {
      current = false
    }
  }, [active, sourceSelectorActive, network, routeAssetId])

  useEffect(() => {
    if (!active) return
    let current = true
    void assetPriceClient
      .getPrices('read')
      .then(value => {
        if (current && value && value.status !== 'error') setPriceSnapshot({ scopeKey, value })
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [active, scopeKey])

  const options = useMemo(
    () => listShieldFundingAssets(model, managedAssets, catalogTokens, network),
    [model, managedAssets, catalogTokens, network]
  )
  const portfolioBalances = useMemo(() => shieldPortfolioBalances(model), [model])
  const displayBalances = currentBalances ?? portfolioBalances
  const fundedSources = useMemo(
    () => shieldFundingSources(options, displayBalances),
    [options, displayBalances]
  )
  const prices = priceSnapshot?.scopeKey === scopeKey ? priceSnapshot.value : null
  const sources = useMemo(() => {
    const fundedAssetIds = new Set(fundedSources.map(item => item.asset.asset.id))
    return [...fundedSources, ...options.filter(item => !fundedAssetIds.has(item.asset.asset.id))]
  }, [fundedSources, options])
  const sourcePickerItems = useMemo(() => {
    if (!sourceSelectorActive) return []
    return sortSendAssetsByBalanceValue(
      sources.map(item => ({
        key: item.asset.asset.id,
        amount: formatBaseUnitDecimalAmount(
          shieldFundingAvailableRaw(item, displayBalances),
          item.asset.metadata.decimals
        ),
        priceUsd: findAssetPrice(prices, item.asset.asset.id)?.priceUsd ?? null,
        item
      }))
    ).map(row => ({
      key: row.item.asset.asset.id,
      assetId: row.item.asset.asset.id,
      symbol: row.item.asset.metadata.symbol,
      iconUrl: row.item.asset.metadata.iconUrl,
      chainName: row.item.chain.chain.displayName,
      chainId: row.item.chain.chain.id,
      badgeBlockchain: resolveChainIconAlias(
        row.item.chain.chain.family,
        row.item.chain.chain.displayName,
        row.item.chain.chain.id
      ),
      nativeIconChain: row.item.asset.metadata.symbol.toUpperCase() === 'ZEC' ? 'zcash' : undefined,
      availableRaw: shieldFundingAvailableRaw(row.item, displayBalances),
      decimals: row.item.asset.metadata.decimals,
      priceUsd: row.priceUsd
    }))
  }, [sourceSelectorActive, displayBalances, prices, sources])
  const routedPublicAsset = model?.assets.find(item => item.asset.id === sourceId)
  const routedManaged = routedPublicAsset
    ? resolveShieldManagedAsset(routedPublicAsset, managedAssets, catalogTokens, network)
    : null
  const source = moveToOwnZcash
    ? (sources.find(item => item.asset.asset.id === routeAssetId) ?? null)
    : sourceId
      ? (sources.find(item => item.asset.asset.id === sourceId) ??
        sources.find(item => item.managed.protocolAssetId === routedManaged?.protocolAssetId) ??
        null)
      : selectDefaultShieldWithdrawSource(options, displayBalances, model, prices, network)
  const selectedSourceAssetId = source?.asset.asset.id
  const reportedPickerState = useRef<{
    scopeKey: string
    items: readonly ShieldSourceTokenPickerItem[]
    selectedAssetId?: string
    balancesHidden: boolean
    callback: typeof onSourcePickerState
    source: ShieldFundingAsset | null
    destinationNetworkId: string | null
    options: readonly ShieldFundingAsset[]
    catalogResolved: boolean
    moveToOwnZcash: boolean
    activeAccount: typeof activeAccount
    modelChains: PortfolioReadModel['chains'] | undefined
  } | null>(null)
  useEffect(() => {
    if (!sourceSelectorActive || !onSourcePickerState) return
    if (
      reportedPickerState.current?.scopeKey === scopeKey &&
      reportedPickerState.current?.items === sourcePickerItems &&
      reportedPickerState.current.selectedAssetId === selectedSourceAssetId &&
      reportedPickerState.current.balancesHidden === balancesHidden &&
      reportedPickerState.current.callback === onSourcePickerState &&
      reportedPickerState.current.source === source &&
      reportedPickerState.current.destinationNetworkId === destinationNetworkId &&
      reportedPickerState.current.options === options &&
      reportedPickerState.current.catalogResolved === catalogResolved &&
      reportedPickerState.current.moveToOwnZcash === moveToOwnZcash &&
      reportedPickerState.current.activeAccount === activeAccount &&
      reportedPickerState.current.modelChains === model?.chains
    )
      return
    reportedPickerState.current = {
      scopeKey,
      items: sourcePickerItems,
      selectedAssetId: selectedSourceAssetId,
      balancesHidden,
      callback: onSourcePickerState,
      source,
      destinationNetworkId,
      options,
      catalogResolved,
      moveToOwnZcash,
      activeAccount,
      modelChains: model?.chains
    }
    onSourcePickerState({
      items: sourcePickerItems,
      selectedAssetId: selectedSourceAssetId,
      balancesHidden,
      onSelect: assetId => {
        if (assetId === selectedSourceAssetId) {
          setPicker(null)
          return
        }
        const nextSource = sources.find(item => item.asset.asset.id === assetId)
        if (!nextSource) return
        setSourceId(assetId)
        pendingSourceNetworkCheck.current = null
        if (moveToOwnZcash) {
          setDestinationNetworkId(null)
          setRecipient('')
        } else {
          const currentNetworkId = destinationNetworkId ?? source?.chain.chain.id ?? null
          const nextDestinations = listShieldSendDestinations(nextSource, options, network)
          const stillSupported = currentNetworkId
            ? selectShieldWithdrawDestinationForNetwork(
                nextDestinations,
                nextSource,
                currentNetworkId
              )
            : null
          const previousFamily =
            (currentNetworkId === source?.chain.chain.id ? source.chain.chain.family : undefined) ??
            activeAccount?.networks.find(item => item.chain.id === currentNetworkId)?.chain
              .family ??
            model?.chains.find(item => item.chain.id === currentNetworkId)?.chain.family
          if (stillSupported || !catalogResolved) {
            setDestinationNetworkId(currentNetworkId)
            if (!stillSupported && currentNetworkId) {
              pendingSourceNetworkCheck.current = {
                sourceAssetId: assetId,
                networkId: currentNetworkId,
                previousFamily
              }
            }
          } else {
            const fallback =
              nextDestinations.find(item => item.chain.chain.id === nextSource.chain.chain.id) ??
              nextDestinations[0]
            setDestinationNetworkId(fallback?.chain.chain.id ?? null)
            if (previousFamily !== fallback?.chain.chain.family) setRecipient('')
          }
        }
        setAmount('')
        setPicker(null)
      }
    })
  }, [
    sourceSelectorActive,
    onSourcePickerState,
    scopeKey,
    sourcePickerItems,
    selectedSourceAssetId,
    balancesHidden,
    sources,
    source,
    destinationNetworkId,
    options,
    network,
    catalogResolved,
    moveToOwnZcash,
    activeAccount,
    model?.chains
  ])
  const keepSelectedSource = () => {
    if (!sourceId && source) setSourceId(source.asset.asset.id)
  }
  const destinations = useMemo(
    () => (source ? listShieldSendDestinations(source, options, network) : []),
    [source, options, network]
  )
  const networkOptions: ChainSelectorOption[] = useMemo(() => {
    if (!networkPickerOpen) return []
    const supportedIds = new Set(destinations.map(item => item.chain.chain.id))
    const chains = new Map<string, ShieldFundingAsset['chain']['chain']>()
    for (const item of activeAccount?.networks ?? model?.chains ?? []) {
      chains.set(item.chain.id, item.chain)
    }
    for (const item of destinations) chains.set(item.chain.chain.id, item.chain.chain)
    return sortSendNetworks(
      [...chains.values()].map(chain => {
        const supported = supportedIds.has(chain.id)
        const checkingRoute =
          !supported && !catalogResolved && (chain.family === 'evm' || chain.family === 'zcash')
        return {
          id: chain.id,
          name: chain.displayName,
          icon: withdrawChainIconAlias(chain),
          disabled: !supported,
          priority: supported ? 0 : checkingRoute ? 1 : 2,
          note: supported
            ? undefined
            : checkingRoute
              ? 'Checking route'
              : chain.family === 'evm' || chain.family === 'zcash'
                ? 'No route for this token'
                : 'Shield Send unavailable'
        }
      }),
      option => option
    )
  }, [networkPickerOpen, activeAccount, model?.chains, destinations, catalogResolved])
  const selectedDestinationNetworkId = destinationNetworkId ?? source?.chain.chain.id ?? null
  const destination = moveToOwnZcash
    ? source
    : source && selectedDestinationNetworkId
      ? selectShieldWithdrawDestinationForNetwork(
          destinations,
          source,
          selectedDestinationNetworkId
        )
      : null
  const destinationNetwork = destination?.chain.chain
  useEffect(() => {
    const pending = pendingSourceNetworkCheck.current
    if (!catalogResolved || !pending) return
    pendingSourceNetworkCheck.current = null
    if (moveToOwnZcash || source?.asset.asset.id !== pending.sourceAssetId) return
    const currentNetworkId = destinationNetworkId ?? source.chain.chain.id
    if (
      currentNetworkId !== pending.networkId ||
      selectShieldWithdrawDestinationForNetwork(destinations, source, pending.networkId)
    )
      return
    const fallback =
      destinations.find(item => item.chain.chain.id === source.chain.chain.id) ?? destinations[0]
    setDestinationNetworkId(fallback?.chain.chain.id ?? null)
    if (pending.previousFamily !== fallback?.chain.chain.family) setRecipient('')
  }, [catalogResolved, moveToOwnZcash, source, destinationNetworkId, destinations])
  const availableRaw = shieldFundingAvailableRaw(source, displayBalances)
  const displayedAsset = source?.asset ?? initialAsset
  const amountState = source
    ? resolvePrivateBalanceTransferAmount({
        amount,
        decimals: source.asset.metadata.decimals,
        availableRaw,
        sourceLabel: 'Shield'
      })
    : null
  const recipientValid = isShieldWithdrawRecipient(recipient.trim(), destination, network)
  const previewAmountRaw = useMemo(() => {
    if (!source || !amount.trim()) return null
    try {
      const raw = parseDisplayUnitAmount(amount, source.asset.metadata.decimals)
      return BigInt(raw) > 0n ? raw : null
    } catch {
      return null
    }
  }, [amount, source])
  const previewRequest = useMemo(() => {
    if (
      !account ||
      !canManageNear ||
      !currentBalances ||
      !source ||
      !destination ||
      !previewAmountRaw ||
      !recipientValid
    )
      return null
    const request = buildExternalShieldWithdrawRequest({
      network,
      keyDomainId: account.walletId,
      accountId: account.accountId,
      amountRaw: previewAmountRaw,
      recipient: recipient.trim(),
      source,
      destination,
      slippageBps: Math.round(slippage * 100)
    })
    return moveToOwnZcash ? { ...request, purpose: 'move' as const } : request
  }, [
    network,
    account?.walletId,
    account?.accountId,
    canManageNear,
    currentBalances,
    source,
    destination,
    previewAmountRaw,
    slippage,
    recipient,
    recipientValid,
    moveToOwnZcash
  ])
  const {
    preview,
    loading: previewLoading,
    error: previewError,
    retry: retryPreview
  } = useConfidentialFundingPreview(
    active ? previewRequest : null,
    `${scopeKey}:${previewGeneration}`
  )
  const previewFee =
    source && destination && previewRequest && preview && preview.expiresAt > Date.now()
      ? estimateShieldSendRouteFee(
          source,
          destination,
          previewRequest.source.amountRaw,
          preview.amountOutRaw
        )
      : null

  const scopeStillCurrent = () => {
    const wallet = useWalletStore.getState()
    return (
      activeRef.current &&
      mounted.current &&
      latestScope.current === scopeKey &&
      latestEntry.current === entryKey &&
      wallet.currentWalletId === currentWalletId &&
      wallet.currentAccountId === currentAccountId &&
      wallet.currentNetwork === network
    )
  }
  const openActivity = (transactionId: string) => {
    if (!scopeStillCurrent() || !account) return
    void loadBalances(true, false)
    preparedRef.current = null
    setPrepared(null)
    setAmount('')
    setUncertain(false)
    setError(null)
    void openConfidentialActivity(
      {
        network,
        keyDomainId: account.walletId,
        accountId: account.accountId,
        transactionId
      },
      () => {
        if (activeRef.current)
          navigate(`/?tab=activity&transactionId=${encodeURIComponent(transactionId)}`)
      },
      prepared
        ? {
            operation: moveToOwnZcash ? 'move' : 'send',
            amount: prepared.amount,
            symbol: formatSymbol(prepared.source.asset.metadata.symbol),
            from: 'Shield · NEAR Confidential',
            recipient: prepared.review.destinationAddress,
            network: prepared.destination.chain.chain.displayName
          }
        : undefined
    )
  }
  const refreshBalances = async () => {
    if (!account || !canManageNear || connecting || !scopeStillCurrent()) return
    const requestedDraftKey = draftKey
    setRecoveryPending(true)
    try {
      const refreshed = await loadBalances()
      if (!scopeStillCurrent() || latestDraftKey.current !== requestedDraftKey) return
      if (refreshed) {
        setPreviewGeneration(value => value + 1)
        setError(null)
      }
    } catch (cause) {
      if (scopeStillCurrent() && latestDraftKey.current === requestedDraftKey)
        setError(cause instanceof Error ? cause.message : 'Shield balance unavailable')
    } finally {
      if (scopeStillCurrent() && latestDraftKey.current === requestedDraftKey)
        setRecoveryPending(false)
    }
  }
  const prepare = async () => {
    if (
      !account ||
      !canManageNear ||
      !source ||
      !destination ||
      !amountState?.amountRaw ||
      !recipientValid ||
      !previewRequest ||
      !preview ||
      preview.expiresAt <= Date.now() + 5_000 ||
      recoveryPending ||
      Boolean(error) ||
      Boolean(balanceError) ||
      busy ||
      !scopeStillCurrent()
    )
      return
    setBusy(true)
    setError(null)
    const submittedDraftKey = draftKey
    try {
      const request = previewRequest
      const review = await confidentialFundingClient.prepare(request)
      if (!scopeStillCurrent() || latestDraftKey.current !== submittedDraftKey) {
        if (review.phase === 'prepared')
          void confidentialFundingClient.cancel(review.planId).catch(() => {})
        return
      }
      if (review.phase !== 'prepared') {
        openActivity(review.transactionId)
        return
      }
      if (
        !matchesExternalShieldWithdrawReview(review, request) ||
        review.purpose !== request.purpose
      ) {
        void confidentialFundingClient.cancel(review.planId).catch(() => {})
        throw new Error(`${actionLabel} review changed. Try again.`)
      }
      confirmationAttempt.current = null
      setUncertain(false)
      const pending = { review, request, source, destination, amount }
      preparedRef.current = pending
      setPrepared(pending)
    } catch (cause) {
      if (scopeStillCurrent() && latestDraftKey.current === submittedDraftKey) {
        setRecoveryPending(true)
        setError(cause instanceof Error ? cause.message : `${actionLabel} quote unavailable`)
        setPreviewGeneration(value => value + 1)
        await loadBalances(true, false).catch(() => false)
        if (scopeStillCurrent() && latestDraftKey.current === submittedDraftKey)
          setRecoveryPending(false)
      }
    } finally {
      if (mounted.current && latestScope.current === scopeKey && latestEntry.current === entryKey)
        setBusy(false)
    }
  }
  const inspectPlan = async (planId: string) => {
    const plan = await confidentialFundingClient.get(planId)
    if (!scopeStillCurrent()) return 'changed'
    if (hasShieldTransferStarted(plan)) {
      openActivity(plan.transactionId)
      return 'started'
    }
    if (isUnsignedShieldTerminal(plan)) {
      preparedRef.current = null
      setPrepared(null)
      setUncertain(false)
      setError(`${actionLabel} was not started. Try again.`)
      return 'failed'
    }
    return plan.phase === 'prepared' ? 'prepared' : 'pending'
  }
  const cancelReview = async () => {
    if (!prepared || busy || !scopeStillCurrent()) return
    setBusy(true)
    try {
      if (confirmationAttempt.current === prepared.review.planId) {
        const state = await inspectPlan(prepared.review.planId)
        if (state !== 'prepared') return
      }
      await confidentialFundingClient.cancel(prepared.review.planId)
      if (!mounted.current || latestScope.current !== scopeKey || latestEntry.current !== entryKey)
        return
      preparedRef.current = null
      setPrepared(null)
      setUncertain(false)
    } catch (cause) {
      if (scopeStillCurrent())
        setError(cause instanceof Error ? cause.message : 'Unable to cancel review')
    } finally {
      if (mounted.current && latestScope.current === scopeKey && latestEntry.current === entryKey)
        setBusy(false)
    }
  }
  const confirm = async () => {
    if (!prepared || busy || !canManageNear || !scopeStillCurrent()) return
    setBusy(true)
    setError(null)
    try {
      if (uncertain) {
        const state = await inspectPlan(prepared.review.planId)
        if (!scopeStillCurrent()) return
        if (state === 'prepared') {
          setUncertain(false)
          setError(`${actionLabel} was not started. Review and try again.`)
        }
        return
      }
      if (prepared.review.expiresAt <= Date.now())
        throw new Error(`${actionLabel} quote expired. Review again.`)
      confirmationAttempt.current = prepared.review.planId
      const plan = await confidentialFundingClient.confirm(
        prepared.review.planId,
        prepared.review.payloadFingerprint
      )
      if (hasShieldTransferStarted(plan)) openActivity(plan.transactionId)
      else await inspectPlan(plan.planId)
    } catch (cause) {
      if (!scopeStillCurrent()) return
      try {
        const state = await inspectPlan(prepared.review.planId)
        if (!scopeStillCurrent()) return
        if (state === 'prepared') {
          setUncertain(false)
          setError(cause instanceof Error ? cause.message : `${actionLabel} could not start`)
        } else if (state === 'pending') {
          setUncertain(true)
          setError(`${actionLabel} status is pending. Check status before trying again.`)
        }
      } catch {
        if (scopeStillCurrent()) {
          setUncertain(true)
          setError(`${actionLabel} status unavailable. Check status before trying again.`)
        }
      }
    } finally {
      if (mounted.current && latestScope.current === scopeKey && latestEntry.current === entryKey)
        setBusy(false)
    }
  }

  if (activeAccount && !canManageNear) {
    return (
      <div ref={formRef} className="flex min-h-0 flex-1 flex-col">
        <p role="alert" className="px-4 py-6 text-center text-sm text-muted">
          Shield unavailable for this account
        </p>
      </div>
    )
  }

  if (prepared) {
    const output = formatBaseUnitDecimalAmount(
      prepared.review.expectedOutputRaw,
      prepared.destination.asset.metadata.decimals
    )
    const minimum = formatBaseUnitAmount(
      prepared.review.minimumOutputRaw,
      prepared.destination.asset.metadata.decimals
    )
    return (
      <div ref={formRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TransactionReviewView
          variant="figma"
          title={moveToOwnZcash ? 'Confirm Move' : 'Confirm Send'}
          asset={{
            assetId: prepared.source.asset.asset.id,
            symbol: formatSymbol(prepared.source.asset.metadata.symbol),
            icon: prepared.source.asset.metadata.iconUrl,
            blockchain: withdrawChainIconAlias(prepared.source.chain.chain)
          }}
          amount={prepared.amount}
          network={prepared.destination.chain.chain.displayName}
          summary={
            <TransactionReviewExchangeSummary
              presentation="single"
              destinationLabel={moveToOwnZcash ? 'You receive' : 'Recipient receives'}
              destinationPrefix=""
              source={{
                asset: {
                  assetId: prepared.source.asset.asset.id,
                  symbol: formatSymbol(prepared.source.asset.metadata.symbol),
                  icon: prepared.source.asset.metadata.iconUrl,
                  blockchain: withdrawChainIconAlias(prepared.source.chain.chain)
                },
                amount: prepared.amount
              }}
              destination={{
                asset: {
                  assetId: prepared.destination.asset.asset.id,
                  symbol: formatSymbol(prepared.destination.asset.metadata.symbol),
                  icon: prepared.destination.asset.metadata.iconUrl,
                  blockchain: withdrawChainIconAlias(prepared.destination.chain.chain)
                },
                amount: output
              }}
            />
          }
          rows={[
            { label: 'From', content: 'Shield · NEAR Confidential' },
            {
              label: moveToOwnZcash ? 'To' : 'Recipient',
              content: prepared.review.destinationAddress
            },
            {
              label: 'Network',
              content: (
                <span className="inline-flex items-center gap-1.5">
                  <ChainIcon
                    chain={withdrawChainIconAlias(prepared.destination.chain.chain)}
                    width={16}
                    height={16}
                    className="shrink-0 rounded-sm"
                  />
                  {prepared.destination.chain.chain.displayName}
                </span>
              )
            },
            {
              label: moveToOwnZcash ? 'You receive' : 'Recipient receives',
              content: (
                <AmountDisplay
                  value={output}
                  symbol={formatSymbol(prepared.destination.asset.metadata.symbol)}
                />
              )
            },
            {
              label: 'Minimum receive',
              content: (
                <AmountDisplay
                  value={minimum}
                  symbol={formatSymbol(prepared.destination.asset.metadata.symbol)}
                />
              )
            },
            ...(prepared.review.quoteTimeEstimateSeconds
              ? [
                  {
                    label: 'Estimated time',
                    content: estimateConfidentialSendTime(
                      prepared.review.quoteTimeEstimateSeconds,
                      undefined
                    )
                  }
                ]
              : []),
            ...(prepared.review.sourceNetworkFee
              ? [
                  {
                    label: 'Network fee',
                    content: (
                      <AmountDisplay
                        value={formatBaseUnitDecimalAmount(
                          prepared.review.sourceNetworkFee.raw,
                          prepared.review.sourceNetworkFee.decimals
                        )}
                        symbol={formatSymbol(prepared.review.sourceNetworkFee.symbol)}
                        profile="fee"
                      />
                    )
                  }
                ]
              : []),
            {
              label: 'Fee (est.)',
              content: (() => {
                const fee = estimateShieldSendRouteFee(
                  prepared.source,
                  prepared.destination,
                  prepared.request.source.amountRaw,
                  prepared.review.expectedOutputRaw
                )
                return fee ? (
                  <AmountDisplay
                    value={formatBaseUnitDecimalAmount(fee.raw, fee.decimals)}
                    symbol={formatSymbol(prepared.source.asset.metadata.symbol)}
                    profile="fee"
                  />
                ) : (
                  'Unavailable'
                )
              })()
            }
          ]}
          error={
            error ? (
              <p role="alert" className="mt-3 text-sm text-warning">
                {error}
              </p>
            ) : undefined
          }
          confirmLabel={uncertain ? 'Check status' : 'Confirm'}
          confirming={busy}
          submitting={busy && confirmationAttempt.current === prepared.review.planId}
          onCancel={() => void cancelReview()}
          onConfirm={() => void confirm()}
        />
      </div>
    )
  }

  const routeDetails = (
    <>
      <div>
        <SendRouteInfoCard
          feeLabel="Fee (est.)"
          fee={
            preview && previewRequest && !previewLoading && !previewError ? (
              previewFee ? (
                <AmountDisplay
                  value={formatBaseUnitDecimalAmount(previewFee.raw, previewFee.decimals)}
                  symbol={formatSymbol(source?.asset.metadata.symbol)}
                  profile="fee"
                />
              ) : (
                'Unavailable'
              )
            ) : undefined
          }
          provider={
            <span className="inline-flex items-center gap-2">
              <img src={nearLogo} alt="" className="size-5 rounded" />
              Confidential
            </span>
          }
          extra={
            <div className="flex min-h-5 items-center justify-between gap-3">
              <span className="text-muted">Slippage</span>
              <button
                type="button"
                aria-label={`Slippage settings, currently ${slippage}%`}
                disabled={busy}
                onClick={() => setPicker('slippage')}
                className="wallet-interactive inline-flex items-center gap-2 rounded text-foreground hover:text-primary disabled:opacity-45"
              >
                {slippage}%
                <Icon icon="lucide:settings-2" width={15} height={15} />
              </button>
            </div>
          }
          time={
            previewRequest && destination && !previewError && preview?.timeEstimateSeconds ? (
              <span>{estimateConfidentialSendTime(preview?.timeEstimateSeconds, undefined)}</span>
            ) : undefined
          }
        />
      </div>
      {source && destinations.length === 0 && (
        <p role="alert" className="text-xs text-warning">
          No supported network for this token
        </p>
      )}
      {!error && !balanceError && previewError && (
        <div role="alert" className="flex items-center justify-between gap-2 text-xs text-warning">
          <span>
            {previewError === CONFIDENTIAL_PREVIEW_CONNECTION_ERROR
              ? 'Refresh Shield balances to get a quote.'
              : previewError}
          </span>
          <button
            type="button"
            disabled={connecting || recoveryPending}
            onClick={
              previewError === CONFIDENTIAL_PREVIEW_CONNECTION_ERROR
                ? () => void refreshBalances()
                : retryPreview
            }
            className="shrink-0 text-primary disabled:opacity-45"
          >
            {previewError === CONFIDENTIAL_PREVIEW_CONNECTION_ERROR ? 'Refresh balances' : 'Retry'}
          </button>
        </div>
      )}
      {amountState?.error && (
        <p role="alert" className="text-xs text-warning">
          {amountState.error}
        </p>
      )}
      {recipient && !recipientValid && (
        <p role="alert" className="text-xs text-warning">
          Enter a valid {destinationNetwork?.family === 'zcash' ? 'Zcash' : 'EVM'} address
        </p>
      )}
      {(balanceError || (error && !amountState?.error)) && (
        <InlineError
          message={!amountState?.error && error ? error : balanceError}
          tone="warning"
          onRetry={() => void refreshBalances()}
          retrying={connecting || recoveryPending}
        />
      )}
      {!currentBalances && canManageNear && connecting && (
        <p role="status" className="text-center text-sm text-muted">
          Loading Shield balances…
        </p>
      )}
    </>
  )
  const moveRecipient = ownZcashRecipients.find(item => item.address === recipient)
  const canContinue = Boolean(
    canManageNear &&
    currentBalances &&
    source &&
    destination &&
    amountState?.amountRaw &&
    recipientValid &&
    preview &&
    !previewLoading &&
    !recoveryPending &&
    !error &&
    !balanceError
  )
  const moveBalance = balancesHidden
    ? '••••'
    : source
      ? formatBaseUnitDecimalAmount(availableRaw, source.asset.metadata.decimals)
      : '—'

  return (
    <div ref={formRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {moveToOwnZcash ? (
        <>
          <div className="page-content min-h-0 !px-4 pt-4 space-y-2">
            <ZcashMoveLayout
              amount={
                <input
                  aria-label="ZEC amount"
                  inputMode="decimal"
                  value={amount}
                  disabled={busy}
                  placeholder="0"
                  onChange={event => {
                    const next = normalizePrivateBalanceTransferInput(event.target.value)
                    if (next !== null) setAmount(next)
                  }}
                  className="h-12 w-full max-w-[280px] bg-transparent px-2 text-center text-[40px] font-semibold leading-tight tabular-nums outline-none placeholder:text-muted/45"
                  style={{
                    fontSize: `${Math.max(18, Math.min(40, Math.floor(440 / Math.max(1, amount.length))))}px`
                  }}
                />
              }
              balance={moveBalance}
              max={
                <button
                  type="button"
                  aria-label="Max"
                  disabled={busy || !source || availableRaw === '0'}
                  onClick={() => {
                    if (source)
                      setAmount(
                        formatBaseUnitDecimalAmount(availableRaw, source.asset.metadata.decimals)
                      )
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 font-medium text-primary disabled:opacity-40"
                >
                  Max
                </button>
              }
              source={
                <ZcashMoveAccountCard
                  label="From"
                  source="confidential"
                  accountName={activeAccount?.accountDisplayName ?? ''}
                  address=""
                  disabled={busy}
                  onClick={onMoveSourceSelect}
                />
              }
              destination={
                <ZcashMoveAccountCard
                  label="To"
                  source={moveRecipient?.privacy ?? 'transparent'}
                  accountName={activeAccount?.accountDisplayName ?? ''}
                  address={recipient}
                  disabled={busy}
                  onClick={
                    onMoveDestinationSelect ??
                    (ownZcashRecipients.length > 1
                      ? () => setPicker('move-destination')
                      : undefined)
                  }
                />
              }
              onReverse={onMoveReverse}
              canReverse={Boolean(onMoveReverse)}
            />
            {routeDetails}
          </div>
          <div className="page-footer">
            <Button
              size="wallet"
              className="w-full h-[45px]"
              isLoading={busy}
              disabled={!canContinue || busy}
              onClick={() => void prepare()}
            >
              Move
            </Button>
          </div>
        </>
      ) : (
        <SendFormView
          domain="shield"
          availableDomains={['public', 'shield']}
          disabled={busy}
          onDomainChange={domain => {
            if (domain === 'public') {
              const publicAssetId = [source?.asset, destination?.asset, initialAsset]
                .map(asset => asset?.asset.id)
                .find(id => model?.assets.some(item => item.asset.id === id))
              onSelectPublic(
                publicAssetId ?? null,
                recipientValid ? recipient : '',
                amount,
                destination?.asset.asset.id ?? null
              )
            }
          }}
          recipient={
            <div className="space-y-2">
              <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
                <SendFieldLabel>Send to</SendFieldLabel>
                <button
                  type="button"
                  disabled={busy || !source}
                  onClick={() => {
                    keepSelectedSource()
                    setNetworkPickerOpen(true)
                  }}
                  className="wallet-interactive inline-flex min-w-0 items-center gap-1.5 hover:text-primary disabled:opacity-50"
                  aria-label={`Destination network, ${destinationNetwork?.displayName ?? 'select network'}`}
                >
                  {destinationNetwork && (
                    <ChainIcon
                      chain={withdrawChainIconAlias(destinationNetwork)}
                      width={16}
                      height={16}
                      className="shrink-0 rounded-[4px]"
                    />
                  )}
                  <span className="truncate">
                    {destinationNetwork?.displayName ?? 'Select network'}
                  </span>
                  <Icon icon="lucide:chevron-down" width={13} height={13} className="shrink-0" />
                </button>
              </div>
              <div>
                <SendRecipientInputCard
                  id="shield-send-recipient"
                  label="Recipient address"
                  value={recipient}
                  onChange={value => {
                    keepSelectedSource()
                    setRecipient(value)
                  }}
                  placeholder="Enter address"
                  variant="filled"
                  hideLabel
                  disabled={busy || !destination}
                  onSelectRecipient={
                    busy || !destination
                      ? undefined
                      : () => {
                          keepSelectedSource()
                          setPicker('recipient')
                        }
                  }
                />
              </div>
            </div>
          }
          amountInput={
            <SendAmountInputCard
              ariaLabel="Send amount"
              disabled={busy}
              available={availableRaw}
              symbol={formatSymbol(displayedAsset?.metadata.symbol)}
              inline
              value={amount}
              onChange={value => {
                const next = normalizePrivateBalanceTransferInput(value)
                if (next !== null) {
                  keepSelectedSource()
                  setAmount(next)
                }
              }}
            />
          }
          assetSelector={
            <button
              type="button"
              disabled={busy}
              onClick={onOpenSourcePicker}
              className="wallet-interactive flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-wallet-surface px-2.5 text-sm enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
              aria-label={`Select Confidential ${formatSymbol(displayedAsset?.metadata.symbol)} asset`}
            >
              {displayedAsset && (
                <TokenIcon
                  assetId={displayedAsset.asset.id}
                  symbol={formatSymbol(displayedAsset.metadata.symbol)}
                  icon={displayedAsset.metadata.iconUrl}
                  blockchain={source ? withdrawChainIconAlias(source.chain.chain) : undefined}
                  size={24}
                />
              )}
              <span className="flex min-w-0 flex-col items-start gap-0.5 leading-none">
                <span className="max-w-[7ch] truncate">
                  {displayedAsset ? formatSymbol(displayedAsset.metadata.symbol) : 'Token'}
                </span>
                {source && (
                  <span className="text-[10px] text-muted">{source.chain.chain.displayName}</span>
                )}
              </span>
              <Icon icon="lucide:chevron-down" width={16} height={16} className="shrink-0" />
            </button>
          }
          balance={
            <span
              className="min-w-0 truncate"
              title={
                source && !balancesHidden
                  ? formatBaseUnitDecimalAmount(availableRaw, source.asset.metadata.decimals)
                  : undefined
              }
            >
              {balancesHidden
                ? '••••'
                : source
                  ? formatTokenQuantity(
                      formatBaseUnitDecimalAmount(availableRaw, source.asset.metadata.decimals)
                    )
                  : '—'}
            </span>
          }
          maxButton={
            <button
              type="button"
              disabled={busy || !source || availableRaw === '0'}
              title={availableRaw === '0' ? 'Shield balance unavailable' : 'Use maximum balance'}
              onClick={() => {
                if (!source) return
                keepSelectedSource()
                setAmount(formatBaseUnitDecimalAmount(availableRaw, source.asset.metadata.decimals))
              }}
              className="rounded-md bg-white/10 px-2 py-1 font-medium text-muted disabled:opacity-40"
            >
              Max
            </button>
          }
          footer={
            <SendFormActions
              loading={busy}
              disabled={
                !canManageNear ||
                !currentBalances ||
                !source ||
                !destination ||
                !amountState?.amountRaw ||
                !recipientValid ||
                !preview ||
                previewLoading ||
                recoveryPending ||
                Boolean(error) ||
                Boolean(balanceError)
              }
              onContinue={() => void prepare()}
            />
          }
        >
          {routeDetails}
        </SendFormView>
      )}
      <Dialog open={active && picker !== null} onOpenChange={open => !open && setPicker(null)}>
        <DialogContent
          position="bottom"
          className="max-h-[80vh] min-h-0 overflow-y-auto bg-wallet-surface p-4 pb-6"
        >
          <DialogTitle>
            {picker === 'slippage'
              ? 'Slippage'
              : picker === 'move-destination'
                ? 'Move to'
                : 'Recipient'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Set {actionLabel} {picker}
          </DialogDescription>
          {picker === 'slippage' ? (
            <SlippageSettingContent
              key={slippage}
              currentSlippage={slippage}
              onSave={value => {
                setSlippage(value)
                setPicker(null)
              }}
            />
          ) : picker === 'move-destination' ? (
            <div className="space-y-2">
              {ownZcashRecipients.map(item => (
                <ZcashMoveAccountCard
                  key={item.address}
                  label="To"
                  source={item.privacy}
                  accountName={activeAccount?.accountDisplayName ?? ''}
                  address={item.address}
                  selected={recipient === item.address}
                  disabled={busy}
                  onClick={() => {
                    setRecipient(item.address)
                    setPicker(null)
                  }}
                />
              ))}
            </div>
          ) : picker === 'recipient' && destination ? (
            <RecipientSelector
              chainId={destination.chain.chain.id}
              includeCurrentAccount
              onSelect={address => {
                setRecipient(address)
                setPicker(null)
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ChainSelector
        open={active && networkPickerOpen}
        onOpenChange={setNetworkPickerOpen}
        options={networkOptions}
        enabledFirst
        selectedId={selectedDestinationNetworkId}
        onSelect={id => {
          const next = selectShieldWithdrawDestinationForNetwork(destinations, source, id)
          if (!next) return
          if (selectedDestinationNetworkId !== id) setRecipient('')
          setDestinationNetworkId(id)
        }}
      />
    </div>
  )
}
