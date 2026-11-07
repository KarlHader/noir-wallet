import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { formatBaseUnitAmount, formatTokenQuantity } from '@/lib/number-format'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { cn } from '@/lib/utils'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useNavigate } from '@/popup/provider/Router'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
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
  resolveTransferDomains,
  selectDefaultTransferAssetId,
  type PrivateBalanceTransferDirection,
  type TransferDomain
} from '@/popup/services/private-balance-transfer'
import {
  buildAddToPrivateEvmPath,
  buildMoveToMainEvmPath,
  getEvmTokenFeeBalanceError
} from './evm-send-validation'

type TransferAsset = { asset: PortfolioAssetView; chain: PortfolioChainView }

function domainLabel(domain: TransferDomain): string {
  return domain === 'shield' ? 'Shield' : domain === 'private' ? 'Private' : 'Public'
}

function DomainCard({
  label,
  accountName,
  domain,
  address,
  balance,
  network,
  networkName,
  showNetwork,
  onClick,
  onMax,
  maxDisabled,
  maxLoading,
  disabled
}: {
  label: 'From' | 'To'
  accountName: string
  domain: TransferDomain
  address: string
  balance: string
  network: string
  networkName: string
  showNetwork: boolean
  onClick: () => void
  onMax?: () => void
  maxDisabled?: boolean
  maxLoading?: boolean
  disabled?: boolean
}) {
  return (
    <div className="flex min-h-[104px] w-full flex-col justify-between rounded-lg border border-white/10 bg-wallet-surface px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium leading-[18px] text-muted">{label}</span>
        {(showNetwork || domain === 'shield') && (
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={`Select ${label.toLowerCase()} account and network`}
            className="wallet-interactive flex min-w-0 max-w-[60%] items-center gap-1 rounded text-xs text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            {domain === 'shield' ? (
              <img
                src={nearLogo}
                alt=""
                aria-hidden="true"
                className="size-4 shrink-0 rounded-[3px]"
              />
            ) : (
              <ChainIcon
                chain={network}
                width={16}
                height={16}
                showTooltip={false}
                alt=""
                aria-hidden="true"
                className="shrink-0 rounded-[4px]"
              />
            )}
            <span className="truncate">
              {domain === 'shield' ? 'NEAR Confidential' : networkName}
            </span>
            <Icon icon="lucide:chevron-down" width={13} height={13} />
          </button>
        )}
      </div>
      <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={`${label}: ${domainLabel(domain)}. Change account`}
          className="wallet-interactive flex min-w-0 items-center gap-1.5 rounded text-left hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-primary"
        >
          <span className="min-w-0 truncate text-sm font-medium leading-[18px]">{accountName}</span>
          <span
            className={cn(
              'shrink-0 rounded px-2 py-0.5 text-xs leading-4',
              domain === 'shield'
                ? 'bg-success/10 text-success'
                : domain === 'private'
                  ? 'bg-warning/10 text-warning'
                  : 'bg-white/10 text-muted'
            )}
          >
            {domainLabel(domain)}
          </span>
          <Icon icon="lucide:chevron-down" width={12} height={12} className="shrink-0 text-muted" />
        </button>
        <div className="max-w-[43%] min-w-0 text-right">
          <span
            className="block max-w-full truncate text-right text-sm font-medium leading-[18px]"
            title={balance}
          >
            {formatTokenQuantity(balance)}
          </span>
        </div>
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
        {domain !== 'shield' && (
          <span className="min-w-0 truncate font-mono text-xs text-muted" title={address}>
            {address ? formatSortAddress(address) : '—'}
          </span>
        )}
        {onMax && (
          <button
            type="button"
            onClick={onMax}
            disabled={maxDisabled || maxLoading}
            aria-label="Max"
            className="wallet-interactive ml-auto shrink-0 rounded bg-white/10 px-1.5 text-xs font-medium leading-4 text-muted enabled:hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
          >
            {maxLoading ? '…' : 'Max'}
          </button>
        )}
      </div>
    </div>
  )
}

