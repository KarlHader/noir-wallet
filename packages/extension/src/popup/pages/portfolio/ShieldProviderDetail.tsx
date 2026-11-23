import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { ActivityItem } from '@/core/activity'
import type { AssetPriceReadModel } from '@/core/prices'
import { useWalletStore } from '@/store/wallet-store'
import Big from '@/lib/big'
import { useSettingsStore } from '@/store/settings-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { useShieldBalances } from '@/popup/hooks/useShieldBalances'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { useNavigate } from '@/popup/provider/Router'
import { WalletActionIcon } from '@/popup/components/portfolio/WalletActionIcon'
import { WalletActionButton } from '@/popup/components/portfolio/WalletActionButton'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { useSwapTokenCatalog } from '@/popup/hooks/useSwapTokenCatalog'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import {
  availableDepositTokens,
  depositSourceNetworks
} from '@/popup/services/shield-deposit-options'
import {
  getConfidentialWalletDetailAssetId,
  summarizeNearConfidentialHoldings
} from '@/popup/services/near-confidential-holdings'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { buildShieldProviderGroups, type ShieldProvider } from '@/popup/services/asset-domains'
import { NearConfidentialHoldingRow } from '@/popup/components/portfolio/NearConfidentialHoldingRow'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { PortfolioChainAssetRow } from '@/popup/components/portfolio/PortfolioAssetGroupCard'
import {
  ShieldProviderSupport,
  ShieldProviderLogo,
  SHIELD_PROVIDERS
} from '@/popup/components/portfolio/shield-providers'
import { MultichainActivityPanel } from '@/popup/components/transaction/MultichainActivityPanel'
import { MultichainActivityDetail } from '@/popup/components/transaction/MultichainActivityDetail'
import { openModal } from '@/popup/provider/ModalManager'
import { Tabs, TabsContent } from '@/popup/components/ui/tabs'
import { PageTabsList, PageTabsTrigger } from '@/popup/components/common/PageTabs'
import { Button } from '@/popup/components/ui/button'
import { BalanceSkeleton } from '@/popup/components/ui/skeleton'
import { buildShieldActionPath, SHIELD_ACTIONS } from '@/popup/services/shield-action-selection'
import {
  resolveShieldZcashVaultEntry,
  shieldZcashEnablePath
} from '@/popup/services/shield-zcash-entry'
import { canSwapNativeShieldZec } from '@/popup/services/shield-swap-zec-sources'
import { getFundingSourceUnavailableReason } from '@/core/wallet/funding-source'
import { formatShieldProviderFiat } from '@/popup/services/shield-provider-presentation'

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
  const sendOriginState = account
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
  const scopeKey = `${currentNetwork}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`
  const { model, status } = useHomePortfolio(account?.walletId ?? null, account?.accountId ?? null)
  const [prices, setPrices] = useState<AssetPriceReadModel | null>(null)
  const [pricesLoading, setPricesLoading] = useState(true)
  const directoryTokens = useSwapTokenCatalog(provider === 'near-confidential')
  const [detailTab, setDetailTab] = useState<'assets' | 'activity'>('assets')
  const appliedAssetSelection = useRef<string | null>(null)
  const currentWallet = useWalletStore(state =>
    currentWalletId ? state.getWallet(currentWalletId) : undefined
  )

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

  const near = useMemo(() => summarizeNearConfidentialHoldings(model, prices), [model, prices])
  const managedAssets = useMemo(
    () => resolveManagedIntentsCatalog(directoryTokens ?? []),
    [directoryTokens]
  )
  const canManageNear =
    getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet').length > 0
  const {
    connecting,
    loading: loadingShieldBalances,
    error: connectionError,
    refreshBalances: refreshShieldBalances
  } = useShieldBalances({
    active: provider === 'near-confidential',
    enabled: canManageNear,
    scopeKey,
    scope: account
      ? { network: currentNetwork, keyDomainId: account.walletId, accountId: account.accountId }
      : null
  })
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
    const assetId = entry && getConfidentialWalletDetailAssetId(model, entry.asset)
    if (!assetId) return
    appliedAssetSelection.current = selectionKey
    openAssetDetail(assetId, true)
  }, [model, near.entries, openAssetDetail, provider, requestedAssetId, scopeKey])
  const nearBalanceEmpty =
    provider === 'near-confidential' &&
    near.status === 'ready' &&
    near.entries.every(entry => Big(entry.asset.availableRaw).eq(0))
  const showNearEmptyState = nearBalanceEmpty && !connecting && !connectionError
  const networks = model?.chains.filter(chain => chain.chain.family === 'zcash') ?? []
  const supportedNetworks = useMemo(() => depositSourceNetworks(), [])
  const supportedTokens = directoryTokens
    ? availableDepositTokens(directoryTokens, supportedNetworks)
    : null
  const providerFiat = provider === 'near-confidential' ? near.fiat : group?.fiat
  const providerLoading =
    provider === 'near-confidential'
      ? near.status !== 'ready' && (status === 'loading' || loadingShieldBalances)
      : status === 'loading' || pricesLoading
  const canSpendNativeZec =
    hasZcashAccount && !getFundingSourceUnavailableReason(currentWallet?.keySource, 'shielded')
  const canSwapNativeZec = canSwapNativeShieldZec({
    account: activeAccount,
    network: currentNetwork,
    enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__,
    keySource: currentWallet?.keySource
  })
  const handleActivityClick = async (item: ActivityItem) => {
    await openModal({
      showCloseButton: true,
      body: (resolve: (value: unknown) => void, close: () => void) => (
        <MultichainActivityDetail
          item={item}
          network={currentNetwork}
          portfolio={model}
          accountNetworks={activeAccount?.networks}
          perspective={{ viewedDomain: 'shield', shieldProvider: provider }}
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
          onClick={() => navigate('/?domain=shield&tab=providers', { replace: true })}
          className="wallet-interactive mt-4 rounded-sm text-sm text-primary hover:bg-primary/10 active:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          Back
        </button>
      </div>
    )
  }

  const info = SHIELD_PROVIDERS[provider]
  const openAction = (action: (typeof SHIELD_ACTIONS)[number]['action']) => {
    navigate(
      buildShieldActionPath(action, {
        provider,
        assetId: requestedAssetId,
        account,
        originPath: sendOriginPath
      }),
      { state: action === 'send' ? sendOriginState : undefined }
    )
  }
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
              {info.description}
            </p>
          )}
          {provider === 'near-confidential' ? (
            <div className="mt-5">
              <ShieldProviderSupport
                provider={provider}
                networks={supportedNetworks}
                tokens={supportedTokens}
              />
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
          <div className="mt-5 grid grid-cols-3 gap-2.5">
            {SHIELD_ACTIONS.map(({ action, label }) => (
              <WalletActionButton
                key={action}
                icon={<WalletActionIcon action={action} />}
                label={label}
                disabled={
                  !account ||
                  (provider === 'near-confidential'
                    ? !canManageNear
                    : action === 'send'
                      ? !canSpendNativeZec
                      : action === 'receive'
                        ? !hasZcashAccount
                        : !canSwapNativeZec)
                }
                onClick={() => openAction(action)}
              />
            ))}
          </div>
        </header>

        <Tabs
          value={detailTab}
          onValueChange={value => {
            if (value === 'assets' || value === 'activity') setDetailTab(value)
          }}
          className="gap-0"
        >
          <PageTabsList
            aria-label="Shield funds"
            className="h-[50px] w-full border-y border-white/[0.08] px-5"
          >
            {(['assets', 'activity'] as const).map(tab => (
              <PageTabsTrigger key={tab} value={tab}>
                {tab === 'assets' ? 'Assets' : 'Activity'}
              </PageTabsTrigger>
            ))}
          </PageTabsList>
          <TabsContent value="assets" className="mt-0">
            <section aria-label={`${info.name} balance`}>
              <div className="py-5 text-center">
                <div className="break-all px-4 text-[26px] font-semibold leading-[37.4px]">
                  {!balancesHidden && providerFiat == null && providerLoading ? (
                    <BalanceSkeleton className="h-7 w-28" />
                  ) : (
                    formatShieldProviderFiat(providerFiat, balancesHidden)
                  )}
                </div>
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
                    const assetId = getConfidentialWalletDetailAssetId(
                      model,
                      entry.asset,
                      matchedAsset?.assetId
                    )
                    return (
                      <NearConfidentialHoldingRow
                        key={entry.asset.tokenId}
                        entry={entry}
                        iconChain={matchedAsset?.blockchain}
                        balancesHidden={balancesHidden}
                        showQuantitySymbol={false}
                        onClick={assetId ? () => openAssetDetail(assetId) : undefined}
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
                providerLoading ||
                (provider === 'zcash-shield' && group?.fiat === '0') ? null : (
                <p className="px-4 py-5 text-center text-sm text-muted">Balance unavailable</p>
              )}
              {showNearEmptyState && (
                <p className="px-4 pb-6 pt-7 text-center text-sm text-muted">
                  No shielded assets yet.
                </p>
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
                showToolbar={false}
                showStatusFilter
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
