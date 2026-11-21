import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate as useRouterNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
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
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useSettingsStore } from '@/store/settings-store'
import { useNavigate } from '@/popup/provider/Router'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
import { useBalanceTransferEstimate } from '@/popup/hooks/useBalanceTransferEstimate'
import { useShieldBalances } from '@/popup/hooks/useShieldBalances'
import {
  clusterTransferEstimate,
  estimateDirectTransfer,
  formatBalanceTransferFee,
  formatTransferQuoteMinimumError,
  type BalanceTransferEstimate
} from '@/popup/services/balance-transfer-estimate'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenSelectorDialog } from '@/popup/components/tokens/TokenSelectorDialog'
import { TokenPicker, type TokenPickerAdapter } from '@/popup/components/tokens/TokenPicker'
import {
  shieldTokenSelectionItem,
  shieldTokenPickerAdapter
} from '@/popup/components/tokens/ShieldTokenPicker'
import type { ShieldTokenPickerItem } from '@/popup/services/shield-transfer'
import { ShieldProviderDialog } from '@/popup/components/portfolio/ShieldProviderPicker'
import { ShieldProviderLogo, SHIELD_PROVIDERS } from '@/popup/components/portfolio/shield-providers'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import {
  listExternalShieldReceiveAssets,
  resolveShieldReceiveProvider,
  shieldDepositSource
} from '@/popup/services/shield-deposit-route'
import { ShieldReceiveAddress } from '@/popup/components/portfolio/ShieldReceiveAddress'
import {
  BalanceTransferAccountCard,
  BalanceTransferAccounts,
  BalanceTransferAmount
} from '@/popup/components/transaction/BalanceTransferFields'
import {
  ZcashTransferReview,
  ZcashTransferRoute,
  ZcashTransferSyncStatus
} from '@/popup/components/zcash/ZcashTransferDetails'
import { useZcashTransfer } from '@/popup/hooks/useZcashTransfer'
import {
  hasNativeZecConfidentialSwapRoute,
  resolveShieldNativeZecSwapAvailable
} from '@/popup/services/shield-swap-zec-sources'
import { ChainSelector, type ChainSelectorOption } from '@/popup/components/common/ChainSelector'
import { ExecutionAccountIcon } from '@/popup/components/account/ExecutionAccountSelector'
import { Button } from '@/popup/components/ui/button'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import { areEvmFeeSelectionsEqual, type EvmFeeSelection } from '@/infrastructure/chains/evm'
import { Skeleton } from '@/popup/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { toWalletEvmQuoteToken } from '@/popup/services/token-address-discovery'
import type { SwapToken } from '@/core/services/intents-api'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import {
  listBalanceTransferAssetPickerRows,
  listTransferSameChainDestinationAssets
} from '@/popup/services/balance-transfer-asset-picker'
import {
  confidentialFundingClient,
  previewClusterNetworkFeeTiers
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
  formatShieldQuoteTime,
  getZcashTokenPickerChain,
  hasShieldTransferStarted,
  isClusterTransferRoute,
  isUnsignedShieldTerminal,
  isShieldTransferRoute,
  listShieldFundingAssets,
  listShieldMoveDestinations,
  listShieldTokenPickerNetworks,
  matchesShieldReview,
  resolveShieldManagedAsset,
  shieldFundingSources,
  shieldPortfolioBalances,
  shieldQuoteFeeRaw
} from '@/popup/services/shield-transfer'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import { openConfidentialActivity } from '@/popup/components/transaction/ConfidentialActivitySheet'
import { resolveNativeRouteMaximum } from '@/popup/services/transfer-maximum'
import {
  balanceTransferDomainLabel as domainLabel,
  balanceTransferLabel,
  fixedTransferSide,
  normalizePrivateBalanceTransferInput,
  getPrivateTransferChainIds,
  getTransferDomainBalanceRaw,
  resolvePrivateBalanceTransferAmount,
  resolvePrivateBalanceTransferSource,
  resolveBalanceTransferIntent,
  selectDefaultTransferAssetId,
  type PrivateBalanceTransferDirection,
  type TransferDomain
} from '@/popup/services/private-balance-transfer'
import {
  buildAddToPrivateEvmPath,
  buildMoveToMainEvmPath,
  getEvmTokenFeeBalanceError
} from '@/popup/services/evm-send-validation'
import {
  initialBalanceTransferDraft,
  readBalanceTransferAssetHint,
  readBalanceTransferDraft
} from '@/popup/services/balance-transfer-draft'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import { getFundingSourceUnavailableReason } from '@/core/wallet/funding-source'
import { getConfidentialZcashTransferRecipients } from '@/popup/services/zcash-self-transfer'
import { getZcashChainId } from '@/core/chains/registry'
import { ZEC_DECIMALS } from '@/config/wallet'
import {
  readShieldTransferPreference,
  selectShieldTransferAssetId,
  shieldTransferPreferenceKey,
  type ShieldTransferPreference
} from '@/popup/services/shield-transfer-preference'

type TransferAsset = { asset: PortfolioAssetView; chain: PortfolioChainView }
type TransferPickerRow =
  | ReturnType<typeof listBalanceTransferAssetPickerRows>[number]
  | ShieldTokenPickerItem

const transferAssetSearch: TokenPickerAdapter<TransferPickerRow> = {
  chainId: item => ('key' in item ? shieldTokenPickerAdapter.chainId(item) : item.chain.chain.id),
  searchFields: item =>
    'key' in item
      ? shieldTokenPickerAdapter.searchFields(item)
      : {
          symbol: item.asset.metadata.symbol,
          name: item.asset.metadata.name,
          contractAddress:
            item.asset.asset.namespace === 'erc20' ? item.asset.asset.reference : null,
          assetId: item.asset.asset.id,
          searchTerms: [item.chain.chain.displayName]
        }
}

function TransferBalanceOption({
  label,
  ariaLabel,
  icon,
  address,
  balance,
  selected = false,
  disabled,
  onSelect
}: {
  label: string
  ariaLabel?: string
  icon: ReactNode
  address?: string
  balance?: string | null
  selected?: boolean
  disabled: boolean
  onSelect?: () => void
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'wallet-interactive flex min-h-[65px] w-full items-center justify-between gap-3 rounded-lg border bg-white/5 px-3 py-2 text-left enabled:hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45',
        selected ? 'border-primary ring-1 ring-primary' : 'border-white/10'
      )}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-base font-medium leading-[21px]">
          <span className="shrink-0" aria-hidden="true">
            {icon}
          </span>
          <span>{label}</span>
        </span>
        {address !== undefined && (
          <span
            className="mt-1 block truncate font-mono text-xs font-medium leading-4 text-muted"
            title={address}
          >
            {address ? formatSortAddress(address) : '—'}
          </span>
        )}
      </span>
      {balance !== undefined && (
        <span
          className={cn(
            'max-w-[38%] break-words text-right text-base font-medium leading-[21px]',
            (!balance || balance === '0') && 'text-muted'
          )}
        >
          {balance ?? '—'}
        </span>
      )}
    </button>
  )
}

function formatMoveReviewAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 7)}...${address.slice(-5)}` : address
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
  estimate: BalanceTransferEstimate | null
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
        <span className="absolute -top-2.5 left-3 rounded-full bg-primary px-2 py-0.5 text-primary-foreground">
          Recommended
        </span>
      )}
      <span className="flex items-center justify-between gap-1 font-medium leading-[18px]">
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
      <span className="mt-2 flex min-h-8 justify-between gap-2">
        <span className="shrink-0 text-muted">Time</span>
        <span className="min-w-0 text-right">
          {loading ? (
            <Skeleton className="ml-auto h-4 w-12 max-w-full" />
          ) : (
            <span className="block">{estimate?.time ?? '—'}</span>
          )}
        </span>
      </span>
      <span className="mt-2 flex justify-between gap-2">
        <span className="shrink-0 text-muted">Fee</span>
        <span className="min-w-0 break-words text-right">
          {loading ? (
            <Skeleton className="ml-auto h-4 w-full max-w-24" />
          ) : (
            <>
              <span className="block">{fee.value}</span>
              {fee.detail && <span className="block text-muted">{fee.detail}</span>}
            </>
          )}
        </span>
      </span>
    </button>
  )
}

export function DepositWithdraw({ receiveEntry = false }: { readonly receiveEntry?: boolean }) {
  const [params] = useSearchParams()
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const scope = `${network}:${walletId}:${accountId}`
  return <DepositWithdrawForm key={`${scope}:${params.toString()}`} receiveEntry={receiveEntry} />
}

function NativeZcashReceiveForm({
  destination,
  retryPath,
  asset,
  accounts,
  onStateChange
}: {
  readonly destination: 'shielded' | 'confidential'
  readonly retryPath: string
  readonly asset: ReactNode
  readonly accounts: ReactNode
  readonly onStateChange: (state: { readonly reviewing: boolean; readonly busy: boolean }) => void
}) {
  const transfer = useZcashTransfer({ shieldReceive: { destination, retryPath }, onStateChange })
  const { action } = transfer
  if (!transfer.available) {
    return (
      <div className="flex flex-1 items-center justify-center px-5">
        <p className="text-center text-muted">No account available</p>
      </div>
    )
  }

  return (
    <>
      <div className="page-content min-h-0 !px-4 pt-4">
        <div className="space-y-2">
          <BalanceTransferAmount
            asset={asset}
            amount={{ label: 'ZEC amount', ...transfer.amountField }}
            balance={transfer.balance ?? '—'}
            max={transfer.maximum}
          />
          {accounts}
          {transfer.depositErrors.map((error, index) =>
            error ? <InlineError key={index} {...error} /> : null
          )}
          {transfer.balanceError && <InlineError {...transfer.balanceError} />}
          <ZcashTransferRoute route={transfer.route} />
        </div>
      </div>
      <div className="page-footer">
        <ZcashTransferSyncStatus sync={transfer.sync} />
        <Button
          size="wallet"
          disabled={action.disabled}
          isLoading={action.loading}
          onClick={action.onContinue}
          className="h-[45px] w-full"
        >
          {action.label}
        </Button>
      </div>
      <ZcashTransferReview transfer={transfer} />
    </>
  )
}

function DepositWithdrawForm({ receiveEntry }: { readonly receiveEntry: boolean }) {
  const [params] = useSearchParams()
  const location = useLocation()
  const routerNavigate = useRouterNavigate()
  const walletMode =
    params.get('mode') === 'private' || (receiveEntry && params.get('from') === 'private')
      ? 'private'
      : 'public'
  const routeFrom = params.get('from')
  const routeTo = receiveEntry ? 'shield' : params.get('to')
  const intent = receiveEntry ? 'deposit' : resolveBalanceTransferIntent(params.get('intent'))
  const fixedSide = fixedTransferSide(intent)
  const routeAssetId = params.get('assetId')
  const entry = receiveEntry ? 'shield' : params.get('entry')
  const shieldEntry =
    receiveEntry ||
    (entry === 'shield' &&
      (params.get('provider') === null || params.get('provider') === 'near-confidential'))
  const { goBack, navigate } = useNavigate()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const wallets = useWalletStore(state => state.wallets)
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const zcashBalance = useAccountDataStore(state => state.getCurrentBalance())
  const zecPrice = useWalletStore(state => state.zecPrice)
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
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
    shieldEntry && !receiveEntry && effective
      ? shieldTransferPreferenceKey(currentNetwork, effective.walletId, effective.accountId)
      : null
  const initialDraft = initialBalanceTransferDraft({
    state: location.state,
    scope: scopeKey,
    mode: walletMode,
    routeFrom,
    routeTo,
    routeAssetId,
    intent
  })
  const initialRouteState = useRef(location.state).current
  const launchDraft = initialBalanceTransferDraft({
    state: initialRouteState,
    scope: scopeKey,
    mode: walletMode,
    routeFrom,
    routeTo,
    routeAssetId,
    intent
  })
  const restoredLaunchDraft = readBalanceTransferDraft(initialRouteState, scopeKey)
  const launchHasDraft =
    restoredLaunchDraft !== null &&
    (!fixedSide || restoredLaunchDraft[fixedSide] === launchDraft[fixedSide])
  const moveAssetHint = readBalanceTransferAssetHint(location.state, scopeKey, initialDraft.assetId)
  const latestScopeKey = useRef(scopeKey)
  latestScopeKey.current = scopeKey
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
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
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const [receiveExternal, setReceiveExternal] = useState(
    () => shieldDepositSource(routeFrom) === 'external'
  )
  const [preferredReceiveProvider, setPreferredReceiveProvider] = useState<ShieldProvider | null>(
    () => {
      const provider = params.get('provider')
      return provider === 'zcash-shield' || provider === 'near-confidential' ? provider : null
    }
  )
  const [nativeReceiveState, setNativeReceiveState] = useState({ reviewing: false, busy: false })
  const [pickerAccountId, setPickerAccountId] = useState<string | null>(null)
  const [draftScope, setDraftScope] = useState(scopeKey)
  const [selectedAssetId, setSelectedAssetId] = useState(initialDraft.assetId)
  const [from, setFrom] = useState<TransferDomain>(initialDraft.from)
  const [to, setTo] = useState<TransferDomain>(initialDraft.to)
  const usesConfidentialBalances =
    (from === 'shield' || to === 'shield') &&
    (!receiveEntry || (!receiveExternal && preferredReceiveProvider !== 'zcash-shield'))
  const {
    model: portfolio,
    status: loadState,
    settled: portfolioSettled,
    refresh: refreshPortfolio
  } = usePortfolioSnapshot(effective?.walletId ?? null, effective?.accountId ?? null, {
    refreshConfidential: usesConfidentialBalances
  })
  const actionLabel = balanceTransferLabel(intent ?? (to === 'public' ? 'withdraw' : 'deposit'))
  const [amount, setAmount] = useState(initialDraft.amount)
  const [method, setMethod] = useState<'cluster' | 'directly'>(initialDraft.method)
  const [evmMoveFee, setEvmMoveFee] = useState<EvmFeeSelection>({
    kind: 'tier',
    tier: 'standard'
  })
  const [maxSelected, setMaxSelected] = useState(initialDraft.maxSelected)
  const [loadedPreference, setLoadedPreference] = useState<{
    key: string
    value: ShieldTransferPreference | null
  } | null>(null)
  const rememberedMove = loadedPreference?.key === preferenceKey ? loadedPreference.value : null
  const preferenceReady = loadedPreference?.key === preferenceKey
  const [preferenceAppliedScope, setPreferenceAppliedScope] = useState<string | null>(null)
  const userEditedMove = useRef(false)
  const userPickedMethod = useRef(launchHasDraft)
  const [catalogReady, setCatalogReady] = useState(false)
  const [managedAssets, setManagedAssets] = useState<readonly IntentsManagedAsset[]>([])
  const [catalogTokens, setCatalogTokens] = useState<readonly SwapToken[]>([])
  const canLoadShield =
    getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet').length > 0
  const shieldBalanceKey = `${currentNetwork}:${effective?.walletId ?? ''}:${effective?.accountId ?? ''}`
  const {
    balances: shieldBalances,
    connecting: shieldConnecting,
    error: shieldBalanceError,
    errorCode: shieldBalanceErrorCode,
    refreshBalances: loadShieldBalances
  } = useShieldBalances({
    active: usesConfidentialBalances,
    enabled: canLoadShield,
    scopeKey: shieldBalanceKey,
    scope: effective
      ? { network: currentNetwork, keyDomainId: effective.walletId, accountId: effective.accountId }
      : null
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
  const reviewAttempt = useRef<{ key: string; dedupKey: string } | null>(null)
  const [feeRefresh, setFeeRefresh] = useState<{
    planId: string
    selection: EvmFeeSelection
    cancelled: boolean
  } | null>(null)
  const feeRefreshRef = useRef(feeRefresh)
  const updateFeeRefresh = (next: typeof feeRefresh) => {
    feeRefreshRef.current = next
    setFeeRefresh(next)
  }
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
          value: readShieldTransferPreference(result[preferenceKey])
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
  }, [shieldBalanceKey, usesConfidentialBalances])

  useEffect(() => {
    if (!usesConfidentialBalances || canLoadShield || accountLoading || !effective) return
    setShieldConnection('required')
    setShieldError('Confidential account is unavailable. Try again.')
  }, [
    usesConfidentialBalances,
    canLoadShield,
    accountLoading,
    effective?.walletId,
    effective?.accountId
  ])

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
    const draft = initialBalanceTransferDraft({
      state: location.state,
      scope: scopeKey,
      mode: walletMode,
      routeFrom,
      routeTo,
      routeAssetId,
      intent
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
    reviewAttempt.current = null
    updateFeeRefresh(null)
    setAssetPickerOpen(false)
    setNetworkPickerOpen(false)
    setDomainPicker(null)
    setProviderPickerOpen(false)
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
        ? selectShieldTransferAssetId({
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
      !preferenceKey ||
      !effective ||
      !preferenceReady ||
      !catalogReady ||
      !portfolioSettled ||
      assets.length === 0 ||
      (usesConfidentialBalances &&
        rememberedMove?.from === 'shield' &&
        shieldConnection === 'checking') ||
      preferenceAppliedScope === scopeKey ||
      draftScope !== scopeKey
    )
      return
    if (!userEditedMove.current && !launchHasDraft) {
      const useRememberedDomains = !fixedSide && !routeFrom && !routeTo && rememberedMove !== null
      const preferredFrom = useRememberedDomains ? rememberedMove.from : launchDraft.from
      const preferredTo = useRememberedDomains ? rememberedMove.to : launchDraft.to
      const preferredAssetId = routeAssetId ?? rememberedMove?.assetId ?? null
      const preferredAsset = selectShieldTransferAssetId({
        assets,
        from: preferredFrom,
        eligibleChainIds,
        managedAssets,
        catalogTokens,
        network: currentNetwork,
        shieldBalances: currentShieldBalances,
        preferredAssetId
      })
      const fallbackToPublic = !fixedSide && preferredFrom === 'shield' && !preferredAsset
      const nextFrom = fallbackToPublic ? 'public' : preferredFrom
      const nextTo = fallbackToPublic ? 'shield' : preferredTo
      const nextAsset = fallbackToPublic
        ? selectShieldTransferAssetId({
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
    preferenceKey,
    effective,
    preferenceReady,
    catalogReady,
    portfolioSettled,
    usesConfidentialBalances,
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
    fixedSide,
    rememberedMove,
    assets,
    eligibleChainIds,
    managedAssets,
    catalogTokens,
    currentNetwork
  ])
  const zcashAssetId = `${getZcashChainId(currentNetwork)}/slip44:133`
  const zcashMoveRecipients = getConfidentialZcashTransferRecipients(activeAccount, currentNetwork)
  const zcashPublicAddress = zcashMoveRecipients.find(
    item => item.privacy === 'transparent'
  )?.address
  const zcashReceiveAddress = zcashMoveRecipients.find(item => item.privacy === 'shielded')?.address
  const canSpendPublicZec = Boolean(
    zcashPublicAddress &&
    !getFundingSourceUnavailableReason(currentWallet?.keySource, 'transparent')
  )
  const defaultReceiveZec =
    zcashReceiveAddress && (preferredReceiveProvider === 'zcash-shield' || !canLoadShield)
  const receiveAssetId = receiveEntry
    ? (selectedAssetId ?? (defaultReceiveZec ? zcashAssetId : defaultAssetId))
    : null
  const receiveZec = receiveAssetId === zcashAssetId
  const externalReceive = receiveEntry && (receiveExternal || (receiveZec && !canSpendPublicZec))
  const receiveSource = externalReceive ? 'external' : receiveZec ? 'public' : from
  const selected =
    assets.find(
      item =>
        item.asset.asset.id ===
        (receiveEntry ? receiveAssetId : (selectedAssetId ?? defaultAssetId))
    ) ?? null
  const externalAssets = useMemo(
    () =>
      receiveEntry && canLoadShield && activeAccount
        ? listExternalShieldReceiveAssets(currentNetwork, catalogTokens, activeAccount.networks)
        : [],
    [receiveEntry, canLoadShield, activeAccount, currentNetwork, catalogTokens, endpointRuntimeKey]
  )
  const externalAsset = externalAssets.find(item => item.assetId === receiveAssetId) ?? null
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
      listBalanceTransferAssetPickerRows({
        assets,
        includeEmpty: receiveEntry,
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
      receiveEntry,
      from,
      currentNetwork,
      assetPrices,
      portfolio,
      currentShieldBalances,
      managedAssets,
      catalogTokens
    ]
  )
  const shieldAssetPicker = shieldEntry || from === 'shield' || to === 'shield'
  const evmShieldPickerRows: ShieldTokenPickerItem[] = pickerRows.map(item => ({
    key: item.asset.asset.id,
    assetId: item.asset.asset.id,
    symbol: item.asset.metadata.symbol,
    iconUrl: item.asset.metadata.iconUrl,
    chainName: item.chain.chain.displayName,
    chainId: item.chain.chain.id,
    badgeBlockchain: resolveChainIconAlias(
      item.chain.chain.family,
      item.chain.chain.displayName,
      item.chain.chain.id
    ),
    availableRaw: item.sourceRaw,
    decimals: item.asset.metadata.decimals,
    priceUsd: findAssetPrice(assetPrices, item.asset.asset.id)?.priceUsd
  }))
  const receivePickerRows: ShieldTokenPickerItem[] = receiveEntry
    ? [
        ...(externalReceive
          ? externalAssets
              .filter(item => !zcashReceiveAddress || item.assetId !== zcashAssetId)
              .map(item => ({
                key: item.assetId,
                assetId: item.assetId,
                symbol: item.token.symbol,
                chainName: item.chain.displayName,
                chainId: item.chain.id,
                badgeBlockchain: resolveChainIconAlias(
                  item.chain.family,
                  item.chain.displayName,
                  item.chain.id
                ),
                decimals: item.token.decimals
              }))
          : evmShieldPickerRows),
        ...(zcashReceiveAddress
          ? [
              {
                key: zcashAssetId,
                assetId: zcashAssetId,
                symbol: 'ZEC',
                ...getZcashTokenPickerChain(currentNetwork),
                nativeIconChain: 'zcash',
                decimals: ZEC_DECIMALS,
                ...(externalReceive
                  ? {}
                  : {
                      availableRaw: parseDisplayUnitAmount(
                        getFundingBalance(zcashBalance, 'transparent').available,
                        ZEC_DECIMALS
                      ),
                      priceUsd: zecPrice
                    })
              }
            ]
          : [])
      ]
    : []
  const providerAssetRows = receiveEntry ? receivePickerRows : evmShieldPickerRows
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
  const shieldPair =
    !externalReceive && isShieldTransferRoute(from, to) && selected?.chain.chain.family === 'evm'
  const clusterPair = isClusterTransferRoute(from, to) && selected?.chain.chain.family === 'evm'
  const clusterSelected = method === 'cluster' && clusterPair
  const fundingRoute = Boolean(shieldPair || clusterSelected)
  const fundingReady = !shieldPair || shieldConnection === 'connected'
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
  const { available: receiveProviders, selected: receiveProvider } = resolveShieldReceiveProvider({
    nativeZec: receiveZec,
    preferred: preferredReceiveProvider,
    canReceiveNativeZec: Boolean(zcashReceiveAddress) && (externalReceive || canSpendPublicZec),
    nearSupportsAsset:
      receiveEntry &&
      canLoadShield &&
      (externalReceive
        ? Boolean(externalAsset)
        : receiveZec
          ? canSpendPublicZec &&
            currentNetwork === 'mainnet' &&
            hasNativeZecConfidentialSwapRoute(
              activeAccount,
              currentNetwork,
              __ENABLED_CHAIN_FEATURE_FLAGS__
            ) &&
            resolveShieldNativeZecSwapAvailable({
              network: currentNetwork,
              portfolio: null,
              enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__,
              zcashAccountEnabled: true
            })
          : Boolean(managedAsset))
  })
  const nativeReceive = receiveEntry && receiveZec && !externalReceive && receiveProvider !== null
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
  const sameChainDestinationOptions = useMemo(
    () =>
      selected && to !== 'shield' && from !== 'shield'
        ? listTransferSameChainDestinationAssets({
            source: selected,
            assets,
            from,
            eligibleChainIds,
            managedAssets,
            catalogTokens,
            network: currentNetwork,
            destinationChainIds:
              activeAccount?.networks.flatMap(network =>
                network.addresses.some(address => address.preferredForReceive) &&
                network.privateExecutionAddress
                  ? [network.chain.id]
                  : []
              ) ?? []
          })
        : [],
    [
      selected,
      to,
      from,
      assets,
      eligibleChainIds,
      activeAccount,
      managedAssets,
      catalogTokens,
      currentNetwork
    ]
  )
  const networkAssets = from === 'shield' ? destinationOptions : sameChainDestinationOptions
  const destinationNetworkOptions: ChainSelectorOption[] = [
    ...new Map(networkAssets.map(item => [item.chain.chain.id, item])).values()
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
    const preference: ShieldTransferPreference = {
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
  const routeState =
    selected?.chain.chain.family === 'evm' &&
    eligible &&
    supportedPair &&
    toWalletEvmQuoteToken(selected.asset)
      ? 'supported'
      : 'unsupported'
  const methodAvailable = supportedPair && routeState === 'supported'

  const maximumRaw =
    selected?.asset.asset.kind === 'native' &&
    selected.chain.chain.family === 'evm' &&
    source &&
    from !== 'shield'
      ? resolveNativeRouteMaximum({
          family: 'evm',
          chainId: selected.chain.chain.id,
          availableRaw: source.availableRaw,
          decimals: selected.asset.metadata.decimals,
          priceUsd: findAssetPrice(assetPrices, selected.asset.asset.id)?.priceUsd
        })
      : null
  const available =
    selected && source
      ? resolvePortfolioTransferAvailability({
          balanceRaw: source.availableRaw,
          decimals: selected.asset.metadata.decimals,
          isNative: selected.asset.asset.kind === 'native',
          maximumRaw: null
        })
      : null
  const shieldAvailable =
    selected && fundingRoute && shieldSourceRaw !== null
      ? resolvePortfolioTransferAvailability({
          balanceRaw: shieldSourceRaw,
          decimals: selected.asset.metadata.decimals,
          isNative: from !== 'shield' && selected.asset.asset.kind === 'native',
          maximumRaw: null
        })
      : null
  const maxAmount =
    selected && maximumRaw !== null
      ? formatBaseUnitDecimalAmount(maximumRaw, selected.asset.metadata.decimals)
      : ((fundingRoute ? shieldAvailable : available)?.display ?? '')
  const currentAmount = maxSelected ? maxAmount : amount
  useEffect(() => {
    if (maxSelected) setAmount(maxAmount)
  }, [maxSelected, maxAmount])
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
  const directEstimate = useBalanceTransferEstimate({
    enabled: canEstimateMethods && methodAvailable,
    requestKey: methodEstimateKey,
    estimate: signal =>
      estimateDirectTransfer({
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
  const clusterEstimateKey = `${methodEstimateKey}:${managedAsset?.protocolAssetId ?? ''}`
  const buildClusterPreviewRequest = (amountRaw = estimateAmountRaw!) =>
    buildShieldTransferRequest({
      network: currentNetwork,
      keyDomainId: effective!.walletId,
      accountId: effective!.accountId,
      from,
      to,
      method: 'cluster',
      amountRaw,
      asset: selected!.asset,
      chain: selected!.chain,
      managed: managedAsset!
    })
  const clusterEstimate = useBalanceTransferEstimate({
    enabled: canEstimateMethods && Boolean(managedAsset && effective),
    requestKey: clusterEstimateKey,
    estimate: async signal => {
      const preview = await confidentialFundingClient.preview(buildClusterPreviewRequest())
      signal.throwIfAborted()
      return clusterTransferEstimate(estimateAmountRaw!, preview)
    }
  })
  const clusterQuoted = Boolean(canEstimateMethods && managedAsset && clusterEstimate.value)
  const clusterNetworkFee = useBalanceTransferEstimate({
    enabled: clusterQuoted && Boolean(estimateAmountRaw) && !preparingShield,
    requestKey: `${clusterEstimateKey}:${JSON.stringify(evmMoveFee)}`,
    estimate: () =>
      confidentialFundingClient.previewClusterNetworkFee({
        ...buildClusterPreviewRequest(),
        feeSelection: evmMoveFee
      })
  }).value
  const clusterEstimateWithFee =
    clusterEstimate.value && clusterNetworkFee
      ? { ...clusterEstimate.value, sourceNetworkFee: clusterNetworkFee }
      : clusterEstimate.value
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
      ? formatTransferQuoteMinimumError(
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
  const shieldReviewKeyForFee = (feeSelection: EvmFeeSelection) =>
    `${routeKey}:${method}:${currentAmount}:${shieldAmountState?.amountRaw ?? ''}:${JSON.stringify(feeSelection)}`
  const shieldReviewKey = shieldReviewKeyForFee(evmMoveFee)
  const latestShieldReviewKey = useRef(shieldReviewKey)
  latestShieldReviewKey.current = shieldReviewKey
  const activeShieldReview = preparedShield?.key === shieldReviewKey ? preparedShield.review : null
  useEffect(() => {
    if (!preparedShield || preparedShield.key === shieldReviewKey) return
    if (confirmAttemptedPlanId.current !== preparedShield.review.planId)
      void confidentialFundingClient.cancel(preparedShield.review.planId).catch(() => {})
    setPreparedShield(null)
    reviewAttempt.current = null
    updateFeeRefresh(null)
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
    (!maxSelected || amount === currentAmount) &&
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
    fundingReady &&
    shieldSourceRaw !== null &&
    !tokenFeeBalanceError &&
    (!maxSelected || amount === currentAmount) &&
    shieldAmountState?.amountRaw
  )
  const selectDomain = (domain: TransferDomain, side: 'from' | 'to') => {
    if (pickerAccountId !== effective?.accountId || side === fixedSide) return
    if (domain === (side === 'from' ? to : from)) return
    userEditedMove.current = true
    if (receiveEntry) {
      if (receiveAssetId) setSelectedAssetId(receiveAssetId)
      setReceiveExternal(false)
    } else if (selected) setSelectedAssetId(selected.asset.asset.id)
    if (side === 'from') {
      setFrom(domain)
    } else {
      setTo(domain)
    }
    setAmount('')
    setDestinationAssetId(null)
    if (domain === 'shield' || from === 'shield' || to === 'shield') setMethod('directly')
    setMaxSelected(false)
    setDomainPicker(null)
  }
  const openDomainPicker = (side: 'from' | 'to') => {
    if (side === fixedSide) return
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
    pickerAccount &&
    effective &&
    pickerAccount.walletId === effective.walletId &&
    pickerAccount.accountId === effective.accountId &&
    pickerAccountId === effective.accountId
  )
  const pickerNetwork = pickerAccount?.networks.find(
    item =>
      item.chain.id === (receiveZec ? getZcashChainId(currentNetwork) : selected?.chain.chain.id)
  )
  const pickerValue = receiveEntry ? receiveSource : domainPicker === 'from' ? from : to
  const oppositeDomain = domainPicker === 'from' ? to : from
  const pickerBalance = (raw: string | null) =>
    selected && pickerIsActive && raw !== null
      ? formatTokenQuantity(formatBaseUnitAmount(raw, selected.asset.metadata.decimals))
      : null
  const nearPickerAvailable =
    pickerIsActive && canLoadShield && Boolean(managedAsset) && oppositeDomain !== 'shield'
  const addressFor = (domain: TransferDomain) => {
    if (domain === 'shield') return ''
    return domain === 'private' ? privateAddress : mainAddress
  }
  const maxDisabled = fundingRoute
    ? !eligible ||
      !managedAsset ||
      !fundingReady ||
      !shieldAvailable ||
      BigInt(shieldAvailable.amountRaw) === 0n
    : !eligible ||
      !supportedPair ||
      (direction === 'main-to-private' ? publicRaw === null : privateRaw === null) ||
      routeState !== 'supported' ||
      !available ||
      BigInt(available.amountRaw) === 0n
  const handleMax = () => {
    if (!selected || maxDisabled || maximumRaw === '0') return
    setSelectedAssetId(selected.asset.asset.id)
    setMaxSelected(true)
    setAmount(maxAmount)
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
  const prepareShield = async (
    feeSelection: EvmFeeSelection = evmMoveFee,
    replacingReview = false
  ): Promise<boolean> => {
    if (
      (!replacingReview && !canReviewShield) ||
      !selected ||
      !managedAsset ||
      !effective ||
      !shieldAmountState?.amountRaw ||
      !scopeStillCurrent()
    )
      return false
    const key = shieldReviewKeyForFee(feeSelection)
    const expectedKey = shieldReviewKey
    if (reviewAttempt.current?.key !== key)
      reviewAttempt.current = { key, dedupKey: `move:${crypto.randomUUID()}` }
    const dedupKey = reviewAttempt.current.dedupKey
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
        ...(from === 'shield' ? {} : { feeSelection }),
        ...(from === 'shield' && destination ? { destination } : {}),
        dedupKey
      })
      const result = await confidentialFundingClient.prepare(request)
      if (!scopeStillCurrent() || latestShieldReviewKey.current !== expectedKey) {
        if (result.phase === 'prepared')
          void confidentialFundingClient.cancel(result.planId).catch(() => {})
        return false
      }
      if (result.phase !== 'prepared') {
        const status = await checkShieldPlan(result.planId)
        if (replacingReview && scopeStillCurrent()) {
          if (status !== 'started')
            throw new Error('Transfer review could not be prepared. Try again.')
        }
        if (status === 'started') reviewAttempt.current = null
        return false
      }
      if (!matchesShieldReview(result, request)) {
        void confidentialFundingClient.cancel(result.planId).catch(() => {})
        throw new Error('Shield review changed. Try again.')
      }
      confirmAttemptedPlanId.current = null
      setConfirmUncertain(false)
      reviewAttempt.current = null
      if (replacingReview) setEvmMoveFee(feeSelection)
      setPreparedShield({ key, review: result })
      return true
    } catch (error) {
      if (scopeStillCurrent()) {
        const message = error instanceof Error ? error.message : ''
        const classifiedMessage = classifyError(error).userMessage
        const userMessage =
          message === 'Gas limit is below the estimated gas required'
            ? 'Gas limit is below the estimated gas required. Edit the network fee and try again.'
            : classifiedMessage === 'Insufficient native balance for the amount and network fee.' &&
                nativeFeeAsset
              ? `Insufficient ${formatSymbol(nativeFeeAsset.metadata.symbol)} balance for the amount and network fee.`
              : classifiedMessage
        setShieldError(userMessage)
        if (replacingReview) throw new Error(userMessage)
      }
      return false
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
      reviewAttempt.current = null
      updateFeeRefresh(null)
      const domain = (fixedSide === 'to' ? to : from) === 'private' ? 'private' : 'shield'
      void openConfidentialActivity(
        plan,
        () => {
          navigate(
            `/?domain=${domain}&tab=activity&transactionId=${encodeURIComponent(plan.transactionId)}`
          )
        },
        selected
          ? {
              operation: 'move',
              perspective: { viewedDomain: domain },
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
      if (feeRefreshRef.current?.planId !== pending.planId || !feeRefreshRef.current.cancelled)
        await confidentialFundingClient.cancel(pending.planId)
      if (!scopeStillCurrent()) return
      setPreparedShield(null)
    } catch {
      if (scopeStillCurrent()) setPreparedShield(null)
    } finally {
      reviewAttempt.current = null
      updateFeeRefresh(null)
      if (scopeStillCurrent()) setCancellingShield(false)
    }
  }
  const confirmShield = async () => {
    const pending = activeShieldReview
    if (!pending || feeRefreshRef.current || preparingShield || !scopeStillCurrent()) return
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
    if (
      !review?.sourceEvmFee ||
      (areEvmFeeSelectionsEqual(next, evmMoveFee) && !feeRefreshRef.current)
    )
      return
    if (cancellingShield || confirmingShield || preparingShield || !scopeStillCurrent()) return
    if (confirmAttemptedPlanId.current === review.planId)
      throw new Error('Check transfer status before changing network fee.')
    const previous = feeRefreshRef.current
    const refresh = {
      planId: review.planId,
      selection: next,
      cancelled: previous?.planId === review.planId && previous.cancelled
    }
    updateFeeRefresh(refresh)
    setCancellingShield(true)
    try {
      if (!refresh.cancelled) {
        await confidentialFundingClient.cancel(review.planId)
        if (!scopeStillCurrent() || latestShieldReviewKey.current !== shieldReviewKey) return
        updateFeeRefresh({ ...refresh, cancelled: true })
      }
      if (!scopeStillCurrent() || latestShieldReviewKey.current !== shieldReviewKey) return
      if (await prepareShield(next, true)) updateFeeRefresh(null)
    } catch (error) {
      if (scopeStillCurrent()) setShieldError(classifyError(error).userMessage)
      throw error
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
    const previewAmount = shieldAmountState?.amountRaw
    const loadTierPreviews =
      activeShieldReview.operation === 'cluster' &&
      from !== 'shield' &&
      effective &&
      managedAsset &&
      previewAmount
        ? () =>
            scopeStillCurrent()
              ? previewClusterNetworkFeeTiers(
                  buildClusterPreviewRequest(previewAmount),
                  evmMoveFee.kind === 'tier' ? evmMoveFee.tier : undefined
                )
              : Promise.resolve({})
        : undefined
    return (
      <div className="page-container">
        <TransactionReviewView
          variant="figma"
          title={`Confirm ${actionLabel}`}
          asset={{
            assetId: selected.asset.asset.id,
            symbol,
            icon: selected.asset.metadata.iconUrl
          }}
          amount={currentAmount}
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
                    content: formatShieldQuoteTime(activeShieldReview.quoteTimeEstimateSeconds!)
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
                        loadTierPreviews={loadTierPreviews}
                        onTierChange={tier => changeShieldFee({ kind: 'tier', tier })}
                        onSelectionChange={changeShieldFee}
                        disabled={
                          cancellingShield ||
                          confirmingShield ||
                          confirmUncertain ||
                          preparingShield
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
              <div className="mt-3 flex items-center justify-between gap-3">
                <p role="alert" className="text-xs text-warning">
                  {shieldError}
                </p>
                {feeRefresh && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={cancellingShield || preparingShield}
                    onClick={() => void changeShieldFee(feeRefresh.selection).catch(() => {})}
                  >
                    Retry
                  </Button>
                )}
              </div>
            ) : undefined
          }
          confirmLabel={confirmUncertain ? 'Check status' : actionLabel}
          confirming={confirmingShield}
          submitting={
            confirmingShield && confirmAttemptedPlanId.current === activeShieldReview.planId
          }
          cancelDisabled={cancellingShield}
          confirmDisabled={
            !scopeStillCurrent() ||
            cancellingShield ||
            preparingShield ||
            feeRefresh !== null ||
            (!confirmUncertain && activeShieldReview.expiresAt <= Date.now())
          }
          onCancel={() => void cancelShieldReview()}
          onConfirm={() => void confirmShield()}
        />
      </div>
    )
  }

  const assetSymbol = receiveZec
    ? 'ZEC'
    : symbol || formatSymbol(externalAsset?.token.symbol ?? pendingAssetHint?.symbol)
  const assetControl = (
    <button
      type="button"
      onClick={() => setAssetPickerOpen(true)}
      disabled={!receiveEntry && !selected && loadState === 'loading'}
      className="wallet-interactive flex h-9 max-w-full items-center gap-2 rounded-full bg-card px-2 text-base font-medium leading-[21px] hover:bg-wallet-selected active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary"
      aria-label="Select transfer asset"
    >
      {assetSymbol ? (
        <TokenIcon
          assetId={selected?.asset.asset.id ?? receiveAssetId ?? selectedAssetId ?? undefined}
          symbol={assetSymbol}
          icon={selected?.asset.metadata.iconUrl ?? pendingAssetHint?.iconUrl}
          nativeChain={receiveZec ? 'zcash' : undefined}
          blockchain={
            receiveZec
              ? 'zec'
              : externalAsset
                ? resolveChainIconAlias(
                    externalAsset.chain.family,
                    externalAsset.chain.displayName,
                    externalAsset.chain.id
                  )
                : from !== 'shield'
                  ? networkIcon
                  : undefined
          }
          size={26}
        />
      ) : (
        <Icon icon="lucide:coins" width={20} height={20} />
      )}
      <span className="max-w-32 truncate">
        {assetSymbol || (loadState === 'loading' ? '…' : 'Select asset')}
      </span>
      <Icon icon="lucide:chevron-down" width={14} height={14} />
    </button>
  )
  const receiveAccounts = receiveEntry && (
    <div className="mt-3 space-y-2.5">
      <BalanceTransferAccountCard
        label="From"
        accountName={accountName}
        domain={receiveSource === 'private' ? 'private' : 'public'}
        address={receiveZec ? (zcashPublicAddress ?? '') : addressFor(from)}
        networkName=""
        network={networkIcon}
        onNetworkClick={() => setAssetPickerOpen(true)}
        onAccountClick={() => openDomainPicker('from')}
        external={externalReceive}
      />
      <BalanceTransferAccountCard
        label="To"
        accountName={accountName}
        domain="shield"
        address=""
        networkName=""
        network="near"
        onNetworkClick={() => setAssetPickerOpen(true)}
        onAccountClick={() => setProviderPickerOpen(true)}
        provider={receiveProvider}
      />
    </div>
  )
  const nativeRetryPath =
    nativeReceive &&
    receiveProvider &&
    `/receive?${new URLSearchParams({
      mode: 'shield',
      provider: receiveProvider,
      from: 'public',
      assetId: zcashAssetId,
      walletId: currentWalletId ?? '',
      accountId: currentAccountId ?? ''
    })}`

  return (
    <div className="page-container" data-wallet-mode={receiveEntry ? 'public' : walletMode}>
      {(!nativeReceive || !nativeReceiveState.reviewing) && (
        <PageHeader
          title={receiveEntry ? 'Receive' : actionLabel}
          showBack
          onBack={goBack}
          backDisabled={nativeReceive && nativeReceiveState.busy}
        />
      )}
      {nativeRetryPath ? (
        <NativeZcashReceiveForm
          key={receiveProvider}
          destination={receiveProvider === 'zcash-shield' ? 'shielded' : 'confidential'}
          retryPath={nativeRetryPath}
          asset={assetControl}
          accounts={receiveAccounts}
          onStateChange={setNativeReceiveState}
        />
      ) : externalReceive ? (
        <>
          <div className="page-content flex min-h-0 flex-col !px-4 !pb-2 !pt-3">
            <BalanceTransferAmount asset={assetControl} />
            {receiveAccounts}
          </div>
          <div className="page-footer">
            <ShieldReceiveAddress
              key={`${scopeKey}:${receiveProvider}:${receiveAssetId}`}
              provider={receiveProvider ?? 'near-confidential'}
              network={currentNetwork}
              account={activeAccount}
              accountCatalog={catalog}
              asset={externalAsset}
              zcashAddress={zcashReceiveAddress}
              enabled={Boolean(effective && receiveProvider)}
            />
          </div>
        </>
      ) : (
        <>
          <div className="page-content flex min-h-0 flex-col !px-4 !pb-2 !pt-3">
            <BalanceTransferAmount
              asset={assetControl}
              balance={sourceBalance}
              amount={{
                id: 'transfer-amount',
                label: 'Transfer amount',
                value: currentAmount,
                disabled: !selected,
                onChange: value => {
                  const next = normalizePrivateBalanceTransferInput(value)
                  if (next !== null) {
                    userEditedMove.current = true
                    if (selected) setSelectedAssetId(selected.asset.asset.id)
                    setAmount(next)
                    setMaxSelected(false)
                  }
                }
              }}
              max={{ onClick: handleMax, disabled: !selected || maxDisabled || maximumRaw === '0' }}
            />
            {receiveEntry ? (
              receiveAccounts
            ) : (
              <BalanceTransferAccounts
                className="mt-3 shrink-0"
                privateMode={walletMode === 'private'}
                disabled={!selected}
                onReverse={
                  fixedSide
                    ? undefined
                    : () => {
                        userEditedMove.current = true
                        if (from === 'shield' && destination)
                          setSelectedAssetId(destination.asset.asset.id)
                        else if (selected) setSelectedAssetId(selected.asset.asset.id)
                        setDestinationAssetId(null)
                        setFrom(to)
                        setTo(from)
                        setAmount('')
                        setMaxSelected(false)
                      }
                }
                source={
                  <BalanceTransferAccountCard
                    label="From"
                    accountName={accountName}
                    domain={from}
                    address={addressFor(from)}
                    networkName={selected?.chain.chain.displayName ?? ''}
                    network={from === 'shield' ? 'near' : networkIcon}
                    onNetworkClick={() => setAssetPickerOpen(true)}
                    onAccountClick={
                      fixedSide === 'from' ? undefined : () => openDomainPicker('from')
                    }
                    disabled={!selected}
                  />
                }
                destination={
                  <BalanceTransferAccountCard
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
                    showNetwork={to !== 'shield'}
                    onAccountClick={fixedSide === 'to' ? undefined : () => openDomainPicker('to')}
                    disabled={!selected}
                  />
                }
              />
            )}
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
                      loading={canEstimateMethods && clusterEstimate.loading}
                      fee={formatBalanceTransferFee(clusterEstimateWithFee, selected.asset)}
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
                      fee={formatBalanceTransferFee(directEstimate.value, selected.asset)}
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
                      clusterNetworkFee
                        ? formatBaseUnitAmount(clusterNetworkFee.raw, clusterNetworkFee.decimals)
                        : '—'
                    }
                    symbol={
                      clusterNetworkFee?.symbol ??
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
            {loadState === 'error' && !portfolio && (
              <InlineError
                message="Assets could not be loaded."
                onRetry={() => void refreshPortfolio(true, { forceDiscovery: true })}
              />
            )}
            {shieldPair && shieldConnection === 'required' && !shieldConnecting && (
              <InlineError
                message={shieldError ?? 'Shield balance unavailable.'}
                onRetry={() => void refreshShield(shieldNeedsAuthorization)}
              />
            )}
            {shieldError && !activeShieldReview && shieldConnection !== 'required' && (
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
              isLoading={
                preparingShield ||
                (shieldPair &&
                  (shieldConnecting ||
                    shieldConnection === 'checking' ||
                    shieldConnection === 'busy')) ||
                (!transferError &&
                  clusterPair &&
                  (clusterSelected || method === 'directly') &&
                  selectedEstimate.loading)
              }
              onClick={fundingRoute ? () => void prepareShield() : review}
            >
              {clusterSelected ? `Review ${actionLabel}` : actionLabel}
            </Button>
          </div>
        </>
      )}

      <TokenSelectorDialog
        open={assetPickerOpen}
        onOpenChange={setAssetPickerOpen}
        title="Select asset"
        walletMode={walletMode}
      >
        <TokenPicker<TransferPickerRow>
          filter={{
            search: assetSearch,
            onSearchChange: setAssetSearch,
            selectedNetwork: assetChainId,
            onNetworkChange: setAssetChainId
          }}
          networks={
            shieldAssetPicker
              ? listShieldTokenPickerNetworks(providerAssetRows)
              : Array.from(
                  new Map(pickerRows.map(item => [item.chain.chain.id, item.chain])).values()
                ).map(chain => ({
                  id: chain.chain.id,
                  label: chain.chain.displayName,
                  iconChain: resolveChainIconAlias(
                    chain.chain.family,
                    chain.chain.displayName,
                    chain.chain.id
                  )
                }))
          }
          selectedKey={receiveEntry ? (receiveAssetId ?? undefined) : selected?.asset.asset.id}
          rows={shieldAssetPicker ? providerAssetRows : pickerRows}
          adapter={transferAssetSearch}
          isDisabled={item => 'key' in item && Boolean(item.disabledReason)}
          toItem={item =>
            'key' in item
              ? shieldTokenSelectionItem(item, balancesHidden)
              : {
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
                }
          }
          onSelect={item => {
            const key = 'key' in item ? item.key : item.asset.asset.id
            if (
              receiveEntry
                ? !receivePickerRows.some(item => item.key === key)
                : !pickerRows.some(row => row.asset.asset.id === key)
            )
              return
            userEditedMove.current = true
            setSelectedAssetId(key)
            setDestinationAssetId(null)
            setAmount('')
            setMaxSelected(false)
            setAssetPickerOpen(false)
          }}
          emptyMessage={
            (shieldAssetPicker ? providerAssetRows.length : pickerRows.length) === 0
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
        selectedId={targetAsset?.chain.chain.id ?? null}
        label={`Networks for ${symbol}`}
        onSelect={id => {
          const item = networkAssets.find(option => option.chain.chain.id === id)
          if (!item) return
          userEditedMove.current = true
          if (from === 'shield') {
            setDestinationAssetId(item.asset.asset.id)
          } else if (item.asset.asset.id !== selected?.asset.asset.id) {
            setSelectedAssetId(item.asset.asset.id)
            setDestinationAssetId(null)
            setAmount('')
            setMaxSelected(false)
          }
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
              {domainPicker === 'from' ? 'From' : 'To'} · {walletDisplayName} · {pickerAccountName}
            </DialogTitle>
            <DialogDescription className="sr-only">Select a balance.</DialogDescription>
          </DialogHeader>
          <div aria-label={`${pickerAccountName} balances`} className="space-y-2 pb-2">
            {(['public', 'private'] as const)
              .filter(domain => domain !== oppositeDomain)
              .map(domain => {
                const address =
                  domain === 'private'
                    ? pickerNetwork?.privateExecutionAddress
                    : receiveZec
                      ? zcashPublicAddress
                      : pickerNetwork?.addresses.find(item => item.preferredForReceive)?.value
                const nativeRaw =
                  receiveZec && domain === 'public'
                    ? getFundingBalance(zcashBalance, 'transparent').available
                    : null
                return (
                  <TransferBalanceOption
                    key={domain}
                    label={`${domainLabel(domain)} account`}
                    ariaLabel={`Select ${domainLabel(domain)} account`}
                    icon={<ExecutionAccountIcon mode={domain === 'private' ? 'private' : 'main'} />}
                    address={address ?? ''}
                    balance={
                      nativeRaw !== null
                        ? formatTokenQuantity(nativeRaw)
                        : pickerBalance(
                            selected ? getTransferDomainBalanceRaw(selected.asset, domain) : null
                          )
                    }
                    disabled={
                      !pickerIsActive ||
                      !address ||
                      (receiveZec && (domain === 'private' || !canSpendPublicZec))
                    }
                    selected={pickerIsActive && pickerValue === domain}
                    onSelect={() => domainPicker && selectDomain(domain, domainPicker)}
                  />
                )
              })}
            {receiveEntry && domainPicker === 'from' && (
              <TransferBalanceOption
                label="External transfer"
                icon={<Icon icon="lucide:qr-code" width={20} height={20} />}
                selected={externalReceive}
                disabled={!pickerIsActive || (!canLoadShield && !zcashReceiveAddress)}
                onSelect={() => {
                  if (receiveAssetId) setSelectedAssetId(receiveAssetId)
                  setReceiveExternal(true)
                  setAssetChainId('all')
                  setDomainPicker(null)
                }}
              />
            )}
            {!receiveEntry && (
              <div
                role="group"
                aria-labelledby="transfer-shield-providers"
                className="space-y-2 pt-2"
              >
                <p id="transfer-shield-providers" className="px-1 text-xs font-medium text-muted">
                  Shield providers
                </p>
                <TransferBalanceOption
                  label={SHIELD_PROVIDERS['near-confidential'].name}
                  icon={<ShieldProviderLogo provider="near-confidential" size={18} />}
                  selected={pickerIsActive && pickerValue === 'shield'}
                  disabled={!nearPickerAvailable}
                  balance={nearPickerAvailable ? pickerBalance(refreshedShieldRaw) : null}
                  onSelect={() => {
                    if (nearPickerAvailable && domainPicker) selectDomain('shield', domainPicker)
                  }}
                />
                <TransferBalanceOption
                  label={SHIELD_PROVIDERS['zcash-shield'].detailName}
                  icon={<ShieldProviderLogo provider="zcash-shield" size={18} />}
                  disabled
                />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {receiveEntry && (
        <ShieldProviderDialog
          open={providerPickerOpen}
          onClose={() => setProviderPickerOpen(false)}
          selected={receiveProvider}
          available={receiveProviders}
          onSelect={provider => {
            if (!receiveProviders[provider]) return
            if (receiveAssetId) setSelectedAssetId(receiveAssetId)
            setPreferredReceiveProvider(provider)
            setProviderPickerOpen(false)
          }}
          networks={portfolio?.chains.map(item => item.chain) ?? []}
          tokens={catalogTokens}
        />
      )}
    </div>
  )
}
