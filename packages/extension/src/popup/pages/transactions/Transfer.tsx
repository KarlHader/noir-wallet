import { useEffect, useMemo, useRef, useState } from 'react'
import { isDerivedAccount } from '@/core/accounts/domain'
import { useLocation, useNavigate as useRouterNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import { formatBaseUnitAmount, formatTokenQuantity, formatFiatAmount } from '@/lib/number-format'
import { formatSortAddress, formatWalletNameAtIndex, getAccountDisplayName } from '@/lib/format'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { cn } from '@/lib/utils'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useNavigate } from '@/popup/provider/Router'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import { useMoveMethodEstimate } from '@/popup/hooks/useMoveMethodEstimate'
import {
  clusterMoveEstimate,
  estimateDirectMove,
  formatMoveMethodFee,
  type MoveMethodEstimate
} from '@/popup/services/move-method-estimate'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { ExecutionAccountIcon } from '@/popup/components/account/ExecutionAccountSelector'
import nearLogo from '@/images/figma-near-confidential.svg'
import { Button } from '@/popup/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { rheaSwapClient } from '@/popup/services/rhea-swap-client'
import { resolveRheaPrivateTransferToken } from '@/core/services/rhea-swap'
import type { SwapToken } from '@/core/services/intents-api'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { listMoveAssetPickerRows } from '@/popup/services/move-asset-picker'
import {
  confidentialFundingClient,
  type ConfidentialBalance
} from '@/popup/services/confidential-funding-client'
import type {
  ConfidentialFundingPlan,
  ConfidentialFundingReview
} from '@/core/services/confidential-funding'
import { getConfidentialAvailableForAsset } from '@/core/services/confidential-funding'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import {
  buildShieldTransferRequest,
  hasShieldTransferStarted,
  isClusterTransferRoute,
  isUnsignedShieldTerminal,
  isShieldTransferRoute,
  listShieldFundingAssets,
  listShieldMoveDestinations,
  matchesShieldReview,
  resolveShieldManagedAsset,
  shieldFundingSources,
  shieldPortfolioBalances,
  shieldQuoteFeeRaw
} from '@/popup/services/shield-transfer'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import {
  createNativeTransferSource,
  estimateConfidentialTransferMaximum,
  fallbackTransferMaximum
} from '@/popup/services/transfer-maximum'
import {
  normalizePrivateBalanceTransferInput,
  getPrivateTransferChainIds,
  getTransferDomainBalanceRaw,
  resolvePrivateBalanceTransferAmount,
  resolvePrivateBalanceTransferSource,
  selectDefaultTransferAssetId,
  type PrivateBalanceTransferDirection,
  type TransferDomain
} from '@/popup/services/private-balance-transfer'
import {
  buildAddToPrivateEvmPath,
  buildMoveToMainEvmPath,
  getEvmTokenFeeBalanceError
} from './evm-send-validation'
import { initialMoveDraft, readMoveAssetHint, readMoveDraft } from './move-draft'
import {
  readShieldMovePreference,
  selectShieldMoveAssetId,
  shieldMovePreferenceKey,
  type ShieldMovePreference
} from './move-preference'

type TransferAsset = { asset: PortfolioAssetView; chain: PortfolioChainView }

function domainLabel(domain: TransferDomain): string {
  return domain === 'shield' ? 'Shield' : domain === 'private' ? 'Private' : 'Public'
}

function DomainCard({
  label,
  accountName,
  domain,
  address,
  network,
  networkName,
  onNetworkClick,
  onAccountClick,
  showNetwork = false,
  disabled
}: {
  label: 'From' | 'To'
  accountName: string
  domain: TransferDomain
  address: string
  network: string
  networkName: string
  onNetworkClick: () => void
  onAccountClick: () => void
  showNetwork?: boolean
  disabled?: boolean
}) {
  return (
    <div className="w-full rounded-xl border border-white/5 bg-wallet-surface px-4 py-4">
      <p className="mb-3 text-xs font-medium text-muted">{label}</p>
      <button
        type="button"
        onClick={onAccountClick}
        disabled={disabled}
        aria-label={`${label}: ${domainLabel(domain)}. Change account`}
        className="wallet-interactive flex w-full min-w-0 items-center gap-3 rounded text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        {domain === 'shield' ? (
          <img src={nearLogo} alt="" aria-hidden="true" className="size-7 shrink-0 rounded" />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-muted">
            <Icon icon="lucide:wallet" width={19} height={19} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          {domain === 'shield' ? (
            <>
              <span className="block text-xs text-muted">Shield</span>
              <span className="block truncate text-base font-medium">
                NEAR Confidential Intents
              </span>
            </>
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <span className="truncate">{accountName}</span>
                <span
                  className={cn(
                    'shrink-0 rounded-md px-2 py-0.5',
                    domain === 'private' ? 'bg-warning/10 text-warning' : 'bg-white/10 text-muted'
                  )}
                >
                  {domainLabel(domain)}
                </span>
              </span>
              <span className="mt-1 block truncate text-base font-medium" title={address}>
                {address ? formatSortAddress(address) : '—'}
              </span>
            </>
          )}
        </span>
        <Icon icon="lucide:chevron-down" width={15} height={15} className="shrink-0 text-muted" />
      </button>
      {showNetwork && domain !== 'shield' && (
        <button
          type="button"
          onClick={onNetworkClick}
          disabled={disabled}
          aria-label={`Select ${label.toLowerCase()} network`}
          className="wallet-interactive mt-4 flex w-full items-center gap-3 rounded text-left focus-visible:outline-2 focus-visible:outline-primary"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-muted">
            <Icon icon="lucide:globe" width={19} height={19} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted">Network</span>
            <span className="mt-1 flex items-center gap-1.5 text-base font-medium">
              <ChainIcon
                chain={network}
                width={16}
                height={16}
                showTooltip={false}
                alt=""
                aria-hidden="true"
                className="shrink-0 rounded"
              />
              <span className="truncate">{networkName || 'Select network'}</span>
            </span>
          </span>
          <Icon icon="lucide:chevron-down" width={15} height={15} className="shrink-0 text-muted" />
        </button>
      )}
    </div>
  )
}

function MethodCard({
  title,
  detail,
  recommended,
  selected,
  estimate,
  fee,
  onClick
}: {
  title: 'Cluster' | 'Directly'
  detail: string
  recommended: boolean
  selected: boolean
  estimate: MoveMethodEstimate
  fee: { value: string; detail: string | null }
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-label={title}
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'relative flex min-h-[150px] flex-col rounded-xl border bg-wallet-surface px-3 py-4 text-left text-xs leading-4',
        selected ? 'border-primary/60' : 'border-white/10'
      )}
    >
      {recommended && (
        <span className="absolute -top-2.5 left-3 rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
          Recommended
        </span>
      )}
      <span className="flex items-center justify-between gap-1 text-sm font-medium leading-[18px]">
        <span>{title}</span>
        <Icon
          icon={selected ? 'lucide:circle-check' : 'lucide:circle'}
          width={17}
          height={17}
          className={selected ? 'text-primary' : 'text-muted'}
        />
      </span>
      <span className="mt-2 text-muted">{detail}</span>
      <span className="mt-4 flex justify-between gap-2">
        <span className="text-muted">Privacy</span>
        <span>{title === 'Cluster' ? 'Strong' : 'Standard'}</span>
      </span>
      {estimate.time !== '—' && (
        <span className="mt-2 flex justify-between gap-2">
          <span className="shrink-0 text-muted">Time (est.)</span>
          <span className="min-w-0 text-right">
            <span className="block">{estimate.time}</span>
            <span className="block text-[10px] text-muted">{estimate.timeScope}</span>
          </span>
        </span>
      )}
      <span className="mt-2 flex justify-between gap-2">
        <span className="shrink-0 text-muted">Fee (est.)</span>
        <span className="min-w-0 break-words text-right">
          <span className="block">{fee.value}</span>
          {fee.detail && <span className="block text-[10px] text-muted">{fee.detail}</span>}
        </span>
      </span>
    </button>
  )
}

export function Transfer() {
  const [params] = useSearchParams()
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  return <TransferForm key={`${network}:${walletId}:${accountId}:${params.toString()}`} />
}

