import { MARKET_ASSETS } from '@/config/asset-market-assets'
import { Icon } from '@iconify/react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import type { PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { formatSortAddress } from '@/lib/format'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import type { TokenSelectionItem } from '@/popup/components/tokens/TokenPicker'
import { TokenPicker } from '@/popup/components/tokens/TokenPicker'
import { TokenSelectorDialog } from '@/popup/components/tokens/TokenSelectorDialog'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { ChainSelector, type ChainSelectorOption } from '@/popup/components/common/ChainSelector'
import { TransactionNotice } from '@/popup/components/transaction/TransactionNotice'
import { ListSkeleton } from '@/popup/components/ui/skeleton'
import { TransactionModeDropdown } from '@/popup/components/transaction/TransactionModeDropdown'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenBalanceDisplay } from '@/popup/components/tokens/TokenBalanceDisplay'
import { ZcashFundingBadge } from '@/popup/components/zcash/ZcashFundingBadge'
import type { EvmTransferSubmission } from '@/popup/services/evm-wallet-client'
import { useNavigate } from '@/popup/provider/Router'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import {
  getFundingSourceOptions,
  getFundingSourceUnavailableReason,
  type FundingSourceOption
} from '@/core/wallet/funding-source'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { ZEC_DECIMALS } from '@/config/wallet'
import type { FundingSource, KeySource } from '@/types'
import { getAssetDomainRaw, type ShieldProvider } from '@/popup/services/asset-domains'
import {
  ZcashTransferReview,
  ZcashTransferRoute,
  ZcashTransferSyncStatus
} from '@/popup/components/zcash/ZcashTransferDetails'
import { ShieldFundsBanner } from '@/popup/components/zcash/ShieldFundsBanner'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import { ShieldTokenPicker } from '@/popup/components/tokens/ShieldTokenPicker'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import {
  ConfidentialSendForm,
  type ShieldWithdrawEntry,
  type ShieldWithdrawSourcePickerState
} from '@/popup/components/transaction/ConfidentialSendForm'
import { OnchainTransactionResult } from './OnchainTransactionResult'
import {
  NetworkSendForm,
  type SendTransferSubmission
} from '@/popup/components/transaction/NetworkSendForm'
import { SendFormLayout, SendFormSlot } from '@/popup/components/transaction/SendFormLayout'
import { SendFormActions } from '@/popup/components/transaction/SendInputCards'
import { PAGE_IDS } from '@/lib/analytics'
import { openModal } from '@/popup/provider/ModalManager'
import { useShieldFunds } from '@/popup/hooks/useShieldFunds'
import { useZcashTransfer } from '@/popup/hooks/useZcashTransfer'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { getZcashChainId } from '@/core/chains/registry'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { offerSaveRecipient } from '@/popup/services/save-recipient-prompt'
import {
  buildSendAssetSelectionModel,
  resolveSendAssetSelection,
  sortSendNetworks,
  type SendAsset
} from '@/popup/services/send-asset-order'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import { isPortfolioModelForScope } from '@/popup/services/portfolio-cache'
import { parsePublicPrivateEvmSendDraft } from '@/popup/services/evm-send-validation'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import {
  getCrossChainSendAssetGroup,
  getCrossChainSendDestinationCandidates,
  getCrossChainSendDestinationAssetId,
  type CrossChainSendDraft
} from '@/popup/services/cross-chain-send-assets'
import { CrossChainSendAdapter } from '../swap/Swap'
import { SwapSettingsButton } from '@/popup/components/swap/SwapSettings'
import {
  hydrateEvmSendDestinationCatalogs,
  readEvmSendDestinationSupport
} from '@/popup/services/evm-send-catalog'
import { getEnabledSwapChains } from '@/popup/services/swap-catalog-loading'
import {
  getZcashTokenPickerChain,
  type ShieldTokenPickerItem
} from '@/popup/services/shield-transfer'
import { homeActivityPath } from '@/popup/services/home-navigation'
import {
  resolveEvmFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'

type SendSubmission =
  | Readonly<{ family: 'evm'; value: EvmTransferSubmission }>
  | SendTransferSubmission

interface SendSourcePicker {
  mode: 'shield' | 'zcash-public'
  initial?: boolean
}

interface SendDomainSession {
  key: string
  routeKey: string
  source: 'main' | 'shield'
  publicVisited: boolean
  publicRecipient: string
  publicAmount: string
  shieldEntry: ShieldWithdrawEntry | null
  shieldProvider: ShieldProvider
  zcashVisited: boolean
  publicZcash: boolean
  zcashInitialFundingSource: FundingSource
}

const crossChainCapabilities = Object.freeze({
  evm: resolveEvmFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled,
  solana: resolveSolanaFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled
})

function availableUsdPrice(
  asset: PortfolioReadModel['assets'][number],
  prices: AssetPriceReadModel | null
): string | null {
  return findAssetPrice(prices, asset.asset.id)?.priceUsd ?? null
}

function AssetSelection({
  accountScope,
  assets,
  zcashSources,
  zcashEnabled,
  zcashNetwork,
  zecPrice,
  prices,
  loadingAdditional,
  additionalError,
  onSelectZcash,
  onSelect,
  onRetry
}: {
  accountScope: Readonly<{ walletId: string; accountId: string }> | null
  assets: readonly SendAsset[]
  zcashSources: readonly FundingSourceOption[]
  zcashEnabled: boolean
  zcashNetwork: 'mainnet' | 'testnet'
  zecPrice: number
  prices: AssetPriceReadModel | null
  loadingAdditional: boolean
  additionalError: boolean
  onSelectZcash: (source: FundingSource) => void
  onSelect: (asset: SendAsset) => void
  onRetry: (chainId?: string) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [selectedNetwork, setSelectedNetwork] = useState('all')
  const filterKey = `${selectedNetwork}:${deferredQuery}`
  const runtimeNetwork = useWalletStore(state => state.currentNetwork)
  const { networkOptions, orderedRows } = useMemo(
    () =>
      buildSendAssetSelectionModel({
        assets,
        zcashSources,
        zcashEnabled,
        zcashNetwork,
        zecPrice,
        prices,
        selectedNetwork,
        searchQuery: deferredQuery,
        enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
      }),
    [
      assets,
      prices,
      deferredQuery,
      selectedNetwork,
      zcashSources,
      zcashEnabled,
      zcashNetwork,
      zecPrice
    ]
  )
  if (!networkOptions.some(option => !option.disabled) && (loadingAdditional || additionalError)) {
    return (
      <div className="flex h-full min-h-0 flex-col pt-2">
        {loadingAdditional ? (
          <ListSkeleton label="Loading tokens" className="py-2" />
        ) : (
          <TransactionNotice
            message="Unable to load tokens."
            onRetry={() => void onRetry()}
            className="mt-2 px-3 py-2.5"
          />
        )}
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col pt-2">
      <TokenPicker
        networks={networkOptions.map(option => ({
          id: option.id,
          label: option.label,
          iconChain: option.iconAlias,
          disabledReason: option.disabled ? 'Coming soon' : undefined
        }))}
        filter={{
          search: query,
          onSearchChange: setQuery,
          selectedNetwork,
          onNetworkChange: chainId => {
            setSelectedNetwork(chainId)
            if (
              chainId.startsWith('eip155:') &&
              assets.some(
                entry =>
                  entry.chain.chain.id === chainId &&
                  getAssetDomainRaw(entry.asset, 'public') === null
              )
            )
              onRetry(chainId)
          },
          queryKey: filterKey
        }}
        discovery={
          accountScope
            ? {
                scopeKey: `${runtimeNetwork}:${accountScope.walletId}:${accountScope.accountId}`,
                chainId: selectedNetwork.startsWith('eip155:') ? selectedNetwork : null,
                onAdded: async () => {
                  await onRetry()
                  return 'Added to wallet'
                }
              }
            : undefined
        }
        rows={orderedRows}
        toItem={(row): TokenSelectionItem => {
          if (row.kind === 'zcash') {
            const networkName = zcashNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'
            return {
              key: row.key,
              symbol: 'ZEC',
              symbolSuffix: <ZcashFundingBadge source={row.source} />,
              ariaLabel: `Send ${row.source === 'shielded' ? 'Shield' : 'Transparent'} ZEC on ${networkName}`,
              subtitle: networkName,
              icon: (
                <TokenIcon
                  symbol="ZEC"
                  nativeChain="zcash"
                  blockchain="zec"
                  size={32}
                  className="shrink-0"
                />
              ),
              balance: (
                <TokenBalanceDisplay amount={row.amount} symbol="ZEC" priceUsd={row.priceUsd} />
              )
            }
          }
          const { entry } = row
          const { asset, metadata, source } = entry.asset
          const customToken = asset.kind === 'token' && source === 'user-added'
          const networkName = entry.chain.chain.displayName
          return {
            key: row.key,
            symbol: metadata.symbol,
            symbolSuffix: customToken ? (
              <span className="shrink-0 rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-muted">
                Custom
              </span>
            ) : undefined,
            ariaLabel: `Send ${metadata.symbol}${customToken ? ' custom Token' : ''} on ${networkName}`,
            subtitle: `${networkName}${customToken ? ` · ${formatSortAddress(asset.reference)}` : ''}`,
            icon: (
              <TokenIcon
                assetId={asset.id}
                symbol={metadata.symbol}
                icon={metadata.iconUrl}
                blockchain={resolveChainIconAlias(
                  entry.chain.chain.family,
                  networkName,
                  entry.chain.chain.id
                )}
                size={32}
                className="shrink-0"
              />
            ),
            balance: (
              <TokenBalanceDisplay
                amount={row.amount}
                symbol={metadata.symbol}
                priceUsd={row.priceUsd}
              />
            )
          }
        }}
        onSelect={row => {
          if (row.kind === 'zcash') onSelectZcash(row.source)
          else onSelect(row.entry)
        }}
        emptyMessage={loadingAdditional ? 'Loading tokens' : 'No assets found'}
        afterRows={
          <>
            {loadingAdditional && (
              <div
                role="status"
                aria-label="Loading additional networks"
                className="flex animate-pulse items-center gap-3 py-3"
              >
                <div className="size-10 rounded-full bg-card" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-16 rounded bg-card" />
                  <div className="h-2.5 w-28 rounded bg-card/70" />
                </div>
              </div>
            )}
            {additionalError && (
              <TransactionNotice
                message="Additional networks are unavailable."
                onRetry={onRetry}
                className="mt-2 px-3 py-2.5"
              />
            )}
          </>
        }
      />
    </div>
  )
}

export function Send({ multiChainEnabled }: { readonly multiChainEnabled: boolean }) {
  return (
    <SendFormLayout>
      {multiChainEnabled ? <SendAssetFlow /> : <ZcashSendForm standalone />}
    </SendFormLayout>
  )
}

function ZcashSendForm({
  standalone = false,
  active = true,
  onSelectAsset,
  destinationNetworks = [],
  onSelectDestinationNetwork,
  ...options
}: Omit<NonNullable<Parameters<typeof useZcashTransfer>[0]>, 'shieldReceive'> & {
  readonly standalone?: boolean
  readonly onSelectAsset?: (fundingSource: FundingSource) => void
  readonly destinationNetworks?: readonly ChainSelectorOption[]
  readonly onSelectDestinationNetwork?: (chainId: string) => void | Promise<void>
}) {
  const transfer = useZcashTransfer({ ...options, active })
  const { funding, recipient, memoField, route, action } = transfer
  const { isShielding, handleShieldFunds, shieldSheet } = useShieldFunds(PAGE_IDS.SEND)
  const [destinationPickerOpen, setDestinationPickerOpen] = useState(false)
  const canSelectDestination =
    funding.source === 'transparent' && destinationNetworks.length > 1 && onSelectDestinationNetwork
  const recipientError = (recipient.znsInput && recipient.zns.error) || recipient.formatError
  const memoError = !transfer.privacy?.checked && memoField.invalid
  const showAmountError = !recipientError && Boolean(transfer.amountError)
  const showMemoError = !recipientError && !showAmountError && memoError
  const showRouteNotices = !recipientError && !showAmountError && !memoError
  const balanceOrSyncNotice = showRouteNotices
    ? (transfer.balanceError ??
      (!route.maximumError && !route.error && !transfer.sync.progress ? transfer.sync.error : null))
    : null
  if (!active) return null

  const selectRecipient = async () => {
    await openModal<string>({
      title: 'Select Recipient',
      showCloseButton: true,
      scroll: 'body',
      fixedHeight: true,
      body: (resolve, close) => (
        <RecipientSelector
          chainId={recipient.chainId}
          excludeAddresses={recipient.fromAddress ? [recipient.fromAddress] : []}
          onSelect={(address, name) => {
            recipient.setRecipient(address, name)
            close()
            resolve(address)
          }}
        />
      )
    })
  }

  return (
    <>
      {standalone && (
        <PageHeader
          title={
            transfer.available ? (
              <TransactionModeDropdown
                action="Send"
                value={funding.source === 'shielded' ? 'shield' : 'public'}
                options={(['public', 'shield'] as const).filter(domain =>
                  funding.options.some(
                    option =>
                      !option.disabledReason &&
                      option.type === (domain === 'public' ? 'transparent' : 'shielded')
                  )
                )}
                onChange={domain =>
                  funding.onSelect(domain === 'shield' ? 'shielded' : 'transparent')
                }
                disabled={funding.disabled}
              />
            ) : (
              'Send'
            )
          }
          showBack
          onBack={transfer.available ? transfer.leaveSend : undefined}
          rightContent={<SwapSettingsButton disabled={funding.disabled} />}
        />
      )}
      {transfer.available ? (
        <SendFormSlot
          adapter={{
            recipient: {
              id: 'zcash-send-recipient',
              value: recipient.address,
              onChange: recipient.setRecipient,
              placeholder: 'Recipient address',
              invalid: Boolean(recipientError),
              onSelectRecipient: selectRecipient,
              network: {
                name: transfer.networkName,
                icon: 'zcash',
                onSelect: canSelectDestination ? () => setDestinationPickerOpen(true) : undefined,
                disabled: funding.disabled
              },
              notice: recipientError && (
                <TransactionNotice
                  id="zcash-send-recipient-error"
                  message={recipientError}
                  onRetry={
                    recipient.znsInput && recipient.zns.retryable ? recipient.zns.retry : undefined
                  }
                  retrying={recipient.zns.loading}
                />
              ),
              feedback: (
                <>
                  {recipient.zns.loading && (
                    <p className="text-muted text-xs mt-1.5 px-1 flex items-center gap-1.5">
                      <Icon
                        icon="lucide:loader-2"
                        width={12}
                        height={12}
                        className="animate-spin"
                      />
                      Resolving name...
                    </p>
                  )}
                  {recipient.zns.address && (
                    <p className="text-primary text-xs mt-1.5 px-1 flex items-center gap-1.5">
                      <Icon icon="lucide:check-circle" width={12} height={12} />
                      {formatSortAddress(recipient.zns.address)}
                    </p>
                  )}
                </>
              )
            },
            amount: {
              testId: 'zcash-amount-card',
              ariaLabel: 'ZEC amount',
              ...transfer.amountField,
              describedBy: showAmountError ? 'zcash-amount-card-error' : undefined
            },
            asset: {
              symbol: 'ZEC',
              networkName: transfer.networkName,
              nativeChain: 'zcash',
              blockchain: 'zec',
              onSelectAsset: onSelectAsset ? () => onSelectAsset(funding.source) : undefined
            },
            balance: { value: transfer.balance },
            maximum: transfer.maximum
          }}
          footer={
            <>
              <ZcashTransferSyncStatus sync={transfer.sync} />
              <SendFormActions {...action} privacy={transfer.privacy} />
            </>
          }
        >
          <div className="flex flex-col gap-4">
            {!transfer.privacy?.checked && (
              <div className="order-4">
                <div className="mb-1.5 flex items-center justify-between px-1">
                  <label htmlFor="zcash-send-memo" className="text-xs text-muted">
                    Memo (optional)
                  </label>
                  {memoField.invalid && (
                    <button
                      type="button"
                      onClick={() => memoField.onChange('')}
                      className="text-xs text-primary"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <textarea
                  id="zcash-send-memo"
                  value={memoField.value}
                  disabled={!memoField.supported}
                  aria-invalid={memoField.invalid || undefined}
                  aria-describedby={showMemoError ? 'zcash-send-memo-error' : undefined}
                  onChange={event => memoField.onChange(event.target.value)}
                  placeholder="Add a private memo"
                  rows={2}
                  className="w-full resize-none rounded-xl border border-border/60 bg-card/50 px-4 py-3 text-sm placeholder:text-muted/50 focus:border-primary/50 focus:outline-none disabled:opacity-40"
                />
                {memoField.value && (
                  <p className="mt-1 px-1 text-right text-xs text-muted">
                    {memoField.byteLength}/512 bytes
                  </p>
                )}
              </div>
            )}
            {funding.migrationBalance !== null && (
              <div className="order-4">
                <ShieldFundsBanner
                  transparentBalance={funding.migrationBalance}
                  action="send"
                  isShielding={isShielding}
                  onShield={handleShieldFunds}
                />
              </div>
            )}
            <ZcashTransferRoute
              route={route}
              showNotice={showRouteNotices && !transfer.balanceError}
            />
            {showAmountError ? (
              <TransactionNotice
                id="zcash-amount-card-error"
                className="order-6"
                tone="warning"
                message={transfer.amountError}
              />
            ) : showMemoError ? (
              <TransactionNotice
                id="zcash-send-memo-error"
                className="order-6"
                tone="warning"
                message="This recipient cannot receive a memo."
              />
            ) : balanceOrSyncNotice ? (
              <TransactionNotice className="order-6" {...balanceOrSyncNotice} />
            ) : null}
          </div>
        </SendFormSlot>
      ) : (
        <div className="flex-1 flex items-center justify-center px-5">
          <p className="text-muted text-center">No account available</p>
        </div>
      )}
      {transfer.available && <ZcashTransferReview transfer={transfer} />}
      {transfer.available && canSelectDestination && (
        <ChainSelector
          open={destinationPickerOpen}
          onOpenChange={setDestinationPickerOpen}
          options={destinationNetworks}
          selectedId={recipient.chainId}
          onSelect={onSelectDestinationNetwork}
        />
      )}
      {shieldSheet}
    </>
  )
}

function SendAssetFlow() {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const requestedAssetId = searchParams.get('assetId')
  const requestedSourceMode = searchParams.get('sourceMode') ?? searchParams.get('mode')
  const requestedNetworkId = searchParams.get('networkId')
  const { goBack, navigate, replace } = useNavigate()
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const zecPrice = useWalletStore(state => state.zecPrice)
  const chainEndpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const zcashBalance = useAccountDataStore(state => state.getCurrentBalance())
  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const currentAccount = useWalletStore(state => state.getCurrentAccount())
  const appliedRequestedAssetRef = useRef<string | null>(null)
  const [assetPriceSnapshot, setAssetPriceSnapshot] = useState<{
    scopeKey: string
    value: AssetPriceReadModel | null
  } | null>(null)
  const [selectionSnapshot, setSelectionSnapshot] = useState<{
    scopeKey: string
    entryKey: string
    requestedAssetId: string | null
    value: SendAsset | null
  } | null>(null)
  const [submission, setSubmission] = useState<SendSubmission | null>(null)
  const [crossChainSession, setCrossChainSession] = useState<{
    key: string
    draft: CrossChainSendDraft & { walletId: string; accountId: string }
  } | null>(null)
  const [returnedDraft, setReturnedDraft] = useState<{
    key: string
    draft: CrossChainSendDraft
    revision: number
  } | null>(null)
  const [destinationCacheAttempt, requestDestinationCache] = useState(0)
  const [, refreshDestinationSupport] = useState(0)
  const [assetPickerState, setAssetPickerState] = useState<{
    key: string
    open: boolean
    resumeCrossChain?: CrossChainSendDraft
    draft?: {
      recipient: string
      amount: string
      destinationAssetId: string | null
      destinationChainId: string
    }
  } | null>(null)
  const [sourcePickerState, setSourcePickerState] = useState<{
    key: string
    value: SendSourcePicker | null
  } | null>(null)
  const [nearSourceOptions, setNearSourceOptions] = useState<{
    key: string
    value: ShieldWithdrawSourcePickerState
  } | null>(null)
  const [zcashFundingSelection, setZcashFundingSelection] = useState<{
    key: string
    source: FundingSource
    revision: number
    resetDraft: boolean
  } | null>(null)
  const [publicModeRequest, requestPublicMode] = useState(0)
  const [shieldModeRequest, requestShieldMode] = useState(0)
  const {
    activeAccount: storageV2Account,
    catalog: accountCatalog,
    loading: accountCatalogLoading,
    error: accountCatalogError,
    refresh: refreshAccountCatalog,
    contextChanging
  } = useActiveAccountNetworks()
  const zcashKeySource: KeySource | undefined = storageV2Account
    ? storageV2Account.walletSource.kind === 'hardware'
      ? isZcashHardwareKeySource(storageV2Account.walletSource.hardware.vendor)
        ? storageV2Account.walletSource.hardware.vendor
        : undefined
      : storageV2Account.walletSource.kind
    : currentWallet?.keySource
  const zcashSources = useMemo(
    () => getFundingSourceOptions(zcashBalance, currentAccount?.addresses ?? {}, zcashKeySource),
    [zcashBalance, currentAccount?.addresses, zcashKeySource]
  )
  const defaultZcashFundingSource: FundingSource =
    zcashSources.find(source => source.type === 'transparent' && !source.disabledReason)?.type ??
    zcashSources.find(source => !source.disabledReason)?.type ??
    (getFundingSourceUnavailableReason(zcashKeySource, 'transparent') ? 'shielded' : 'transparent')
  const zcashEnabled =
    !contextChanging &&
    (storageV2Account?.networks.some(network => network.chain.family === 'zcash') ??
      Boolean(currentAccount?.addresses.transparent || currentAccount?.addresses.shielded))
  const confidentialEnabled =
    getPrivateTransferChainIds(storageV2Account, currentNetwork === 'mainnet').length > 0
  const effectiveAccount = contextChanging
    ? null
    : resolveEffectiveActiveAccountIdentity({
        currentWalletId,
        currentAccountId,
        nativeAccount: storageV2Account
      })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const {
    model,
    status: loadStatus,
    refresh,
    readLatest
  } = usePortfolioSnapshot(effectiveWalletId, effectiveAccountId)
  const accountLoading =
    !storageV2Account && !accountCatalogError && (accountCatalogLoading || contextChanging)
  const entryScope = location.state as {
    walletId?: unknown
    accountId?: unknown
  } | null
  const entryScopeValid =
    (!searchParams.get('sourceWalletId') ||
      searchParams.get('sourceWalletId') === effectiveWalletId) &&
    (!searchParams.get('sourceAccountId') ||
      searchParams.get('sourceAccountId') === effectiveAccountId) &&
    (typeof entryScope?.walletId !== 'string' || entryScope.walletId === effectiveWalletId) &&
    (typeof entryScope?.accountId !== 'string' || entryScope.accountId === effectiveAccountId)
  const requestedRecipient = entryScopeValid ? searchParams.get('recipient') : null
  const requestedAmount = entryScopeValid ? (searchParams.get('amount') ?? '') : ''
  const requestedOriginPath = searchParams.get('originPath')
  const originPath =
    requestedOriginPath?.startsWith('/') &&
    !requestedOriginPath.startsWith('//') &&
    !requestedOriginPath.includes('\\') &&
    !requestedOriginPath.startsWith('/send') &&
    !requestedOriginPath.startsWith('/transaction-result') &&
    entryScopeValid
      ? requestedOriginPath
      : null
  const sendOriginHistory = (
    location.state as {
      sendOriginHistory?: {
        originPath?: unknown
        network?: unknown
        walletId?: unknown
        accountId?: unknown
        entryKey?: unknown
      }
    } | null
  )?.sendOriginHistory
  const canReturnToOriginHistory = Boolean(
    originPath &&
    sendOriginHistory?.originPath === originPath &&
    sendOriginHistory.network === currentNetwork &&
    sendOriginHistory.walletId === effectiveWalletId &&
    sendOriginHistory.accountId === effectiveAccountId &&
    typeof sendOriginHistory.entryKey === 'string' &&
    sendOriginHistory.entryKey.length > 0
  )
  const scopeKey = JSON.stringify([
    effectiveWalletId,
    effectiveAccountId,
    currentNetwork,
    chainEndpointRuntimeKey
  ])
  const sendEntryKey = `${location.key}:${scopeKey}`
  const activeCrossChainSend = crossChainSession?.key === sendEntryKey ? crossChainSession : null
  const navigationSnapshot = location.state as {
    initialPortfolio?: PortfolioReadModel | null
    initialPrices?: AssetPriceReadModel | null
    walletId?: string | null
    accountId?: string | null
    network?: string
    endpointRuntimeKey?: string
    preparedSendSelection?: { scopeKey: string; value: SendAsset }
  } | null
  const currentAssetPicker = assetPickerState?.key === sendEntryKey ? assetPickerState : null
  const assetPickerOpen = currentAssetPicker?.open ?? false
  const setAssetPickerOpen = (open: boolean) => setAssetPickerState({ key: sendEntryKey, open })
  useEffect(() => {
    setNearSourceOptions(null)
    setZcashFundingSelection(null)
  }, [sendEntryKey])
  const [domainSession, setDomainSession] = useState<SendDomainSession | null>(null)
  const requestedZcashProvider =
    entryScopeValid && zcashEnabled && searchParams.get('provider') === 'zcash-shield'
  const requestedNearProvider = searchParams.get('provider') === 'near-confidential'
  const initialZcashSource = searchParams.get('from')
  const transparentZcashRequested = requestedZcashProvider && initialZcashSource === 'transparent'
  const initialPublicZcash =
    transparentZcashRequested && !getFundingSourceUnavailableReason(zcashKeySource, 'transparent')
  const shieldedZcashAvailable =
    zcashEnabled &&
    zcashSources.some(source => source.type === 'shielded' && !source.disabledReason)
  const initialSource =
    domainSession?.routeKey === location.key
      ? domainSession.source
      : transparentZcashRequested
        ? 'main'
        : requestedZcashProvider || requestedSourceMode === 'shield'
          ? 'shield'
          : 'main'
  const initialShieldProvider: ShieldProvider = requestedZcashProvider
    ? 'zcash-shield'
    : requestedNearProvider || confidentialEnabled || accountLoading || contextChanging
      ? 'near-confidential'
      : 'zcash-shield'
  const currentSession: SendDomainSession =
    domainSession?.key === sendEntryKey
      ? domainSession
      : {
          key: sendEntryKey,
          routeKey: location.key,
          source: initialSource,
          publicVisited: initialSource !== 'shield',
          publicRecipient: requestedRecipient ?? '',
          publicAmount: requestedAmount,
          shieldProvider: initialShieldProvider,
          zcashVisited:
            initialPublicZcash ||
            (initialSource === 'shield' &&
              initialShieldProvider === 'zcash-shield' &&
              shieldedZcashAvailable),
          publicZcash: initialPublicZcash,
          zcashInitialFundingSource:
            initialZcashSource === 'transparent' &&
            !getFundingSourceUnavailableReason(zcashKeySource, 'transparent')
              ? 'transparent'
              : (initialZcashSource === 'shielded' ||
                    (initialSource === 'shield' && initialShieldProvider === 'zcash-shield')) &&
                  !getFundingSourceUnavailableReason(zcashKeySource, 'shielded')
                ? 'shielded'
                : defaultZcashFundingSource,
          shieldEntry:
            initialSource === 'shield'
              ? {
                  assetId:
                    initialShieldProvider === 'zcash-shield' ? ZEC_ZCASH_ASSET : requestedAssetId,
                  networkId: requestedNetworkId,
                  recipient: requestedRecipient ?? '',
                  amount: requestedAmount,
                  provider: 'near-confidential'
                }
              : null
        }
  const shieldActive = currentSession.source === 'shield'
  const initialShieldPicker =
    shieldActive &&
    requestedSourceMode === 'shield' &&
    !requestedAssetId &&
    !searchParams.has('provider')
  const sourcePicker: SendSourcePicker | null =
    sourcePickerState?.key === sendEntryKey
      ? sourcePickerState.value
      : initialShieldPicker
        ? { mode: 'shield', initial: true }
        : null
  const setSourcePicker = (value: SendSourcePicker | null) =>
    setSourcePickerState({ key: sendEntryKey, value })
  const zcashActive =
    ((shieldActive && currentSession.shieldProvider === 'zcash-shield') ||
      (!shieldActive && currentSession.publicZcash)) &&
    !sourcePicker
  const nearActive =
    shieldActive && currentSession.shieldProvider === 'near-confidential' && !sourcePicker
  const selectZcash = (source: FundingSource) => {
    if (!zcashEnabled || getFundingSourceUnavailableReason(zcashKeySource, source)) return
    setAssetPickerOpen(false)
    setZcashFundingSelection(previous => ({
      key: sendEntryKey,
      source,
      revision: (previous?.revision ?? 0) + 1,
      resetDraft: source === 'transparent' && !shieldActive && !currentSession.publicZcash
    }))
    setDomainSession({
      ...currentSession,
      source: source === 'shielded' ? 'shield' : 'main',
      shieldProvider: 'zcash-shield',
      zcashVisited: true,
      publicVisited: currentSession.publicVisited || source === 'transparent',
      publicZcash: currentSession.publicZcash || source === 'transparent',
      zcashInitialFundingSource: currentSession.zcashVisited
        ? currentSession.zcashInitialFundingSource
        : source,
      shieldEntry: currentSession.shieldEntry ?? {
        assetId: ZEC_ZCASH_ASSET,
        networkId: null,
        recipient: '',
        provider: 'near-confidential'
      }
    })
  }
  const openSourcePicker = (mode: 'shield' | 'zcash-public') => {
    if (mode === 'shield' && !currentSession.shieldEntry) {
      setDomainSession({
        ...currentSession,
        shieldEntry: {
          assetId: ZEC_ZCASH_ASSET,
          networkId: null,
          recipient: '',
          provider: 'near-confidential'
        }
      })
    }
    setSourcePicker({ mode })
  }
  const [{ reviewing: shieldReviewing, busy: shieldBusy }, setShieldState] = useState({
    reviewing: false,
    busy: false
  })
  const handleShieldStateChange = useCallback(
    (next: { readonly reviewing: boolean; readonly busy: boolean }) => {
      setShieldState(previous =>
        previous.reviewing === next.reviewing && previous.busy === next.busy ? previous : next
      )
    },
    []
  )
  const [{ reviewing: zcashReviewing, busy: zcashBusy }, setZcashState] = useState({
    reviewing: false,
    busy: false
  })
  const handleZcashStateChange = useCallback(
    (next: { readonly reviewing: boolean; readonly busy: boolean }) => {
      setZcashState(previous =>
        previous.reviewing === next.reviewing && previous.busy === next.busy ? previous : next
      )
    },
    []
  )
  const handleNearSourceOptions = useCallback(
    (value: ShieldWithdrawSourcePickerState) => {
      setNearSourceOptions({ key: sendEntryKey, value })
    },
    [sendEntryKey]
  )
  const setSelection = (value: SendAsset | null) =>
    setSelectionSnapshot({ scopeKey, entryKey: location.key, requestedAssetId, value })
  const returnToEntry = originPath
    ? canReturnToOriginHistory
      ? goBack
      : () => navigate(originPath, { replace: true })
    : !entryScopeValid
      ? () => navigate(shieldActive ? '/?domain=shield' : '/', { replace: true })
      : goBack
  const initialPortfolio =
    navigationSnapshot?.walletId === effectiveWalletId &&
    navigationSnapshot?.accountId === effectiveAccountId &&
    navigationSnapshot?.network === currentNetwork &&
    navigationSnapshot?.endpointRuntimeKey === chainEndpointRuntimeKey &&
    isPortfolioModelForScope(
      navigationSnapshot?.initialPortfolio ?? null,
      effectiveWalletId,
      effectiveAccountId
    )
      ? navigationSnapshot.initialPortfolio
      : null
  const visibleModel = model
  const loadingSendAssets = accountLoading || loadStatus === 'loading'
  const sendAssetsError =
    !loadingSendAssets && !visibleModel && (loadStatus === 'error' || !effectiveAccount)
  const initialPrices =
    initialPortfolio && navigationSnapshot?.initialPrices?.status !== 'error'
      ? (navigationSnapshot?.initialPrices ?? null)
      : null
  const cachedPrices = assetPriceSnapshot?.scopeKey === scopeKey ? assetPriceSnapshot.value : null
  const assetPrices =
    cachedPrices &&
    (!initialPrices ||
      (cachedPrices.fetchedAt >= initialPrices.fetchedAt &&
        cachedPrices.quotes.length >= initialPrices.quotes.length))
      ? cachedPrices
      : initialPrices
  const availableShieldProviders: ShieldProvider[] = [
    ...(confidentialEnabled ? (['near-confidential'] as const) : []),
    ...(shieldedZcashAvailable ? (['zcash-shield'] as const) : [])
  ]

  const load = useCallback(
    async (forceRefresh = false, refreshChainId?: string) => {
      await refresh(forceRefresh, refreshChainId ? { chainIds: [refreshChainId] } : {})
    },
    [refresh]
  )
  const retrySendAssets = async (chainId?: string) => {
    if (!storageV2Account && (!effectiveAccount || accountCatalogError)) {
      await refreshAccountCatalog()
    }
    await load(true, chainId)
  }

  useEffect(() => {
    setSelectionSnapshot(null)
    setSubmission(null)
    setAssetPickerState(null)
  }, [effectiveWalletId, effectiveAccountId, chainEndpointRuntimeKey])

  useEffect(() => {
    let cancelled = false
    void assetPriceClient
      .getPrices('read')
      .then(prices => {
        if (!cancelled && prices && prices.status !== 'error' && prices.quotes.length > 0)
          setAssetPriceSnapshot({ scopeKey, value: prices })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [scopeKey])

  const assets = useMemo<readonly SendAsset[]>(() => {
    if (!visibleModel) return []
    const chainById = new Map(visibleModel.chains.map(chain => [chain.chain.id, chain]))
    return visibleModel.assets.flatMap(asset => {
      const chain = chainById.get(asset.asset.chainId)
      return chain &&
        isSelectableChainFamily(chain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__) &&
        (chain.chain.family === 'evm' ||
          chain.chain.family === 'bitcoin' ||
          chain.chain.family === 'solana' ||
          chain.chain.family === 'near') &&
        chain.chain.capabilities.transaction.status === 'available'
        ? [{ asset, chain }]
        : []
    })
  }, [visibleModel])
  const selectedSnapshot =
    selectionSnapshot?.scopeKey === scopeKey &&
    selectionSnapshot.entryKey === location.key &&
    selectionSnapshot.requestedAssetId === requestedAssetId
      ? selectionSnapshot
      : null
  const selectedAssetId = selectedSnapshot
    ? (selectedSnapshot.value?.asset.asset.id ?? null)
    : requestedAssetId
  const preparedSelection =
    !selectedSnapshot &&
    entryScopeValid &&
    navigationSnapshot?.preparedSendSelection?.scopeKey === scopeKey &&
    navigationSnapshot.preparedSendSelection.value.asset.asset.id === requestedAssetId
      ? navigationSnapshot.preparedSendSelection.value
      : null
  const selection = resolveSendAssetSelection(
    assets,
    selectedAssetId,
    selectedSnapshot ? selectedSnapshot.value : preparedSelection
  )
  const zcashNetworkOption =
    zcashEnabled &&
    isSelectableChainFamily('zcash', __ENABLED_CHAIN_FEATURE_FLAGS__) &&
    zcashSources.some(source => source.type === 'transparent' && !source.disabledReason)
      ? {
          chainId: getZcashChainId(currentNetwork),
          name: currentNetwork === 'mainnet' ? 'Zcash' : 'Zcash Testnet',
          icon: 'zcash',
          switchesAsset: true
        }
      : null
  const publicZcashDestinations =
    currentSession.publicZcash && zcashNetworkOption
      ? (storageV2Account?.networks ?? []).filter(
          ({ chain }) =>
            (chain.family === 'evm' || chain.family === 'solana') &&
            isSelectableChainFamily(chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__) &&
            chain.capabilities.transaction.status === 'available'
        )
      : []
  const currentReturnedDraft =
    returnedDraft?.key === sendEntryKey &&
    returnedDraft.draft.sourceAssetId === selection?.asset.asset.id
      ? returnedDraft
      : null
  const returnDraft = currentReturnedDraft?.draft
  const onchainFormKey = `${sendEntryKey}:${selection?.asset.asset.id}:${currentReturnedDraft?.revision ?? 0}`
  const supportsCrossChainDestination = Boolean(
    selection &&
    (selection.chain.chain.family === 'evm' ||
      (selection.chain.chain.family === 'solana' &&
        crossChainCapabilities.solana &&
        getCrossChainSendAssetGroup(selection.asset.asset) === MARKET_ASSETS.usdc))
  )
  const destinationCandidates = useMemo(
    () =>
      selection && supportsCrossChainDestination && currentNetwork === 'mainnet' && storageV2Account
        ? getCrossChainSendDestinationCandidates({
            sourceChainId: selection.chain.chain.id,
            chains: storageV2Account.networks,
            enabledChainIds: storageV2Account?.networks.map(network => network.chain.id) ?? [],
            capabilities: crossChainCapabilities,
            enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
          })
        : [],
    [currentNetwork, selection, storageV2Account, supportsCrossChainDestination]
  )
  useEffect(() => {
    if (
      !selection ||
      !supportsCrossChainDestination ||
      currentNetwork !== 'mainnet' ||
      shieldActive ||
      assetPickerOpen
    )
      return
    let cancelled = false
    void hydrateEvmSendDestinationCatalogs({
      sourceChain: selection.chain.chain,
      destinationChains: destinationCandidates.map(item => item.chain.chain)
    }).then(() => {
      if (!cancelled) refreshDestinationSupport(revision => revision + 1)
    })
    return () => {
      cancelled = true
    }
  }, [
    selection,
    supportsCrossChainDestination,
    destinationCandidates,
    sendEntryKey,
    currentNetwork,
    shieldActive,
    assetPickerOpen,
    destinationCacheAttempt
  ])
  const destinationNetworks = selection
    ? sortSendNetworks(
        [
          ...[selection.chain.chain, ...destinationCandidates.map(item => item.chain.chain)].map(
            chain => ({
              chainId: chain.id,
              name: chain.displayName,
              icon: resolveChainIconAlias(chain.family, chain.displayName, chain.id),
              switchesAsset: false
            })
          ),
          ...(zcashNetworkOption &&
          (selection.chain.chain.family === 'evm' || selection.chain.chain.family === 'solana')
            ? [zcashNetworkOption]
            : [])
        ],
        option => ({ id: option.chainId, name: option.name })
      )
    : []
  const selectDestinationNetwork = (
    destinationChainId: string,
    draft: Readonly<{ recipient: string; amount: string }>
  ) => {
    if (!selection || !effectiveWalletId || !effectiveAccountId) return
    if (destinationChainId === zcashNetworkOption?.chainId) {
      openPublicZcash()
      return
    }
    if (!destinationCandidates.some(item => item.chain.chain.id === destinationChainId)) return
    const sourceAssetId = selection.asset.asset.id
    const availability = readEvmSendDestinationSupport({
      sourceAssetId,
      destinationChainId,
      capabilities: crossChainCapabilities
    })
    if (availability.status === 'unavailable') return
    startCrossChainSend({
      ...draft,
      sourceAssetId,
      destinationChainId,
      destinationAssetId: availability.destinationAssetId ?? null
    })
  }

  const startCrossChainSend = (draft: CrossChainSendDraft) => {
    if (currentNetwork !== 'mainnet' || !effectiveWalletId || !effectiveAccountId) return
    setAssetPickerOpen(false)
    setCrossChainSession({
      key: sendEntryKey,
      draft: { ...draft, walletId: effectiveWalletId, accountId: effectiveAccountId }
    })
  }

  const applyReturnedDraft = (draft: CrossChainSendDraft) => {
    setReturnedDraft(previous => ({
      key: sendEntryKey,
      draft,
      revision: (previous?.revision ?? 0) + 1
    }))
  }

  const openPublicZcash = () => {
    if (!zcashNetworkOption) return
    setCrossChainSession(null)
    setSelection(null)
    selectZcash('transparent')
  }

  const selectAssetFromPublicZcash = (asset: SendAsset) => {
    const assetId = asset.asset.asset.id
    switchSource('main', assetId, '', undefined, '', asset)
    applyReturnedDraft({
      sourceAssetId: assetId,
      destinationAssetId: assetId,
      destinationChainId: asset.chain.chain.id,
      recipient: '',
      amount: ''
    })
  }

  const selectNetworkFromPublicZcash = async (chainId: string) => {
    if (!publicZcashDestinations.some(item => item.chain.id === chainId)) return
    const isNativeAsset = (entry: SendAsset['asset']) =>
      entry.asset.chainId === chainId && entry.asset.kind === 'native'
    const cached = assets.find(({ asset }) => isNativeAsset(asset))
    if (cached) {
      selectAssetFromPublicZcash(cached)
      return
    }
    await refresh(false, { chainIds: [chainId], additionalChainIds: [chainId] })
    const latest = await readLatest()
    if (!isPortfolioModelForScope(latest, effectiveWalletId, effectiveAccountId)) return
    const chain = latest?.chains.find(item => item.chain.id === chainId)
    const asset = chain?.assets.find(isNativeAsset)
    if (!asset || !chain) throw new Error('Unable to load the asset for this network.')
    selectAssetFromPublicZcash({ asset, chain })
  }

  const selectReturnedSource = (
    asset: SendAsset | null,
    zcashSource: FundingSource = defaultZcashFundingSource
  ) => {
    const draft = currentAssetPicker?.draft
    if (!draft || !effectiveWalletId || !effectiveAccountId) {
      if (asset) {
        setSelection(asset)
        setAssetPickerOpen(false)
      } else {
        selectZcash(zcashSource)
      }
      return
    }

    const sourceAssetId = asset?.asset.asset.id ?? ZEC_ZCASH_ASSET
    const requestedDestinationChainId = draft.destinationChainId
    const destinationSupport =
      asset && requestedDestinationChainId
        ? readEvmSendDestinationSupport({
            sourceAssetId,
            destinationChainId: requestedDestinationChainId,
            capabilities: crossChainCapabilities
          })
        : null
    const destinationChainId =
      destinationSupport?.status === 'unavailable'
        ? asset?.chain.chain.id
        : requestedDestinationChainId
    const destinationChain = storageV2Account?.networks.find(
      network => network.chain.id === destinationChainId
    )
    const group = asset ? getCrossChainSendAssetGroup(asset.asset.asset) : null
    const matchingDestinationAssetId =
      destinationChainId === requestedDestinationChainId &&
      destinationSupport?.status === 'available'
        ? destinationSupport.destinationAssetId
        : destinationChainId && group
          ? getCrossChainSendDestinationAssetId(destinationChainId, group)
          : null
    const destinationDescriptor = destinationChain
      ? getEnabledSwapChains([destinationChain.chain])[0]
      : null
    const enabledDescriptor = (descriptor: typeof destinationDescriptor) =>
      descriptor &&
      ((descriptor.walletFamily === 'evm' && crossChainCapabilities.evm) ||
        (descriptor.walletFamily === 'solana' && crossChainCapabilities.solana))
    const validDestinationChain =
      currentNetwork === 'mainnet' &&
      asset &&
      destinationChainId &&
      storageV2Account?.networks.some(network => network.chain.id === asset.chain.chain.id) &&
      storageV2Account?.networks.some(network => network.chain.id === destinationChainId) &&
      destinationChain &&
      isSelectableChainFamily(destinationChain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__) &&
      destinationChain?.chain.capabilities.transaction.status === 'available' &&
      enabledDescriptor(destinationDescriptor)
        ? destinationChain
        : null
    const previousDestination = storageV2Account?.networks.find(
      network => network.chain.id === requestedDestinationChainId
    )
    const recipient =
      requestedDestinationChainId !== destinationChainId &&
      previousDestination?.chain.family !== destinationChain?.chain.family
        ? ''
        : (draft.recipient ?? requestedRecipient ?? '')
    const amount = draft?.amount ?? requestedAmount
    if (!asset) {
      selectZcash(zcashSource)
      return
    }
    setSelection(asset)
    setDomainSession({ ...currentSession, source: 'main', publicVisited: true, publicZcash: false })
    if (validDestinationChain && asset.chain.chain.id !== destinationChainId) {
      startCrossChainSend({
        sourceAssetId,
        destinationChainId: validDestinationChain.chain.id,
        destinationAssetId: matchingDestinationAssetId,
        recipient,
        amount
      })
      return
    }
    setAssetPickerOpen(false)
    applyReturnedDraft({
      sourceAssetId,
      destinationAssetId: sourceAssetId,
      destinationChainId: asset.chain.chain.id,
      recipient: previousDestination?.chain.family === asset.chain.chain.family ? recipient : '',
      amount
    })
  }

  useEffect(() => {
    if (selection?.chain.chain.family !== 'evm' || requestedSourceMode !== 'private') return
    replace(
      `/transfer?${new URLSearchParams({
        assetId: selection.asset.asset.id,
        from: 'private',
        to: 'shield',
        mode: 'private',
        intent: 'withdraw'
      })}`
    )
  }, [replace, requestedSourceMode, selection])

  const leaveOnchainResult = useCallback(
    (activityPath: string | null, submitted: boolean) => {
      const graph = submission?.value.graph
      const recipient = graph?.root.intent?.recipient
      const sender = graph?.root.intent?.sender
      const chain = selection?.chain.chain
      const retryPath = selection
        ? `/send?${new URLSearchParams({ assetId: selection.asset.asset.id, sourceMode: 'main' })}`
        : '/send'
      setSubmission(null)
      if (!activityPath && canReturnToOriginHistory) goBack()
      else navigate(activityPath ?? originPath ?? (submitted ? '/' : retryPath), { replace: true })
      if (
        !submitted ||
        !recipient ||
        !chain ||
        (chain.family !== 'evm' && chain.family !== 'bitcoin') ||
        (chain.network.kind !== 'mainnet' && chain.network.kind !== 'testnet')
      ) {
        return
      }
      void offerSaveRecipient({
        chainId: chain.id,
        chainFamily: chain.family,
        network: chain.network.kind,
        networkName: chain.displayName,
        address: recipient.address,
        name: 'Recipient',
        selfTransfer:
          graph?.root.intent?.direction === 'self' ||
          (sender?.address.toLowerCase() === recipient.address.toLowerCase() &&
            sender.chainId === recipient.chainId)
      })
    },
    [canReturnToOriginHistory, goBack, navigate, originPath, selection, submission]
  )

  useEffect(() => {
    if (
      shieldActive ||
      !selectedAssetId ||
      !visibleModel ||
      appliedRequestedAssetRef.current === `${sendEntryKey}:${selectedAssetId}`
    ) {
      return
    }
    const requested = visibleModel.assets.find(asset => asset.asset.id === selectedAssetId)
    if (!requested) {
      if (loadStatus !== 'loading')
        appliedRequestedAssetRef.current = `${sendEntryKey}:${selectedAssetId}`
      return
    }
    const chain = visibleModel.chains.find(item => item.chain.id === requested.asset.chainId)
    appliedRequestedAssetRef.current = `${sendEntryKey}:${selectedAssetId}`
    if (chain?.chain.family === 'zcash') {
      selectZcash(currentSession.zcashInitialFundingSource)
      return
    }
  }, [loadStatus, visibleModel, selectedAssetId, shieldActive, sendEntryKey])

  const nearPicker = nearSourceOptions?.key === sendEntryKey ? nearSourceOptions.value : null
  const shieldPickerRows = useMemo((): readonly ShieldTokenPickerItem[] => {
    if (sourcePicker?.mode !== 'shield') return []
    const zec = zcashEnabled
      ? zcashSources.find(source => source.type === 'shielded' && !source.disabledReason)
      : undefined
    return [
      ...(zec
        ? [
            {
              ...getZcashTokenPickerChain(currentNetwork),
              key: 'zcash:shielded',
              assetId: ZEC_ZCASH_ASSET,
              symbol: 'ZEC',
              nativeIconChain: 'zcash',
              zcashFundingSource: 'shielded' as const,
              decimals: ZEC_DECIMALS,
              displayBalance: zec.available,
              priceUsd: zecPrice
            }
          ]
        : []),
      ...(confidentialEnabled ? (nearPicker?.items ?? []) : [])
    ]
  }, [
    sourcePicker?.mode,
    zcashEnabled,
    zcashSources,
    currentNetwork,
    zecPrice,
    confidentialEnabled,
    nearPicker?.items
  ])

  if (submission && selection && submission.family === selection.chain.chain.family) {
    return (
      <OnchainTransactionResult
        key={submission.value.graph.root.id}
        family={submission.family}
        asset={selection.asset}
        chain={selection.chain}
        submission={submission.value}
        onDone={outcome => leaveOnchainResult(null, outcome !== 'failed')}
        onViewActivity={transactionId =>
          leaveOnchainResult(homeActivityPath('public', transactionId), true)
        }
      />
    )
  }

  const walletMode = 'public'
  const publicPrivateDraft =
    selection && !currentReturnedDraft && effectiveWalletId && effectiveAccountId
      ? parsePublicPrivateEvmSendDraft(searchParams, {
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          network: currentNetwork,
          assetId: selection.asset.asset.id
        })
      : null
  const preparingRequestedAsset = Boolean(
    !assetPickerOpen && requestedAssetId && !selection && loadingSendAssets
  )
  const showPublicAssetPicker =
    !shieldActive &&
    !sourcePicker &&
    (assetPickerOpen || (!selection && !currentSession.publicZcash && !preparingRequestedAsset))
  const dismissAssetPicker = () => {
    if (currentAssetPicker?.resumeCrossChain) {
      startCrossChainSend(currentAssetPicker.resumeCrossChain)
    } else if (selection || currentSession.publicZcash) {
      setAssetPickerOpen(false)
    } else {
      returnToEntry()
    }
  }
  const dismissSourcePicker = () => {
    if (sourcePicker?.initial) returnToEntry()
    else setSourcePicker(null)
  }
  const switchSource = (
    sourceMode: 'main' | 'shield',
    assetId: string | null,
    recipient: string,
    networkId?: string,
    amount = '',
    selectedAsset?: SendAsset
  ) => {
    setAssetPickerOpen(false)
    if (selectedAsset) setSelection(selectedAsset)
    else if (sourceMode === 'main' && assetId)
      setSelection(assets.find(item => item.asset.asset.id === assetId) ?? null)
    setDomainSession({
      ...currentSession,
      source: sourceMode,
      publicVisited: currentSession.publicVisited || sourceMode === 'main',
      publicZcash:
        sourceMode === 'main' && assetId && assetId !== ZEC_ZCASH_ASSET
          ? false
          : currentSession.publicZcash,
      shieldProvider:
        sourceMode === 'shield' && currentSession.source === 'main'
          ? (availableShieldProviders[0] ?? currentSession.shieldProvider)
          : currentSession.shieldProvider,
      publicRecipient:
        sourceMode === 'main' && !currentSession.publicVisited
          ? recipient
          : currentSession.publicRecipient,
      publicAmount:
        sourceMode === 'main' && !currentSession.publicVisited
          ? amount
          : currentSession.publicAmount,
      shieldEntry:
        currentSession.shieldEntry ??
        (sourceMode === 'shield'
          ? {
              assetId,
              recipient,
              amount,
              networkId: networkId ?? null,
              provider: 'near-confidential'
            }
          : null)
    })
  }
  const switchMode = (mode: 'public' | 'private' | 'shield') => {
    if (mode === 'private' || (mode === 'shield') === shieldActive) return
    if (mode === 'shield') {
      if ((zcashActive || !confidentialEnabled) && shieldedZcashAvailable) {
        selectZcash('shielded')
      } else if (selection?.chain.chain.family === 'evm' && !currentSession.publicZcash) {
        requestShieldMode(value => value + 1)
      } else {
        switchSource('shield', selection?.asset.asset.id ?? null, '', undefined, '')
      }
    } else if (
      zcashActive &&
      zcashSources.some(source => source.type === 'transparent' && !source.disabledReason)
    ) {
      selectZcash('transparent')
    } else if (nearActive) {
      requestPublicMode(value => value + 1)
    } else if (zcashActive) {
      setDomainSession({
        ...currentSession,
        source: 'main',
        publicVisited: true,
        publicZcash: false
      })
    } else {
      switchSource('main', null, '', undefined, '')
    }
  }
  if (activeCrossChainSend) {
    return (
      <CrossChainSendAdapter
        draft={activeCrossChainSend.draft}
        originPath={originPath}
        localDestination={
          zcashNetworkOption
            ? {
                option: { ...zcashNetworkOption, id: zcashNetworkOption.chainId },
                onSelect: openPublicZcash
              }
            : undefined
        }
        onBack={returnToEntry}
        onReturn={(draft, action) => {
          setCrossChainSession(null)
          applyReturnedDraft(draft)
          if (action === 'asset') {
            setAssetPickerState({ key: sendEntryKey, open: true, draft, resumeCrossChain: draft })
          } else if (action === 'shield') {
            const asset = assets.find(item => item.asset.asset.id === draft.sourceAssetId)
            switchSource(
              'shield',
              draft.sourceAssetId,
              draft.recipient,
              draft.destinationChainId,
              draft.amount,
              asset
            )
          }
        }}
      />
    )
  }
  return (
    <>
      {!(nearActive && shieldReviewing) && !(zcashActive && zcashReviewing) && (
        <PageHeader
          title={
            <TransactionModeDropdown
              action="Send"
              value={shieldActive ? 'shield' : 'public'}
              options={availableShieldProviders.length > 0 ? ['public', 'shield'] : ['public']}
              onChange={switchMode}
              disabled={shieldBusy || shieldReviewing || zcashBusy || zcashReviewing}
            />
          }
          showBack
          backDisabled={shieldBusy || zcashBusy}
          rightContent={<SwapSettingsButton disabled={shieldBusy || zcashBusy} />}
          onBack={returnToEntry}
        />
      )}
      {sourcePicker && (
        <TokenSelectorDialog open onOpenChange={open => !open && dismissSourcePicker()}>
          {sourcePicker.mode === 'zcash-public' && (
            <AssetSelection
              key={`${sendEntryKey}:${sourcePicker.mode}:zcash`}
              accountScope={effectiveAccount}
              assets={assets}
              zcashSources={zcashSources.filter(source => source.type === 'transparent')}
              zcashEnabled={zcashEnabled}
              zcashNetwork={currentNetwork}
              zecPrice={zecPrice}
              prices={assetPrices}
              loadingAdditional={loadingSendAssets}
              additionalError={sendAssetsError}
              onSelectZcash={source => {
                selectZcash(source)
                setSourcePicker(null)
              }}
              onSelect={asset => {
                selectAssetFromPublicZcash(asset)
                setSourcePicker(null)
              }}
              onRetry={retrySendAssets}
            />
          )}
          {sourcePicker.mode === 'shield' && (
            <div className="flex h-full min-h-0 flex-col pt-2">
              <ShieldTokenPicker
                key={sendEntryKey}
                rows={shieldPickerRows}
                policy="funded"
                balancesHidden={nearPicker?.balancesHidden ?? false}
                selectedKey={
                  currentSession.shieldProvider === 'zcash-shield'
                    ? 'zcash:shielded'
                    : nearPicker?.selectedAssetId
                }
                onSelect={item => {
                  if (item.zcashFundingSource) selectZcash(item.zcashFundingSource)
                  else {
                    nearPicker?.onSelect(item.assetId)
                    setDomainSession({
                      ...currentSession,
                      source: 'shield',
                      shieldProvider: 'near-confidential'
                    })
                  }
                  setSourcePicker(null)
                }}
                emptyMessage={loadingSendAssets ? 'Loading tokens' : 'No tokens found'}
              />
            </div>
          )}
        </TokenSelectorDialog>
      )}
      {currentSession.shieldEntry && (
        <div
          hidden={!nearActive}
          className={nearActive ? 'flex min-h-0 flex-1 flex-col' : undefined}
        >
          <ConfidentialSendForm
            key={sendEntryKey}
            active={nearActive}
            entry={currentSession.shieldEntry}
            model={visibleModel ?? null}
            initialAsset={
              assets.find(item => item.asset.asset.id === currentSession.shieldEntry?.assetId)
                ?.asset ?? null
            }
            onStateChange={handleShieldStateChange}
            publicModeRequest={publicModeRequest}
            onSelectPublic={(assetId, recipient, amount, destinationAssetId) => {
              if (
                assetId &&
                destinationAssetId &&
                assetId !== destinationAssetId &&
                effectiveWalletId &&
                effectiveAccountId
              ) {
                switchSource('main', assetId, recipient, undefined, amount)
                startCrossChainSend({
                  sourceAssetId: assetId,
                  destinationAssetId,
                  destinationChainId: destinationAssetId.split('/')[0],
                  recipient,
                  amount
                })
              } else switchSource('main', assetId, recipient, undefined, amount)
            }}
            onOpenSourcePicker={() => openSourcePicker('shield')}
            onSourcePickerState={handleNearSourceOptions}
            sourceSelectorActive={sourcePicker?.mode === 'shield' && confidentialEnabled}
          />
        </div>
      )}
      {currentSession.zcashVisited && (
        <ZcashSendForm
          key={sendEntryKey}
          active={zcashActive}
          initialFundingSource={currentSession.zcashInitialFundingSource}
          fundingSourceSelection={
            zcashFundingSelection?.key === sendEntryKey ? zcashFundingSelection : null
          }
          onStateChange={handleZcashStateChange}
          destinationNetworks={
            !shieldActive && zcashNetworkOption
              ? [
                  { ...zcashNetworkOption, id: zcashNetworkOption.chainId },
                  ...publicZcashDestinations.map(({ chain }) => ({
                    id: chain.id,
                    name: chain.displayName,
                    icon: resolveChainIconAlias(chain.family, chain.displayName, chain.id)
                  }))
                ]
              : []
          }
          onSelectDestinationNetwork={selectNetworkFromPublicZcash}
          onSelectAsset={fundingSource =>
            openSourcePicker(fundingSource === 'shielded' ? 'shield' : 'zcash-public')
          }
        />
      )}
      {shieldActive &&
        !sourcePicker &&
        !accountLoading &&
        !contextChanging &&
        currentSession.shieldProvider === 'zcash-shield' &&
        !currentSession.zcashVisited && (
          <div className="page-content px-4 pt-4">
            <TransactionNotice
              message={
                requestedZcashProvider
                  ? 'Shielded ZEC is unavailable for this account.'
                  : 'Shield is unavailable for this account.'
              }
            />
          </div>
        )}
      {currentSession.publicVisited && selection && !currentSession.publicZcash && (
        <div className={shieldActive || assetPickerOpen ? 'hidden' : 'contents'}>
          {selection.chain.chain.family === 'evm' && visibleModel ? (
            requestedSourceMode === 'private' ? null : storageV2Account ? (
              <NetworkSendForm
                family="evm"
                key={onchainFormKey}
                active={!shieldActive && !assetPickerOpen}
                walletMode={walletMode}
                catalogAccount={storageV2Account}
                catalog={accountCatalog}
                onSelectAsset={draft =>
                  setAssetPickerState({
                    key: sendEntryKey,
                    open: true,
                    draft: {
                      ...draft,
                      destinationAssetId: selection.asset.asset.id,
                      destinationChainId: selection.chain.chain.id
                    }
                  })
                }
                onSelectShield={(recipient, amount) =>
                  switchSource(
                    'shield',
                    selection.asset.asset.id,
                    recipient,
                    selection.chain.chain.id,
                    amount
                  )
                }
                shieldModeRequest={shieldModeRequest}
                onOpenDestinationNetworks={() => requestDestinationCache(attempt => attempt + 1)}
                destinationNetworks={destinationNetworks}
                onSelectDestinationNetwork={selectDestinationNetwork}
                selection={selection}
                portfolio={visibleModel}
                priceUsd={availableUsdPrice(selection.asset, assetPrices)}
                sourceMode="main"
                onFundPrivate={
                  currentNetwork === 'mainnet'
                    ? () =>
                        navigate(
                          `/transfer?${new URLSearchParams({
                            assetId: selection.asset.asset.id,
                            from: 'public',
                            to: 'private',
                            intent: 'deposit',
                            mode: walletMode
                          })}`
                        )
                    : undefined
                }
                initialRecipient={
                  returnDraft?.recipient ??
                  (/^0x[0-9a-fA-F]{40}$/.test(currentSession.publicRecipient)
                    ? currentSession.publicRecipient
                    : undefined)
                }
                initialAmount={returnDraft?.amount ?? currentSession.publicAmount}
                initialDraft={publicPrivateDraft ?? undefined}
                onSubmitted={value => setSubmission({ family: 'evm', value })}
              />
            ) : (
              <div className="px-4 py-6">
                {accountCatalogLoading ? (
                  <p role="status" className="text-sm text-muted">
                    Loading account…
                  </p>
                ) : (
                  <TransactionNotice
                    message="Unable to load account."
                    onRetry={() => void refreshAccountCatalog()}
                  />
                )}
              </div>
            )
          ) : selection?.chain.chain.family === 'bitcoin' ||
            selection?.chain.chain.family === 'solana' ||
            selection?.chain.chain.family === 'near' ? (
            <NetworkSendForm
              key={onchainFormKey}
              family={selection.chain.chain.family}
              active={!shieldActive && !assetPickerOpen}
              selection={selection}
              initialRecipient={returnDraft?.recipient}
              initialAmount={returnDraft?.amount}
              destinationNetworks={destinationNetworks.map(
                ({ chainId, switchesAsset, ...option }) => {
                  if (switchesAsset) return { ...option, id: chainId }
                  const support = readEvmSendDestinationSupport({
                    sourceAssetId: selection.asset.asset.id,
                    destinationChainId: chainId,
                    capabilities: crossChainCapabilities
                  })
                  return {
                    ...option,
                    id: chainId,
                    disabled:
                      chainId !== selection.chain.chain.id && support.status === 'unavailable',
                    note: chainId === selection.chain.chain.id ? undefined : support.disabledReason
                  }
                }
              )}
              onSelectDestinationNetwork={selectDestinationNetwork}
              onSubmitted={setSubmission}
            />
          ) : null}
        </div>
      )}
      {showPublicAssetPicker && (
        <TokenSelectorDialog open onOpenChange={open => !open && dismissAssetPicker()}>
          <AssetSelection
            key={sendEntryKey}
            accountScope={effectiveAccount}
            assets={assets}
            zcashSources={zcashSources.filter(source => source.type === 'transparent')}
            zcashEnabled={zcashEnabled}
            zcashNetwork={currentNetwork}
            zecPrice={zecPrice}
            prices={assetPrices}
            loadingAdditional={loadingSendAssets}
            additionalError={sendAssetsError}
            onSelectZcash={source => selectReturnedSource(null, source)}
            onRetry={retrySendAssets}
            onSelect={asset => selectReturnedSource(asset)}
          />
        </TokenSelectorDialog>
      )}
      {!shieldActive && preparingRequestedAsset && (
        <div className="page-content !px-4 pt-4">
          <ListSkeleton label="Loading asset" />
        </div>
      )}
    </>
  )
}
