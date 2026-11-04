import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import {
  formatBaseUnitDecimalAmount,
  formatFiatAmount,
  formatTokenPrice
} from '@/lib/number-format'
import type { AssetPriceReadModel } from '@/core/prices'
import { findAssetPrice } from '@/core/prices'
import { useWalletStore } from '@/store/wallet-store'
import { confidentialFundingClient } from '@/popup/services/confidential-funding-client'
import { useSettingsStore } from '@/store/settings-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { useNavigate } from '@/popup/provider/Router'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { buildShieldProviderGroups, type ShieldProvider } from '@/popup/services/asset-domains'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { getZcashChainId } from '@/core/chains/registry'
import { resolveChainExplorerTarget } from '@/popup/services/chain-explorer'
import { PortfolioChainAssetRow } from '@/popup/components/portfolio/PortfolioAssetGroupCard'
import { getPortfolioAssetUsdValue } from '@/popup/components/portfolio/portfolio-prices'
import {
  ShieldProviderLogo,
  SHIELD_PROVIDERS
} from '@/popup/components/portfolio/ShieldPortfolioView'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'

export function ShieldProviderDetail() {
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
  const { activeAccount } = useActiveAccountNetworks()
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const { model, status, refresh } = useHomePortfolio(
    account?.walletId ?? null,
    account?.accountId ?? null
  )
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [prices, setPrices] = useState<AssetPriceReadModel | null>(null)
  const [pricesLoading, setPricesLoading] = useState(true)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const balancesHidden = useSettingsStore(state => state.balancesHidden)

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

  const group = useMemo(
    () =>
      model && provider
        ? buildShieldProviderGroups(model, prices).find(item => item.id === provider)
        : null,
    [model, prices, provider]
  )
  const shieldBalanceUnknown = Boolean(
    model?.assets.some(
      asset =>
        asset.asset.chainId.startsWith('eip155:') && asset.balance.confidentialRaw === undefined
    )
  )
  const selectedEntry = group?.entries.find(entry => entry.asset.asset.id === selectedAssetId)
  const selectedQuote = selectedEntry ? findAssetPrice(prices, selectedEntry.asset.asset.id) : null
  const selectedAssetFiat = selectedEntry
    ? getPortfolioAssetUsdValue(selectedEntry.asset, prices)
    : null
  const networks =
    model?.chains.filter(chain =>
      provider === 'near-confidential'
        ? chain.chain.family === 'evm' && chain.chain.network.kind === 'mainnet'
        : provider === 'zcash-shield' && chain.chain.family === 'zcash'
    ) ?? []
  const displayFiat = balancesHidden
    ? '••••'
    : group?.fiat === null || group?.fiat === undefined
      ? pricesLoading
        ? '…'
        : '—'
      : formatFiatAmount(group.fiat, { showSign: true })
  const mode = searchParams.get('mode')
  const explorerUrl =
    provider === 'near-confidential'
      ? 'https://explorer.near-intents.org/'
      : provider === 'zcash-shield'
        ? resolveChainExplorerTarget(getZcashChainId(currentNetwork), currentNetwork)?.baseUrl
        : null
  const connectShield = async () => {
    if (!account || connecting) return
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
        wallet.currentWalletId === currentWalletId &&
        wallet.currentAccountId === currentAccountId &&
        wallet.currentNetwork === currentNetwork
      )
        await refresh(true)
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Shield balance unavailable')
    } finally {
      setConnecting(false)
    }
  }

  const transferPath = (
    assetId: string | null,
    from: 'public' | 'shield',
    to: 'shield' | 'private'
  ) => {
    const query = new URLSearchParams({ from, to })
    if (assetId) query.set('assetId', assetId)
    if (mode === 'public' || mode === 'private') query.set('mode', mode)
    return `/transfer?${query.toString()}`
  }

  if (!provider) {
    return (
      <div className="page-container items-center justify-center">
        <p className="text-sm text-muted">Shield account unavailable</p>
        <button type="button" onClick={goBack} className="mt-4 text-sm text-primary">
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
            className="absolute left-4 top-4 flex size-7 items-center justify-center text-white"
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
          <div
            className={`${provider === 'near-confidential' ? 'mt-8' : 'mt-5'} flex min-h-5 items-center justify-between gap-3 text-left`}
          >
            <span className="shrink-0 text-xs text-[var(--color-wallet-secondary)]">
              Supported networks
            </span>
            <span className="flex min-w-0 max-w-[190px] flex-wrap justify-end gap-1.5">
              {networks.map(chain => (
                <ChainIcon
                  key={chain.chain.id}
                  chain={resolveChainIconAlias(chain.chain.family, chain.chain.displayName)}
                  width={16}
                  height={16}
                  className="shrink-0"
                  showTooltip
                />
              ))}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() =>
                navigate(
                  transferPath(group?.entries[0]?.asset.asset.id ?? null, 'public', 'shield')
                )
              }
              className="flex h-[50px] items-center justify-center gap-2 rounded-xl bg-[var(--color-wallet-surface)] text-sm hover:bg-[var(--color-wallet-selected)]"
            >
              <Icon icon="lucide:arrow-left-right" width={20} height={20} />
              Transfer
            </button>
            <a
              href={explorerUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!explorerUrl}
              className="flex h-[50px] items-center justify-center gap-2 rounded-xl bg-[var(--color-wallet-surface)] text-sm hover:bg-[var(--color-wallet-selected)] aria-disabled:pointer-events-none aria-disabled:opacity-40"
            >
              <Icon icon="lucide:globe" width={20} height={20} />
              Explore
            </a>
          </div>
        </header>

        <section aria-label={`${info.name} deposits`} className="border-t border-white/[0.08]">
          <div className="py-3.5 text-center">
            <p className="break-all px-4 text-[26px] font-semibold leading-[37.4px]">
              {displayFiat}
            </p>
            <div className="mt-0.5 flex items-center justify-center gap-1.5 text-sm text-[var(--color-wallet-secondary)]">
              <span>Total deposit</span>
              {provider === 'near-confidential' && !shieldBalanceUnknown && (
                <button
                  type="button"
                  title="Refresh Shield balance"
                  aria-label="Refresh Shield balance"
                  onClick={() => void connectShield()}
                  disabled={connecting}
                  className="text-primary disabled:opacity-50"
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
            {provider === 'near-confidential' && shieldBalanceUnknown && (
              <button
                type="button"
                onClick={() => void connectShield()}
                disabled={connecting}
                className="mt-2 text-sm font-medium text-primary disabled:opacity-50"
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
          {group?.entries.length &&
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
          ) : group?.fiat === '0' ? (
            <button
              type="button"
              onClick={() =>
                navigate(transferPath(group.entries[0]?.asset.asset.id ?? null, 'public', 'shield'))
              }
              className="mx-auto mt-4 flex h-[42px] min-w-[165px] items-center justify-center rounded-xl bg-[var(--color-wallet-selected)] px-5 text-sm font-medium hover:bg-[var(--color-wallet-surface)]"
            >
              Deposit
            </button>
          ) : (
            <p className="px-4 py-5 text-center text-sm text-muted">Balance unavailable</p>
          )}
        </section>
      </div>

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
              className="ml-auto flex size-6 items-center justify-center"
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
                      navigate(transferPath(selectedEntry.asset.asset.id, 'public', 'shield'))
                    }
                    className="h-11 rounded-lg bg-[var(--color-wallet-selected)] text-sm font-medium"
                  >
                    Deposit
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(transferPath(selectedEntry.asset.asset.id, 'shield', 'private'))
                    }
                    className="h-11 rounded-lg bg-[var(--color-wallet-selected)] text-sm font-medium"
                  >
                    Withdraw
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/asset-detail?assetId=${encodeURIComponent(selectedEntry.asset.asset.id)}&domain=shield`
                    )
                  }
                  className="col-span-2 h-11 rounded-lg bg-[var(--color-wallet-selected)] text-sm font-medium"
                >
                  View Zcash actions
                </button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
