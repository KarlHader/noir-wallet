import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { useSwapPreferences } from '@/store/swap-store'
import { SwapSettingsButton } from '@/popup/components/swap/SwapSettings'
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
import { TransactionNotice } from '@/popup/components/transaction/TransactionNotice'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenSelectorDialog } from '@/popup/components/tokens/TokenSelectorDialog'
import { TokenPicker, type TokenPickerAdapter } from '@/popup/components/tokens/TokenPicker'
import {
  shieldTokenSelectionItem,
  shieldTokenPickerAdapter
} from '@/popup/components/tokens/ShieldTokenPicker'
import {
  shieldTokenPickerBalance,
  type ShieldTokenPickerItem
} from '@/popup/services/shield-transfer'
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
import type { FundingSource } from '@/types'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
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
  listPrivateTransferDestinationAssets
} from '@/popup/services/balance-transfer-asset-picker'
import {
  confidentialFundingClient,
  previewClusterNetworkFeeTiers,
  previewReviewedConfidentialDepositFeeTiers
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
import {
  estimateQuickShieldNativeFee,
  prepareQuickShieldMaximum,
  quickShieldMaximum,
  readQuickShieldBalances
} from '@/popup/services/quick-shield-maximum'
import type { PrepareConfidentialFundingRequest } from '@/popup/services/confidential-funding-client'
import { TransactionReviewParty } from '@/popup/components/transaction/TransactionReviewParty'
import {
  ConfidentialActivityView,
  openConfidentialActivity,
  type ConfidentialActivityDisplay
} from '@/popup/components/transaction/ConfidentialActivitySheet'
import { homeActivityPath } from '@/popup/services/home-navigation'
import { resolveNativeRouteMaximum } from '@/popup/services/transfer-maximum'
import {
  balanceTransferDomainLabel as domainLabel,
  balanceTransferLabel,
  buildCrossChainPrivateWithdrawReviewPath,
  buildPrivateDepositReviewPath,
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
import {
  getConfidentialZcashTransferRecipients,
  resolveZcashSelfTransfer
} from '@/popup/services/zcash-self-transfer'
import { getShieldableTransparentBalance } from '@/core/zcash/shielding'
import {
  buildFixedShieldFundsRequest,
  fixedShieldFundsDomains,
  matchesFixedShieldFundsRecipient,
  selectShieldFundsAsset,
  shieldFundsPath,
  type ShieldFundsFormProps
} from '@/popup/services/shield-funds-route'
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

function MethodCard({
  title,
  detail,
  recommended,
  selected,
  estimate,
  fee,
  loading,
  disabled,
  unavailableReason,
  onClick
}: {
  title: 'Cluster' | 'Directly'
  detail: string
  recommended: boolean
  selected: boolean
  estimate: BalanceTransferEstimate | null
  fee: ReturnType<typeof formatBalanceTransferFee>
  loading?: boolean
  disabled?: boolean
  unavailableReason?: string | null
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
        'relative flex min-w-0 flex-col rounded-xl border bg-wallet-surface px-3 py-3 text-left text-xs leading-4 disabled:cursor-not-allowed disabled:opacity-50 max-[359px]:px-2',
        selected ? 'border-primary/60' : 'border-white/10'
      )}
    >
      {recommended && !disabled && (
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
      <span className="mt-2 text-muted">{unavailableReason ?? detail}</span>
      <span className="mt-4 flex justify-between gap-2">
        <span className="text-muted">Privacy</span>
        <span>{title === 'Cluster' ? 'Strong' : 'Standard'}</span>
      </span>
      <span className="mt-2 flex justify-between gap-1">
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
            <Skeleton className="ml-auto h-4 w-20 max-w-full" />
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

export function DepositWithdraw({
  receiveEntry = false,
  fixedShield
}: {
  readonly receiveEntry?: boolean
  readonly fixedShield?: ShieldFundsFormProps
}) {
  const [params] = useSearchParams()
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const scope = `${network}:${walletId}:${accountId}`
  const entryKey = fixedShield
    ? JSON.stringify([fixedShield.direction, fixedShield.assetId, fixedShield.provider])
    : params.toString()
  return (
    <DepositWithdrawForm
      key={`${scope}:${entryKey}`}
      receiveEntry={receiveEntry}
      fixedShield={fixedShield}
    />
  )
}

function QuickShieldReviewSkeleton() {
  return (
    <div
      role="status"
      aria-label="Preparing Shield review"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 pt-2 pb-4"
    >
      <div className="flex shrink-0 items-center gap-3">
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-7 w-28" />
      </div>
      <div className="space-y-3 rounded-xl bg-card px-3 py-3">
        <div className="flex justify-between gap-4">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="flex justify-between gap-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <Skeleton className="mt-auto h-11 w-full shrink-0 rounded-lg" />
    </div>
  )
}

function NativeZcashMoveForm({
  destination,
  fundingSource,
  retryPath,
  asset,
  accounts,
  onStateChange,
  actionLabel,
  resultReturnPath,
  slippageBps
}: {
  readonly destination: 'transparent' | 'shielded' | 'confidential'
  readonly fundingSource: FundingSource
  readonly retryPath: string
  readonly asset: ReactNode
  readonly accounts: ReactNode
  readonly onStateChange: (state: { readonly reviewing: boolean; readonly busy: boolean }) => void
  readonly actionLabel?: 'Shield' | 'Unshield'
  readonly resultReturnPath?: string
  readonly slippageBps?: number
}) {
  const transfer = useZcashTransfer({
    shieldReceive: {
      destination,
      fundingSource,
      retryPath,
      actionLabel,
      resultReturnPath,
      slippageBps
    },
    onStateChange
  })
  const { action } = transfer
  const { route, sync } = transfer
  const notice =
    transfer.depositErrors.find(Boolean) ??
    transfer.balanceError ??
    (!route.maximumError && !route.error && !sync.progress ? sync.error : null)
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
          <ZcashTransferRoute route={route} showNotice={!notice} />
          {notice && <TransactionNotice {...notice} />}
        </div>
      </div>
      <div className="page-footer">
        <ZcashTransferSyncStatus sync={sync} />
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

function DepositWithdrawForm({
  receiveEntry,
  fixedShield
}: {
  readonly receiveEntry: boolean
  readonly fixedShield?: ShieldFundsFormProps
}) {
  const [params] = useSearchParams()
  const swapSlippageBps = useSwapPreferences(state => Math.round(state.slippage * 100))
  const quoteMode = useSwapPreferences(state => state.quoteMode)
  const location = useLocation()
  const routerNavigate = useRouterNavigate()
  const fixedDirection = fixedShield?.direction
  const [shieldSlippageBps, setShieldSlippageBps] = useState(1)
  const slippageBps = fixedDirection === 'shield' ? shieldSlippageBps : swapSlippageBps
  const fixedDomains = fixedDirection ? fixedShieldFundsDomains(fixedDirection) : null
  const walletMode =
    !fixedDirection &&
    (params.get('mode') === 'private' || (receiveEntry && params.get('from') === 'private'))
      ? 'private'
      : 'public'
  const routeFrom = fixedDomains?.from ?? params.get('from')
  const routeTo = fixedDomains?.to ?? (receiveEntry ? 'shield' : params.get('to'))
  const intent = fixedDirection
    ? null
    : receiveEntry
      ? 'deposit'
      : resolveBalanceTransferIntent(params.get('intent'))
  const fixedSide = fixedTransferSide(intent)
  const routeAssetId = fixedShield ? (fixedShield.assetId ?? null) : params.get('assetId')
  const startsWithPicker =
    !receiveEntry && !routeAssetId && (fixedDirection === 'unshield' || intent === 'withdraw')
  const entry = receiveEntry ? 'shield' : params.get('entry')
  const shieldEntry =
    Boolean(fixedDirection) ||
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
    shieldEntry && !receiveEntry && !fixedDirection && effective
      ? shieldTransferPreferenceKey(currentNetwork, effective.walletId, effective.accountId)
      : null
  const draftState = fixedDirection ? null : location.state
  const initialDraft = initialBalanceTransferDraft({
    state: draftState,
    scope: scopeKey,
    mode: walletMode,
    routeFrom,
    routeTo,
    routeAssetId,
    intent
  })
  const initialRouteState = useRef(draftState).current
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
  const [assetPickerOpen, setAssetPickerOpen] = useState(startsWithPicker)
  const [shieldAwaitingReview, setShieldAwaitingReview] = useState(false)
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const [destinationAssetId, setDestinationAssetId] = useState<string | null>(
    initialDraft.destinationAssetId ?? null
  )
  const [assetPrices, setAssetPrices] = useState<AssetPriceReadModel | null>(null)
  const [domainPicker, setDomainPicker] = useState<'from' | 'to' | null>(null)
  const [shieldPickerLoading, setShieldPickerLoading] = useState(false)
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const [receiveExternal, setReceiveExternal] = useState(
    () => shieldDepositSource(routeFrom) === 'external'
  )
  const [receiveFundingSource, setReceiveFundingSource] = useState<FundingSource>(() =>
    routeFrom === 'zcash-shield' ? 'shielded' : 'transparent'
  )
  const [preferredReceiveProvider, setPreferredReceiveProvider] = useState<ShieldProvider | null>(
    () => {
      if (fixedShield) return fixedShield.provider ?? null
      const provider = params.get('provider')
      return provider === 'zcash-shield' || provider === 'near-confidential' ? provider : null
    }
  )
  const [nativeReceiveState, setNativeReceiveState] = useState({ reviewing: false, busy: false })
  const [shieldActivity, setShieldActivity] = useState<{
    plan: ConfidentialFundingPlan
    display?: ConfidentialActivityDisplay
  } | null>(null)
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
    refresh: refreshPortfolio,
    refreshSource: refreshPortfolioSource
  } = usePortfolioSnapshot(effective?.walletId ?? null, effective?.accountId ?? null, {
    refreshConfidential: usesConfidentialBalances
  })
  const fixedActionLabel =
    fixedDirection === 'shield' ? 'Shield' : fixedDirection ? 'Unshield' : undefined
  const actionLabel =
    fixedActionLabel ?? balanceTransferLabel(intent ?? (to === 'public' ? 'withdraw' : 'deposit'))
  const [amount, setAmount] = useState(initialDraft.amount)
  const [method, setMethod] = useState<'cluster' | 'directly'>(initialDraft.method)
  const [evmMoveFee, setEvmMoveFee] = useState<EvmFeeSelection>({
    kind: 'tier',
    tier: 'standard'
  })
  const [maxSelected, setMaxSelected] = useState(initialDraft.maxSelected)
  const [maxRequestRevision, setMaxRequestRevision] = useState(0)
  const maximumShield = fixedDirection === 'shield' && maxSelected
  const [loadedPreference, setLoadedPreference] = useState<{
    key: string
    value: ShieldTransferPreference | null
  } | null>(null)
  const rememberedMove = loadedPreference?.key === preferenceKey ? loadedPreference.value : null
  const preferenceReady = loadedPreference?.key === preferenceKey
  const [preferenceAppliedScope, setPreferenceAppliedScope] = useState<string | null>(null)
  const userEditedMove = useRef(false)
  const explicitAssetSelection = useRef(Boolean(routeAssetId))
  const userPickedMethod = useRef(launchHasDraft)
  const [catalogReady, setCatalogReady] = useState(false)
  const [managedAssets, setManagedAssets] = useState<readonly IntentsManagedAsset[]>([])
  const [catalogTokens, setCatalogTokens] = useState<readonly SwapToken[]>([])
  const canLoadShield =
    getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet').length > 0
  const shieldBalanceKey = `${currentNetwork}:${effective?.walletId ?? ''}:${effective?.accountId ?? ''}`
  const {
    balances: shieldBalances,
    loading: loadingShieldBalances,
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
  const confirmingShieldRef = useRef(false)
  const preparingShieldRef = useRef(false)
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
    quickRequest?: PrepareConfidentialFundingRequest
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
    explicitAssetSelection.current = Boolean(routeAssetId)
    userPickedMethod.current = launchHasDraft
    const draft = initialBalanceTransferDraft({
      state: draftState,
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
    setShieldSlippageBps(1)
    setShieldAwaitingReview(false)
    setMethod(draft.method)
    setEvmMoveFee({ kind: 'tier', tier: 'standard' })
    setMaxSelected(draft.maxSelected)
    setPreparingShield(false)
    setConfirmingShield(false)
    setCancellingShield(false)
    setShieldActivity(null)
    setShieldError(null)
    setConfirmUncertain(false)
    reviewAttempt.current = null
    updateFeeRefresh(null)
    setAssetPickerOpen(startsWithPicker)
    setNetworkPickerOpen(false)
    setDomainPicker(null)
    setProviderPickerOpen(false)
    setPickerAccountId(null)
    setPreferenceAppliedScope(null)
  }, [scopeKey, location.pathname, location.search])

  useEffect(() => {
    if (fixedDirection || !effective || draftScope !== scopeKey) return
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
    fixedDirection,
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
  const shieldAssets = useMemo(
    () => listShieldFundingAssets(portfolio, managedAssets, catalogTokens, currentNetwork),
    [portfolio, managedAssets, catalogTokens, currentNetwork]
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
    const fallbackAssets =
      shieldEntry || intent
        ? shieldAssets
        : shieldFundingSources(shieldAssets, currentShieldBalances)
    const existing = new Set(publicAssets.map(item => item.asset.asset.id))
    return [
      ...publicAssets,
      ...fallbackAssets
        .filter(
          item =>
            (eligibleChainIds.includes(item.chain.chain.id) ||
              (fixedDirection === 'unshield' &&
                item.chain.chain.id === getZcashChainId(currentNetwork) &&
                eligibleChainIds.length > 0)) &&
            !existing.has(item.asset.asset.id)
        )
        .map(({ asset, chain }) => ({ asset, chain }))
    ]
  }, [
    portfolio,
    currentShieldBalances,
    shieldAssets,
    eligibleChainIds,
    shieldEntry,
    intent,
    fixedDirection,
    currentNetwork
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
  const currentZcashAccount = currentWallet?.accounts.find(
    account => account.id === currentAccountId
  )
  const fixedZcashSource = fixedDirection === 'unshield' ? 'shielded' : 'transparent'
  const fixedZcashSelfTransfer = fixedDirection
    ? resolveZcashSelfTransfer(currentZcashAccount?.addresses, fixedZcashSource, currentNetwork)
    : null
  const fixedZcashNativeAvailable = Boolean(
    fixedZcashSelfTransfer &&
    !getFundingSourceUnavailableReason(currentWallet?.keySource, fixedZcashSource)
  )
  const fixedZcashAvailable =
    fixedDirection === 'unshield'
      ? getFundingBalance(zcashBalance, 'shielded').available
      : getShieldableTransparentBalance(zcashBalance)
  const fixedNearZecAsset =
    fixedDirection === 'unshield' && zcashPublicAddress
      ? shieldAssets.find(item => item.asset.asset.id === zcashAssetId)
      : undefined
  const fixedNearZecRaw =
    fixedNearZecAsset && currentShieldBalances
      ? getConfidentialAvailableForAsset(
          currentShieldBalances,
          fixedNearZecAsset.managed.protocolAssetId
        )
      : null
  const canSpendPublicZec = Boolean(
    zcashPublicAddress &&
    !getFundingSourceUnavailableReason(currentWallet?.keySource, 'transparent')
  )
  const supportsConfidentialZec =
    (receiveEntry || fixedDirection === 'shield') &&
    canLoadShield &&
    currentNetwork === 'mainnet' &&
    !isZcashHardwareKeySource(currentWallet?.keySource) &&
    Boolean(zcashPublicAddress) &&
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
  const canSpendShieldedZec = Boolean(
    zcashReceiveAddress &&
    supportsConfidentialZec &&
    !getFundingSourceUnavailableReason(currentWallet?.keySource, 'shielded')
  )
  const defaultReceiveZec =
    zcashReceiveAddress && (preferredReceiveProvider === 'zcash-shield' || !canLoadShield)
  const receiveAssetId = receiveEntry
    ? (selectedAssetId ?? (defaultReceiveZec ? zcashAssetId : defaultAssetId))
    : null
  const receiveZec = receiveAssetId === zcashAssetId
  const shieldedZecReceive = receiveZec && receiveFundingSource === 'shielded' && !receiveExternal
  const externalReceive =
    receiveEntry && (receiveExternal || (receiveZec && !shieldedZecReceive && !canSpendPublicZec))
  const receiveSource = externalReceive
    ? 'external'
    : shieldedZecReceive
      ? 'zcash-shield'
      : receiveZec
        ? 'public'
        : from
  const { assetId: fixedAssetId, provider: fixedProvider } = selectShieldFundsAsset({
    direction: fixedDirection,
    selectedAssetId,
    defaultAssetId,
    zcashAssetId,
    preferredProvider: preferredReceiveProvider,
    nativeAvailable: fixedZcashNativeAvailable,
    nativeFunded: Number(fixedZcashAvailable) > 0,
    confidentialZecFunded: BigInt(fixedNearZecRaw ?? '0') > 0n
  })
  const fixedZec = fixedAssetId === zcashAssetId
  const fixedAvailableProviders = {
    'zcash-shield': fixedZec && fixedZcashNativeAvailable,
    'near-confidential':
      fixedZec &&
      (fixedDirection === 'shield'
        ? supportsConfidentialZec && canSpendPublicZec
        : Boolean(fixedNearZecAsset && fixedNearZecRaw && BigInt(fixedNearZecRaw) > 0n))
  }
  const fixedZecForm = fixedZec && (fixedDirection === 'shield' || fixedProvider === 'zcash-shield')
  const selected =
    (fixedZecForm
      ? null
      : assets.find(
          item =>
            item.asset.asset.id ===
            (fixedDirection
              ? fixedAssetId
              : receiveEntry
                ? receiveAssetId
                : (selectedAssetId ?? defaultAssetId))
        )) ?? null
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
        assets: fixedDirection
          ? assets.filter(
              item =>
                item.chain.chain.family === 'evm' &&
                resolveShieldManagedAsset(item.asset, managedAssets, catalogTokens, currentNetwork)
            )
          : assets,
        includeEmpty: receiveEntry || Boolean(fixedDirection || intent),
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
      catalogTokens,
      fixedDirection,
      intent
    ]
  )
  const shieldAssetPicker = shieldEntry || from === 'shield' || to === 'shield'
  const withdrawalPicker = fixedDirection === 'unshield' || intent === 'withdraw'
  const evmShieldPickerRows: ShieldTokenPickerItem[] = pickerRows.map(item => ({
    key: item.asset.asset.id,
    assetId: item.asset.asset.id,
    contractAddress:
      item.asset.asset.namespace === 'erc20' ? item.asset.asset.reference : undefined,
    name: item.asset.metadata.name,
    symbol: item.asset.metadata.symbol,
    iconUrl: item.asset.metadata.iconUrl,
    chainName: item.chain.chain.displayName,
    subtitle:
      !receiveEntry && from === 'shield' ? SHIELD_PROVIDERS['near-confidential'].name : undefined,
    chainId: item.chain.chain.id,
    badgeBlockchain: resolveChainIconAlias(
      item.chain.chain.family,
      item.chain.chain.displayName,
      item.chain.chain.id
    ),
    availableRaw: item.sourceRaw,
    decimals: item.asset.metadata.decimals,
    priceUsd:
      findAssetPrice(assetPrices, item.asset.asset.id)?.priceUsd ??
      portfolio?.confidential?.assets.find(holding => holding.assetId === item.asset.asset.id)
        ?.priceUsd,
    disabledReason:
      withdrawalPicker && BigInt(item.sourceRaw) === 0n ? 'No available balance' : undefined
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
                        getFundingBalance(zcashBalance, receiveFundingSource).available,
                        ZEC_DECIMALS
                      ),
                      priceUsd: zecPrice
                    })
              }
            ]
          : [])
      ]
    : []
  const providerAssetRows: readonly ShieldTokenPickerItem[] = fixedDirection
    ? [
        ...evmShieldPickerRows,
        ...(fixedZcashNativeAvailable || (fixedDirection === 'shield' && supportsConfidentialZec)
          ? [
              {
                key: zcashAssetId,
                assetId: zcashAssetId,
                symbol: 'ZEC',
                ...getZcashTokenPickerChain(currentNetwork),
                nativeIconChain: 'zcash',
                zcashFundingSource: fixedZcashSource,
                availableRaw: parseDisplayUnitAmount(fixedZcashAvailable, ZEC_DECIMALS),
                decimals: ZEC_DECIMALS,
                priceUsd: zecPrice,
                disabledReason:
                  withdrawalPicker && Number(fixedZcashAvailable) <= 0
                    ? 'No available balance'
                    : undefined
              } satisfies ShieldTokenPickerItem
            ]
          : []),
        ...(fixedDirection === 'unshield' && fixedNearZecAsset
          ? [
              {
                key: `near-confidential:${zcashAssetId}`,
                assetId: zcashAssetId,
                symbol: 'ZEC',
                ...getZcashTokenPickerChain(currentNetwork),
                subtitle: SHIELD_PROVIDERS['near-confidential'].name,
                nativeIconChain: 'zcash',
                availableRaw: fixedNearZecRaw ?? '0',
                decimals: ZEC_DECIMALS,
                priceUsd: zecPrice,
                disabledReason:
                  BigInt(fixedNearZecRaw ?? '0') > 0n ? undefined : 'No available balance'
              }
            ]
          : [])
      ]
    : receiveEntry
      ? receivePickerRows
      : evmShieldPickerRows
  const groupedAssetPicker = !receiveEntry && Boolean(fixedDirection || intent)
  const pickerAsset = (item: TransferPickerRow) =>
    'key' in item
      ? shieldTokenPickerBalance({ ...item, pinned: item.key === zcashAssetId })
      : {
          availableRaw: item.sourceRaw,
          symbol: item.asset.metadata.symbol,
          decimals: item.asset.metadata.decimals,
          isNative: item.asset.asset.kind === 'native',
          priceUsd: findAssetPrice(assetPrices, item.asset.asset.id)?.priceUsd
        }
  const selectionRows: readonly TransferPickerRow[] = shieldAssetPicker
    ? providerAssetRows
    : pickerRows
  const withdrawalReady =
    withdrawalPicker &&
    loadState === 'ready' &&
    catalogReady &&
    (from !== 'shield' || currentShieldBalances !== null || !canLoadShield)
  const accountNetwork = activeAccount?.networks.find(
    item => item.chain.id === selected?.chain.chain.id
  )
  const mainAddress =
    accountNetwork?.addresses.find(address => address.preferredForReceive)?.value ?? ''
  const privateAddress = accountNetwork?.privateExecutionAddress ?? ''
  const fixedNearZecWithdraw = Boolean(
    fixedNearZecAsset && fixedZec && fixedProvider === 'near-confidential'
  )
  const eligible = Boolean(
    selected &&
    (eligibleChainIds.includes(selected.chain.chain.id) || (fixedNearZecWithdraw && canLoadShield))
  )
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
    !externalReceive &&
    isShieldTransferRoute(from, to) &&
    (selected?.chain.chain.family === 'evm' || fixedNearZecWithdraw)
  const privateTransferOptions = useMemo(
    () =>
      supportedPair && selected
        ? listPrivateTransferDestinationAssets({
            source: selected,
            assets,
            catalogAssets: shieldAssets,
            eligibleChainIds
          })
        : [],
    [supportedPair, selected, assets, shieldAssets, eligibleChainIds]
  )
  const privateTransferDestination = supportedPair
    ? destinationAssetId
      ? (privateTransferOptions.find(item => item.asset.asset.id === destinationAssetId) ?? null)
      : selected
    : null
  const crossChainPrivateTransfer = supportedPair && destinationAssetId !== null
  const clusterPair = isClusterTransferRoute(from, to) && selected?.chain.chain.family === 'evm'
  const clusterSelected = method === 'cluster' && clusterPair && !crossChainPrivateTransfer
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
      fixedNearZecWithdraw
        ? (fixedNearZecAsset?.managed ?? null)
        : selected
          ? resolveShieldManagedAsset(selected.asset, managedAssets, catalogTokens, currentNetwork)
          : null,
    [
      fixedNearZecWithdraw,
      fixedNearZecAsset,
      selected?.asset,
      managedAssets,
      catalogTokens,
      currentNetwork
    ]
  )
  const { available: receiveProviders, selected: receiveProvider } = resolveShieldReceiveProvider({
    nativeZec: receiveZec,
    preferred: preferredReceiveProvider,
    canReceiveNativeZec:
      !shieldedZecReceive && Boolean(zcashReceiveAddress) && (externalReceive || canSpendPublicZec),
    nearSupportsAsset:
      receiveEntry &&
      canLoadShield &&
      (externalReceive
        ? Boolean(externalAsset)
        : receiveZec
          ? supportsConfidentialZec &&
            (shieldedZecReceive ? canSpendShieldedZec : canSpendPublicZec)
          : Boolean(managedAsset))
  })
  const nativeReceive = receiveEntry && receiveZec && !externalReceive && receiveProvider !== null
  const clusterAvailable = Boolean(
    clusterPair && !crossChainPrivateTransfer && managedAsset && effective
  )
  const destinationOptions = useMemo(() => {
    if (from !== 'shield' || !selected || !managedAsset) return []
    if (fixedDirection === 'unshield') return [{ ...selected, managed: managedAsset }]
    const options = shieldAssets.filter(item =>
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
    shieldAssets,
    currentNetwork,
    eligibleChainIds,
    fixedDirection
  ])
  const networkAssets = from === 'shield' ? destinationOptions : privateTransferOptions
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
  const targetAsset =
    from === 'shield' ? destination : supportedPair ? privateTransferDestination : selected
  const canSelectTargetNetwork =
    !fixedDirection &&
    (from === 'shield' ||
      (supportedPair && (privateTransferOptions.length > 1 || crossChainPrivateTransfer)))
  const targetNetwork = activeAccount?.networks.find(
    item => item.chain.id === targetAsset?.chain.chain.id
  )
  const targetAddress = fixedNearZecWithdraw
    ? (zcashPublicAddress ?? '')
    : to === 'private'
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
  const routeKey = `${scopeKey}:${selected?.asset.asset.id ?? ''}:${from}:${to}:${destination?.asset.asset.id ?? destinationAssetId ?? ''}`
  const routeState =
    selected?.chain.chain.family === 'evm' &&
    eligible &&
    supportedPair &&
    (!crossChainPrivateTransfer ||
      (privateTransferDestination &&
        privateTransferDestination.chain.chain.id !== selected.chain.chain.id &&
        mainAddress &&
        targetAddress)) &&
    toWalletEvmQuoteToken(selected.asset)
      ? 'supported'
      : 'unsupported'
  const methodAvailable = supportedPair && routeState === 'supported'

  const nativeShieldMaxEstimate = Boolean(
    maximumShield &&
    selected?.chain.chain.family === 'evm' &&
    selected.asset.asset.kind === 'native'
  )
  const maxSender = from === 'private' ? privateAddress : mainAddress
  const shieldMaxEstimate = useBalanceTransferEstimate({
    enabled: nativeShieldMaxEstimate && Boolean(maxSender && shieldSourceRaw),
    requestKey: JSON.stringify([routeKey, shieldSourceRaw, evmMoveFee, maxRequestRevision]),
    estimate: async () => {
      const feeRaw = await estimateQuickShieldNativeFee(
        selected!.asset.asset.id,
        maxSender,
        from,
        evmMoveFee
      )
      const balance = BigInt(shieldSourceRaw!)
      return quickShieldMaximum({ native: true, assetRaw: balance, gasRaw: balance }, feeRaw)
    }
  })
  const maximumRaw = nativeShieldMaxEstimate
    ? shieldMaxEstimate.value
    : selected?.asset.asset.kind === 'native' &&
        selected.chain.chain.family === 'evm' &&
        source &&
        from !== 'shield' &&
        fixedDirection !== 'shield'
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
  const buildClusterPreviewRequest = (amountRaw: string) =>
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
      managed: managedAsset!,
      slippageBps
    })
  const maxAmount =
    selected && maximumRaw !== null
      ? formatBaseUnitDecimalAmount(maximumRaw, selected.asset.metadata.decimals)
      : nativeShieldMaxEstimate
        ? ''
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
          symbol: selected.asset.metadata.symbol
        })
      : null
  const shieldAmountState =
    selected && shieldAvailable
      ? resolvePrivateBalanceTransferAmount({
          amount: currentAmount,
          decimals: selected.asset.metadata.decimals,
          availableRaw: shieldAvailable.amountRaw,
          symbol: selected.asset.metadata.symbol
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
  const directRecipient = crossChainPrivateTransfer ? targetAddress : source?.recipient
  const methodEstimateKey = `${routeKey}:${estimateAmountRaw ?? ''}:${source?.sender}:${directRecipient}:${source?.executionMode}:${slippageBps}:${retry}`
  const canEstimateMethods = Boolean(
    draftScope === scopeKey &&
    (clusterPair || crossChainPrivateTransfer) &&
    selected &&
    eligible &&
    source &&
    estimateAmountRaw &&
    !preparedShield
  )
  const directEstimate = useBalanceTransferEstimate({
    enabled: canEstimateMethods && methodAvailable,
    requestKey: `${methodEstimateKey}:${quoteMode}`,
    estimate: signal =>
      estimateDirectTransfer({
        asset: selected!.asset,
        chain: selected!.chain,
        ...(crossChainPrivateTransfer
          ? { destinationAsset: privateTransferDestination!.asset }
          : {}),
        nativeFeeAsset: nativeFeeAsset ?? null,
        amountRaw: estimateAmountRaw!,
        sender: source!.sender,
        recipient: directRecipient!,
        executionMode: source!.executionMode,
        slippageBps,
        quoteMode,
        signal
      })
  })
  const clusterEstimateKey = `${methodEstimateKey}:${managedAsset?.protocolAssetId ?? ''}`
  const clusterEstimate = useBalanceTransferEstimate({
    enabled: canEstimateMethods && clusterAvailable,
    requestKey: clusterEstimateKey,
    estimate: async signal => {
      const preview = await confidentialFundingClient.preview(
        buildClusterPreviewRequest(estimateAmountRaw!)
      )
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
        ...buildClusterPreviewRequest(estimateAmountRaw!),
        feeSelection: evmMoveFee
      })
  }).value
  const clusterEstimateWithFee =
    clusterEstimate.value && clusterNetworkFee
      ? { ...clusterEstimate.value, sourceNetworkFee: clusterNetworkFee }
      : clusterEstimate.value
  const directQuoted = Boolean(canEstimateMethods && methodAvailable && directEstimate.value)
  const selectedEstimate = clusterSelected ? clusterEstimate : directEstimate
  const maxLoading = maxSelected && (selectedEstimate.loading || shieldMaxEstimate.loading)
  const clusterUnavailable = !clusterAvailable || clusterEstimate.error
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
  const clusterMinimumError =
    selected && clusterEstimate.errorMessage
      ? formatTransferQuoteMinimumError(
          clusterEstimate.errorMessage,
          selected.asset.metadata.decimals,
          formatSymbol(selected.asset.metadata.symbol)
        )
      : null
  const showGenericEstimateError =
    (clusterPair || crossChainPrivateTransfer) &&
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
    if (method === 'cluster' && clusterUnavailable && methodAvailable) {
      userPickedMethod.current = clusterEstimate.error
      setMethod('directly')
    } else if (method === 'directly' && directUnavailable && clusterQuoted) {
      userPickedMethod.current = false
      setMethod('cluster')
    }
  }, [
    method,
    clusterUnavailable,
    directUnavailable,
    clusterQuoted,
    methodAvailable,
    clusterEstimate.error
  ])
  const shieldReviewKeyForFee = (feeSelection: EvmFeeSelection) =>
    maximumShield
      ? JSON.stringify([
          routeKey,
          fixedProvider,
          from === 'private' ? privateAddress : mainAddress,
          managedAsset?.protocolAssetId,
          sourceRaw,
          nativeFeeRaw,
          selected?.asset.balance.availableRaw,
          nativeFeeAsset?.balance.availableRaw,
          slippageBps,
          feeSelection,
          retry
        ])
      : `${routeKey}:${method}:${currentAmount}:${shieldAmountState?.amountRaw ?? ''}:${slippageBps}:${JSON.stringify(feeSelection)}`
  const submittedQuickReview =
    preparedShield?.quickRequest && confirmAttemptedPlanId.current === preparedShield.review.planId
  const shieldReviewKey = submittedQuickReview
    ? preparedShield.key
    : shieldReviewKeyForFee(evmMoveFee)
  const latestShieldReviewKey = useRef(shieldReviewKey)
  latestShieldReviewKey.current = shieldReviewKey
  const activeShieldReview = preparedShield?.key === shieldReviewKey ? preparedShield.review : null
  const discardPreparedOnExit = useRef<string | null>(null)
  discardPreparedOnExit.current = preparedShield?.review.planId ?? null
  useEffect(() => {
    if (!fixedDirection) return
    return () => {
      const id = discardPreparedOnExit.current
      if (id && id !== confirmAttemptedPlanId.current)
        void confidentialFundingClient.cancel(id).catch(() => {})
    }
  }, [fixedDirection, scopeKey])
  const stateChange = useRef(fixedShield?.onStateChange)
  stateChange.current = fixedShield?.onStateChange
  const reviewing = Boolean(
    shieldAwaitingReview || activeShieldReview || shieldActivity || nativeReceiveState.reviewing
  )
  const busy = preparingShield || confirmingShield || cancellingShield || nativeReceiveState.busy
  const submittingShield =
    confirmingShield && confirmAttemptedPlanId.current === activeShieldReview?.planId
  const fullHeight = Boolean(shieldActivity || submittingShield)
  useLayoutEffect(() => {
    stateChange.current?.({ reviewing, busy, fullHeight })
  }, [reviewing, busy, fullHeight])
  useLayoutEffect(
    () => () => stateChange.current?.({ reviewing: false, busy: false, fullHeight: false }),
    []
  )
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
    (!crossChainPrivateTransfer || directQuoted) &&
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
    (!nativeShieldMaxEstimate ||
      (!shieldMaxEstimate.loading && !shieldMaxEstimate.error && shieldMaxEstimate.value)) &&
    shieldSourceRaw !== null &&
    !tokenFeeBalanceError &&
    (!maxSelected || amount === currentAmount) &&
    shieldAmountState?.amountRaw
  )
  const canPickAccountSide = (side: 'from' | 'to') =>
    side !== fixedSide &&
    (!fixedDirection ||
      (side === (fixedDirection === 'shield' ? 'from' : 'to') && Boolean(privateAddress)))
  const selectDomain = (domain: TransferDomain, side: 'from' | 'to') => {
    if (!canPickAccountSide(side) || pickerAccountId !== effective?.accountId) return
    if (fixedDirection && (domain === 'shield' || (domain === 'private' && !privateAddress))) return
    if (domain === (side === 'from' ? to : from)) return
    userEditedMove.current = true
    if (receiveEntry) {
      if (receiveAssetId) setSelectedAssetId(receiveAssetId)
      setReceiveExternal(false)
      setReceiveFundingSource('transparent')
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
    if (!canPickAccountSide(side)) return
    setPickerAccountId(effective?.accountId ?? null)
    setDomainPicker(side)
  }
  const review = () => {
    if (!canReview || !selected || !effective || !mainAddress || !scopeStillCurrent()) return
    const activityDomain = fixedSide === 'to' ? to : fixedSide === 'from' ? from : walletMode
    navigate(
      direction === 'main-to-private'
        ? buildPrivateDepositReviewPath({
            sourceAssetId: selected.asset.asset.id,
            destinationAssetId: privateTransferDestination!.asset.asset.id,
            amount: currentAmount,
            maximum: maxSelected
          })
        : crossChainPrivateTransfer
          ? buildCrossChainPrivateWithdrawReviewPath({
              sourceAssetId: selected.asset.asset.id,
              destinationAssetId: privateTransferDestination!.asset.asset.id,
              walletId: effective.walletId,
              accountId: effective.accountId,
              amount: currentAmount,
              maximum: maxSelected
            })
          : buildMoveToMainEvmPath({
              assetId: selected.asset.asset.id,
              mainAddress,
              amount: currentAmount,
              maximum: maxSelected
            }),
      { state: { activityDomain } }
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
      ? `${formatTokenQuantity(formatBaseUnitAmount(raw, selected.asset.metadata.decimals))} ${symbol}`
      : null
  const nearPickerAvailable =
    pickerIsActive && canLoadShield && Boolean(managedAsset) && oppositeDomain !== 'shield'
  const showShieldPickerBalance = domainPicker !== null && !receiveEntry && nearPickerAvailable
  useEffect(() => {
    if (!showShieldPickerBalance || usesConfidentialBalances) {
      setShieldPickerLoading(false)
      return
    }
    let current = true
    setShieldPickerLoading(true)
    void refreshPortfolioSource({ source: 'near-confidential', authorize: false })
      .catch(() => false)
      .finally(() => {
        if (current) setShieldPickerLoading(false)
      })
    return () => {
      current = false
    }
  }, [showShieldPickerBalance, usesConfidentialBalances, refreshPortfolioSource])
  const shieldPickerRaw =
    currentShieldBalances && managedAsset
      ? (getConfidentialAvailableForAsset(currentShieldBalances, managedAsset.protocolAssetId) ??
        '0')
      : null
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
    if (!selected || maxDisabled || maximumRaw === '0' || maxLoading) return
    setSelectedAssetId(selected.asset.asset.id)
    setMaxSelected(true)
    setAmount(maxAmount)
    setMaxRequestRevision(value => value + 1)
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
  useEffect(() => {
    if (!maximumShield || !activeShieldReview || confirmingShield || confirmUncertain) return
    const timer = window.setTimeout(
      () => {
        if (
          confirmingShieldRef.current ||
          confirmAttemptedPlanId.current === activeShieldReview.planId
        )
          return
        void confidentialFundingClient.cancel(activeShieldReview.planId).catch(() => {})
        setPreparedShield(null)
        setShieldError('Shield review expired. Try again.')
      },
      Math.max(0, activeShieldReview.expiresAt - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [maximumShield, activeShieldReview, confirmingShield, confirmUncertain])
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
      preparingShieldRef.current ||
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
    preparingShieldRef.current = true
    setPreparingShield(true)
    setShieldError(null)
    try {
      const commonRequest = {
        network: currentNetwork,
        keyDomainId: effective.walletId,
        accountId: effective.accountId,
        amountRaw: shieldAmountState.amountRaw,
        asset: selected.asset,
        chain: selected.chain,
        managed: managedAsset,
        slippageBps,
        ...(from === 'shield' ? {} : { feeSelection }),
        dedupKey
      }
      const request = fixedDirection
        ? buildFixedShieldFundsRequest({
            ...commonRequest,
            direction: fixedDirection,
            accountDomain:
              (fixedDirection === 'shield' ? from : to) === 'private' ? 'private' : 'public',
            ownTransparentAddress: fixedNearZecWithdraw ? zcashPublicAddress : undefined
          })
        : buildShieldTransferRequest({
            ...commonRequest,
            from,
            to,
            method: clusterSelected ? 'cluster' : 'directly',
            ...(from === 'shield' && destination ? { destination } : {})
          })
      const maximum = maximumShield
        ? await prepareQuickShieldMaximum(
            request,
            addressFor(from),
            () => scopeStillCurrent() && latestShieldReviewKey.current === expectedKey
          )
        : null
      if (maximumShield && !maximum) return false
      const reviewedRequest = maximum?.request ?? request
      const result = maximum?.review ?? (await confidentialFundingClient.prepare(reviewedRequest))
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
      if (
        !matchesShieldReview(result, reviewedRequest) ||
        (fixedDirection &&
          !matchesFixedShieldFundsRecipient(
            result,
            reviewedRequest,
            fixedDirection === 'unshield' ? targetAddress : addressFor(from)
          ))
      ) {
        void confidentialFundingClient.cancel(result.planId).catch(() => {})
        throw new Error('Shield review changed. Try again.')
      }
      confirmAttemptedPlanId.current = null
      setConfirmUncertain(false)
      reviewAttempt.current = null
      if (replacingReview) setEvmMoveFee(feeSelection)
      setPreparedShield({ key, review: result, quickRequest: maximum?.request })
      return true
    } catch (error) {
      if (scopeStillCurrent()) {
        const message = error instanceof Error ? error.message : ''
        const classifiedMessage = classifyError(error, {
          source: selected.asset.metadata.symbol,
          fee: nativeFeeAsset?.metadata.symbol
        }).userMessage
        const userMessage =
          message === 'Gas limit is below the estimated gas required'
            ? 'Gas limit is below the estimated gas required. Edit the network fee and try again.'
            : classifiedMessage
        setShieldError(userMessage)
        if (replacingReview) throw new Error(userMessage)
      }
      return false
    } finally {
      preparingShieldRef.current = false
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
      const domain = plan.sourceDomain ?? from
      const display: ConfidentialActivityDisplay | undefined = selected
        ? {
            operation: 'move',
            perspective: { viewedDomain: domain },
            amount: formatBaseUnitDecimalAmount(
              plan.source.amountRaw,
              selected.asset.metadata.decimals
            ),
            symbol: formatSymbol(selected.asset.metadata.symbol),
            from: `${accountName} · ${domainLabel(from)}`,
            recipient: `${accountName} · ${domainLabel(to)}`,
            network: selected.chain.chain.displayName
          }
        : undefined
      if (fixedDirection) setShieldActivity({ plan, display })
      else
        void openConfidentialActivity(
          plan,
          () => navigate(homeActivityPath(domain, plan.transactionId)),
          display
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
        if (maximumShield) confirmAttemptedPlanId.current = null
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
      if (maximumShield && plan.phase === 'prepared') confirmAttemptedPlanId.current = null
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
    if (
      !pending ||
      confirmingShieldRef.current ||
      cancellingShield ||
      feeRefreshRef.current ||
      preparingShieldRef.current ||
      !scopeStillCurrent()
    )
      return
    if (!confirmUncertain && pending.expiresAt <= Date.now()) {
      setShieldError('Shield review expired. Try again.')
      return
    }
    confirmingShieldRef.current = true
    setConfirmingShield(true)
    setShieldError(null)
    try {
      if (confirmUncertain) {
        const status = await checkShieldPlan(pending.planId)
        if (status === 'prepared' && scopeStillCurrent())
          setShieldError('Transfer not started. Review and try again.')
        return
      }
      if (preparedShield?.quickRequest) {
        const balances = await readQuickShieldBalances(preparedShield.quickRequest)
        if (!scopeStillCurrent() || latestShieldReviewKey.current !== shieldReviewKey) return
        if (
          quickShieldMaximum(balances, pending.sourceNetworkFee!.raw) !== pending.sourceAmountRaw ||
          pending.expiresAt <= Date.now()
        ) {
          await confidentialFundingClient.cancel(pending.planId)
          setPreparedShield(null)
          setShieldError('Balance or quote changed. Review the maximum again.')
          return
        }
      }
      confirmAttemptedPlanId.current = pending.planId
      const plan = await confidentialFundingClient.confirm(
        pending.planId,
        pending.payloadFingerprint
      )
      if (hasShieldTransferStarted(plan)) openShieldActivity(plan)
      else await checkShieldPlan(plan.planId)
    } catch (error) {
      if (preparedShield?.quickRequest && confirmAttemptedPlanId.current !== pending.planId) {
        if (scopeStillCurrent()) {
          void confidentialFundingClient.cancel(pending.planId).catch(() => {})
          setPreparedShield(null)
          setShieldError(classifyError(error).userMessage)
        }
        return
      }
      const status = await checkShieldPlan(pending.planId)
      if (status === 'prepared' && scopeStillCurrent())
        setShieldError(classifyError(error).userMessage)
    } finally {
      confirmingShieldRef.current = false
      if (scopeStillCurrent()) setConfirmingShield(false)
    }
  }

  const moveReviewFiatValue = useMemo(() => {
    if (!selected || !assetPrices || !activeShieldReview) return null
    const priceUsd = findAssetPrice(assetPrices, selected.asset.asset.id)?.priceUsd
    if (typeof priceUsd !== 'string' || !priceUsd) return null
    const usd = Number(priceUsd)
    if (!Number.isFinite(usd) || usd <= 0) return null
    try {
      const quantity = Number(
        formatBaseUnitAmount(activeShieldReview.sourceAmountRaw, selected.asset.metadata.decimals)
      )
      if (!Number.isFinite(quantity) || quantity <= 0) return null
      return formatFiatAmount(quantity * usd, { showSign: true })
    } catch {
      return null
    }
  }, [selected, assetPrices, activeShieldReview])

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

  const exitForm = fixedShield?.onBack ?? goBack
  const openShieldReview = () => {
    if (!canReviewShield) return
    setShieldAwaitingReview(true)
    void prepareShield()
  }
  if (shieldActivity && draftScope === scopeKey) {
    const { plan, display } = shieldActivity
    return (
      <div className="page-container">
        <ConfidentialActivityView
          plan={plan}
          display={display}
          onDone={exitForm}
          onViewActivity={() =>
            navigate(homeActivityPath(plan.sourceDomain ?? from, plan.transactionId))
          }
        />
      </div>
    )
  }

  if (activeShieldReview && selected && draftScope === scopeKey) {
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
          title={`Confirm ${actionLabel}`}
          asset={{
            assetId: selected.asset.asset.id,
            symbol,
            icon: selected.asset.metadata.iconUrl,
            blockchain: resolveChainIconAlias(
              selected.chain.chain.family,
              selected.chain.chain.displayName,
              selected.chain.chain.id
            )
          }}
          amount={formatBaseUnitDecimalAmount(
            activeShieldReview.sourceAmountRaw,
            selected.asset.metadata.decimals
          )}
          fiatValue={moveReviewFiatValue}
          network={selected.chain.chain.displayName}
          rows={[
            ...(fixedDirection === 'shield'
              ? [
                  {
                    label: 'Provider',
                    content: (
                      <span className="inline-flex items-center gap-1.5">
                        <ShieldProviderLogo provider="near-confidential" size={16} /> Confidential
                      </span>
                    )
                  }
                ]
              : []),
            {
              label: 'From',
              content: (
                <TransactionReviewParty
                  accountName={accountName}
                  domain={from}
                  confidential={from === 'shield'}
                  address={from === 'shield' ? undefined : activeShieldReview.sourceAddress}
                  chain={selected.chain.chain}
                />
              )
            },
            {
              label: 'To',
              content: (
                <TransactionReviewParty
                  accountName={accountName}
                  domain={to}
                  confidential={to === 'shield'}
                  address={to === 'shield' ? undefined : activeShieldReview.destinationAddress}
                  chain={targetAsset?.chain.chain ?? selected.chain.chain}
                />
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
                        loadTierPreviews={() =>
                          scopeStillCurrent()
                            ? previewReviewedConfidentialDepositFeeTiers(
                                activeShieldReview,
                                selected.asset.asset.id,
                                evmMoveFee.kind === 'tier' ? evmMoveFee.tier : undefined
                              )
                            : Promise.resolve({})
                        }
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
              <TransactionNotice
                className="mt-3"
                message={shieldError}
                tone={feeRefresh ? 'warning' : 'error'}
                retrying={cancellingShield || preparingShield}
                onRetry={
                  feeRefresh
                    ? () => void changeShieldFee(feeRefresh.selection).catch(() => {})
                    : undefined
                }
              />
            ) : undefined
          }
          confirmLabel={confirmUncertain ? 'Check status' : actionLabel}
          confirming={confirmingShield}
          submitting={submittingShield}
          cancelDisabled={cancellingShield}
          confirmDisabled={
            !scopeStillCurrent() ||
            cancellingShield ||
            preparingShield ||
            feeRefresh !== null ||
            (!confirmUncertain && activeShieldReview.expiresAt <= Date.now())
          }
          onCancel={() => {
            setShieldAwaitingReview(false)
            void cancelShieldReview()
          }}
          onConfirm={() => void confirmShield()}
        />
      </div>
    )
  }

  const assetSymbol =
    receiveZec || fixedZec
      ? 'ZEC'
      : symbol || formatSymbol(externalAsset?.token.symbol ?? pendingAssetHint?.symbol)
  const assetIcon = (
    <TokenIcon
      assetId={
        selected?.asset.asset.id ?? receiveAssetId ?? fixedAssetId ?? selectedAssetId ?? undefined
      }
      symbol={assetSymbol}
      icon={selected?.asset.metadata.iconUrl ?? pendingAssetHint?.iconUrl}
      nativeChain={receiveZec || fixedZec ? 'zcash' : undefined}
      blockchain={
        receiveZec || fixedZec
          ? 'zec'
          : externalAsset
            ? resolveChainIconAlias(
                externalAsset.chain.family,
                externalAsset.chain.displayName,
                externalAsset.chain.id
              )
            : networkIcon
      }
      size={26}
    />
  )
  const assetControl = (
    <button
      type="button"
      onClick={() => setAssetPickerOpen(true)}
      disabled={!receiveEntry && !selected && !fixedZec && loadState === 'loading'}
      className="wallet-interactive flex h-9 max-w-full items-center gap-2 rounded-full bg-card px-2 text-base font-medium leading-[21px] hover:bg-wallet-selected active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary"
      aria-label="Select transfer asset"
    >
      {assetSymbol ? assetIcon : <Icon icon="lucide:coins" width={20} height={20} />}
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
        domain={shieldedZecReceive ? 'shield' : receiveSource === 'private' ? 'private' : 'public'}
        transparent={receiveZec && !shieldedZecReceive}
        address={
          receiveZec
            ? ((shieldedZecReceive ? zcashReceiveAddress : zcashPublicAddress) ?? '')
            : addressFor(from)
        }
        networkName=""
        network={networkIcon}
        onNetworkClick={() => setAssetPickerOpen(true)}
        onAccountClick={() => openDomainPicker('from')}
        external={externalReceive}
        provider={shieldedZecReceive ? 'zcash-shield' : null}
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
      from: shieldedZecReceive ? 'zcash-shield' : 'public',
      assetId: zcashAssetId,
      walletId: currentWalletId ?? '',
      accountId: currentAccountId ?? ''
    })}`
  const fixedNativeRetryPath =
    fixedDirection && fixedZecForm && fixedProvider && fixedAvailableProviders[fixedProvider]
      ? shieldFundsPath(fixedDirection, zcashAssetId, fixedProvider)
      : null
  const showNativeMove = Boolean(nativeRetryPath || fixedNativeRetryPath)
  const canChooseFixedProvider =
    fixedAvailableProviders['zcash-shield'] && fixedAvailableProviders['near-confidential']
  const openFixedProvider = canChooseFixedProvider ? () => setProviderPickerOpen(true) : undefined
  const fixedZecAccounts = fixedZecForm && (
    <div className="mt-3 space-y-2.5">
      <BalanceTransferAccountCard
        label="From"
        accountName={accountName}
        domain={from}
        transparent={from === 'public'}
        address={
          fixedZcashSelfTransfer?.fromAddress ??
          (from === 'public' ? (zcashPublicAddress ?? '') : '')
        }
        network="zcash"
        provider={from === 'shield' ? 'zcash-shield' : null}
        onAccountClick={from === 'shield' ? openFixedProvider : undefined}
      />
      <BalanceTransferAccountCard
        label="To"
        accountName={accountName}
        domain={to}
        transparent={to === 'public'}
        address={
          fixedProvider === 'near-confidential' ? '' : (fixedZcashSelfTransfer?.toAddress ?? '')
        }
        network={fixedProvider === 'near-confidential' ? 'near' : 'zcash'}
        provider={to === 'shield' ? fixedProvider : null}
        onAccountClick={to === 'shield' ? openFixedProvider : undefined}
      />
    </div>
  )
  const shieldHasQuote = fixedDirection === 'shield' && fixedProvider === 'near-confidential'

  if (
    fixedDirection &&
    shieldAwaitingReview &&
    !fixedNativeRetryPath &&
    (preparingShield || shieldError)
  ) {
    return (
      <div className="page-container">
        <PageHeader
          title={`Confirm ${fixedActionLabel}`}
          showBack
          onBack={() => setShieldAwaitingReview(false)}
          backDisabled={preparingShield}
        />
        {preparingShield ? (
          <QuickShieldReviewSkeleton />
        ) : (
          <div className="p-4" aria-live="polite">
            <TransactionNotice message={shieldError!} onRetry={openShieldReview} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page-container" data-wallet-mode={receiveEntry ? 'public' : walletMode}>
      {(!showNativeMove || !nativeReceiveState.reviewing) && (
        <PageHeader
          title={
            receiveEntry
              ? 'Receive'
              : fixedDirection
                ? actionLabel
                : to === 'private'
                  ? 'Deposit to Incognito'
                  : from === 'private'
                    ? 'Withdraw from Incognito'
                    : actionLabel
          }
          showBack
          onBack={exitForm}
          backDisabled={
            Boolean(fixedDirection && busy) || (showNativeMove && nativeReceiveState.busy)
          }
          rightContent={
            (
              fixedDirection
                ? shieldHasQuote
                : !receiveEntry || receiveProvider === 'near-confidential'
            ) ? (
              <SwapSettingsButton
                disabled={preparingShield || confirmingShield || nativeReceiveState.busy}
                shieldDraft={
                  shieldHasQuote
                    ? {
                        slippageBps: shieldSlippageBps,
                        onChange: next => {
                          if (!scopeStillCurrent()) return
                          setShieldError(null)
                          setShieldSlippageBps(next)
                        }
                      }
                    : undefined
                }
              />
            ) : undefined
          }
        />
      )}
      {fixedNativeRetryPath ? (
        <NativeZcashMoveForm
          key={`${scopeKey}:${fixedDirection}:${fixedProvider}`}
          destination={
            fixedProvider === 'near-confidential'
              ? 'confidential'
              : fixedDirection === 'unshield'
                ? 'transparent'
                : 'shielded'
          }
          fundingSource={fixedZcashSource}
          retryPath={fixedNativeRetryPath}
          asset={assetControl}
          accounts={fixedZecAccounts}
          onStateChange={setNativeReceiveState}
          actionLabel={fixedActionLabel}
          slippageBps={shieldHasQuote ? shieldSlippageBps : undefined}
          resultReturnPath={
            fixedShield?.onBack ? location.pathname + location.search : '/?domain=shield'
          }
        />
      ) : nativeRetryPath ? (
        <NativeZcashMoveForm
          key={`${receiveProvider}:${receiveFundingSource}`}
          destination={receiveProvider === 'zcash-shield' ? 'shielded' : 'confidential'}
          fundingSource={receiveFundingSource}
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
              slippageBps={slippageBps}
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
              balanceLoading={from === 'shield' && !currentShieldBalances && loadingShieldBalances}
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
              max={{
                onClick: handleMax,
                selected: maxSelected,
                loading: maxLoading,
                disabled: !selected || maxDisabled || maximumRaw === '0' || maxLoading
              }}
            />
            {receiveEntry ? (
              receiveAccounts
            ) : (
              <BalanceTransferAccounts
                className="mt-3 shrink-0"
                privateMode={walletMode === 'private'}
                disabled={!selected}
                onReverse={
                  fixedDirection || fixedSide
                    ? undefined
                    : () => {
                        userEditedMove.current = true
                        if (from === 'shield' && destination)
                          setSelectedAssetId(destination.asset.asset.id)
                        else if (crossChainPrivateTransfer && privateTransferDestination)
                          setSelectedAssetId(privateTransferDestination.asset.asset.id)
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
                    onNetworkClick={fixedDirection ? undefined : () => setAssetPickerOpen(true)}
                    onAccountClick={
                      fixedDirection
                        ? from === 'shield'
                          ? openFixedProvider
                          : canPickAccountSide('from')
                            ? () => openDomainPicker('from')
                            : undefined
                        : fixedSide === 'from'
                          ? undefined
                          : () => openDomainPicker('from')
                    }
                    provider={fixedDirection && from === 'shield' ? 'near-confidential' : null}
                    disabled={!selected}
                  />
                }
                destination={
                  <BalanceTransferAccountCard
                    label="To"
                    accountName={accountName}
                    domain={to}
                    address={to === 'shield' ? '' : targetAddress}
                    networkName={
                      targetAsset?.chain.chain.displayName ??
                      (crossChainPrivateTransfer ? 'Select network' : undefined)
                    }
                    network={
                      targetAsset
                        ? resolveChainIconAlias(
                            targetAsset.chain.chain.family,
                            targetAsset.chain.chain.displayName,
                            targetAsset.chain.chain.id
                          )
                        : networkIcon
                    }
                    onNetworkClick={
                      canSelectTargetNetwork ? () => setNetworkPickerOpen(true) : undefined
                    }
                    showNetwork={to !== 'shield'}
                    onAccountClick={
                      to === 'shield' && fixedDirection
                        ? openFixedProvider
                        : canPickAccountSide('to')
                          ? () => openDomainPicker('to')
                          : undefined
                    }
                    provider={fixedDirection && to === 'shield' ? 'near-confidential' : null}
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
            {selected?.chain.chain.family === 'evm' && clusterPair && (
              <div
                role="radiogroup"
                aria-label="Transfer method"
                className="mt-auto grid shrink-0 grid-cols-2 gap-2.5 pt-4"
              >
                <MethodCard
                  title="Cluster"
                  detail="Multiple transactions"
                  recommended
                  selected={clusterSelected}
                  disabled={clusterUnavailable}
                  unavailableReason={clusterMinimumError}
                  estimate={clusterEstimate.value}
                  loading={canEstimateMethods && clusterEstimate.loading}
                  fee={formatBalanceTransferFee(clusterEstimateWithFee, selected.asset)}
                  onClick={() => {
                    userPickedMethod.current = true
                    setMethod('cluster')
                  }}
                />
                <MethodCard
                  title="Directly"
                  detail="One transaction"
                  recommended={false}
                  selected={!clusterSelected}
                  disabled={!methodAvailable || directUnavailable}
                  estimate={directEstimate.value}
                  loading={canEstimateMethods && methodAvailable && directEstimate.loading}
                  fee={formatBalanceTransferFee(directEstimate.value, selected.asset)}
                  onClick={() => {
                    userPickedMethod.current = true
                    setMethod('directly')
                  }}
                />
              </div>
            )}
            {clusterSelected &&
              clusterNetworkFee &&
              clusterQuoted &&
              evmMoveFee.kind !== 'tier' && (
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-xs">
                  <span className="text-muted">Network fee</span>
                  <NetworkFeeTierPicker
                    chainFamily="evm"
                    tier="standard"
                    selection={evmMoveFee}
                    feeModel={evmMoveFee.kind === 'legacy' ? 'legacy' : 'eip1559'}
                    amount={formatBaseUnitAmount(clusterNetworkFee.raw, clusterNetworkFee.decimals)}
                    symbol={formatSymbol(clusterNetworkFee.symbol)}
                    loadTierPreviews={() =>
                      scopeStillCurrent()
                        ? previewClusterNetworkFeeTiers(
                            buildClusterPreviewRequest(estimateAmountRaw!)
                          )
                        : Promise.resolve({})
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
            {loadState === 'error' && !portfolio ? (
              <TransactionNotice
                className="mt-2"
                message="Assets could not be loaded."
                onRetry={() => void refreshPortfolio(true, { forceDiscovery: true })}
              />
            ) : shieldPair && shieldConnection === 'required' && !shieldConnecting ? (
              <TransactionNotice
                className="mt-2"
                message={shieldError ?? 'Shield balance unavailable.'}
                onRetry={() => void refreshShield(shieldNeedsAuthorization)}
              />
            ) : shieldMaxEstimate.error ? (
              <TransactionNotice
                className="mt-2"
                message={shieldMaxEstimate.errorMessage ?? 'Could not calculate maximum amount.'}
                onRetry={handleMax}
              />
            ) : transferError ? (
              <TransactionNotice className="mt-2" message={transferError} tone="warning" />
            ) : shieldError && !activeShieldReview && shieldConnection !== 'required' ? (
              <TransactionNotice className="mt-2" message={shieldError} />
            ) : showGenericEstimateError ? (
              <TransactionNotice
                className="mt-2"
                message="Transfer estimate unavailable."
                onRetry={() => setRetry(value => value + 1)}
              />
            ) : null}
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
                  selectedEstimate.loading) ||
                (crossChainPrivateTransfer && directEstimate.loading)
              }
              onClick={
                fundingRoute
                  ? fixedDirection
                    ? openShieldReview
                    : () => void prepareShield()
                  : review
              }
            >
              {clusterSelected ? `Review ${actionLabel}` : actionLabel}
            </Button>
          </div>
        </>
      )}

      <TokenSelectorDialog
        open={assetPickerOpen}
        onOpenChange={open => {
          if (!open && startsWithPicker && !explicitAssetSelection.current) exitForm()
          else setAssetPickerOpen(open)
        }}
        title="Select asset"
      >
        <TokenPicker<TransferPickerRow>
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
          selectedKey={
            fixedDirection
              ? fixedNearZecWithdraw
                ? `near-confidential:${zcashAssetId}`
                : (fixedAssetId ?? undefined)
              : receiveEntry
                ? (receiveAssetId ?? undefined)
                : selected?.asset.asset.id
          }
          rows={selectionRows}
          adapter={transferAssetSearch}
          loading={
            loadState === 'loading' || (from === 'shield' && shieldConnection === 'checking')
          }
          visibility={
            groupedAssetPicker
              ? { policy: withdrawalPicker ? 'withdrawal' : 'grouped', balance: pickerAsset }
              : undefined
          }
          isDisabled={item =>
            'key' in item
              ? Boolean(item.disabledReason)
              : withdrawalPicker && BigInt(item.sourceRaw) === 0n
          }
          emptyAction={
            withdrawalReady
              ? {
                  label: fixedDirection ? 'Shield First' : 'Deposit First',
                  onClick: () =>
                    routerNavigate(
                      fixedDirection
                        ? '/shield'
                        : '/transfer?intent=deposit&mode=private&from=public&to=private',
                      { replace: true }
                    )
                }
              : undefined
          }
          toItem={item => {
            if ('key' in item) return shieldTokenSelectionItem(item, balancesHidden)
            return {
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
              disabledReason:
                withdrawalPicker && BigInt(item.sourceRaw) === 0n
                  ? 'No available balance'
                  : undefined,
              balance: (
                <span className="block truncate text-base tabular-nums">
                  {balancesHidden
                    ? '••••'
                    : `${formatTokenQuantity(
                        formatBaseUnitAmount(item.sourceRaw, item.asset.metadata.decimals)
                      )} ${formatSymbol(item.asset.metadata.symbol)}`}
                  <span className="block truncate text-xs text-muted">
                    {balancesHidden
                      ? '••••'
                      : item.valueUsd !== null
                        ? formatFiatAmount(item.valueUsd)
                        : '—'}
                  </span>
                </span>
              )
            }
          }}
          onSelect={item => {
            const key = 'key' in item ? item.key : item.asset.asset.id
            if (fixedDirection) {
              const row = providerAssetRows.find(candidate => candidate.key === key)
              if (!row) return
              userEditedMove.current = true
              explicitAssetSelection.current = true
              setSelectedAssetId(row.assetId)
              if (row.assetId === zcashAssetId) {
                if (fixedDirection === 'shield') setFrom('public')
                else setTo('public')
              }
              setPreferredReceiveProvider(
                key === zcashAssetId && fixedZcashNativeAvailable
                  ? 'zcash-shield'
                  : 'near-confidential'
              )
              setDestinationAssetId(null)
              setAmount('')
              setMaxSelected(false)
              setShieldError(null)
              setAssetPickerOpen(false)
              return
            }
            if (
              receiveEntry
                ? !receivePickerRows.some(item => item.key === key)
                : !pickerRows.some(row => row.asset.asset.id === key)
            )
              return
            userEditedMove.current = true
            explicitAssetSelection.current = true
            setSelectedAssetId(key)
            if (receiveEntry && key !== zcashAssetId) setReceiveFundingSource('transparent')
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
        open={canSelectTargetNetwork && networkPickerOpen}
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
          } else if (supportedPair) {
            const differentChain = item.chain.chain.id !== selected?.chain.chain.id
            setDestinationAssetId(differentChain ? item.asset.asset.id : null)
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
          className="bg-wallet-surface p-4"
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
                        ? `${formatTokenQuantity(nativeRaw)} ZEC`
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
            {receiveEntry && domainPicker === 'from' && receiveZec && canSpendShieldedZec && (
              <TransferBalanceOption
                label={SHIELD_PROVIDERS['zcash-shield'].detailName}
                icon={<ShieldProviderLogo provider="zcash-shield" size={18} />}
                address={zcashReceiveAddress ?? ''}
                balance={`${formatTokenQuantity(getFundingBalance(zcashBalance, 'shielded').available)} ZEC`}
                selected={pickerIsActive && shieldedZecReceive}
                disabled={!pickerIsActive}
                onSelect={() => {
                  if (!pickerIsActive) return
                  setSelectedAssetId(zcashAssetId)
                  setReceiveExternal(false)
                  setReceiveFundingSource('shielded')
                  setPreferredReceiveProvider('near-confidential')
                  setDomainPicker(null)
                }}
              />
            )}
            {receiveEntry && domainPicker === 'from' && (
              <TransferBalanceOption
                label="External transfer"
                icon={<Icon icon="lucide:qr-code" width={20} height={20} />}
                selected={externalReceive}
                disabled={!pickerIsActive || (!canLoadShield && !zcashReceiveAddress)}
                onSelect={() => {
                  if (receiveAssetId) setSelectedAssetId(receiveAssetId)
                  setReceiveExternal(true)
                  setReceiveFundingSource('transparent')
                  setDomainPicker(null)
                }}
              />
            )}
            {!receiveEntry && !fixedDirection && (
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
                  balance={
                    nearPickerAvailable
                      ? (pickerBalance(shieldPickerRaw) ??
                        (shieldPickerLoading || loadingShieldBalances ? 'Updating…' : null))
                      : null
                  }
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
      {(receiveEntry || canChooseFixedProvider) && (
        <ShieldProviderDialog
          open={providerPickerOpen}
          onClose={() => setProviderPickerOpen(false)}
          selected={fixedDirection ? fixedProvider : receiveProvider}
          available={fixedDirection ? fixedAvailableProviders : receiveProviders}
          onSelect={provider => {
            if (fixedDirection) {
              if (!fixedAvailableProviders[provider]) return
              setSelectedAssetId(zcashAssetId)
              setPreferredReceiveProvider(provider)
              setAmount('')
              setMaxSelected(false)
              setShieldError(null)
              setProviderPickerOpen(false)
              return
            }
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
