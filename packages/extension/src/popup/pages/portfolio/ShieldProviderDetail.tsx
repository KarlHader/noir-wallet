import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveEvmChainIconAlias } from '@/config/icons'
import {
  formatBaseUnitDecimalAmount,
  formatFiatAmount,
  formatTokenPrice,
  formatTokenQuantity
} from '@/lib/number-format'
import type { AssetPriceReadModel } from '@/core/prices'
import { findAssetPrice } from '@/core/prices'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import type { FundingSource } from '@/types/wallet'
import Big from '@/lib/big'
import { getAvailableZcashSelfMoveSources } from '@/popup/services/zcash-self-move'
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
  listShieldFundingAssets,
  shieldFundingSources,
  shieldPortfolioBalances
} from '@/popup/services/shield-transfer'
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
import { getPortfolioAssetUsdValue } from '@/popup/components/portfolio/portfolio-prices'
import {
  ShieldProviderLogo,
  SHIELD_PROVIDERS
} from '@/popup/components/portfolio/ShieldPortfolioView'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'

export function ShieldProviderDetail() {
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  return <ShieldProviderContent key={`${currentNetwork}:${currentWalletId}:${currentAccountId}`} />
}

function ShieldProviderContent() {
  const [searchParams] = useSearchParams()
  const requestedProvider = searchParams.get('provider')
  const provider: ShieldProvider | null =
    requestedProvider === 'near-confidential' || requestedProvider === 'zcash-shield'
      ? requestedProvider
      : null
  const { goBack, navigate } = useNavigate()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const zcashBalance = useAccountDataStore(state => state.getCurrentBalance())
  const zcashAccount = useWalletStore(state => state.getCurrentAccount())
  const zcashKeySource = useWalletStore(state => state.getCurrentWallet()?.keySource)
  const { activeAccount } = useActiveAccountNetworks()
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const scopeKey = `${currentNetwork}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`
  const latestScope = useRef(scopeKey)
  latestScope.current = scopeKey
  const mounted = useRef(false)
  const { model, status, refresh } = useHomePortfolio(
    account?.walletId ?? null,
    account?.accountId ?? null
  )
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [prices, setPrices] = useState<AssetPriceReadModel | null>(null)
  const [pricesLoading, setPricesLoading] = useState(true)
  const [directoryTokens, setDirectoryTokens] = useState<readonly SwapToken[] | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [zcashMoveOpen, setZcashMoveOpen] = useState(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setSelectedAssetId(null)
    setZcashMoveOpen(false)
    setConnectionError(null)
    setConnecting(false)
  }, [account?.walletId, account?.accountId, currentNetwork])
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const hasZcashAccount =
    activeAccount?.networks.some(network => network.chain.family === 'zcash') ??
    model?.chains.some(chain => chain.chain.family === 'zcash') ??
    false
  const zcashMoveSources = hasZcashAccount
    ? getAvailableZcashSelfMoveSources({
        addresses: zcashAccount?.addresses,
        balance: zcashBalance,
        keySource: zcashKeySource,
        network: currentNetwork
      })
    : []
  const canMoveZcash = zcashMoveSources.length > 0
  const canSendShieldedZcash =
    hasZcashAccount && new Big(getFundingBalance(zcashBalance, 'shielded').available).gt(0)

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
  const canManageNear =
    getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet').length > 0
  const providerAvailable =
    provider === 'zcash-shield'
      ? hasZcashAccount
      : provider === 'near-confidential' && (canManageNear || near.entries.length > 0)
  const group = useMemo(
    () =>
      model && provider === 'zcash-shield'
        ? buildShieldProviderGroups(model, prices).find(item => item.id === provider)
        : null,
    [model, prices, provider]
  )
  const selectedNearEntry = near.entries.find(entry => entry.asset.tokenId === selectedAssetId)
  const nearSources = useMemo(() => {
    const options = listShieldFundingAssets(
      model,
      resolveManagedIntentsCatalog(directoryTokens ?? []),
      directoryTokens ?? [],
      currentNetwork
    )
    return shieldFundingSources(options, shieldPortfolioBalances(model))
  }, [model, directoryTokens, currentNetwork])
  const movableNearSource = nearSources.find(source => source.chain.chain.family === 'evm')
  const canAttemptNearSpend = canManageNear && (near.status !== 'ready' || nearSources.length > 0)
  const nearBalanceEmpty =
    provider === 'near-confidential' &&
    near.status === 'ready' &&
    near.entries.every(entry => Big(entry.asset.availableRaw).eq(0))
  const selectedNearAssetId = selectedNearEntry?.asset.assetId
  const selectedNearAssetSupported = Boolean(
    selectedNearAssetId &&
    (getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet').some(chainId =>
      selectedNearAssetId.startsWith(`${chainId}/`)
    ) ||
      nearSources.some(source => source.asset.asset.id === selectedNearAssetId))
  )
  const selectedEntry = group?.entries.find(entry => entry.asset.asset.id === selectedAssetId)
  const selectedQuote = selectedEntry ? findAssetPrice(prices, selectedEntry.asset.asset.id) : null
  const selectedAssetFiat = selectedEntry
    ? getPortfolioAssetUsdValue(selectedEntry.asset, prices)
    : null
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
  const mode = searchParams.get('mode')
  const connectShield = async () => {
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
        await refresh(true)
    } catch (error) {
      if (mounted.current && latestScope.current === scopeKey)
        setConnectionError(error instanceof Error ? error.message : 'Shield balance unavailable')
    } finally {
      if (mounted.current && latestScope.current === scopeKey) setConnecting(false)
    }
  }

  const transferPath = (
    assetId: string | null,
    from: 'public' | 'shield',
    to: 'shield' | 'private'
  ) => {
    const query = new URLSearchParams({ from, to })
    query.set('provider', 'near-confidential')
    if (assetId) query.set('assetId', assetId)
    if (mode === 'public' || mode === 'private') query.set('mode', mode)
    return `/transfer?${query.toString()}`
  }

  if (!provider || (activeAccount && !providerAvailable)) {
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
        <header className="relative bg-[radial-gradient(ellipse_75%_120px_at_50%_0%,#07574666,transparent)] px-4 pb-5 pt-[63px] text-center">
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
          <h1 className="mt-4 text-lg font-bold">{info.detailName}</h1>
          {provider === 'near-confidential' && (
            <p className="mx-auto mt-2 max-w-[300px] text-sm leading-[18px] text-[var(--color-wallet-secondary)]">
              Confidential Intents extends NEAR Intents with private swaps. Balances and swap
              details are shielded from public view.
            </p>
          )}
          {provider === 'near-confidential' ? (
            <div className="mt-6 grid grid-cols-2 gap-3 text-center">
              <div className="min-w-0">
                <div className="flex h-5 items-center justify-center -space-x-1">
                  {supportedNetworks.slice(0, 7).map(network => (
                    <ChainIcon
                      key={network.id}
                      chain={
                        network.family === 'evm'
                          ? resolveEvmChainIconAlias(network.id)
                          : resolveChainIconAlias(network.family, network.displayName)
                      }
                      width={17}
                      height={17}
                      className="shrink-0 rounded-full border border-background"
                    />
                  ))}
                </div>
                <p className="mt-2 text-xs text-wallet-secondary">
                  {supportedNetworks.length} Supported networks
                </p>
              </div>
              <div className="min-w-0">
                <div className="flex h-5 items-center justify-center -space-x-1">
                  {supportedTokens?.slice(0, 7).map(token => (
                    <TokenIcon
                      key={token.assetId}
                      token={token}
                      size={17}
                      className="shrink-0 rounded-full border border-background"
                    />
                  ))}
                </div>
                <p className="mt-2 text-xs text-wallet-secondary">
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
                    chain={resolveChainIconAlias(chain.chain.family, chain.chain.displayName)}
                    width={16}
                    height={16}
                    className="shrink-0"
                  />
                ))}
              </span>
            </div>
          )}
          <div
            className={`mt-4 grid gap-2 ${provider === 'near-confidential' ? 'grid-cols-4' : 'grid-cols-3'}`}
          >
            {provider === 'near-confidential' && (
              <>
                <button
                  type="button"
                  onClick={() => navigate('/shield-withdraw?provider=near-confidential')}
                  disabled={!canAttemptNearSpend}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="send" size={20} />
                  Send
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/shield-deposit?provider=near-confidential')}
                  disabled={!canManageNear}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="receive" size={20} />
                  Receive
                </button>
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      transferPath(
                        movableNearSource?.asset.asset.id ?? null,
                        movableNearSource || near.status !== 'ready' ? 'shield' : 'public',
                        movableNearSource || near.status !== 'ready' ? 'private' : 'shield'
                      )
                    )
                  }
                  disabled={!canManageNear}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="move" size={20} />
                  Move
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/shield-swap?provider=near-confidential')}
                  disabled={!canAttemptNearSpend}
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
                  onClick={() => navigate('/send/zcash?from=shielded')}
                  disabled={!canSendShieldedZcash}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="send" size={20} />
                  Send
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!account) return
                    navigate(
                      `/addresses-list?walletId=${encodeURIComponent(account.walletId)}&accountId=${encodeURIComponent(account.accountId)}&chain=zcash&privacy=shielded`
                    )
                  }}
                  disabled={!account || !hasZcashAccount}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="receive" size={20} />
                  Receive
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (zcashMoveSources.length === 1) {
                      navigate(`/send/zcash?move=1&from=${zcashMoveSources[0]}`)
                    } else if (zcashMoveSources.length > 1) {
                      setZcashMoveOpen(true)
                    }
                  }}
                  disabled={!canMoveZcash}
                  className="wallet-interactive flex h-[74px] min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-wallet-surface)] text-xs enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                >
                  <WalletActionIcon action="move" size={20} />
                  Move
                </button>
              </>
            )}
          </div>
        </header>

        <section aria-label={`${info.name} balance`} className="border-t border-white/[0.08]">
          <div className="py-3.5 text-center">
            <p className="break-all px-4 text-[26px] font-semibold leading-[37.4px]">
              {displayFiat}
            </p>
            <div className="mt-0.5 flex items-center justify-center gap-1.5 text-sm text-[var(--color-wallet-secondary)]">
              <span>Total balance</span>
              {provider === 'near-confidential' && near.status === 'ready' && canManageNear && (
                <button
                  type="button"
                  title="Refresh Shield balance"
                  aria-label="Refresh Shield balance"
                  onClick={() => void connectShield()}
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
            {provider === 'near-confidential' && near.status === 'unavailable' && canManageNear && (
              <button
                type="button"
                onClick={() => void connectShield()}
                disabled={connecting}
                className="wallet-interactive mt-2 rounded-md text-sm font-medium text-primary enabled:hover:bg-primary/10 enabled:active:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
              >
                {connecting ? 'Connecting…' : 'Connect Shield'}
              </button>
            )}
            {connectionError && (
              <p role="alert" className="px-4 pt-2 text-xs text-warning">
                {connectionError}
              </p>
            )}
          </div>
          {provider === 'near-confidential' && near.entries.length > 0 && !nearBalanceEmpty ? (
            <div className="divide-y divide-white/[0.08]">
              {near.entries.map(entry => (
                <NearConfidentialHoldingRow
                  key={entry.asset.tokenId}
                  entry={entry}
                  balancesHidden={balancesHidden}
                  onClick={() => setSelectedAssetId(entry.asset.tokenId)}
                />
              ))}
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
                  onSelectAsset={setSelectedAssetId}
                />
              ))}
            </div>
          ) : status === 'loading' ? (
            <p className="px-4 py-5 text-center text-sm text-muted">Loading balances…</p>
          ) : nearBalanceEmpty ? (
            <div className="flex flex-col items-center gap-3 px-4 py-5">
              <button
                type="button"
                onClick={() => navigate(transferPath(null, 'public', 'shield'))}
                disabled={!canManageNear}
                className="wallet-interactive h-11 min-w-48 rounded-lg bg-wallet-surface px-4 text-sm enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45"
              >
                Move from your wallet
              </button>
              <button
                type="button"
                onClick={() => navigate('/shield-deposit?provider=near-confidential')}
                disabled={!canManageNear}
                className="wallet-interactive h-11 min-w-48 rounded-lg bg-wallet-surface px-4 text-sm enabled:hover:bg-wallet-selected enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45"
              >
                Receive from others
              </button>
            </div>
          ) : (
              provider === 'near-confidential' ? near.status === 'ready' : group?.fiat === '0'
            ) ? null : (
            <p className="px-4 py-5 text-center text-sm text-muted">Balance unavailable</p>
          )}
        </section>
      </div>

      {provider === 'near-confidential' && selectedNearEntry && (
        <Dialog open onOpenChange={open => !open && setSelectedAssetId(null)}>
          <DialogContent
            position="bottom"
            className="min-h-[210px] gap-0 bg-wallet-surface px-4 pb-8 pt-4"
            showCloseButton={false}
          >
            <button
              type="button"
              aria-label="Close"
              onClick={() => setSelectedAssetId(null)}
              className="wallet-interactive ml-auto flex size-6 items-center justify-center rounded-md hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            >
              <Icon icon="lucide:x" width={20} height={20} />
            </button>
            <div className="mt-1 flex items-center gap-3">
              <TokenIcon
                assetId={selectedNearEntry.asset.assetId}
                symbol={selectedNearEntry.asset.symbol ?? '?'}
                icon={selectedNearEntry.asset.iconUrl}
                size={32}
              />
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-base font-medium">
                  {selectedNearEntry.asset.symbol ?? 'Unknown token'}
                </DialogTitle>
                <DialogDescription className="sr-only">Confidential holding</DialogDescription>
                <p className="text-xs text-muted">
                  {selectedNearEntry.priceUsd
                    ? formatTokenPrice(selectedNearEntry.priceUsd, { showSign: true })
                    : '—'}
                </p>
              </div>
              <div className="min-w-0 text-right">
                <p className="font-medium">
                  {balancesHidden
                    ? '••••'
                    : selectedNearEntry.fiat === null
                      ? '—'
                      : formatFiatAmount(selectedNearEntry.fiat, { showSign: true })}
                </p>
                <p className="text-xs text-muted">
                  {balancesHidden
                    ? '••••'
                    : selectedNearEntry.amount === null
                      ? '—'
                      : formatTokenQuantity(selectedNearEntry.amount)}
                </p>
              </div>
            </div>
            {(!selectedNearEntry.asset.symbol || selectedNearEntry.identityLabel) && (
              <p className="mt-4 break-all font-mono text-xs text-muted">
                {selectedNearEntry.asset.protocolAssetId}
              </p>
            )}
            {!balancesHidden && selectedNearEntry.amount === null && (
              <p className="mt-2 break-all font-mono text-xs text-muted">
                Raw balance: {selectedNearEntry.asset.availableRaw}
              </p>
            )}
            {selectedNearAssetId &&
              selectedNearAssetSupported &&
              selectedNearEntry.amount !== null && (
                <div className="mt-8 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/shield-withdraw?provider=near-confidential&assetId=${encodeURIComponent(selectedNearAssetId)}`
                      )
                    }
                    disabled={
                      !canManageNear ||
                      !nearSources.some(source => source.asset.asset.id === selectedNearAssetId)
                    }
                    className="wallet-interactive h-11 rounded-lg bg-wallet-selected text-sm font-medium hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/shield-deposit?provider=near-confidential&assetId=${encodeURIComponent(selectedNearAssetId)}`
                      )
                    }
                    disabled={!canManageNear}
                    className="wallet-interactive h-11 rounded-lg bg-wallet-selected text-sm font-medium enabled:hover:brightness-110 enabled:active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
                  >
                    Receive
                  </button>
                </div>
              )}
          </DialogContent>
        </Dialog>
      )}

      {selectedEntry && (
        <Dialog open onOpenChange={open => !open && setSelectedAssetId(null)}>
          <DialogContent
            position="bottom"
            className="min-h-[210px] gap-0 bg-[var(--color-wallet-surface)] px-4 pb-8 pt-4"
            showCloseButton={false}
          >
            <button
              type="button"
              aria-label="Close"
              onClick={() => setSelectedAssetId(null)}
              className="wallet-interactive ml-auto flex size-6 items-center justify-center rounded-md hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            >
              <Icon icon="lucide:x" width={20} height={20} />
            </button>
            <div className="mt-1 flex items-center gap-3">
              <TokenIcon
                assetId={selectedEntry.asset.asset.id}
                symbol={selectedEntry.asset.metadata.symbol}
                icon={selectedEntry.asset.metadata.iconUrl}
                size={32}
              />
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-base font-medium">
                  {selectedEntry.asset.metadata.symbol}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Shield balance and transfer actions
                </DialogDescription>
                <p className="text-xs text-muted">
                  {selectedQuote
                    ? formatTokenPrice(selectedQuote.priceUsd, { showSign: true })
                    : '—'}
                </p>
              </div>
              <div className="min-w-0 text-right">
                <p className="font-medium">
                  {balancesHidden
                    ? '••••'
                    : selectedAssetFiat === null
                      ? '—'
                      : formatFiatAmount(selectedAssetFiat, { showSign: true })}
                </p>
                <p className="text-xs text-muted">
                  {balancesHidden
                    ? '••••'
                    : formatBaseUnitDecimalAmount(
                        selectedEntry.asset.balance.totalRaw,
                        selectedEntry.asset.metadata.decimals
                      )}
                </p>
              </div>
            </div>
            <div className="mt-8 grid grid-cols-2 gap-3">
              {provider === 'near-confidential' ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/shield-withdraw?provider=near-confidential&assetId=${encodeURIComponent(selectedEntry.asset.asset.id)}`
                      )
                    }
                    className="wallet-interactive h-11 rounded-lg bg-[var(--color-wallet-selected)] text-sm font-medium hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/shield-deposit?provider=near-confidential&assetId=${encodeURIComponent(selectedEntry.asset.asset.id)}`
                      )
                    }
                    className="wallet-interactive h-11 rounded-lg bg-[var(--color-wallet-selected)] text-sm font-medium hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    Receive
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/asset-detail?assetId=${encodeURIComponent(selectedEntry.asset.asset.id)}&domain=shield${mode === 'public' || mode === 'private' ? `&mode=${mode}` : ''}`
                    )
                  }
                  className="wallet-interactive col-span-2 h-11 rounded-lg bg-[var(--color-wallet-selected)] text-sm font-medium hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                >
                  View Zcash actions
                </button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
      <Dialog open={zcashMoveOpen} onOpenChange={setZcashMoveOpen}>
        <DialogContent position="bottom" className="gap-2 bg-wallet-surface p-4 pb-6">
          <DialogTitle className="text-base font-medium">Move ZEC</DialogTitle>
          <DialogDescription className="sr-only">Choose a balance to move from</DialogDescription>
          {zcashMoveSources.map((source: FundingSource) => (
            <button
              key={source}
              type="button"
              onClick={() => {
                setZcashMoveOpen(false)
                navigate(`/send/zcash?move=1&from=${source}`)
              }}
              className="wallet-interactive h-12 rounded-lg bg-background px-3 text-left text-sm hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary"
            >
              {source === 'transparent' ? 'Move to Shield' : 'Move to Public'}
            </button>
          ))}
        </DialogContent>
      </Dialog>
    </div>
  )
}
