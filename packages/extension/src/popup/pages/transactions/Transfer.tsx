import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate as useRouterNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import {
  formatBaseUnitAmount,
  formatTokenQuantity,
  formatFiatAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import {
  formatSortAddress,
  formatSymbol,
  formatWalletNameAtIndex,
  getAccountDisplayName
} from '@/lib/format'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { cn } from '@/lib/utils'
import { classifyError } from '@/lib/errors'
import { getSwapQuoteFailureMessage } from '@/popup/services/swap-quote-error-message'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useNavigate } from '@/popup/provider/Router'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import { useMoveMethodEstimate } from '@/popup/hooks/useMoveMethodEstimate'
import { useShieldBalances } from '@/popup/hooks/useShieldBalances'
import {
  clusterMoveEstimate,
  estimateDirectMove,
  formatMoveMethodFee,
  type MoveMethodEstimate
} from '@/popup/services/move-method-estimate'
import { formatMoveQuoteMinimumError } from '@/popup/services/move-quote-error'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenSelectorDialog } from '@/popup/components/tokens/TokenSelectorDialog'
import { TokenSelectorView } from '@/popup/components/tokens/TokenSelectorView'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { ChainSelector, type ChainSelectorOption } from '@/popup/components/common/ChainSelector'
import { ExecutionAccountIcon } from '@/popup/components/account/ExecutionAccountSelector'
import nearLogo from '@/images/figma-near-confidential.svg'
import { Button } from '@/popup/components/ui/button'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import {
  areEvmFeeSelectionsEqual,
  formatEvmWeiAsGwei,
  type EvmFeeSelection
} from '@/infrastructure/chains/evm'
import { Skeleton } from '@/popup/components/ui/skeleton'
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
import { resolveConfidentialEvmAssetSupport } from '@/core/services/rhea-swap/rhea-confidential-support'
import type { SwapToken } from '@/core/services/intents-api'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { listMoveAssetPickerRows } from '@/popup/services/move-asset-picker'
import { confidentialFundingClient } from '@/popup/services/confidential-funding-client'
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
import { openConfidentialActivity } from '@/popup/components/transaction/ConfidentialActivitySheet'
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

function formatMoveReviewAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 7)}...${address.slice(-5)}` : address
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
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <span className="shrink-0">{label}</span>
                <span>Shield</span>
              </span>
              <span className="block truncate text-base font-medium">
                NEAR Confidential Intents
              </span>
            </>
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <span className="shrink-0">{label}</span>
                <span className="truncate">{accountName}</span>
                <span
                  className={cn(
                    'shrink-0 rounded-md px-2 py-0.5',
                    domain === 'private' ? 'bg-private/10 text-private' : 'bg-white/10 text-muted'
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
  loading,
  disabled,
  onClick
}: {
  title: 'Cluster' | 'Directly'
  detail: string
  recommended: boolean
  selected: boolean
  estimate: MoveMethodEstimate | null
  fee: { value: string; detail: string | null }
  loading?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-label={title}
      aria-checked={selected}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'relative flex min-h-[180px] min-w-0 flex-col rounded-xl border bg-wallet-surface px-3 py-3 text-left text-xs leading-4 disabled:cursor-not-allowed disabled:opacity-50',
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
      {(loading || (estimate && estimate.time !== '—')) && (
        <span className="mt-2 flex justify-between gap-2">
          <span className="shrink-0 text-muted">Time (est.)</span>
          <span className="min-w-0 text-right">
            {loading ? (
              <Skeleton className="ml-auto h-4 w-full max-w-16" />
            ) : estimate ? (
              <>
                <span className="block">{estimate.time}</span>
                <span className="block text-[10px] text-muted">{estimate.timeScope}</span>
              </>
            ) : null}
          </span>
        </span>
      )}
      <span className="mt-2 flex justify-between gap-2">
        <span className="shrink-0 text-muted">Fee (est.)</span>
        <span className="min-w-0 break-words text-right">
          {loading ? (
            <Skeleton className="ml-auto h-4 w-full max-w-24" />
          ) : (
            <>
              <span className="block">{fee.value}</span>
              {fee.detail && <span className="block text-[10px] text-muted">{fee.detail}</span>}
            </>
          )}
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
  const { goBack, navigate } = useNavigate()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const wallets = useWalletStore(state => state.wallets)
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const endpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const {
    activeAccount,
    catalog,
    loading: accountLoading,
    refresh: refreshAccountNetworks
  } = useActiveAccountNetworks()
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
    refresh: refreshPortfolio,
    readLatest: readLatestPortfolio
  } = useHomePortfolio(effective?.walletId ?? null, effective?.accountId ?? null)
  const [retry, setRetry] = useState(0)
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [assetSearch, setAssetSearch] = useState('')
  const [assetChainId, setAssetChainId] = useState('all')
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
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
  const [evmMoveFee, setEvmMoveFee] = useState<EvmFeeSelection>({
    kind: 'tier',
    tier: 'standard'
  })
  const [maxSelected, setMaxSelected] = useState(initialDraft.maxSelected)
  const [loadedPreference, setLoadedPreference] = useState<{
    key: string
    value: ShieldMovePreference | null
  } | null>(null)
  const rememberedMove = loadedPreference?.key === preferenceKey ? loadedPreference.value : null
  const preferenceReady = loadedPreference?.key === preferenceKey
  const [preferenceAppliedScope, setPreferenceAppliedScope] = useState<string | null>(null)
  const userEditedMove = useRef(false)
  const userPickedMethod = useRef(launchHasDraft)
  const [catalogReady, setCatalogReady] = useState(false)
  const [routeSnapshot, setRouteSnapshot] = useState<{
    key: string
    status: 'supported' | 'unsupported' | 'error'
  } | null>(null)
  const [managedAssets, setManagedAssets] = useState<readonly IntentsManagedAsset[]>([])
  const [catalogTokens, setCatalogTokens] = useState<readonly SwapToken[]>([])
  const canLoadShield =
    getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet').length > 0
  const shieldBalanceKey = `${currentNetwork}:${effective?.walletId ?? ''}:${effective?.accountId ?? ''}`
  const {
    balances: shieldBalances,
    error: shieldBalanceError,
    errorCode: shieldBalanceErrorCode,
    refreshBalances: loadShieldBalances
  } = useShieldBalances({
    active: true,
    enabled: canLoadShield,
    scopeKey: shieldBalanceKey,
    scope: effective
      ? { network: currentNetwork, keyDomainId: effective.walletId, accountId: effective.accountId }
      : null,
    refreshPortfolio,
    readProjection: readLatestPortfolio,
    authorizeOnMount: false
  })
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
    setShieldConnection('checking')
    setShieldError(null)
  }, [shieldBalanceKey])

  useEffect(() => {
    if (canLoadShield || accountLoading || !effective) return
    setShieldConnection('required')
    setShieldError('Confidential account is unavailable. Try again.')
  }, [canLoadShield, accountLoading, effective?.walletId, effective?.accountId])

  useEffect(() => {
    if (!shieldBalances) return
    setShieldConnection('connected')
    setShieldError(null)
  }, [shieldBalances])

  useEffect(() => {
    if (!shieldBalanceError) return
    setShieldConnection('required')
    setShieldError(shieldBalanceError)
  }, [shieldBalanceError])

  useEffect(() => {
    userEditedMove.current = false
    userPickedMethod.current = launchHasDraft
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
    setEvmMoveFee({ kind: 'tier', tier: 'standard' })
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
    () => shieldBalances ?? shieldPortfolioBalances(portfolio),
    [shieldBalances, portfolio]
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
  useEffect(() => {
    setEvmMoveFee({ kind: 'tier', tier: 'standard' })
  }, [selected?.chain.chain.id])
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
  const rankPickerAsset = (item: TransferAsset) =>
    rankTokenSearchFields(
      {
        symbol: item.asset.metadata.symbol,
        name: item.asset.metadata.name,
        contractAddress: item.asset.asset.namespace === 'erc20' ? item.asset.asset.reference : null,
        assetId: item.asset.asset.id,
        searchTerms: [item.chain.chain.displayName]
      },
      assetSearch
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
      ? getEvmTokenFeeBalanceError(
          'token',
          nativeFeeRaw,
          formatSymbol(nativeFeeAsset.metadata.symbol)
        )
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
  useEffect(() => {
    if (!supportedPair && !fundingRoute) return
    let cancelled = false
    void (async () => {
      try {
        const prices = await assetPriceClient.getPrices('read')
        if (!cancelled && prices) setAssetPrices(prices)
      } catch {}
    })()
    return () => {
      cancelled = true
    }
  }, [scopeKey, supportedPair, fundingRoute])
  const managedAsset = useMemo(
    () =>
      selected
        ? resolveShieldManagedAsset(selected.asset, managedAssets, catalogTokens, currentNetwork)
        : null,
    [selected?.asset, managedAssets, catalogTokens, currentNetwork]
  )
  const clusterAvailable = Boolean(clusterPair && managedAsset && effective)
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
  const destinationNetworkOptions: ChainSelectorOption[] = [
    ...new Map(destinationOptions.map(item => [item.chain.chain.id, item])).values()
  ].map(item => ({
    id: item.chain.chain.id,
    name: item.chain.chain.displayName,
    icon: resolveChainIconAlias(
      item.chain.chain.family,
      item.chain.chain.displayName,
      item.chain.chain.id
    )
  }))
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
  const hasShieldSnapshot = shieldBalances !== null
  const refreshedShieldRaw =
    managedAsset && hasShieldSnapshot
      ? (getConfidentialAvailableForAsset(shieldBalances, managedAsset.protocolAssetId) ?? '0')
      : null
  const shieldSourceRaw =
    from === 'shield'
      ? (refreshedShieldRaw ??
        (managedAsset && currentShieldBalances
          ? (getConfidentialAvailableForAsset(
              currentShieldBalances,
              managedAsset.protocolAssetId
            ) ?? null)
          : null))
      : sourceRaw
  const routeKey = `${scopeKey}:${selected?.asset.asset.id ?? ''}:${from}:${to}:${destination?.asset.asset.id ?? ''}`
  const routeState = routeSnapshot?.key === routeKey ? routeSnapshot.status : 'loading'
  const methodAvailable = supportedPair && routeState === 'supported'

  useEffect(() => {
    let cancelled = false
    if (!selected || selected.chain.chain.family !== 'evm' || !eligible || !supportedPair) {
      setRouteSnapshot({ key: routeKey, status: 'unsupported' })
      return
    }
    if (!amount.trim()) {
      setRouteSnapshot(null)
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
        if (!resolveRheaPrivateTransferToken(catalog.tokens, contract)) {
          setRouteSnapshot({
            key: routeKey,
            status: catalog.failedChainIds.includes(Number(match[1])) ? 'error' : 'unsupported'
          })
          return
        }
        const confidentialSupport = resolveConfidentialEvmAssetSupport({
          chain: selected.chain.chain,
          asset: selected.asset.asset,
          catalog
        })
        setRouteSnapshot({
          key: routeKey,
          status:
            confidentialSupport === 'supported'
              ? 'supported'
              : confidentialSupport === 'unsupported'
                ? 'unsupported'
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
  }, [routeKey, selected?.chain.chain.id, eligible, supportedPair, retry, amount])

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
    refreshOnExpiry: false,
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
        executionMode: source!.executionMode,
        purpose: source!.executionMode === 'private' ? 'private-transfer' : 'confidential-funding'
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
  const confidentialRouteError =
    supportedPair && selected && amount.trim() && routeState === 'unsupported' && !clusterAvailable
      ? 'Confidential transfers are unavailable for this asset.'
      : null
  const estimateAmountRaw = useMemo(() => {
    if (!selected || currentAmount.length === 0 || currentAmount === '.') return null
    try {
      const raw = parseDisplayUnitAmount(currentAmount, selected.asset.metadata.decimals)
      return BigInt(raw) > 0n ? raw : null
    } catch {
      return null
    }
  }, [selected, currentAmount])
  const methodEstimateKey = `${routeKey}:${estimateAmountRaw ?? ''}:${source?.sender}:${source?.recipient}:${source?.executionMode}:${retry}`
  const canEstimateMethods = Boolean(
    draftScope === scopeKey &&
    clusterPair &&
    selected &&
    eligible &&
    source &&
    estimateAmountRaw &&
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
    requestKey: `${methodEstimateKey}:${shieldConnection}:${JSON.stringify(evmMoveFee)}`,
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
        managed: managedAsset!,
        ...(from === 'shield' ? {} : { feeSelection: evmMoveFee })
      })
      const preview = await confidentialFundingClient.preview(request)
      signal.throwIfAborted()
      return clusterMoveEstimate(estimateAmountRaw!, preview)
    }
  })
  const clusterQuoted = Boolean(
    canEstimateMethods && managedAsset && shieldConnection === 'connected' && clusterEstimate.value
  )
  const directQuoted = Boolean(canEstimateMethods && methodAvailable && directEstimate.value)
  const selectedEstimate = method === 'cluster' ? clusterEstimate : directEstimate
  const clusterUnavailable = getSwapQuoteFailureMessage(clusterEstimate.errorMessage) === 'no route'
  const directUnavailable =
    directEstimate.errorMessage === 'Move route unavailable' ||
    getSwapQuoteFailureMessage(directEstimate.errorMessage) === 'no route'
  const quoteMinimumError = useMemo(() => {
    if (!selected) return null
    const message = selectedEstimate.errorMessage
    return message
      ? formatMoveQuoteMinimumError(
          message,
          selected.asset.metadata.decimals,
          formatSymbol(selected.asset.metadata.symbol)
        )
      : null
  }, [selected, selectedEstimate.errorMessage])
  const showGenericEstimateError =
    clusterPair &&
    selectedEstimate.error &&
    !quoteMinimumError &&
    !clusterEstimate.loading &&
    !directEstimate.loading
  const transferError =
    amountError ??
    quoteMinimumError ??
    confidentialRouteError ??
    ((fundingRoute ? shieldAmountState?.amountRaw : amountState?.amountRaw)
      ? tokenFeeBalanceError
      : null)
  useEffect(() => {
    if (
      !clusterPair ||
      !clusterAvailable ||
      clusterUnavailable ||
      userPickedMethod.current ||
      method === 'cluster'
    )
      return
    setMethod('cluster')
  }, [clusterPair, clusterAvailable, clusterUnavailable, method])
  useEffect(() => {
    if (method === 'cluster' && clusterUnavailable && directQuoted) {
      userPickedMethod.current = false
      setMethod('directly')
    } else if (method === 'directly' && directUnavailable && clusterQuoted) {
      userPickedMethod.current = false
      setMethod('cluster')
    }
  }, [method, clusterUnavailable, directUnavailable, clusterQuoted, directQuoted])
  const shieldReviewKey = `${routeKey}:${method}:${currentAmount}:${shieldAmountState?.amountRaw ?? ''}:${JSON.stringify(evmMoveFee)}`
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
  const symbol = formatSymbol(selected?.asset.metadata.symbol)
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
  const pickerAccount = activeAccount
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
  const shieldNeedsAuthorization = shieldBalanceErrorCode === 'authorization_required'
  const refreshShield = async (authorize = false) => {
    if (!effective || !scopeStillCurrent()) return
    setShieldConnection('busy')
    setShieldError(null)
    if (!canLoadShield) {
      await refreshAccountNetworks()
      if (scopeStillCurrent()) {
        setShieldConnection('required')
        setShieldError('Confidential account is unavailable. Try again.')
      }
      return
    }
    const updated = await loadShieldBalances(true, authorize)
    if (!scopeStillCurrent()) return
    setShieldConnection(updated ? 'connected' : 'required')
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
        ...(from === 'shield' ? {} : { feeSelection: evmMoveFee }),
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
      if (scopeStillCurrent()) {
        const message = error instanceof Error ? error.message : ''
        const classifiedMessage = classifyError(error).userMessage
        setShieldError(
          message === 'Gas limit is below the estimated gas required'
            ? 'Gas limit is below the estimated gas required. Edit the network fee and try again.'
            : classifiedMessage === 'Insufficient native balance for the amount and network fee.' &&
                nativeFeeAsset
              ? `Insufficient ${formatSymbol(nativeFeeAsset.metadata.symbol)} balance for the amount and network fee.`
              : classifiedMessage
        )
      }
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
      setAmount('')
      setMaxSelected(false)
      setShieldError(null)
      setConfirmUncertain(false)
      void loadShieldBalances(true, false)
      void openConfidentialActivity(
        plan,
        () => navigate(`/?tab=activity&transactionId=${encodeURIComponent(plan.transactionId)}`),
        selected
          ? {
              operation: 'move',
              amount: currentAmount,
              symbol: formatSymbol(selected.asset.metadata.symbol),
              from: `${accountName} · ${domainLabel(from)}`,
              recipient: `${accountName} · ${domainLabel(to)}`,
              network: selected.chain.chain.displayName
            }
          : undefined
      )
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
        setShieldError(classifyError(error).userMessage)
    } finally {
      if (scopeStillCurrent()) setConfirmingShield(false)
    }
  }

  const moveReviewFiatValue = useMemo(() => {
    if (!selected || !assetPrices || !currentAmount) return null
    const priceUsd = findAssetPrice(assetPrices, selected.asset.asset.id)?.priceUsd
    if (typeof priceUsd !== 'string' || !priceUsd) return null
    const usd = Number(priceUsd)
    if (!Number.isFinite(usd) || usd <= 0) return null
    try {
      const raw = parseDisplayUnitAmount(currentAmount, selected.asset.metadata.decimals)
      const quantity = Number(formatBaseUnitAmount(raw, selected.asset.metadata.decimals))
      if (!Number.isFinite(quantity) || quantity <= 0) return null
      return formatFiatAmount(quantity * usd, { showSign: true })
    } catch {
      return null
    }
  }, [selected, assetPrices, currentAmount])

  const changeShieldFee = async (next: EvmFeeSelection) => {
    const review = activeShieldReview
    if (!review?.sourceEvmFee || areEvmFeeSelectionsEqual(next, evmMoveFee)) return
    if (confirmAttemptedPlanId.current === review.planId)
      throw new Error('Check transfer status before changing network fee.')
    setCancellingShield(true)
    try {
      await confidentialFundingClient.cancel(review.planId)
      if (!scopeStillCurrent()) return
      setPreparedShield(null)
      setShieldError(null)
      setEvmMoveFee(next)
    } finally {
      if (scopeStillCurrent()) setCancellingShield(false)
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
    const quoteDifference =
      quoteFeeRaw !== null && BigInt(quoteFeeRaw) > 0n ? (
        <AmountDisplay
          value={formatBaseUnitAmount(quoteFeeRaw, selected.asset.metadata.decimals)}
          symbol={symbol}
          profile="fee"
        />
      ) : null
    const networkFee = activeShieldReview.sourceNetworkFee
    return (
      <div className="page-container">
        <TransactionReviewView
          variant="figma"
          title={activeShieldReview.operation === 'cluster' ? 'Cluster Move' : 'Confirm Move'}
          asset={{
            assetId: selected.asset.asset.id,
            symbol,
            icon: selected.asset.metadata.iconUrl
          }}
          amount={currentAmount}
          amountDetails={false}
          fiatValue={moveReviewFiatValue}
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
                    <span className="ml-auto mt-1 block max-w-full font-mono text-xs">
                      {formatMoveReviewAddress(activeShieldReview.sourceAddress)}
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
                    <span className="ml-auto mt-1 block max-w-full font-mono text-xs">
                      {formatMoveReviewAddress(activeShieldReview.destinationAddress)}
                    </span>
                  </span>
                )
            },
            {
              label: 'Estimated receive',
              content: (
                <AmountDisplay
                  value={output}
                  symbol={targetAsset ? formatSymbol(targetAsset.asset.metadata.symbol) : symbol}
                />
              )
            },
            {
              label: 'Minimum receive',
              content: (
                <AmountDisplay
                  value={minimum}
                  symbol={targetAsset ? formatSymbol(targetAsset.asset.metadata.symbol) : symbol}
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
            ...(quoteDifference ? [{ label: 'Quote difference', content: quoteDifference }] : []),
            ...(networkFee
              ? [
                  {
                    label: 'Max network fee',
                    content: activeShieldReview.sourceEvmFee ? (
                      <NetworkFeeTierPicker
                        chainFamily="evm"
                        tier={evmMoveFee.kind === 'tier' ? evmMoveFee.tier : 'standard'}
                        selection={evmMoveFee}
                        feeModel={
                          activeShieldReview.sourceEvmFee.transactionType === 'legacy'
                            ? 'legacy'
                            : 'eip1559'
                        }
                        customDefaults={{
                          gasLimit: activeShieldReview.sourceEvmFee.gasLimit,
                          maxFeePerGasWei: activeShieldReview.sourceEvmFee.maxFeePerGasWei ?? '0',
                          maxPriorityFeePerGasWei:
                            activeShieldReview.sourceEvmFee.maxPriorityFeePerGasWei ?? '0',
                          gasPriceWei: activeShieldReview.sourceEvmFee.gasPriceWei
                        }}
                        amount={formatBaseUnitAmount(networkFee.raw, networkFee.decimals)}
                        symbol={formatSymbol(networkFee.symbol)}
                        onTierChange={tier => changeShieldFee({ kind: 'tier', tier })}
                        onSelectionChange={changeShieldFee}
                        disabled={
                          cancellingShield ||
                          confirmingShield ||
                          confirmUncertain ||
                          preparingShield
                        }
                        details={
                          <div className="space-y-2 border-t border-border/60 pt-3 text-xs">
                            <div className="flex justify-between gap-3">
                              <span className="text-muted">Gas limit</span>
                              <span>{activeShieldReview.sourceEvmFee.gasLimit}</span>
                            </div>
                            {activeShieldReview.sourceEvmFee.transactionType === 'legacy' ? (
                              <div className="flex justify-between gap-3">
                                <span className="text-muted">Gas price</span>
                                <span>
                                  {formatEvmWeiAsGwei(
                                    activeShieldReview.sourceEvmFee.gasPriceWei ?? '0'
                                  )}{' '}
                                  GWEI
                                </span>
                              </div>
                            ) : (
                              <>
                                <div className="flex justify-between gap-3">
                                  <span className="text-muted">Max fee per gas</span>
                                  <span>
                                    {formatEvmWeiAsGwei(
                                      activeShieldReview.sourceEvmFee.maxFeePerGasWei ?? '0'
                                    )}{' '}
                                    GWEI
                                  </span>
                                </div>
                                <div className="flex justify-between gap-3">
                                  <span className="text-muted">Priority fee per gas</span>
                                  <span>
                                    {formatEvmWeiAsGwei(
                                      activeShieldReview.sourceEvmFee.maxPriorityFeePerGasWei ?? '0'
                                    )}{' '}
                                    GWEI
                                  </span>
                                </div>
                              </>
                            )}
                          </div>
                        }
                      />
                    ) : (
                      <AmountDisplay
                        value={formatBaseUnitAmount(networkFee.raw, networkFee.decimals)}
                        symbol={formatSymbol(networkFee.symbol)}
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
          submitting={
            confirmingShield && confirmAttemptedPlanId.current === activeShieldReview.planId
          }
          cancelDisabled={cancellingShield}
          confirmDisabled={
            !scopeStillCurrent() ||
            cancellingShield ||
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
        <div className="flex min-h-[145px] shrink-0 flex-col items-center justify-center gap-2 py-3">
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
                symbol={symbol || formatSymbol(pendingAssetHint!.symbol)}
                icon={selected?.asset.metadata.iconUrl ?? pendingAssetHint?.iconUrl}
                {...(from !== 'shield' ? { blockchain: networkIcon } : {})}
                size={26}
              />
            ) : (
              <Icon icon="lucide:coins" width={20} height={20} />
            )}
            <span className="max-w-32 truncate">
              {symbol ||
                formatSymbol(pendingAssetHint?.symbol) ||
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
        </div>
        <div className="mt-3 shrink-0">
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
              setNetworkPickerOpen(true)
            }}
            showNetwork={from === 'shield'}
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
        {selected?.chain.chain.family === 'evm' &&
          clusterPair &&
          (clusterAvailable || methodAvailable) && (
            <div
              role="radiogroup"
              aria-label="Transfer method"
              className={cn(
                'mt-auto grid shrink-0 gap-2.5 pt-4',
                clusterAvailable && methodAvailable
                  ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
                  : 'grid-cols-1'
              )}
            >
              {clusterAvailable && (
                <MethodCard
                  title="Cluster"
                  detail="Multiple transactions"
                  recommended
                  selected={method === 'cluster'}
                  disabled={clusterUnavailable}
                  estimate={clusterEstimate.value}
                  loading={
                    canEstimateMethods &&
                    shieldConnection === 'connected' &&
                    clusterEstimate.loading
                  }
                  fee={formatMoveMethodFee(clusterEstimate.value, selected.asset)}
                  onClick={() => {
                    userPickedMethod.current = true
                    setMethod('cluster')
                  }}
                />
              )}
              {methodAvailable && (
                <MethodCard
                  title="Directly"
                  detail="One transaction"
                  recommended={false}
                  selected={method === 'directly'}
                  disabled={directUnavailable}
                  estimate={directEstimate.value}
                  loading={canEstimateMethods && methodAvailable && directEstimate.loading}
                  fee={formatMoveMethodFee(directEstimate.value, selected.asset)}
                  onClick={() => {
                    userPickedMethod.current = true
                    setMethod('directly')
                  }}
                />
              )}
            </div>
          )}
        {fundingRoute &&
          selected?.chain.chain.family === 'evm' &&
          from !== 'shield' &&
          evmMoveFee.kind !== 'tier' && (
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-xs">
              <span className="text-muted">Network fee</span>
              <NetworkFeeTierPicker
                chainFamily="evm"
                tier="standard"
                selection={evmMoveFee}
                feeModel={evmMoveFee.kind === 'legacy' ? 'legacy' : 'eip1559'}
                amount={
                  clusterEstimate.value?.sourceNetworkFee
                    ? formatBaseUnitAmount(
                        clusterEstimate.value.sourceNetworkFee.raw,
                        clusterEstimate.value.sourceNetworkFee.decimals
                      )
                    : '—'
                }
                symbol={
                  clusterEstimate.value?.sourceNetworkFee?.symbol ??
                  nativeFeeAsset?.metadata.symbol ??
                  selected.chain.chain.displayName
                }
                onTierChange={tier => {
                  setEvmMoveFee({ kind: 'tier', tier })
                  setShieldError(null)
                }}
                onSelectionChange={next => {
                  setEvmMoveFee(next)
                  setShieldError(null)
                }}
              />
            </div>
          )}
        {showGenericEstimateError && (
          <InlineError
            message="Transfer estimate unavailable. Try again."
            onRetry={() => setRetry(value => value + 1)}
          />
        )}
        {supportedPair && amount.trim() && routeState === 'error' && (
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
              ? () => void refreshShield(shieldNeedsAuthorization)
              : fundingRoute
                ? () => void prepareShield()
                : review
          }
        >
          {fundingRoute && shieldConnection !== 'connected'
            ? shieldConnection === 'required'
              ? shieldNeedsAuthorization
                ? 'Connect'
                : 'Retry'
              : 'Loading balances…'
            : clusterSelected
              ? 'Review Cluster'
              : shieldPair
                ? 'Move'
                : 'Move'}
        </Button>
      </div>

      <TokenSelectorDialog
        open={assetPickerOpen}
        onOpenChange={setAssetPickerOpen}
        title="Select asset"
        walletMode={walletMode}
      >
        <TokenSelectorView
          search={assetSearch}
          onSearchChange={setAssetSearch}
          networks={Array.from(
            new Map(pickerRows.map(item => [item.chain.chain.id, item.chain])).values()
          ).map(chain => ({
            id: chain.chain.id,
            label: chain.chain.displayName,
            iconChain: resolveChainIconAlias(
              chain.chain.family,
              chain.chain.displayName,
              chain.chain.id
            )
          }))}
          selectedNetwork={assetChainId}
          onNetworkChange={setAssetChainId}
          selectedKey={selected?.asset.asset.id}
          items={pickerRows
            .filter(item => assetChainId === 'all' || item.chain.chain.id === assetChainId)
            .filter(item => rankPickerAsset(item) < 99)
            .sort((left, right) => rankPickerAsset(left) - rankPickerAsset(right))
            .map(item => ({
              key: item.asset.asset.id,
              symbol: formatSymbol(item.asset.metadata.symbol),
              icon: (
                <TokenIcon
                  assetId={item.asset.asset.id}
                  symbol={formatSymbol(item.asset.metadata.symbol)}
                  icon={item.asset.metadata.iconUrl}
                  blockchain={resolveChainIconAlias(
                    item.chain.chain.family,
                    item.chain.chain.displayName,
                    item.chain.chain.id
                  )}
                  size={32}
                />
              ),
              subtitle: item.chain.chain.displayName,
              balance: (
                <span className="block truncate text-base tabular-nums">
                  {formatTokenQuantity(
                    formatBaseUnitAmount(item.sourceRaw, item.asset.metadata.decimals)
                  )}
                  <span className="block truncate text-xs text-muted">
                    {item.valueUsd !== null ? formatFiatAmount(item.valueUsd) : '—'}
                  </span>
                </span>
              )
            }))}
          onSelect={key => {
            const item = pickerRows.find(row => row.asset.asset.id === key)
            if (!item) return
            userEditedMove.current = true
            setSelectedAssetId(item.asset.asset.id)
            setDestinationAssetId(null)
            setAmount('')
            setMaxSelected(false)
            setAssetPickerOpen(false)
          }}
          emptyMessage={
            pickerRows.length === 0
              ? loadState === 'loading' || (from === 'shield' && shieldConnection === 'checking')
                ? 'Loading assets…'
                : 'No assets available'
              : 'No assets found'
          }
        />
      </TokenSelectorDialog>
      <ChainSelector
        open={networkPickerOpen}
        onOpenChange={setNetworkPickerOpen}
        options={destinationNetworkOptions}
        selectedId={destination?.chain.chain.id ?? null}
        label={`Networks for ${symbol}`}
        onSelect={id => {
          const item =
            destination?.chain.chain.id === id
              ? destination
              : destinationOptions.find(option => option.chain.chain.id === id)
          if (!item) return
          userEditedMove.current = true
          setDestinationAssetId(item.asset.asset.id)
          setShieldError(null)
        }}
      />
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
              Move {domainPicker === 'from' ? 'from' : 'to'} · {walletDisplayName} ·{' '}
              {pickerAccountName}
            </DialogTitle>
            <DialogDescription className="sr-only">Select a balance.</DialogDescription>
          </DialogHeader>
          <div aria-label={`${pickerAccountName} balances`} className="space-y-2 pb-2">
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
                  <Icon icon="noir:shield-assets" width={16} height={16} />
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
