import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { ActivityItem } from '@/core/activity'
import type { SwapToken } from '@/core/services/intents-api'
import { formatFiatAmount } from '@/lib/number-format'
import type { AssetPriceReadModel } from '@/core/prices'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import Big from '@/lib/big'
import { confidentialFundingClient } from '@/popup/services/confidential-funding-client'
import { useSettingsStore } from '@/store/settings-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { useNavigate } from '@/popup/provider/Router'
import { WalletActionIcon } from '@/popup/components/common/WalletActionIcon'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import {
  availableDepositTokens,
  depositSourceNetworks
} from '@/popup/services/shield-deposit-options'
import { summarizeNearConfidentialHoldings } from '@/popup/services/near-confidential-holdings'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { buildShieldProviderGroups, type ShieldProvider } from '@/popup/services/asset-domains'
import { NearConfidentialHoldingRow } from '@/popup/components/portfolio/NearConfidentialHoldingRow'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { PortfolioChainAssetRow } from '@/popup/components/portfolio/PortfolioAssetGroupCard'
import { ShieldProviderLogo, SHIELD_PROVIDERS } from '@/popup/components/portfolio/shield-providers'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { MultichainActivityPanel } from '@/popup/components/transaction/MultichainActivityPanel'
import { MultichainActivityDetail } from '@/popup/components/transaction/MultichainActivityDetail'
import { openModal } from '@/popup/provider/ModalManager'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/popup/components/ui/tabs'
import { Button } from '@/popup/components/ui/button'
import { withShieldAsset } from '@/popup/services/shield-action-selection'
import {
  resolveShieldZcashVaultEntry,
  shieldZcashEnablePath
} from '@/popup/services/shield-zcash-entry'
import { getDefaultZcashSelfMoveSource } from '@/popup/services/zcash-self-move'

export function ShieldProviderDetail() {
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  return <ShieldProviderContent key={`${currentNetwork}:${currentWalletId}:${currentAccountId}`} />
}