function MethodCard({
  title,
  detail,
  selected,
  disabled,
  onClick
}: {
  title: 'Cluster' | 'Directly'
  detail: string
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative flex min-h-[75px] flex-col rounded-lg border bg-wallet-surface px-3 py-3 text-left text-xs font-medium leading-4',
        selected ? 'border-primary/60' : 'border-white/10',
        disabled && 'opacity-60'
      )}
    >
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
  const walletMode = params.get('mode') === 'private' ? 'private' : 'public'
  const routeFrom = params.get('from')
  const routeTo = params.get('to')
  const { goBack, navigate } = useNavigate()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
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
    refresh: refreshPortfolio
  } = useHomePortfolio(effective?.walletId ?? null, effective?.accountId ?? null)
  const [retry, setRetry] = useState(0)
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [domainPicker, setDomainPicker] = useState<'from' | 'to' | null>(null)
  const [pickerAccountId, setPickerAccountId] = useState<string | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState(params.get('assetId'))
  const [from, setFrom] = useState<TransferDomain>(
    () => resolveTransferDomains({ mode: walletMode, from: routeFrom, to: routeTo }).from
  )
  const [to, setTo] = useState<TransferDomain>(
    () => resolveTransferDomains({ mode: walletMode, from: routeFrom, to: routeTo }).to
  )
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<'cluster' | 'directly'>('directly')
  const [maxSelected, setMaxSelected] = useState(false)
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

  useEffect(() => {
    let cancelled = false
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
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentNetwork, endpointRuntimeKey])

  useEffect(() => {
    let cancelled = false
    setShieldSnapshot(null)
    setShieldConnection('checking')
    if (!effective) return
    const scope = {
      network: currentNetwork,
      keyDomainId: effective.walletId,
      accountId: effective.accountId
    }
    void confidentialFundingClient
      .refreshBalances(scope, false)
      .then(balances => {
        if (cancelled) return
        setShieldSnapshot({ key: scopeKey, balances })
        setShieldConnection('connected')
        void refreshPortfolio(true)
      })
      .catch(() => {
        if (!cancelled) setShieldConnection('required')
      })
    return () => {
      cancelled = true
    }
  }, [scopeKey])

  useEffect(() => {
    const domains = resolveTransferDomains({ mode: walletMode, from: routeFrom, to: routeTo })
    setFrom(domains.from)
    setTo(domains.to)
    setSelectedAssetId(params.get('assetId'))
    setAmount('')
    setMethod('directly')
    setMaxSelected(false)
    setPreparingShield(false)
    setConfirmingShield(false)
    setCancellingShield(false)
    setShieldError(null)
    setConfirmUncertain(false)
    setAssetPickerOpen(false)
    setDomainPicker(null)
    setPickerAccountId(null)
  }, [scopeKey])

  const eligibleChainIds = useMemo(
    () => getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet'),
    [activeAccount, currentNetwork]
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
    const shieldBalances =
      shieldSnapshot?.key === scopeKey
        ? shieldSnapshot.balances
        : shieldPortfolioBalances(portfolio)
    const heldShieldAssets = shieldFundingSources(
      listShieldFundingAssets(portfolio, managedAssets, catalogTokens, currentNetwork),
      shieldBalances
    )
    const existing = new Set(publicAssets.map(item => item.asset.asset.id))
    return [
      ...publicAssets,
      ...heldShieldAssets
        .filter(
          item =>
            eligibleChainIds.includes(item.chain.chain.id) && !existing.has(item.asset.asset.id)
        )
        .map(({ asset, chain }) => ({ asset, chain }))
    ]
  }, [
    portfolio,
    shieldSnapshot,
    scopeKey,
    managedAssets,
    catalogTokens,
    currentNetwork,
    eligibleChainIds
  ])
  const defaultAssetId = useMemo(
    () => selectDefaultTransferAssetId({ assets, from, to, eligibleChainIds }),
    [assets, from, to, eligibleChainIds]
  )
  const selected =
    assets.find(item => item.asset.asset.id === (selectedAssetId ?? defaultAssetId)) ?? null
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
  const targetRaw = selected ? getTransferDomainBalanceRaw(selected.asset, to) : null
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
  const hasShieldSnapshot = shieldSnapshot?.key === scopeKey
  const refreshedShieldRaw =
    managedAsset && hasShieldSnapshot
      ? (getConfidentialAvailableForAsset(shieldSnapshot.balances, managedAsset.protocolAssetId) ??
        '0')
      : null
  const shieldSourceRaw = from === 'shield' ? refreshedShieldRaw : sourceRaw
  const shieldTargetRaw = to === 'shield' ? refreshedShieldRaw : targetRaw
  const routeKey = `${scopeKey}:${selected?.asset.asset.id ?? ''}:${from}:${to}`
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

  const maximum = useTransferMaximum({
    enabled: Boolean(
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
    ),
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
  useEffect(() => {
    const value = fundingRoute ? shieldAvailable : available
    if (maxSelected && value) setAmount(value.display)
  }, [maxSelected, fundingRoute, shieldAvailable?.display, available?.display])
  const amountState =
    selected && available && source && supportedPair
      ? resolvePrivateBalanceTransferAmount({
          amount,
          decimals: selected.asset.metadata.decimals,
          availableRaw: available.amountRaw,
          sourceLabel: source.sourceLabel
        })
      : null
  const shieldAmountState =
    selected && shieldAvailable
      ? resolvePrivateBalanceTransferAmount({
          amount,
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
  const shieldReviewKey = `${routeKey}:${method}:${amount}:${shieldAmountState?.amountRaw ?? ''}`
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
    selected &&
    eligible &&
    supportedPair &&
    routeState === 'supported' &&
    !tokenFeeBalanceError &&
    (direction === 'main-to-private' ? publicRaw !== null : privateRaw !== null) &&
    (!maxSelected ||
      selected.asset.asset.kind !== 'native' ||
      (maximum.value && !maximum.loading)) &&
    amountState?.amountRaw
  )
  const canReviewShield = Boolean(
    fundingRoute &&
    selected &&
    eligible &&
    managedAsset &&
    effective &&
    shieldConnection === 'connected' &&
    shieldSourceRaw !== null &&
    !tokenFeeBalanceError &&
    (!maxSelected ||
      selected.asset.asset.kind !== 'native' ||
      from === 'shield' ||
      (maximum.value && !maximum.loading)) &&
    shieldAmountState?.amountRaw
  )
  const selectDomain = (domain: TransferDomain, side: 'from' | 'to') => {
    if (pickerAccountId !== effective?.accountId) return
    if (selected) setSelectedAssetId(selected.asset.asset.id)
    if (side === 'from') {
      setFrom(domain)
      if (domain === to) setTo(from)
    } else {
      setTo(domain)
      if (domain === from) setFrom(to)
    }
    setAmount('')
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
            amount,
            maximum: maxSelected
          })
        : buildMoveToMainEvmPath({
            assetId: selected.asset.asset.id,
            mainAddress,
            amount,
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
  const targetBalance =
    selected && (shieldPair ? shieldTargetRaw : targetRaw) !== null
      ? formatBaseUnitAmount(
          (shieldPair ? shieldTargetRaw : targetRaw)!,
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
    ? resolveChainIconAlias(selected.chain.chain.family, selected.chain.chain.displayName)
    : 'evm'
  const walletAccounts =
    catalog?.accounts
      .filter(account => account.walletId === effective?.walletId)
      .sort((left, right) => left.accountIndex - right.accountIndex) ??
    (activeAccount ? [activeAccount] : [])
  const pickerAccount =
    walletAccounts.find(account => account.accountId === pickerAccountId) ?? activeAccount
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
      setShieldError(error instanceof Error ? error.message : 'Shield could not connect')
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
        managed: managedAsset
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
      selected.asset.metadata.decimals
    )
    const minimum = formatBaseUnitAmount(
      activeShieldReview.minimumOutputRaw,
      selected.asset.metadata.decimals
    )
    const quoteFeeRaw = shieldQuoteFeeRaw(activeShieldReview)
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
          amount={amount}
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
                    {accountName} · {domainLabel(to)} · {selected.chain.chain.displayName}
                    <span className="ml-auto mt-1 block w-[22ch] max-w-full break-all font-mono text-xs text-balance">
                      {activeShieldReview.destinationAddress}
                    </span>
                  </span>
                )
            },
            {
              label: 'Estimated receive',
              content: <AmountDisplay value={output} symbol={symbol} />
            },
            {
              label: 'Minimum receive',
              content: <AmountDisplay value={minimum} symbol={symbol} />
            },
            ...(activeShieldReview.operation === 'cluster'
              ? [{ label: 'Transfers', content: `${activeShieldReview.withdrawCount}` }]
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
        <div className="flex h-[122px] shrink-0 flex-col items-center justify-center gap-2 pt-2">
          <input
            id="transfer-amount"
            aria-label="Transfer amount"
            inputMode="decimal"
            value={amount}
            disabled={!selected}
            title={amount || undefined}
            style={{
              fontSize: `${Math.max(16, Math.min(40, Math.floor(500 / Math.max(1, amount.length))))}px`
            }}
            onChange={event => {
              const next = normalizePrivateBalanceTransferInput(event.target.value)
              if (next !== null) {
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
            className="wallet-interactive flex h-9 max-w-full items-center gap-2 rounded-full bg-card px-2 text-base font-medium leading-[21px] hover:bg-wallet-selected active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary"
            aria-label="Select transfer asset"
          >
            {selected ? (
              <TokenIcon
                assetId={selected.asset.asset.id}
                symbol={symbol}
                icon={selected.asset.metadata.iconUrl}
                size={26}
              />
            ) : (
              <Icon icon="lucide:coins" width={20} height={20} />
            )}
            <span className="max-w-32 truncate">{symbol || 'Select asset'}</span>
            <Icon icon="lucide:chevron-down" width={14} height={14} />
          </button>
        </div>
        <div className="relative mt-4 grid shrink-0 grid-rows-2 gap-2.5">
          <DomainCard
            label="From"
            accountName={accountName}
            domain={from}
            address={addressFor(from)}
            balance={sourceBalance}
            networkName={selected?.chain.chain.displayName ?? ''}
            network={from === 'shield' ? 'near' : networkIcon}
            showNetwork={false}
            onClick={() => openDomainPicker('from')}
            disabled={!selected}
            onMax={selected ? handleMax : undefined}
            maxDisabled={maxDisabled}
            maxLoading={maximum.loading}
          />
          <DomainCard
            label="To"
            accountName={accountName}
            domain={to}
            address={addressFor(to)}
            balance={targetBalance}
            networkName={selected?.chain.chain.displayName ?? ''}
            network={to === 'shield' ? 'near' : networkIcon}
            showNetwork={selected?.chain.chain.family === 'evm'}
            onClick={() => openDomainPicker('to')}
            disabled={!selected}
          />
          <button
            type="button"
            onClick={() => {
              if (selected) setSelectedAssetId(selected.asset.asset.id)
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
        {!selected && loadState !== 'loading' && loadState !== 'error' && (
          <p role="status" className="mt-3 text-center text-sm text-muted">
            No transferable assets
          </p>
        )}
        {transferError && (
          <p role="alert" className="mt-2 text-xs text-warning">
            {transferError}
          </p>
        )}
        {selected?.chain.chain.family === 'evm' && clusterPair && (
          <div
            role="radiogroup"
            aria-label="Transfer method"
            className="mt-auto grid shrink-0 grid-cols-2 gap-[11px] pt-3"
          >
            <MethodCard
              title="Cluster"
              detail="Multiple transfers"
              selected={method === 'cluster'}
              disabled={!eligible || !managedAsset}
              onClick={() => setMethod('cluster')}
            />
            <MethodCard
              title="Directly"
              detail="NEAR Confidential"
              selected={method === 'directly'}
              disabled={supportedPair && !methodAvailable}
              onClick={() => setMethod('directly')}
            />
          </div>
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
        {fundingRoute && shieldConnection === 'required' && (
          <Button size="wallet" variant="outline" onClick={() => void refreshShield()}>
            Connect Shield
          </Button>
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
          disabled={fundingRoute ? !canReviewShield || preparingShield : !canReview}
          isLoading={preparingShield}
          onClick={fundingRoute ? () => void prepareShield() : review}
        >
          {clusterSelected ? 'Review Cluster' : shieldPair ? 'Move' : 'Transfer'}
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
          <div className="space-y-1">
            {assets.map(item => (
              <button
                key={item.asset.asset.id}
                type="button"
                onClick={() => {
                  setSelectedAssetId(item.asset.asset.id)
                  setAmount('')
                  setMaxSelected(false)
                  setAssetPickerOpen(false)
                }}
                className="flex w-full items-center gap-3 rounded-lg bg-card p-3 text-left hover:bg-accent"
              >
                <TokenIcon
                  assetId={item.asset.asset.id}
                  symbol={item.asset.metadata.symbol}
                  icon={item.asset.metadata.iconUrl}
                  size={30}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.asset.metadata.symbol}</span>
                  <span className="block truncate text-xs text-muted">
                    {item.chain.chain.displayName}
                  </span>
                </span>
                <span className="min-w-0 max-w-[45%] break-all text-right font-sans text-xs tabular-nums">
                  {formatTokenQuantity(
                    formatBaseUnitAmount(item.asset.balance.totalRaw, item.asset.metadata.decimals)
                  )}
                </span>
              </button>
            ))}
            {assets.length === 0 && (
              <p className="py-4 text-center text-sm text-muted">
                {loadState === 'loading' ? 'Loading assets…' : 'No transferable assets'}
              </p>
            )}
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
              {activeAccount?.walletDisplayName ?? 'Wallet'}
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
                    <span className="block text-base font-medium leading-[21px]">
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
                    className="max-w-[38%] break-all text-right text-base font-medium leading-[21px]"
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
                <span className="block text-base font-medium leading-[21px]">Shield</span>
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
              <span className="max-w-[38%] break-all text-right text-base font-medium leading-[21px]">
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