function TransferForm() {
  const [params] = useSearchParams()
  const location = useLocation()
  const routerNavigate = useRouterNavigate()
  const walletMode = params.get('mode') === 'private' ? 'private' : 'public'
  const routeFrom = params.get('from')
  const routeTo = params.get('to')
  const routeAssetId = params.get('assetId')
  const entry = params.get('entry')
  const shieldEntry =
    entry === 'shield' &&
    (params.get('provider') === null || params.get('provider') === 'near-confidential')
  const fromAssetDetail = params.get('entry') === 'asset-detail'
  const { goBack, navigate } = useNavigate()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const wallets = useWalletStore(state => state.wallets)
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const endpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const { activeAccount, catalog } = useActiveAccountNetworks()
  const effective = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const scopeKey = `${currentNetwork}:${effective?.walletId ?? ''}:${effective?.accountId ?? ''}:${endpointRuntimeKey}`
  const preferenceKey =
    shieldEntry && effective
      ? shieldMovePreferenceKey(currentNetwork, effective.walletId, effective.accountId)
      : null
  const initialDraft = initialMoveDraft({
    state: location.state,
    scope: scopeKey,
    mode: walletMode,
    routeFrom,
    routeTo,
    routeAssetId,
    entry
  })
  const initialRouteState = useRef(location.state).current
  const launchDraft = initialMoveDraft({
    state: initialRouteState,
    scope: scopeKey,
    mode: walletMode,
    routeFrom,
    routeTo,
    routeAssetId,
    entry
  })
  const launchHasDraft = readMoveDraft(initialRouteState, scopeKey) !== null
  const moveAssetHint = readMoveAssetHint(location.state, scopeKey, initialDraft.assetId)
  const latestScopeKey = useRef(scopeKey)
  latestScopeKey.current = scopeKey
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const {
    model: portfolio,
    status: loadState,
    settled: portfolioSettled,
    refresh: refreshPortfolio
  } = useHomePortfolio(effective?.walletId ?? null, effective?.accountId ?? null)
  const [retry, setRetry] = useState(0)
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [assetSearch, setAssetSearch] = useState('')
  const [assetChainId, setAssetChainId] = useState('all')
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const [networkSearch, setNetworkSearch] = useState('')
  const [destinationAssetId, setDestinationAssetId] = useState<string | null>(
    initialDraft.destinationAssetId ?? null
  )
  const [assetPrices, setAssetPrices] = useState<AssetPriceReadModel | null>(null)
  const [domainPicker, setDomainPicker] = useState<'from' | 'to' | null>(null)
  const [pickerAccountId, setPickerAccountId] = useState<string | null>(null)
  const [draftScope, setDraftScope] = useState(scopeKey)
  const [selectedAssetId, setSelectedAssetId] = useState(initialDraft.assetId)
  const [from, setFrom] = useState<TransferDomain>(initialDraft.from)
  const [to, setTo] = useState<TransferDomain>(initialDraft.to)
  const [amount, setAmount] = useState(initialDraft.amount)
  const [method, setMethod] = useState<'cluster' | 'directly'>(initialDraft.method)
  const [maxSelected, setMaxSelected] = useState(initialDraft.maxSelected)
  const [loadedPreference, setLoadedPreference] = useState<{
    key: string
    value: ShieldMovePreference | null
  } | null>(null)
  const rememberedMove = loadedPreference?.key === preferenceKey ? loadedPreference.value : null
  const preferenceReady = loadedPreference?.key === preferenceKey
  const [preferenceAppliedScope, setPreferenceAppliedScope] = useState<string | null>(null)
  const userEditedMove = useRef(false)
  const [catalogReady, setCatalogReady] = useState(false)
  const [routeSnapshot, setRouteSnapshot] = useState<{
    key: string
    status: 'supported' | 'unsupported' | 'error'
  } | null>(null)
  const [managedAssets, setManagedAssets] = useState<readonly IntentsManagedAsset[]>([])
  const [catalogTokens, setCatalogTokens] = useState<readonly SwapToken[]>([])
  const [shieldSnapshot, setShieldSnapshot] = useState<{
    key: string
    balances: readonly ConfidentialBalance[]
  } | null>(null)
  const [shieldConnection, setShieldConnection] = useState<
    'checking' | 'connected' | 'required' | 'busy'
  >('checking')
  const [shieldError, setShieldError] = useState<string | null>(null)
  const [preparingShield, setPreparingShield] = useState(false)
  const [confirmingShield, setConfirmingShield] = useState(false)
  const [confirmUncertain, setConfirmUncertain] = useState(false)
  const [cancellingShield, setCancellingShield] = useState(false)
  const confirmAttemptedPlanId = useRef<string | null>(null)
  const [preparedShield, setPreparedShield] = useState<{
    key: string
    review: ConfidentialFundingReview
  } | null>(null)
  const canLoadShield =
    getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet').length > 0

  useEffect(() => {
    let cancelled = false
    setCatalogReady(false)
    void (async () => {
      try {
        const cached = await swapTokenCatalogClient.readCached()
        if (!cancelled && cached.length) {
          setCatalogTokens(cached)
          setManagedAssets(resolveManagedIntentsCatalog(cached))
        }
        const tokens = await swapTokenCatalogClient.refresh()
        if (!cancelled) {
          setCatalogTokens(tokens)
          setManagedAssets(resolveManagedIntentsCatalog(tokens))
        }
      } catch {
        if (!cancelled) {
          setCatalogTokens([])
          setManagedAssets([])
        }
      } finally {
        if (!cancelled) setCatalogReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentNetwork, endpointRuntimeKey])

  useEffect(() => {
    if (!preferenceKey) return
    let cancelled = false
    void chrome.storage.local
      .get(preferenceKey)
      .then(result => {
        if (cancelled) return
        setLoadedPreference({
          key: preferenceKey,
          value: readShieldMovePreference(result[preferenceKey])
        })
      })
      .catch(() => {
        if (!cancelled) setLoadedPreference({ key: preferenceKey, value: null })
      })
    return () => {
      cancelled = true
    }
  }, [preferenceKey])

  useEffect(() => {
    if (!assetPickerOpen) return
    setAssetSearch('')
    setAssetChainId('all')
    let cancelled = false
    const apply = (prices: AssetPriceReadModel | null) => {
      if (!cancelled && prices) setAssetPrices(prices)
    }
    void (async () => {
      try {
        apply(await assetPriceClient.getPrices('read'))
      } catch {}
      try {
        apply(await assetPriceClient.getPrices('refresh'))
      } catch {}
    })()
    return () => {
      cancelled = true
    }
  }, [assetPickerOpen, currentNetwork])

  useEffect(() => {
    let cancelled = false
    setShieldSnapshot(null)
    setShieldConnection('checking')
    if (!effective || !canLoadShield) return
    const scope = {
      network: currentNetwork,
      keyDomainId: effective.walletId,
      accountId: effective.accountId
    }
    void confidentialFundingClient
      .refreshBalances(scope, true)
      .then(balances => {
        if (cancelled) return
        setShieldSnapshot({ key: scopeKey, balances })
        setShieldConnection('connected')
        void refreshPortfolio(true)
      })
      .catch(() => {
        if (!cancelled) {
          setShieldConnection('required')
          setShieldError('Unable to load Shield balances. Please try again.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [scopeKey, canLoadShield])

  useEffect(() => {
    userEditedMove.current = false
    const draft = initialMoveDraft({
      state: location.state,
      scope: scopeKey,
      mode: walletMode,
      routeFrom,
      routeTo,
      routeAssetId,
      entry
    })
    setDraftScope(scopeKey)
    setFrom(draft.from)
    setTo(draft.to)
    setSelectedAssetId(draft.assetId)
    setDestinationAssetId(draft.destinationAssetId ?? null)
    setAmount(draft.amount)
    setMethod(draft.method)
    setMaxSelected(draft.maxSelected)
    setPreparingShield(false)
    setConfirmingShield(false)
    setCancellingShield(false)
    setShieldError(null)
    setConfirmUncertain(false)
    setAssetPickerOpen(false)
    setNetworkPickerOpen(false)
    setDomainPicker(null)
    setPickerAccountId(null)
  }, [scopeKey])

  useEffect(() => {
    if (!effective || draftScope !== scopeKey) return
    const previousState =
      location.state && typeof location.state === 'object' && !Array.isArray(location.state)
        ? location.state
        : {}
    routerNavigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: {
        ...previousState,
        moveDraft: {
          scope: scopeKey,
          assetId: selectedAssetId,
          destinationAssetId,
          from,
          to,
          amount,
          method,
          maxSelected
        }
      }
    })
  }, [
    effective?.walletId,
    effective?.accountId,
    draftScope,
    scopeKey,
    selectedAssetId,
    destinationAssetId,
    from,
    to,
    amount,
    method,
    maxSelected,
    location.pathname,
    location.search,
    routerNavigate
  ])

  const eligibleChainIds = useMemo(
    () => getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet'),
    [activeAccount, currentNetwork]
  )
  const currentShieldBalances = useMemo(
    () =>
      shieldSnapshot?.key === scopeKey
        ? shieldSnapshot.balances
        : shieldPortfolioBalances(portfolio),
    [shieldSnapshot, scopeKey, portfolio]
  )
  const assets = useMemo<TransferAsset[]>(() => {
    if (!portfolio) return []
    const chains = new Map(portfolio.chains.map(chain => [chain.chain.id, chain]))
    const publicAssets = portfolio.assets.flatMap(asset => {
      const chain = chains.get(asset.asset.chainId)
      return chain?.chain.family === 'evm' &&
        eligibleChainIds.includes(chain.chain.id) &&
        chain.chain.capabilities.transaction.status === 'available'
        ? [{ asset, chain }]
        : []
    })
    const shieldAssets = listShieldFundingAssets(
      portfolio,
      managedAssets,
      catalogTokens,
      currentNetwork
    )
    const fallbackAssets = shieldEntry
      ? shieldAssets
      : shieldFundingSources(shieldAssets, currentShieldBalances)
    const existing = new Set(publicAssets.map(item => item.asset.asset.id))
    return [
      ...publicAssets,
      ...fallbackAssets
        .filter(
          item =>
            eligibleChainIds.includes(item.chain.chain.id) && !existing.has(item.asset.asset.id)
        )
        .map(({ asset, chain }) => ({ asset, chain }))
    ]
  }, [
    portfolio,
    currentShieldBalances,
    managedAssets,
    catalogTokens,
    currentNetwork,
    eligibleChainIds,
    shieldEntry
  ])
  const defaultAssetId = useMemo(
    () =>
      shieldEntry
        ? selectShieldMoveAssetId({
            assets,
            from,
            eligibleChainIds,
            managedAssets,
            catalogTokens,
            network: currentNetwork,
            shieldBalances: currentShieldBalances
          })
        : selectDefaultTransferAssetId({ assets, from, to, eligibleChainIds }),
    [
      assets,
      from,
      to,
      eligibleChainIds,
      shieldEntry,
      managedAssets,
      catalogTokens,
      currentNetwork,
      currentShieldBalances
    ]
  )
  useEffect(() => {
    if (
      !shieldEntry ||
      !effective ||
      !preferenceReady ||
      !catalogReady ||
      !portfolioSettled ||
      assets.length === 0 ||
      (rememberedMove?.from === 'shield' && shieldConnection === 'checking') ||
      preferenceAppliedScope === scopeKey ||
      draftScope !== scopeKey
    )
      return
    if (!userEditedMove.current && !launchHasDraft) {
      const useRememberedDomains = !routeFrom && !routeTo && rememberedMove !== null
      const preferredFrom = useRememberedDomains ? rememberedMove.from : launchDraft.from
      const preferredTo = useRememberedDomains ? rememberedMove.to : launchDraft.to
      const preferredAssetId = routeAssetId ?? rememberedMove?.assetId ?? null
      const preferredAsset = selectShieldMoveAssetId({
        assets,
        from: preferredFrom,
        eligibleChainIds,
        managedAssets,
        catalogTokens,
        network: currentNetwork,
        shieldBalances: currentShieldBalances,
        preferredAssetId
      })
      const fallbackToPublic = preferredFrom === 'shield' && !preferredAsset
      const nextFrom = fallbackToPublic ? 'public' : preferredFrom
      const nextTo = fallbackToPublic ? 'shield' : preferredTo
      const nextAsset = fallbackToPublic
        ? selectShieldMoveAssetId({
            assets,
            from: 'public',
            eligibleChainIds,
            managedAssets,
            catalogTokens,
            network: currentNetwork,
            preferredAssetId: routeAssetId
          })
        : preferredAsset
      if (!nextAsset && !routeAssetId) return
      setFrom(nextFrom)
      setTo(nextTo)
      if (!routeAssetId) setSelectedAssetId(nextAsset)
      setDestinationAssetId(
        !routeAssetId && nextFrom === 'shield' ? (rememberedMove?.destinationAssetId ?? null) : null
      )
    }
    setPreferenceAppliedScope(scopeKey)
  }, [
    shieldEntry,
    effective,
    preferenceReady,
    catalogReady,
    portfolioSettled,
    shieldConnection,
    currentShieldBalances,
    preferenceAppliedScope,
    draftScope,
    scopeKey,
    launchHasDraft,
    launchDraft,
    routeFrom,
    routeTo,
    routeAssetId,
    rememberedMove,
    assets,
    eligibleChainIds,
    managedAssets,
    catalogTokens,
    currentNetwork
  ])
  const selected =
    assets.find(item => item.asset.asset.id === (selectedAssetId ?? defaultAssetId)) ?? null
  const requestedChainId = selectedAssetId?.split('/')[0]
  const requestedChain = portfolio?.chains.find(chain => chain.chain.id === requestedChainId)
  const requestedAssetKnown =
    portfolio?.assets.some(asset => asset.asset.id === selectedAssetId) ||
    portfolio?.confidential?.assets.some(asset => asset.assetId === selectedAssetId)
  const requestedAssetUnavailable = Boolean(
    portfolioSettled &&
    portfolio &&
    activeAccount &&
    selectedAssetId &&
    (!requestedChain ||
      (requestedChain.status === 'ready' &&
        (!eligibleChainIds.includes(requestedChain.chain.id) ||
          requestedChain.chain.capabilities.transaction.status !== 'available' ||
          !requestedAssetKnown)))
  )
  const pendingAssetHint =
    !selected && !requestedAssetUnavailable && selectedAssetId === initialDraft.assetId
      ? moveAssetHint
      : null
  const pickerRows = useMemo(
    () =>
      listMoveAssetPickerRows({
        assets,
        from,
        network: currentNetwork,
        prices: assetPrices,
        portfolio,
        shieldBalances: currentShieldBalances,
        managedAssets,
        catalogTokens
      }),
    [
      assets,
      from,
      currentNetwork,
      assetPrices,
      portfolio,
      currentShieldBalances,
      managedAssets,
      catalogTokens
    ]
  )
  const accountNetwork = activeAccount?.networks.find(
    item => item.chain.id === selected?.chain.chain.id
  )
  const mainAddress =
    accountNetwork?.addresses.find(address => address.preferredForReceive)?.value ?? ''
  const privateAddress = accountNetwork?.privateExecutionAddress ?? ''
  const eligible = Boolean(selected && eligibleChainIds.includes(selected.chain.chain.id))
  const direction: PrivateBalanceTransferDirection =
    from === 'private' ? 'private-to-main' : 'main-to-private'
  const publicRaw = selected ? getTransferDomainBalanceRaw(selected.asset, 'public') : null
  const privateRaw = selected ? getTransferDomainBalanceRaw(selected.asset, 'private') : null
  const sourceRaw = selected ? getTransferDomainBalanceRaw(selected.asset, from) : null
  const nativeFeeAsset =
    selected?.chain.chain.family === 'evm'
      ? portfolio?.assets.find(
          asset =>
            asset.asset.chainId === selected.asset.asset.chainId && asset.asset.kind === 'native'
        )
      : null
  const nativeFeeRaw =
    nativeFeeAsset && from !== 'shield' ? getTransferDomainBalanceRaw(nativeFeeAsset, from) : null
  const tokenFeeBalanceError =
    selected?.asset.asset.kind === 'token' && nativeFeeAsset && nativeFeeRaw !== null
      ? getEvmTokenFeeBalanceError('token', nativeFeeRaw, nativeFeeAsset.metadata.symbol)
      : null
  const source =
    selected?.chain.chain.family === 'evm'
      ? resolvePrivateBalanceTransferSource({
          direction,
          mainBalanceRaw: publicRaw ?? '0',
          privateBalanceRaw: privateRaw ?? '0',
          mainAddress,
          privateAddress
        })
      : null
  const supportedPair =
    (from === 'public' && to === 'private') || (from === 'private' && to === 'public')
  const shieldPair = isShieldTransferRoute(from, to) && selected?.chain.chain.family === 'evm'
  const clusterPair = isClusterTransferRoute(from, to) && selected?.chain.chain.family === 'evm'
  const clusterSelected = method === 'cluster' && clusterPair
  const fundingRoute = Boolean(shieldPair || clusterSelected)
  const managedAsset = useMemo(
    () =>
      selected
        ? resolveShieldManagedAsset(selected.asset, managedAssets, catalogTokens, currentNetwork)
        : null,
    [selected?.asset, managedAssets, catalogTokens, currentNetwork]
  )
  const destinationOptions = useMemo(() => {
    if (from !== 'shield' || !selected || !managedAsset) return []
    const options = listShieldFundingAssets(
      portfolio,
      managedAssets,
      catalogTokens,
      currentNetwork
    ).filter(item =>
      activeAccount?.networks.some(
        network =>
          network.chain.id === item.chain.chain.id &&
          network.addresses.some(address => address.preferredForReceive) &&
          (to === 'public' || Boolean(network.privateExecutionAddress))
      )
    )
    return listShieldMoveDestinations(
      { ...selected, managed: managedAsset },
      options,
      currentNetwork
    )
  }, [
    from,
    to,
    activeAccount,
    selected,
    managedAsset,
    portfolio,
    managedAssets,
    catalogTokens,
    currentNetwork,
    eligibleChainIds
  ])
  const destination =
    from === 'shield'
      ? (destinationOptions.find(item => item.asset.asset.id === destinationAssetId) ??
        destinationOptions.find(item => item.asset.asset.id === selected?.asset.asset.id) ??
        null)
      : null
  useEffect(() => {
    if (
      !preferenceKey ||
      preferenceAppliedScope !== scopeKey ||
      !userEditedMove.current ||
      !catalogReady ||
      !portfolioSettled ||
      !selected ||
      !eligible ||
      !managedAsset ||
      !isShieldTransferRoute(from, to) ||
      (from === 'shield' && !destination) ||
      (from === 'shield'
        ? !currentShieldBalances ||
          BigInt(
            getConfidentialAvailableForAsset(currentShieldBalances, managedAsset.protocolAssetId) ??
              '0'
          ) === 0n
        : getTransferDomainBalanceRaw(selected.asset, from) === null)
    )
      return
    const preference: ShieldMovePreference = {
      provider: 'near-confidential',
      assetId: selected.asset.asset.id,
      destinationAssetId: from === 'shield' ? (destination?.asset.asset.id ?? null) : null,
      from,
      to
    }
    void chrome.storage.local.set({ [preferenceKey]: preference }).catch(() => {})
  }, [
    preferenceKey,
    preferenceAppliedScope,
    scopeKey,
    catalogReady,
    portfolioSettled,
    selected,
    eligible,
    managedAsset,
    destination,
    from,
    to,
    currentShieldBalances
  ])
  const targetAsset = from === 'shield' ? destination : selected
  const targetNetwork = activeAccount?.networks.find(
    item => item.chain.id === targetAsset?.chain.chain.id
  )
  const targetAddress =
    to === 'private'
      ? (targetNetwork?.privateExecutionAddress ?? '')
      : (targetNetwork?.addresses.find(address => address.preferredForReceive)?.value ?? '')
  const hasShieldSnapshot = shieldSnapshot?.key === scopeKey
  const refreshedShieldRaw =
    managedAsset && hasShieldSnapshot
      ? (getConfidentialAvailableForAsset(shieldSnapshot.balances, managedAsset.protocolAssetId) ??
        '0')
      : null
  const shieldSourceRaw = from === 'shield' ? refreshedShieldRaw : sourceRaw
  const routeKey = `${scopeKey}:${selected?.asset.asset.id ?? ''}:${from}:${to}:${destination?.asset.asset.id ?? ''}`
  const routeState = routeSnapshot?.key === routeKey ? routeSnapshot.status : 'loading'
  const methodAvailable = supportedPair && routeState === 'supported'

  useEffect(() => {
    let cancelled = false
    if (!selected || selected.chain.chain.family !== 'evm' || !eligible || !supportedPair) {
      setRouteSnapshot({ key: routeKey, status: 'unsupported' })
      return
    }
    const match = /^eip155:([1-9][0-9]*)$/.exec(selected.chain.chain.id)
    if (!match) {
      setRouteSnapshot({ key: routeKey, status: 'unsupported' })
      return
    }
    setRouteSnapshot(null)
    void rheaSwapClient
      .listTokens({ direction: 'from', tokenListChainIds: [Number(match[1])] })
      .then(catalog => {
        if (cancelled) return
        const contract =
          selected.asset.asset.kind === 'token'
            ? selected.asset.asset.reference.toLowerCase()
            : null
        setRouteSnapshot({
          key: routeKey,
          status: resolveRheaPrivateTransferToken(catalog.tokens, contract)
            ? 'supported'
            : catalog.failedChainIds.includes(Number(match[1]))
              ? 'error'
              : 'unsupported'
        })
      })
      .catch(() => {
        if (!cancelled) setRouteSnapshot({ key: routeKey, status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [routeKey, selected?.chain.chain.id, eligible, supportedPair, retry])

  const nativeMaximumEnabled = Boolean(
    selected &&
    source &&
    eligible &&
    (clusterSelected
      ? Boolean(managedAsset)
      : supportedPair
        ? routeState === 'supported'
        : fundingRoute && from !== 'shield' && Boolean(managedAsset)) &&
    (direction === 'main-to-private' ? publicRaw !== null : privateRaw !== null) &&
    selected.asset.asset.kind === 'native' &&
    BigInt(source.availableRaw) > 0n
  )
  const nativeMaximumRequired =
    maxSelected && selected?.asset.asset.kind === 'native' && from !== 'shield'
  const maximum = useTransferMaximum({
    prefetch: selected?.chain.chain.family === 'evm',
    enabled: nativeMaximumEnabled,
    requestKey: `${scopeKey}:${selected?.asset.asset.id ?? ''}:${direction}:${source?.availableRaw ?? '0'}`,
    fallback: () =>
      fallbackTransferMaximum(
        createNativeTransferSource({
          asset: selected!.asset,
          chain: selected!.chain,
          availableRaw: source!.availableRaw,
          sender: source!.sender
        })
      ),
    estimate: () =>
      estimateConfidentialTransferMaximum({
        asset: selected!.asset,
        chain: selected!.chain,
        availableRaw: source!.availableRaw,
        sender: source!.sender,
        recipient: source!.recipient,
        executionMode: source!.executionMode
      })
  })
  useEffect(() => {
    if (
      nativeMaximumRequired &&
      nativeMaximumEnabled &&
      !maximum.value &&
      !maximum.loading &&
      !maximum.error
    )
      void maximum.request()
  }, [
    nativeMaximumRequired,
    nativeMaximumEnabled,
    maximum.value,
    maximum.loading,
    maximum.error,
    routeKey,
    source?.availableRaw
  ])
  const available =
    selected && source
      ? resolvePortfolioTransferAvailability({
          balanceRaw: source.availableRaw,
          decimals: selected.asset.metadata.decimals,
          isNative: selected.asset.asset.kind === 'native',
          maximumRaw: maximum.value?.amountRaw ?? null
        })
      : null
  const shieldAvailable =
    selected && fundingRoute && shieldSourceRaw !== null
      ? resolvePortfolioTransferAvailability({
          balanceRaw: shieldSourceRaw,
          decimals: selected.asset.metadata.decimals,
          isNative: from !== 'shield' && selected.asset.asset.kind === 'native',
          maximumRaw: from === 'shield' ? shieldSourceRaw : (maximum.value?.amountRaw ?? null)
        })
      : null
  const currentAmount = maxSelected
    ? nativeMaximumRequired && (!maximum.value || maximum.loading)
      ? ''
      : ((fundingRoute ? shieldAvailable : available)?.display ?? '')
    : amount
  useEffect(() => {
    if (!maxSelected) return
    if (nativeMaximumRequired && (!maximum.value || maximum.loading)) {
      setAmount('')
      return
    }
    const value = fundingRoute ? shieldAvailable : available
    if (value) setAmount(value.display)
  }, [
    maxSelected,
    nativeMaximumRequired,
    maximum.value,
    maximum.loading,
    fundingRoute,
    shieldAvailable?.display,
    available?.display
  ])
  const amountState =
    selected && available && source && supportedPair
      ? resolvePrivateBalanceTransferAmount({
          amount: currentAmount,
          decimals: selected.asset.metadata.decimals,
          availableRaw: available.amountRaw,
          sourceLabel: source.sourceLabel
        })
      : null
  const shieldAmountState =
    selected && shieldAvailable
      ? resolvePrivateBalanceTransferAmount({
          amount: currentAmount,
          decimals: selected.asset.metadata.decimals,
          availableRaw: shieldAvailable.amountRaw,
          sourceLabel: from === 'public' ? 'Public' : from === 'private' ? 'Private' : 'Shield'
        })
      : null
  const amountError = fundingRoute ? shieldAmountState?.error : amountState?.error
  const transferError =
    amountError ??
    ((fundingRoute ? shieldAmountState?.amountRaw : amountState?.amountRaw)
      ? tokenFeeBalanceError
      : null)
  const methodAmount =
    selected && source && clusterPair
      ? resolvePrivateBalanceTransferAmount({
          amount: currentAmount,
          decimals: selected.asset.metadata.decimals,
          availableRaw: source.availableRaw,
          sourceLabel: source.sourceLabel
        })
      : null
  const estimateAmountRaw = methodAmount?.error ? null : methodAmount?.amountRaw
  const methodEstimateKey = `${routeKey}:${estimateAmountRaw ?? ''}:${source?.sender}:${source?.recipient}:${source?.executionMode}:${source?.availableRaw}:${retry}`
  const canEstimateMethods = Boolean(
    draftScope === scopeKey &&
    clusterPair &&
    selected &&
    eligible &&
    source &&
    estimateAmountRaw &&
    !tokenFeeBalanceError &&
    !preparingShield &&
    !preparedShield
  )
  const directEstimate = useMoveMethodEstimate({
    enabled: canEstimateMethods && methodAvailable,
    requestKey: methodEstimateKey,
    estimate: signal =>
      estimateDirectMove({
        asset: selected!.asset,
        chain: selected!.chain,
        nativeFeeAsset: nativeFeeAsset ?? null,
        amountRaw: estimateAmountRaw!,
        sender: source!.sender,
        recipient: source!.recipient,
        executionMode: source!.executionMode,
        signal
      })
  })
  const clusterEstimate = useMoveMethodEstimate({
    enabled:
      canEstimateMethods && Boolean(managedAsset && effective && shieldConnection === 'connected'),
    requestKey: `${methodEstimateKey}:${shieldConnection}`,
    estimate: async signal => {
      const request = buildShieldTransferRequest({
        network: currentNetwork,
        keyDomainId: effective!.walletId,
        accountId: effective!.accountId,
        from,
        to,
        method: 'cluster',
        amountRaw: estimateAmountRaw!,
        asset: selected!.asset,
        chain: selected!.chain,
        managed: managedAsset!
      })
      const preview = await confidentialFundingClient.preview(request)
      signal.throwIfAborted()
      return clusterMoveEstimate(estimateAmountRaw!, preview)
    }
  })
  const clusterQuoted = Boolean(
    canEstimateMethods &&
    managedAsset &&
    shieldConnection === 'connected' &&
    clusterEstimate.value?.routeFeeRaw !== null &&
    clusterEstimate.value &&
    clusterEstimate.value.expiresAt > Date.now()
  )
  const directQuoted = Boolean(
    canEstimateMethods &&
    methodAvailable &&
    directEstimate.value?.routeFeeRaw !== null &&
    directEstimate.value &&
    directEstimate.value.expiresAt > Date.now()
  )
  const clusterReady = clusterQuoted && clusterEstimate.value?.time !== '—'
  const directReady = directQuoted && directEstimate.value?.time !== '—'
  const directTimeUnavailable = directQuoted && !directReady
  const clusterTimeUnavailable = clusterQuoted && !clusterReady
  useEffect(() => {
    if (
      method === 'cluster' &&
      clusterPair &&
      directQuoted &&
      !clusterReady &&
      !clusterEstimate.loading &&
      shieldConnection !== 'checking' &&
      shieldConnection !== 'busy'
    )
      setMethod('directly')
  }, [method, clusterPair, clusterReady, directQuoted, clusterEstimate.loading, shieldConnection])
  const shieldReviewKey = `${routeKey}:${method}:${currentAmount}:${shieldAmountState?.amountRaw ?? ''}`
  const latestShieldReviewKey = useRef(shieldReviewKey)
  latestShieldReviewKey.current = shieldReviewKey
  const activeShieldReview = preparedShield?.key === shieldReviewKey ? preparedShield.review : null
  useEffect(() => {
    if (!preparedShield || preparedShield.key === shieldReviewKey) return
    if (confirmAttemptedPlanId.current !== preparedShield.review.planId)
      void confidentialFundingClient.cancel(preparedShield.review.planId).catch(() => {})
    setPreparedShield(null)
  }, [shieldReviewKey, preparedShield])
  const canReview = Boolean(
    draftScope === scopeKey &&
    selected &&
    eligible &&
    supportedPair &&
    routeState === 'supported' &&
    (!clusterPair || (method === 'directly' && directQuoted)) &&
    !tokenFeeBalanceError &&
    (direction === 'main-to-private' ? publicRaw !== null : privateRaw !== null) &&
    (!maxSelected || (available?.display === currentAmount && amount === currentAmount)) &&
    (!maxSelected ||
      selected.asset.asset.kind !== 'native' ||
      (maximum.value && !maximum.loading)) &&
    amountState?.amountRaw
  )
  const canReviewShield = Boolean(
    draftScope === scopeKey &&
    fundingRoute &&
    (!clusterSelected || clusterQuoted) &&
    selected &&
    eligible &&
    managedAsset &&
    (from !== 'shield' || (destination && targetAddress)) &&
    effective &&
    shieldConnection === 'connected' &&
    shieldSourceRaw !== null &&
    !tokenFeeBalanceError &&
    (!maxSelected || (shieldAvailable?.display === currentAmount && amount === currentAmount)) &&
    (!maxSelected ||
      selected.asset.asset.kind !== 'native' ||
      from === 'shield' ||
      (maximum.value && !maximum.loading)) &&
    shieldAmountState?.amountRaw
  )
  const selectDomain = (domain: TransferDomain, side: 'from' | 'to') => {
    if (pickerAccountId !== effective?.accountId) return
    userEditedMove.current = true
    if (selected) setSelectedAssetId(selected.asset.asset.id)
    if (side === 'from') {
      setFrom(domain)
      if (domain === to) setTo(from)
    } else {
      setTo(domain)
      if (domain === from) setFrom(to)
    }
    setAmount('')
    setDestinationAssetId(null)
    if (domain === 'shield' || from === 'shield' || to === 'shield') setMethod('directly')
    setMaxSelected(false)
    setDomainPicker(null)
  }
  const openDomainPicker = (side: 'from' | 'to') => {
    setPickerAccountId(effective?.accountId ?? null)
    setDomainPicker(side)
  }
  const review = () => {
    if (!canReview || !selected || !mainAddress) return
    const wallet = useWalletStore.getState()
    if (
      wallet.currentWalletId !== currentWalletId ||
      wallet.currentAccountId !== currentAccountId ||
      wallet.currentNetwork !== currentNetwork
    )
      return
    navigate(
      direction === 'main-to-private'
        ? buildAddToPrivateEvmPath({
            assetId: selected.asset.asset.id,
            chainId: selected.chain.chain.id,
            amount: currentAmount,
            maximum: maxSelected
          })
        : buildMoveToMainEvmPath({
            assetId: selected.asset.asset.id,
            mainAddress,
            amount: currentAmount,
            maximum: maxSelected
          })
    )
  }
  const symbol = selected?.asset.metadata.symbol ?? ''
  const sourceBalance =
    selected && (shieldPair ? shieldSourceRaw : sourceRaw) !== null
      ? formatBaseUnitAmount(
          (shieldPair ? shieldSourceRaw : sourceRaw)!,
          selected.asset.metadata.decimals
        )
      : '—'
  const accountName = activeAccount
    ? getAccountDisplayName(
        activeAccount.walletId,
        activeAccount.accountId,
        activeAccount.accountDisplayName,
        accountDisplayNames
      )
    : 'Account'
  const networkIcon = selected
    ? resolveChainIconAlias(
        selected.chain.chain.family,
        selected.chain.chain.displayName,
        selected.chain.chain.id
      )
    : 'evm'
  const walletAccounts =
    catalog?.accounts
      .filter(account => account.walletId === effective?.walletId)
      .sort((left, right) => {
        if (isDerivedAccount(left) && isDerivedAccount(right))
          return left.accountIndex - right.accountIndex
        return isDerivedAccount(left) === isDerivedAccount(right)
          ? 0
          : isDerivedAccount(left)
            ? -1
            : 1
      }) ?? (activeAccount ? [activeAccount] : [])
  const pickerAccount =
    walletAccounts.find(account => account.accountId === pickerAccountId) ?? activeAccount
  const walletIndexInStore = wallets.findIndex(wallet => wallet.id === effective?.walletId)
  const walletIndex =
    walletIndexInStore >= 0
      ? walletIndexInStore
      : Math.max(
          0,
          [...new Set(catalog?.accounts.map(account => String(account.walletId)) ?? [])].indexOf(
            effective?.walletId ?? ''
          )
        )
  const walletDisplayName = formatWalletNameAtIndex(
    pickerAccount?.walletDisplayName ?? activeAccount?.walletDisplayName ?? 'Wallet',
    walletIndex
  )
  const pickerAccountName = pickerAccount
    ? getAccountDisplayName(
        pickerAccount.walletId,
        pickerAccount.accountId,
        pickerAccount.accountDisplayName,
        accountDisplayNames
      )
    : 'Account'
  const pickerIsActive = Boolean(
    pickerAccount && effective && pickerAccount.accountId === effective.accountId
  )
  const pickerNetwork = pickerAccount?.networks.find(
    item => item.chain.id === selected?.chain.chain.id
  )
  const pickerShieldRaw = pickerIsActive && selected ? refreshedShieldRaw : null
  const addressFor = (domain: TransferDomain) => {
    if (domain === 'shield') return ''
    return domain === 'private' ? privateAddress : mainAddress
  }
  const maxDisabled = fundingRoute
    ? !eligible ||
      !managedAsset ||
      shieldConnection !== 'connected' ||
      !shieldAvailable ||
      BigInt(shieldAvailable.amountRaw) === 0n
    : !eligible ||
      !supportedPair ||
      (direction === 'main-to-private' ? publicRaw === null : privateRaw === null) ||
      routeState !== 'supported' ||
      !available ||
      BigInt(available.amountRaw) === 0n
  const handleMax = () => {
    if (!selected || maxDisabled) return
    setSelectedAssetId(selected.asset.asset.id)
    setMaxSelected(true)
    if (selected.asset.asset.kind === 'native' && from !== 'shield') void maximum.request()
    else setAmount((fundingRoute ? shieldAvailable : available)?.display ?? '')
  }

  const scopeStillCurrent = () => {
    const wallet = useWalletStore.getState()
    return Boolean(
      mounted.current &&
      latestScopeKey.current === scopeKey &&
      effective &&
      wallet.currentWalletId === currentWalletId &&
      wallet.currentAccountId === currentAccountId &&
      wallet.currentNetwork === currentNetwork
    )
  }
  const refreshShield = async () => {
    if (!effective || !scopeStillCurrent()) return
    setShieldConnection('busy')
    setShieldError(null)
    try {
      const balances = await confidentialFundingClient.refreshBalances(
        {
          network: currentNetwork,
          keyDomainId: effective.walletId,
          accountId: effective.accountId
        },
        true
      )
      if (!scopeStillCurrent()) return
      setShieldSnapshot({ key: scopeKey, balances })
      setShieldConnection('connected')
      void refreshPortfolio(true)
    } catch (error) {
      if (!scopeStillCurrent()) return
      setShieldConnection('required')
      setShieldError(
        error instanceof Error ? error.message : 'Unable to load Shield balances. Please try again.'
      )
    }
  }
  const prepareShield = async () => {
    if (
      !canReviewShield ||
      !selected ||
      !managedAsset ||
      !effective ||
      !shieldAmountState?.amountRaw ||
      !scopeStillCurrent()
    )
      return
    const key = shieldReviewKey
    setPreparingShield(true)
    setShieldError(null)
    try {
      const request = buildShieldTransferRequest({
        network: currentNetwork,
        keyDomainId: effective.walletId,
        accountId: effective.accountId,
        from,
        to,
        method: clusterSelected ? 'cluster' : 'directly',
        amountRaw: shieldAmountState.amountRaw,
        asset: selected.asset,
        chain: selected.chain,
        managed: managedAsset,
        ...(from === 'shield' && destination ? { destination } : {})
      })
      const result = await confidentialFundingClient.prepare(request)
      if (!scopeStillCurrent() || latestShieldReviewKey.current !== key) {
        if (result.phase === 'prepared')
          void confidentialFundingClient.cancel(result.planId).catch(() => {})
        return
      }
      if (result.phase !== 'prepared') {
        await checkShieldPlan(result.planId)
        return
      }
      if (!matchesShieldReview(result, request)) {
        void confidentialFundingClient.cancel(result.planId).catch(() => {})
        throw new Error('Shield review changed. Try again.')
      }
      confirmAttemptedPlanId.current = null
      setConfirmUncertain(false)
      setPreparedShield({ key, review: result })
    } catch (error) {
      if (scopeStillCurrent())
        setShieldError(error instanceof Error ? error.message : 'Shield review is unavailable')
    } finally {
      if (scopeStillCurrent()) setPreparingShield(false)
    }
  }
  const openShieldActivity = (plan: ConfidentialFundingPlan) => {
    if (
      scopeStillCurrent() &&
      plan.network === currentNetwork &&
      plan.keyDomainId === effective?.walletId &&
      plan.accountId === effective.accountId
    ) {
      setPreparedShield(null)
      navigate(`/?tab=activity&transactionId=${encodeURIComponent(plan.transactionId)}`)
    }
  }
  const checkShieldPlan = async (
    planId: string
  ): Promise<'prepared' | 'started' | 'pending' | 'failed' | null> => {
    try {
      const plan = await confidentialFundingClient.get(planId)
      if (!scopeStillCurrent()) return null
      if (hasShieldTransferStarted(plan)) {
        openShieldActivity(plan)
        return 'started'
      }
      if (isUnsignedShieldTerminal(plan)) {
        setPreparedShield(null)
        setConfirmUncertain(false)
        setShieldError('Transfer was not started. Try again.')
        return 'failed'
      }
      if (plan.phase !== 'prepared') {
        setConfirmUncertain(true)
        setShieldError('Approval did not complete. Check status before trying again.')
        return 'pending'
      }
      setConfirmUncertain(false)
      return 'prepared'
    } catch {
      if (!scopeStillCurrent()) return null
      setConfirmUncertain(true)
      setShieldError('Transfer status unavailable. Check status before trying again.')
      return null
    }
  }
  const cancelShieldReview = async () => {
    const pending = activeShieldReview
    if (!pending || cancellingShield) return
    setCancellingShield(true)
    try {
      if (confirmAttemptedPlanId.current === pending.planId) {
        const status = await checkShieldPlan(pending.planId)
        if (status !== 'prepared') return
      }
      await confidentialFundingClient.cancel(pending.planId)
      if (!scopeStillCurrent()) return
      setPreparedShield(null)
    } catch {
      if (scopeStillCurrent()) setPreparedShield(null)
    } finally {
      if (scopeStillCurrent()) setCancellingShield(false)
    }
  }
  const confirmShield = async () => {
    const pending = activeShieldReview
    if (!pending || !scopeStillCurrent()) return
    if (!confirmUncertain && pending.expiresAt <= Date.now()) {
      setShieldError('Shield review expired. Try again.')
      return
    }
    setConfirmingShield(true)
    setShieldError(null)
    try {
      if (confirmUncertain) {
        const status = await checkShieldPlan(pending.planId)
        if (status === 'prepared' && scopeStillCurrent())
          setShieldError('Transfer not started. Review and try again.')
        return
      }
      confirmAttemptedPlanId.current = pending.planId
      const plan = await confidentialFundingClient.confirm(
        pending.planId,
        pending.payloadFingerprint
      )
      if (hasShieldTransferStarted(plan)) openShieldActivity(plan)
      else await checkShieldPlan(plan.planId)
    } catch (error) {
      const status = await checkShieldPlan(pending.planId)
      if (status === 'prepared' && scopeStillCurrent())
        setShieldError(error instanceof Error ? error.message : 'Shield transfer could not start')
    } finally {
      if (scopeStillCurrent()) setConfirmingShield(false)
    }
  }

  if (activeShieldReview && selected) {
    const output = formatBaseUnitAmount(
      activeShieldReview.expectedOutputRaw,
      targetAsset?.asset.metadata.decimals ?? selected.asset.metadata.decimals
    )
    const minimum = formatBaseUnitAmount(
      activeShieldReview.minimumOutputRaw,
      targetAsset?.asset.metadata.decimals ?? selected.asset.metadata.decimals
    )
    const quoteFeeRaw =
      targetAsset && targetAsset.asset.metadata.decimals !== selected.asset.metadata.decimals
        ? null
        : shieldQuoteFeeRaw(activeShieldReview)
    const fee =
      quoteFeeRaw !== null ? (
        <AmountDisplay
          value={formatBaseUnitAmount(quoteFeeRaw, selected.asset.metadata.decimals)}
          symbol={symbol}
          profile="fee"
        />
      ) : (
        'Included in quote'
      )
    const networkFee = activeShieldReview.sourceNetworkFee
    return (
      <div className="page-container">
        <TransactionReviewView
          variant="figma"
          title={activeShieldReview.operation === 'cluster' ? 'Cluster transfer' : 'Confirm Move'}
          asset={{
            assetId: selected.asset.asset.id,
            symbol,
            icon: selected.asset.metadata.iconUrl
          }}
          amount={currentAmount}
          network={selected.chain.chain.displayName}
          rows={[
            {
              label: 'From',
              content:
                from === 'shield' ? (
                  `${accountName} · Shield · NEAR Confidential`
                ) : (
                  <span>
                    {accountName} · {domainLabel(from)} · {selected.chain.chain.displayName}
                    <span className="ml-auto mt-1 block w-[22ch] max-w-full break-all font-mono text-xs text-balance">
                      {activeShieldReview.sourceAddress}
                    </span>
                  </span>
                )
            },
            {
              label: 'To',
              content:
                to === 'shield' ? (
                  `${accountName} · Shield · NEAR Confidential`
                ) : (
                  <span>
                    {accountName} · {domainLabel(to)} · {targetAsset?.chain.chain.displayName}
                    <span className="ml-auto mt-1 block w-[22ch] max-w-full break-all font-mono text-xs text-balance">
                      {activeShieldReview.destinationAddress}
                    </span>
                  </span>
                )
            },
            {
              label: 'Estimated receive',
              content: (
                <AmountDisplay
                  value={output}
                  symbol={targetAsset?.asset.metadata.symbol ?? symbol}
                />
              )
            },
            {
              label: 'Minimum receive',
              content: (
                <AmountDisplay
                  value={minimum}
                  symbol={targetAsset?.asset.metadata.symbol ?? symbol}
                />
              )
            },
            ...(Number.isSafeInteger(activeShieldReview.quoteTimeEstimateSeconds) &&
            (activeShieldReview.quoteTimeEstimateSeconds ?? 0) > 0
              ? [
                  {
                    label: 'Estimated time',
                    content: `${activeShieldReview.quoteTimeEstimateSeconds} sec`
                  }
                ]
              : []),
            ...(activeShieldReview.operation === 'cluster'
              ? [{ label: 'Split transfers', content: `${activeShieldReview.withdrawCount}` }]
              : []),
            {
              label:
                activeShieldReview.operation === 'cluster'
                  ? 'Estimated route fees'
                  : 'Estimated fee',
              content: fee
            },
            ...(networkFee
              ? [
                  {
                    label:
                      activeShieldReview.operation === 'cluster'
                        ? 'Max network fee'
                        : 'Network fee',
                    content: (
                      <AmountDisplay
                        value={formatBaseUnitAmount(networkFee.raw, networkFee.decimals)}
                        symbol={networkFee.symbol}
                        profile="fee"
                      />
                    )
                  }
                ]
              : [])
          ]}
          error={
            shieldError ? (
              <p role="alert" className="mt-3 text-xs text-warning">
                {shieldError}
              </p>
            ) : undefined
          }
          confirmLabel={
            confirmUncertain
              ? 'Check status'
              : activeShieldReview.operation === 'cluster'
                ? 'Confirm Cluster'
                : 'Move'
          }
          confirming={confirmingShield}
          cancelDisabled={cancellingShield}
          confirmDisabled={
            !scopeStillCurrent() ||
            (!confirmUncertain && activeShieldReview.expiresAt <= Date.now())
          }
          onCancel={() => void cancelShieldReview()}
          onConfirm={() => void confirmShield()}
        />
      </div>
    )
  }

  return (
    <div className="page-container" data-wallet-mode={walletMode}>
      <PageHeader
        title="Move"
        showBack
        onBack={goBack}
        rightContent={
          fundingRoute &&
          (shieldConnection === 'connected' || shieldConnection === 'busy') && (
            <button
              type="button"
              onClick={() => void refreshShield()}
              disabled={shieldConnection === 'busy'}
              aria-label="Refresh Shield balance"
              aria-busy={shieldConnection === 'busy'}
              title={
                shieldConnection === 'busy' ? 'Updating Shield balance…' : 'Refresh Shield balance'
              }
              className="wallet-interactive flex size-8 items-center justify-center rounded-lg text-muted hover:bg-wallet-selected hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
            >
              <Icon
                icon="lucide:refresh-cw"
                width={16}
                height={16}
                className={cn(shieldConnection === 'busy' && 'animate-spin')}
              />
            </button>
          )
        }
      />
      <div className="page-content flex min-h-0 flex-col !px-4 !pb-2 !pt-3">
        <div className="flex min-h-[155px] shrink-0 flex-col items-center justify-center gap-2 py-3">
          <input
            id="transfer-amount"
            aria-label="Transfer amount"
            inputMode="decimal"
            value={currentAmount}
            disabled={!selected}
            title={currentAmount || undefined}
            style={{
              fontSize: `${Math.max(16, Math.min(40, Math.floor(500 / Math.max(1, currentAmount.length))))}px`
            }}
            onChange={event => {
              const next = normalizePrivateBalanceTransferInput(event.target.value)
              if (next !== null) {
                userEditedMove.current = true
                if (selected) setSelectedAssetId(selected.asset.asset.id)
                setAmount(next)
                setMaxSelected(false)
              }
            }}
            placeholder="0"
            className="h-14 w-full min-w-0 bg-transparent text-center text-[40px] font-semibold leading-[52px] caret-primary outline-none placeholder:text-muted/45"
          />
          <button
            type="button"
            onClick={() => setAssetPickerOpen(true)}
            disabled={!selected && loadState === 'loading'}
            className="wallet-interactive flex h-9 max-w-full items-center gap-2 rounded-full bg-card px-2 text-base font-medium leading-[21px] hover:bg-wallet-selected active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary"
            aria-label="Select transfer asset"
          >
            {selected || pendingAssetHint ? (
              <TokenIcon
                assetId={selected?.asset.asset.id ?? selectedAssetId!}
                symbol={symbol || pendingAssetHint!.symbol}
                icon={selected?.asset.metadata.iconUrl ?? pendingAssetHint?.iconUrl}
                {...(from !== 'shield' ? { blockchain: networkIcon } : {})}
                size={26}
              />
            ) : (
              <Icon icon="lucide:coins" width={20} height={20} />
            )}
            <span className="max-w-32 truncate">
              {symbol ||
                pendingAssetHint?.symbol ||
                (loadState === 'loading' ? '…' : 'Select asset')}
            </span>
            <Icon icon="lucide:chevron-down" width={14} height={14} />
          </button>
          <div className="flex max-w-full items-center gap-2 text-xs text-muted">
            <span className="truncate" title={sourceBalance}>
              {formatTokenQuantity(sourceBalance)}
            </span>
            <button
              type="button"
              onClick={handleMax}
              disabled={!selected || maxDisabled || maximum.loading}
              aria-label="Max"
              className="wallet-interactive shrink-0 rounded bg-white/10 px-1.5 py-0.5 disabled:opacity-40"
            >
              {maximum.loading ? '…' : 'Max'}
            </button>
          </div>
          {fromAssetDetail && from === 'shield' && selected && (
            <button
              type="button"
              onClick={() => {
                setNetworkSearch('')
                setNetworkPickerOpen(true)
              }}
              className="wallet-interactive flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary"
              aria-label="Select network"
            >
              <ChainIcon
                chain={
                  targetAsset
                    ? resolveChainIconAlias(
                        targetAsset.chain.chain.family,
                        targetAsset.chain.chain.displayName,
                        targetAsset.chain.chain.id
                      )
                    : networkIcon
                }
                width={16}
                height={16}
                showTooltip={false}
              />
              <span className="truncate">
                {targetAsset?.chain.chain.displayName ?? 'Select network'}
              </span>
              <Icon icon="lucide:chevron-down" width={14} height={14} />
            </button>
          )}
        </div>
        <div className="mt-4 shrink-0">
          <DomainCard
            label="From"
            accountName={accountName}
            domain={from}
            address={addressFor(from)}
            networkName={selected?.chain.chain.displayName ?? ''}
            network={from === 'shield' ? 'near' : networkIcon}
            onNetworkClick={() => setAssetPickerOpen(true)}
            onAccountClick={() => openDomainPicker('from')}
            disabled={!selected}
          />
          <div className="relative h-2.5">
            <button
              type="button"
              onClick={() => {
                userEditedMove.current = true
                if (from === 'shield' && destination) setSelectedAssetId(destination.asset.asset.id)
                else if (selected) setSelectedAssetId(selected.asset.asset.id)
                setDestinationAssetId(null)
                setFrom(to)
                setTo(from)
                setAmount('')
                setMaxSelected(false)
              }}
              aria-label="Switch transfer direction"
              disabled={!selected}
              className={cn(
                'wallet-interactive absolute left-1/2 top-1/2 z-10 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg border border-white/10 bg-card hover:bg-wallet-selected active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary',
                walletMode === 'private' ? 'text-private' : 'text-foreground'
              )}
            >
              <Icon icon="lucide:arrow-up-down" width={18} height={18} />
            </button>
          </div>
          <DomainCard
            label="To"
            accountName={accountName}
            domain={to}
            address={to === 'shield' ? '' : targetAddress}
            networkName={targetAsset?.chain.chain.displayName ?? 'Select network'}
            network={
              targetAsset
                ? resolveChainIconAlias(
                    targetAsset.chain.chain.family,
                    targetAsset.chain.chain.displayName,
                    targetAsset.chain.chain.id
                  )
                : networkIcon
            }
            onNetworkClick={() => {
              setNetworkSearch('')
              setNetworkPickerOpen(true)
            }}
            showNetwork={from === 'shield' && !fromAssetDetail}
            onAccountClick={() => openDomainPicker('to')}
            disabled={!selected}
          />
        </div>
        {!selected && !pendingAssetHint && loadState !== 'loading' && loadState !== 'error' && (
          <p role="status" className="mt-3 text-center text-sm text-muted">
            No transferable assets
          </p>
        )}
        {transferError && (
          <p role="alert" className="mt-2 text-xs text-warning">
            {transferError}
          </p>
        )}
        {selected?.chain.chain.family === 'evm' && clusterPair && (clusterReady || directReady) && (
          <div
            role="radiogroup"
            aria-label="Transfer method"
            className={cn(
              'mt-auto grid shrink-0 gap-2.5 pt-6',
              clusterReady && directReady ? 'grid-cols-2' : 'grid-cols-1'
            )}
          >
            {clusterReady && clusterEstimate.value && (
              <MethodCard
                title="Cluster"
                detail="Multiple transactions"
                recommended
                selected={method === 'cluster'}
                estimate={clusterEstimate.value}
                fee={formatMoveMethodFee(clusterEstimate.value, selected.asset)}
                onClick={() => setMethod('cluster')}
              />
            )}
            {directReady && directEstimate.value && (
              <MethodCard
                title="Directly"
                detail="One transaction"
                recommended={false}
                selected={method === 'directly'}
                estimate={directEstimate.value}
                fee={formatMoveMethodFee(directEstimate.value, selected.asset)}
                onClick={() => setMethod('directly')}
              />
            )}
          </div>
        )}
        {directTimeUnavailable && (
          <p role="status" className="mt-2 text-xs text-muted">
            Directly: time estimate unavailable
          </p>
        )}
        {clusterTimeUnavailable && (
          <p role="status" className="mt-2 text-xs text-muted">
            Cluster: time estimate unavailable
          </p>
        )}
        {method === 'directly' &&
          selected &&
          supportedPair &&
          eligible &&
          routeState === 'error' && (
            <InlineError
              message="Transfer availability could not be checked."
              onRetry={() => setRetry(value => value + 1)}
            />
          )}
        {loadState === 'error' && !portfolio && (
          <InlineError
            message="Assets could not be loaded."
            onRetry={() => void refreshPortfolio(true)}
          />
        )}
        {shieldError && !activeShieldReview && (
          <p role="alert" className="text-xs text-warning">
            {shieldError}
          </p>
        )}
      </div>
      <div className="page-footer">
        <Button
          size="wallet"
          className="w-full"
          disabled={
            fundingRoute && shieldConnection !== 'connected'
              ? shieldConnection !== 'required'
              : fundingRoute
                ? !canReviewShield || preparingShield
                : !canReview
          }
          isLoading={
            preparingShield ||
            (fundingRoute && (shieldConnection === 'checking' || shieldConnection === 'busy'))
          }
          onClick={
            fundingRoute && shieldConnection !== 'connected'
              ? () => void refreshShield()
              : fundingRoute
                ? () => void prepareShield()
                : review
          }
        >
          {fundingRoute && shieldConnection !== 'connected'
            ? shieldConnection === 'required'
              ? 'Retry'
              : 'Loading balances…'
            : clusterSelected
              ? 'Review Cluster'
              : shieldPair
                ? 'Move'
                : 'Move'}
        </Button>
      </div>

      <Dialog open={assetPickerOpen} onOpenChange={setAssetPickerOpen}>
        <DialogContent
          position="bottom"
          data-wallet-mode={walletMode}
          className="max-h-[75vh] overflow-y-auto p-4"
        >
          <DialogHeader>
            <DialogTitle>Select asset</DialogTitle>
            <DialogDescription className="sr-only">Choose an asset to transfer.</DialogDescription>
          </DialogHeader>
          <input
            aria-label="Search tokens"
            placeholder="Search token"
            value={assetSearch}
            onChange={event => setAssetSearch(event.target.value)}
            className="h-12 w-full rounded-lg border border-white/5 bg-card px-3 text-sm outline-none focus:border-primary"
          />
          <div className="flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              aria-label="All networks"
              aria-pressed={assetChainId === 'all'}
              onClick={() => setAssetChainId('all')}
              className={cn(
                'wallet-interactive h-10 shrink-0 rounded-md border bg-card px-2 text-sm',
                assetChainId === 'all' ? 'border-primary' : 'border-white/10'
              )}
            >
              All
            </button>
            {Array.from(
              new Map(pickerRows.map(item => [item.chain.chain.id, item.chain])).values()
            ).map(chain => (
              <button
                key={chain.chain.id}
                type="button"
                aria-label={chain.chain.displayName}
                aria-pressed={assetChainId === chain.chain.id}
                onClick={() => setAssetChainId(chain.chain.id)}
                className={cn(
                  'wallet-interactive flex size-10 shrink-0 items-center justify-center rounded-md border bg-card',
                  assetChainId === chain.chain.id ? 'border-primary' : 'border-white/10'
                )}
              >
                <ChainIcon
                  chain={resolveChainIconAlias(
                    chain.chain.family,
                    chain.chain.displayName,
                    chain.chain.id
                  )}
                  width={28}
                  height={28}
                />
              </button>
            ))}
          </div>
          <div className="space-y-1">
            {pickerRows
              .filter(
                item =>
                  (assetChainId === 'all' || item.chain.chain.id === assetChainId) &&
                  `${item.asset.metadata.symbol} ${item.asset.metadata.name} ${item.chain.chain.displayName}`
                    .toLowerCase()
                    .includes(assetSearch.trim().toLowerCase())
              )
              .map(item => (
                <button
                  key={item.asset.asset.id}
                  type="button"
                  onClick={() => {
                    userEditedMove.current = true
                    setSelectedAssetId(item.asset.asset.id)
                    setDestinationAssetId(null)
                    setAmount('')
                    setMaxSelected(false)
                    setAssetPickerOpen(false)
                  }}
                  className="flex min-h-[70px] w-full items-center gap-3 rounded-lg text-left hover:bg-accent"
                >
                  <TokenIcon
                    assetId={item.asset.asset.id}
                    symbol={item.asset.metadata.symbol}
                    icon={item.asset.metadata.iconUrl}
                    blockchain={resolveChainIconAlias(
                      item.chain.chain.family,
                      item.chain.chain.displayName,
                      item.chain.chain.id
                    )}
                    size={32}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base">{item.asset.metadata.symbol}</span>
                    <span className="block truncate text-xs text-muted">
                      {item.chain.chain.displayName}
                    </span>
                  </span>
                  <span className="min-w-0 max-w-[45%] truncate text-right text-base tabular-nums">
                    {formatTokenQuantity(
                      formatBaseUnitAmount(item.sourceRaw, item.asset.metadata.decimals)
                    )}
                    <span className="block truncate text-xs text-muted">
                      {item.valueUsd !== null ? formatFiatAmount(item.valueUsd) : '—'}
                    </span>
                  </span>
                </button>
              ))}
            {pickerRows.length === 0 && (
              <p className="py-4 text-center text-sm text-muted">
                {loadState === 'loading' || (from === 'shield' && shieldConnection === 'checking')
                  ? 'Loading assets…'
                  : 'No assets available'}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={networkPickerOpen} onOpenChange={setNetworkPickerOpen}>
        <DialogContent
          position="bottom"
          showCloseButton={false}
          data-wallet-mode={walletMode}
          className="inset-0 flex h-full flex-col gap-4 rounded-none border-0 bg-background p-0 shadow-none"
        >
          <DialogTitle className="sr-only">Select Network</DialogTitle>
          <DialogDescription className="sr-only">
            Choose the network to receive your funds.
          </DialogDescription>
          <PageHeader title="Select Network" showBack onBack={() => setNetworkPickerOpen(false)} />
          <div className="min-h-0 overflow-y-auto px-4 pb-4">
            <input
              aria-label="Search networks"
              placeholder="Search network"
              value={networkSearch}
              onChange={event => setNetworkSearch(event.target.value)}
              className="mb-4 h-12 w-full rounded-lg border border-white/5 bg-card px-3 text-sm outline-none focus:border-primary"
            />
            <p className="mb-2 text-xs text-muted">Networks for {symbol}</p>
            <div className="space-y-1">
              {destinationOptions
                .filter(item =>
                  item.chain.chain.displayName
                    .toLowerCase()
                    .includes(networkSearch.trim().toLowerCase())
                )
                .map(item => (
                  <button
                    type="button"
                    key={item.asset.asset.id}
                    aria-label={item.chain.chain.displayName}
                    aria-pressed={destination?.asset.asset.id === item.asset.asset.id}
                    onClick={() => {
                      userEditedMove.current = true
                      setDestinationAssetId(item.asset.asset.id)
                      setNetworkPickerOpen(false)
                      setShieldError(null)
                    }}
                    className={cn(
                      'wallet-interactive flex h-16 w-full items-center gap-3 rounded-lg px-3 text-left text-base hover:bg-wallet-selected',
                      destination?.asset.asset.id === item.asset.asset.id && 'bg-wallet-selected'
                    )}
                  >
                    <ChainIcon
                      chain={resolveChainIconAlias(
                        item.chain.chain.family,
                        item.chain.chain.displayName,
                        item.chain.chain.id
                      )}
                      width={28}
                      height={28}
                    />
                    <span>{item.chain.chain.displayName}</span>
                  </button>
                ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={domainPicker !== null}
        onOpenChange={open => {
          if (!open) setDomainPicker(null)
        }}
      >
        <DialogContent
          position="bottom"
          data-wallet-mode={walletMode}
          className="max-h-[75dvh] min-h-0 overflow-y-auto bg-wallet-surface p-4"
        >
          <DialogHeader className="text-left">
            <DialogTitle className="text-sm font-medium leading-[18px]">
              Move {domainPicker === 'from' ? 'from' : 'to'} · {walletDisplayName}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Select an account and balance.
            </DialogDescription>
          </DialogHeader>
          <div
            role="tablist"
            aria-label="Wallet accounts"
            className="flex gap-2 overflow-x-auto pb-1"
          >
            {walletAccounts.map(account => (
              <button
                key={account.accountId}
                type="button"
                role="tab"
                aria-selected={pickerAccount?.accountId === account.accountId}
                disabled={account.accountId !== effective?.accountId}
                onClick={() => setPickerAccountId(account.accountId)}
                className={cn(
                  'h-8 shrink-0 rounded-2xl border px-3 text-sm font-medium leading-[18px]',
                  pickerAccount?.accountId === account.accountId
                    ? 'border-white bg-white text-black'
                    : 'border-white/10 bg-white/5 text-foreground'
                )}
              >
                {getAccountDisplayName(
                  account.walletId,
                  account.accountId,
                  account.accountDisplayName,
                  accountDisplayNames
                )}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            aria-label={`${pickerAccountName} balances`}
            className="space-y-2 pb-2"
          >
            {(['public', 'private'] as const).map(domain => {
              const address =
                domain === 'private'
                  ? pickerNetwork?.privateExecutionAddress
                  : pickerNetwork?.addresses.find(item => item.preferredForReceive)?.value
              const raw =
                pickerIsActive && selected
                  ? getTransferDomainBalanceRaw(selected.asset, domain)
                  : null
              return (
                <button
                  key={domain}
                  type="button"
                  onClick={() => domainPicker && selectDomain(domain, domainPicker)}
                  disabled={!pickerIsActive || !address}
                  aria-label={`Select ${domainLabel(domain)} account`}
                  aria-pressed={pickerIsActive && (domainPicker === 'from' ? from : to) === domain}
                  className={cn(
                    'flex min-h-[65px] w-full items-center justify-between gap-3 rounded-lg border bg-white/5 px-3 py-2 text-left disabled:opacity-45',
                    pickerIsActive && (domainPicker === 'from' ? from : to) === domain
                      ? 'border-primary ring-1 ring-primary'
                      : 'border-white/10'
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-base font-medium leading-[21px]">
                      <ExecutionAccountIcon
                        mode={domain === 'private' ? 'private' : 'main'}
                        size={16}
                      />
                      {domainLabel(domain)} account
                    </span>
                    <span
                      className="mt-1 block truncate font-mono text-xs font-medium leading-4 text-muted"
                      title={address}
                    >
                      {address ? formatSortAddress(address) : '—'}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'max-w-[38%] break-all text-right text-base font-medium leading-[21px]',
                      raw === '0' && 'text-muted'
                    )}
                    title={raw ?? undefined}
                  >
                    {raw !== null && selected
                      ? formatTokenQuantity(
                          formatBaseUnitAmount(raw, selected.asset.metadata.decimals)
                        )
                      : '—'}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => {
                if (!domainPicker || !selected) return
                selectDomain('shield', domainPicker)
              }}
              disabled={!pickerIsActive || !managedAsset}
              aria-label="Select Shield balance"
              aria-pressed={pickerIsActive && (domainPicker === 'from' ? from : to) === 'shield'}
              className={cn(
                'flex min-h-[65px] w-full items-center justify-between gap-3 rounded-lg border bg-white/5 px-3 py-2 text-left disabled:opacity-45',
                pickerIsActive && (domainPicker === 'from' ? from : to) === 'shield'
                  ? 'border-primary ring-1 ring-primary'
                  : 'border-white/10'
              )}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-base font-medium leading-[21px]">
                  <Icon icon="lucide:shield-check" width={16} height={16} />
                  Shield
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs font-medium leading-4 text-muted">
                  <img
                    src={nearLogo}
                    alt=""
                    aria-hidden="true"
                    className="size-4 shrink-0 rounded-[3px]"
                  />
                  <span className="truncate">NEAR Confidential</span>
                </span>
              </span>
              <span
                className={cn(
                  'max-w-[38%] break-all text-right text-base font-medium leading-[21px]',
                  pickerShieldRaw === '0' && 'text-muted'
                )}
              >
                {pickerShieldRaw !== null && selected
                  ? formatTokenQuantity(
                      formatBaseUnitAmount(pickerShieldRaw, selected.asset.metadata.decimals)
                    )
                  : '—'}
              </span>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