function ShieldProviderContent() {
  const location = useLocation()
  const sendOriginPath = `${location.pathname}${location.search}`
  const [searchParams] = useSearchParams()
  const requestedProvider = searchParams.get('provider')
  const requestedAssetId = searchParams.get('assetId')
  const mode = searchParams.get('mode') === 'private' ? 'private' : 'public'
  const provider: ShieldProvider | null =
    requestedProvider === 'near-confidential' || requestedProvider === 'zcash-shield'
      ? requestedProvider
      : null
  const { goBack, navigate } = useNavigate()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const { activeAccount, loading: accountLoading } = useActiveAccountNetworks()
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const zcashSendScopeQuery = account
    ? `&sourceWalletId=${encodeURIComponent(account.walletId)}&sourceAccountId=${encodeURIComponent(account.accountId)}`
    : ''
  const scopeKey = `${currentNetwork}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`
  const latestScope = useRef(scopeKey)
  latestScope.current = scopeKey
  const mounted = useRef(false)
  const { model, status, readLatest } = useHomePortfolio(
    account?.walletId ?? null,
    account?.accountId ?? null
  )
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [prices, setPrices] = useState<AssetPriceReadModel | null>(null)
  const [pricesLoading, setPricesLoading] = useState(true)
  const [directoryTokens, setDirectoryTokens] = useState<readonly SwapToken[] | null>(null)
  const [detailTab, setDetailTab] = useState<'assets' | 'activity'>('assets')
  const appliedAssetSelection = useRef<string | null>(null)
  const currentWallet = useWalletStore(state =>
    currentWalletId ? state.getWallet(currentWalletId) : undefined
  )
  const walletAccount = useWalletStore(state =>
    currentWalletId && currentAccountId
      ? state.getAccount(currentWalletId, currentAccountId)
      : undefined
  )
  const zcashBalance = useAccountDataStore(state => state.getCurrentBalance())
  const zcashMoveSource = getDefaultZcashSelfMoveSource({
    addresses: walletAccount?.addresses,
    balance: zcashBalance,
    keySource: currentWallet?.keySource,
    network: currentNetwork
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setConnectionError(null)
    setConnecting(false)
  }, [account?.walletId, account?.accountId, currentNetwork])
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const hasZcashAccount =
    activeAccount?.networks.some(network => network.chain.family === 'zcash') ?? false

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const cached = await assetPriceClient.getPrices('read')
        if (active && cached) setPrices(cached)
      } catch {}
      try {
        const refreshed = await assetPriceClient.getPrices('refresh')
        if (active && refreshed) setPrices(refreshed)
      } catch {}
      if (active) setPricesLoading(false)
    }
    void load()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (provider !== 'near-confidential') return
    let active = true
    void swapTokenCatalogClient
      .readCached()
      .then(tokens => {
        if (active && tokens.length > 0) setDirectoryTokens(tokens)
      })
      .catch(() => {})
    void swapTokenCatalogClient
      .refresh()
      .then(tokens => {
        if (active) setDirectoryTokens(tokens)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [provider])

  const near = useMemo(() => summarizeNearConfidentialHoldings(model, prices), [model, prices])
  const managedAssets = useMemo(
    () => resolveManagedIntentsCatalog(directoryTokens ?? []),
    [directoryTokens]
  )
  const canManageNear =
    getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet').length > 0
  const zcashVaultEntry = resolveShieldZcashVaultEntry({
    network: currentNetwork,
    walletSource: activeAccount?.walletSource ?? null,
    hasPortfolioZcash: hasZcashAccount,
    enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
  })
  const providerAvailable =
    provider === 'zcash-shield'
      ? zcashVaultEntry.showVaultCard
      : provider === 'near-confidential' && (canManageNear || near.entries.length > 0)
  const group = useMemo(
    () =>
      model && provider === 'zcash-shield'
        ? buildShieldProviderGroups(model, prices).find(item => item.id === provider)
        : null,
    [model, prices, provider]
  )
  const openAssetDetail = useCallback(
    (assetId: string, replace = false) => {
      const query = new URLSearchParams({ assetId, domain: 'shield', mode })
      navigate(`/asset-detail?${query}`, { replace })
    },
    [mode, navigate]
  )
  useEffect(() => {
    if (provider !== 'near-confidential' || !requestedAssetId) return
    const selectionKey = `${scopeKey}:${requestedAssetId}`
    if (appliedAssetSelection.current === selectionKey) return
    const entry = near.entries.find(
      holding =>
        holding.asset.tokenId === requestedAssetId || holding.asset.assetId === requestedAssetId
    )
    if (!entry) return
    appliedAssetSelection.current = selectionKey
    openAssetDetail(entry.asset.assetId ?? entry.asset.tokenId, true)
  }, [near.entries, openAssetDetail, provider, requestedAssetId, scopeKey])
  const nearBalanceEmpty =
    provider === 'near-confidential' &&
    near.status === 'ready' &&
    near.entries.every(entry => Big(entry.asset.availableRaw).eq(0))
  const showNearEmptyState = nearBalanceEmpty && canManageNear && !connecting && !connectionError
  const networks = model?.chains.filter(chain => chain.chain.family === 'zcash') ?? []
  const supportedNetworks = useMemo(() => depositSourceNetworks(), [])
  const supportedTokens = directoryTokens
    ? availableDepositTokens(directoryTokens, supportedNetworks)
    : null
  const providerFiat = provider === 'near-confidential' ? near.fiat : group?.fiat
  const displayFiat = balancesHidden
    ? '••••'
    : providerFiat === null || providerFiat === undefined
      ? status === 'loading' || (provider === 'zcash-shield' && pricesLoading)
        ? '…'
        : '—'
      : formatFiatAmount(providerFiat, { showSign: true })
  const movePath = withShieldAsset(
    `/transfer?entry=shield&provider=near-confidential&mode=${mode}${requestedAssetId ? `&from=${mode}&to=shield` : ''}`,
    requestedAssetId
  )
  const refreshShieldBalances = async () => {
    if (!account || !canManageNear || connecting || !mounted.current) return
    setConnecting(true)
    setConnectionError(null)
    try {
      await confidentialFundingClient.refreshBalances(
        {
          network: currentNetwork,
          keyDomainId: account.walletId,
          accountId: account.accountId
        },
        true
      )
      const wallet = useWalletStore.getState()
      if (
        mounted.current &&
        latestScope.current === scopeKey &&
        wallet.currentWalletId === currentWalletId &&
        wallet.currentAccountId === currentAccountId &&
        wallet.currentNetwork === currentNetwork
      )
        await readLatest()
    } catch (error) {
      if (mounted.current && latestScope.current === scopeKey)
        setConnectionError(error instanceof Error ? error.message : 'Shield balance unavailable')
    } finally {
      if (mounted.current && latestScope.current === scopeKey) setConnecting(false)
    }
  }

  useEffect(() => {
    if (provider === 'near-confidential' && canManageNear) void refreshShieldBalances()
  }, [scopeKey, provider, canManageNear])

  const handleActivityClick = async (item: ActivityItem) => {
    await openModal({
      showCloseButton: true,
      className: 'max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain',
      body: (resolve: (value: unknown) => void, close: () => void) => (
        <MultichainActivityDetail
          item={item}
          network={currentNetwork}
          portfolio={model}
          accountNetworks={activeAccount?.networks}
          onClose={() => {
            close()
            resolve(undefined)
          }}
          onContinueSwap={transactionId =>
            navigate(`/swap?resumeApproval=${encodeURIComponent(transactionId)}`)
          }
        />
      )
    })
  }

  if (provider && !activeAccount && accountLoading) {
    return (
      <div
        className="page-container items-center justify-center"
        role="status"
        aria-label="Loading account"
      >
        <Icon icon="lucide:loader-circle" width={22} className="animate-spin text-muted" />
      </div>
    )
  }

  if (!provider || !activeAccount || !providerAvailable) {
    return (
      <div className="page-container items-center justify-center">
        <p className="text-sm text-muted">Shield account unavailable</p>
        <button
          type="button"
          onClick={() => navigate('/shield-funds', { replace: true })}
          className="wallet-interactive mt-4 rounded-sm text-sm text-primary hover:bg-primary/10 active:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          Back
        </button>
      </div>
    )
  }

  const info = SHIELD_PROVIDERS[provider]
  return (
    <div className="page-container relative overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto pb-5">
        <header
          className="relative px-4 pb-5 pt-[63px] text-center"
          style={{
            backgroundImage: `radial-gradient(ellipse 75% 120px at 50% 0%, ${info.tint}66, transparent)`
          }}
        >
          <button
            type="button"
            aria-label="Back"
            onClick={goBack}
            className="wallet-interactive absolute left-4 top-4 flex size-7 items-center justify-center rounded-md text-white hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
          >
            <Icon icon="lucide:chevron-left" width={22} height={22} />
          </button>
          <div className="flex justify-center">
            <ShieldProviderLogo provider={provider} size={49} />
          </div>
          <h1 className="mt-5 text-lg font-bold">{info.detailName}</h1>
          {provider === 'near-confidential' && (
            <p className="mx-auto mt-2 max-w-[343px] text-xs leading-4 text-wallet-secondary">
              Confidential Intents extend the NEAR Intents protocol with privacy-preserving swaps.
              Market makers can provide liquidity on a private chain where balances and swap details
              are shielded from public view.
            </p>
          )}
          {provider === 'near-confidential' ? (
            <div className="mt-5 grid grid-cols-2 gap-3 text-center">
              <div className="min-w-0">
                <div className="flex h-5 items-center justify-center gap-1.5">
                  {supportedNetworks.some(network => network.family === 'evm') && (
                    <ChainIcon chain="evm" width={17} height={17} />
                  )}
                  {supportedNetworks
                    .filter(network => network.family !== 'evm')
                    .slice(0, 4)
                    .map(network => (
                      <ChainIcon
                        key={network.id}
                        chain={resolveChainIconAlias(network.family, network.displayName)}
                        width={17}
                        height={17}
                        className="shrink-0 rounded-full border border-background"
                      />
                    ))}
                </div>
                <p className="mt-1 text-sm text-wallet-secondary">
                  {supportedNetworks.length} Supported networks
                </p>
              </div>
              <div className="min-w-0">
                <div className="flex h-5 items-center justify-center -space-x-1">
                  {supportedTokens?.slice(0, 5).map(token => (
                    <TokenIcon
                      key={token.assetId}
                      token={token}
                      showChainBadge={false}
                      size={17}
                      className="shrink-0 rounded-full border border-background"
                    />
                  ))}
                </div>
                <p className="mt-1 text-sm text-wallet-secondary">
                  {supportedTokens?.length ?? '—'} Supported tokens
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex min-h-5 items-center justify-between gap-3 text-left">
              <span className="shrink-0 text-xs text-wallet-secondary">Supported networks</span>
              <span className="flex min-w-0 flex-wrap justify-end gap-1.5">
                {networks.map(chain => (
                  <ChainIcon
                    key={chain.chain.id}
                    chain={resolveChainIconAlias(
                      chain.chain.family,
                      chain.chain.displayName,
                      chain.chain.id
                    )}
                    width={16}
                    height={16}
                    className="shrink-0"
                  />
                ))}
              </span>
            </div>
          )}
          <div
            className={`mt-5 grid gap-3 ${provider === 'near-confidential' ? 'grid-cols-4' : 'grid-cols-3'}`}
          >
            {provider === 'near-confidential' && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      withShieldAsset(
                        '/shield-withdraw?provider=near-confidential',
                        requestedAssetId
                      )
                    )
                  }
                  disabled={!canManageNear}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="send" size={20} />
                  Send
                </button>
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      withShieldAsset(
                        '/shield-deposit?provider=near-confidential',
                        requestedAssetId
                      )
                    )
                  }
                  disabled={!canManageNear}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="receive" size={20} />
                  Receive
                </button>
                <button
                  type="button"
                  onClick={() => navigate(movePath)}
                  disabled={!canManageNear}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="move" size={20} />
                  Move
                </button>
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      withShieldAsset('/shield-swap?provider=near-confidential', requestedAssetId)
                    )
                  }
                  disabled={!canManageNear}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="swap" size={20} />
                  Swap
                </button>
              </>
            )}
            {provider === 'zcash-shield' && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/send/zcash?from=shielded&originPath=${encodeURIComponent(sendOriginPath)}${zcashSendScopeQuery}`,
                      {
                        state: account
                          ? {
                              sendOriginHistory: {
                                originPath: sendOriginPath,
                                network: currentNetwork,
                                walletId: account.walletId,
                                accountId: account.accountId,
                                entryKey: location.key
                              }
                            }
                          : undefined
                      }
                    )
                  }
                  disabled={!hasZcashAccount}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="send" size={20} />
                  Send
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/shield-deposit?provider=zcash-shield')}
                  disabled={!account || !hasZcashAccount}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="receive" size={20} />
                  Receive
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (zcashMoveSource)
                      navigate(
                        `/send/zcash?move=1&from=${zcashMoveSource}&originPath=${encodeURIComponent(sendOriginPath)}${zcashSendScopeQuery}`
                      )
                  }}
                  disabled={!hasZcashAccount || !zcashMoveSource}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="move" size={20} />
                  Move
                </button>
              </>
            )}
          </div>
        </header>

        <Tabs
          value={detailTab}
          onValueChange={value => {
            if (value === 'assets' || value === 'activity') setDetailTab(value)
          }}
          className="gap-0"
        >
          <TabsList
            aria-label="Shield funds"
            className="h-[50px] w-full rounded-none border-y border-white/[0.08] bg-transparent p-0 px-5"
          >
            {(['assets', 'activity'] as const).map(tab => (
              <TabsTrigger
                key={tab}
                value={tab}
                className="group h-full rounded-none border-0 bg-transparent p-0 text-base font-normal text-wallet-secondary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent"
              >
                <span className="relative flex h-full items-center after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 group-data-[state=active]:after:bg-foreground">
                  {tab === 'assets' ? 'Assets' : 'Activity'}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="assets" className="mt-0">
            <section aria-label={`${info.name} balance`}>
              <div className="py-5 text-center">
                <p className="break-all px-4 text-[26px] font-semibold leading-[37.4px]">
                  {displayFiat}
                </p>
                <div className="mt-0.5 flex items-center justify-center gap-1.5 text-sm text-[var(--color-wallet-secondary)]">
                  <span>
                    {provider === 'near-confidential' ? 'Total balance' : 'Shield balance'}
                  </span>
                  {provider === 'near-confidential' && near.status === 'ready' && canManageNear && (
                    <button
                      type="button"
                      title="Refresh Shield balance"
                      aria-label="Refresh Shield balance"
                      onClick={() => void refreshShieldBalances()}
                      disabled={connecting}
                      className="wallet-interactive rounded-md text-primary enabled:hover:bg-primary/10 enabled:active:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
                    >
                      <Icon
                        icon="lucide:refresh-cw"
                        width={14}
                        height={14}
                        className={connecting ? 'animate-spin' : undefined}
                      />
                    </button>
                  )}
                </div>
                {provider === 'near-confidential' &&
                  connectionError &&
                  canManageNear &&
                  !connecting && (
                    <button
                      type="button"
                      onClick={() => void refreshShieldBalances()}
                      disabled={connecting}
                      className="wallet-interactive mt-2 rounded-md text-sm font-medium text-primary enabled:hover:bg-primary/10 enabled:active:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
                    >
                      Retry
                    </button>
                  )}
                {connectionError && (
                  <p role="alert" className="px-4 pt-2 text-xs text-warning">
                    {connectionError}
                  </p>
                )}
              </div>
              {provider === 'near-confidential' && near.entries.length > 0 && !nearBalanceEmpty ? (
                <div className="py-1">
                  {near.entries.map(entry => {
                    const matchedAsset = managedAssets.find(
                      asset =>
                        asset.protocolAssetId === entry.asset.protocolAssetId &&
                        (!entry.asset.assetId || asset.assetId === entry.asset.assetId)
                    )
                    return (
                      <NearConfidentialHoldingRow
                        key={entry.asset.tokenId}
                        entry={entry}
                        iconChain={matchedAsset?.blockchain}
                        balancesHidden={balancesHidden}
                        showQuantitySymbol={false}
                        onClick={() =>
                          openAssetDetail(
                            entry.asset.assetId ?? matchedAsset?.assetId ?? entry.asset.tokenId
                          )
                        }
                      />
                    )
                  })}
                </div>
              ) : provider === 'zcash-shield' &&
                group?.entries.length &&
                group.entries.some(entry => BigInt(entry.asset.balance.totalRaw) > 0n) ? (
                <div className="divide-y divide-white/[0.08]">
                  {group.entries.map(entry => (
                    <PortfolioChainAssetRow
                      key={entry.asset.asset.id}
                      entry={entry}
                      domain="shield"
                      prices={prices}
                      pricesLoading={pricesLoading}
                      balancesHidden={balancesHidden}
                      onSelectAsset={assetId => openAssetDetail(assetId)}
                    />
                  ))}
                </div>
              ) : nearBalanceEmpty ||
                (provider === 'zcash-shield' && group?.fiat === '0') ? null : status ===
                  'loading' ||
                (provider === 'near-confidential' && connecting) ? (
                <p role="status" className="px-4 py-5 text-center text-sm text-muted">
                  Loading balances…
                </p>
              ) : (
                <p className="px-4 py-5 text-center text-sm text-muted">Balance unavailable</p>
              )}
              {showNearEmptyState && (
                <div className="flex flex-col items-center gap-2 px-4 pb-6 pt-7 text-sm text-muted">
                  <p>No shielded assets yet,</p>
                  <button
                    type="button"
                    onClick={() => navigate(movePath)}
                    disabled={!canManageNear}
                    className="wallet-interactive rounded-sm enabled:hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45"
                  >
                    <span className="font-semibold text-foreground underline underline-offset-2">
                      Move
                    </span>{' '}
                    now
                  </button>
                </div>
              )}
              {provider === 'zcash-shield' &&
                !hasZcashAccount &&
                zcashVaultEntry.canEnableZcash &&
                currentWalletId &&
                currentAccountId && (
                  <div className="px-4 pb-8 pt-6 text-center">
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-10 px-4"
                      onClick={() =>
                        navigate(shieldZcashEnablePath(currentWalletId, currentAccountId))
                      }
                    >
                      Enable Zcash
                    </Button>
                  </div>
                )}
            </section>
          </TabsContent>
          <TabsContent value="activity" className="mt-0 pt-4" aria-label="Shield activity">
            {account ? (
              <MultichainActivityPanel
                walletId={account.walletId}
                accountId={account.accountId}
                network={currentNetwork}
                portfolio={model}
                accountNetworks={activeAccount?.networks}
                filterDomain="shield"
                shieldProvider={provider}
                confidentialIntentsOnly={provider === 'near-confidential'}
                showToolbar={false}
                compact
                heading={undefined}
                hideWhenEmpty={false}
                onItemClick={item => void handleActivityClick(item)}
              />
            ) : (
              <p className="px-4 py-8 text-center text-sm text-muted">No activity yet.</p>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
