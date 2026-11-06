import { useState } from 'react'
import { Icon } from '@iconify/react'
import { safeBig } from '@/lib/big'
import nearLogo from '@/images/figma-near-confidential.svg'
import zcashLogo from '@/images/figma-zcash-shield.svg'
import { formatFiatAmount } from '@/lib/number-format'
import { canShieldTransparentFunds } from '@/core/zcash/shielding'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import { useAccountDataStore } from '@/store/account-data-store'
import { useShieldFunds } from '@/popup/hooks/useShieldFunds'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { useNavigate } from '@/popup/provider/Router'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import { buildShieldProviderGroups, type ShieldProvider } from '@/popup/services/asset-domains'
import { summarizeNearConfidentialHoldings } from '@/popup/services/near-confidential-holdings'
import { PortfolioChainAssetRow } from './PortfolioAssetGroupCard'
import { NearConfidentialHoldingRow } from './NearConfidentialHoldingRow'

export const SHIELD_PROVIDERS: Readonly<
  Record<ShieldProvider, { name: string; detailName: string; logo: string; tint: string }>
> = {
  'near-confidential': {
    name: 'NEAR Confidential',
    detailName: 'NEAR Confidential Intents',
    logo: nearLogo,
    tint: '#0c6e57'
  },
  'zcash-shield': {
    name: 'Zcash shield',
    detailName: 'Zcash shield',
    logo: zcashLogo,
    tint: '#424252'
  }
}

export function ShieldProviderLogo({
  provider,
  size = 36
}: {
  readonly provider: ShieldProvider
  readonly size?: number
}) {
  return (
    <img
      src={SHIELD_PROVIDERS[provider].logo}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className="shrink-0 rounded-[5px] object-contain"
    />
  )
}

export function ShieldPortfolioView({
  model,
  mode,
  prices,
  balancesHidden,
  pricesLoading,
  onSelectAsset
}: {
  readonly model: PortfolioReadModel
  readonly mode: 'public' | 'private'
  readonly prices: AssetPriceReadModel | null
  readonly balancesHidden: boolean
  readonly pricesLoading: boolean
  readonly onSelectAsset?: (assetId: string) => void
}) {
  const { navigate } = useNavigate()
  const zcashBalance = useAccountDataStore(state => state.getCurrentBalance())
  const { isShielding, handleShieldFunds, shieldSheet } = useShieldFunds()
  const near = summarizeNearConfidentialHoldings(model, prices)
  const zcashGroup = buildShieldProviderGroups(model, prices).find(
    group => group.id === 'zcash-shield'
  )
  const providers: readonly ShieldProvider[] = zcashGroup
    ? ['near-confidential', 'zcash-shield']
    : ['near-confidential']
  const modeQuery = `&mode=${mode}`
  const [pendingAction, setPendingAction] = useState<'deposit' | 'withdraw' | null>(null)
  const [collapsedProviders, setCollapsedProviders] = useState<ReadonlySet<ShieldProvider>>(
    () => new Set()
  )
  const canUseProvider = (provider: ShieldProvider, action: 'deposit' | 'withdraw') =>
    provider === 'near-confidential'
      ? action === 'deposit' || near.status !== 'ready' || near.entries.length > 0
      : action === 'deposit'
        ? canShieldTransparentFunds(zcashBalance) && !isShielding
        : safeBig(getFundingBalance(zcashBalance, 'shielded').available).gt(0)

  const runProviderAction = (provider: ShieldProvider, action: 'deposit' | 'withdraw') => {
    setPendingAction(null)
    if (provider === 'zcash-shield') {
      if (action === 'deposit') handleShieldFunds()
      else navigate('/send/zcash?from=shielded')
      return
    }

    navigate(`/shield-${action}?provider=near-confidential`)
  }

  const openAction = (action: 'deposit' | 'withdraw') => {
    if (providers.length === 1) runProviderAction(providers[0]!, action)
    else setPendingAction(action)
  }

  return (
    <div className="min-h-full pb-5">
      <section className="px-4 py-3" aria-label="Shield actions">
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={() => openAction('withdraw')}
            disabled={!providers.some(provider => canUseProvider(provider, 'withdraw'))}
            className="wallet-interactive flex h-[34px] min-w-24 items-center justify-center gap-1 rounded-lg bg-[var(--color-wallet-surface)] px-3 text-sm enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
          >
            <Icon icon="lucide:shield-check" width={15} height={15} className="text-[#1bc891]" />
            Withdraw
          </button>
          <button
            type="button"
            onClick={() => openAction('deposit')}
            disabled={!providers.some(provider => canUseProvider(provider, 'deposit'))}
            className="wallet-interactive flex h-[34px] min-w-24 items-center justify-center gap-1 rounded-lg bg-[var(--color-wallet-surface)] px-3 text-sm enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
          >
            <Icon icon="lucide:shield-check" width={15} height={15} className="text-[#1bc891]" />
            Deposit
          </button>
        </div>
      </section>

      <div
        role="group"
        aria-label="Shield providers"
        className="flex w-full min-w-0 gap-3.5 overflow-x-auto overscroll-x-contain px-4 pb-1"
      >
        {providers.map(providerId => {
          const provider = SHIELD_PROVIDERS[providerId]
          return (
            <button
              key={providerId}
              type="button"
              aria-label={`Open ${provider.name}`}
              onClick={() => navigate(`/shield-provider?provider=${providerId}${modeQuery}`)}
              className="wallet-interactive relative flex h-[156px] w-[225px] min-w-[225px] shrink-0 flex-col overflow-hidden rounded-xl bg-[var(--color-wallet-surface)] text-left hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              style={{
                backgroundImage: `radial-gradient(ellipse at 50% 0%, ${provider.tint}88, transparent 75%)`
              }}
            >
              <span className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3">
                <ShieldProviderLogo provider={providerId} size={40} />
                <span
                  className="w-full truncate text-center text-base font-medium"
                  title={provider.detailName}
                >
                  {provider.detailName}
                </span>
              </span>
              <span className="flex min-h-[42px] min-w-0 items-center justify-between gap-2 bg-[var(--color-wallet-selected)]/75 px-3 py-1">
                <span className="flex min-w-0 flex-1 items-center">
                  {providerId === 'near-confidential'
                    ? near.entries
                        .slice(0, 4)
                        .map((entry, index) => (
                          <TokenIcon
                            key={entry.asset.tokenId}
                            assetId={entry.asset.assetId}
                            symbol={entry.asset.symbol ?? '?'}
                            icon={entry.asset.iconUrl}
                            size={17}
                            className={index === 0 ? 'shrink-0' : '-ml-1 shrink-0'}
                          />
                        ))
                    : zcashGroup?.entries
                        .slice(0, 4)
                        .map((entry, index) => (
                          <TokenIcon
                            key={entry.asset.asset.id}
                            assetId={entry.asset.asset.id}
                            symbol={entry.asset.metadata.symbol}
                            icon={entry.asset.metadata.iconUrl}
                            size={17}
                            className={index === 0 ? 'shrink-0' : '-ml-1 shrink-0'}
                          />
                        ))}
                </span>
                <span className="shrink-0 rounded-lg bg-white/80 px-3 py-1.5 text-xs font-medium text-background">
                  Open
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-3 divide-y divide-white/[0.08] border-t border-white/[0.08]">
        {near.entries.length > 0 && (
          <section aria-label="NEAR Confidential Shield assets">
            <button
              type="button"
              aria-label={`${collapsedProviders.has('near-confidential') ? 'Expand' : 'Collapse'} NEAR Confidential Shield assets`}
              aria-expanded={!collapsedProviders.has('near-confidential')}
              onClick={() =>
                setCollapsedProviders(current => {
                  const next = new Set(current)
                  if (next.has('near-confidential')) next.delete('near-confidential')
                  else next.add('near-confidential')
                  return next
                })
              }
              className="wallet-interactive flex min-h-12 w-full items-center gap-2.5 px-4 text-left hover:bg-white/[0.05] active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
            >
              <ShieldProviderLogo provider="near-confidential" size={24} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">NEAR Confidential</span>
              <span className="shrink-0 text-sm font-medium">
                {balancesHidden
                  ? '••••'
                  : near.fiat === null
                    ? '—'
                    : formatFiatAmount(near.fiat, { showSign: true })}
              </span>
              <Icon
                icon="lucide:chevron-down"
                width={14}
                height={14}
                className={`shrink-0 text-muted transition-transform ${collapsedProviders.has('near-confidential') ? '' : 'rotate-180'}`}
              />
            </button>
            {!collapsedProviders.has('near-confidential') && (
              <div role="region" aria-label="NEAR Confidential Shield token balances">
                {near.entries.map(entry => (
                  <NearConfidentialHoldingRow
                    key={entry.asset.tokenId}
                    entry={entry}
                    balancesHidden={balancesHidden}
                    onClick={() =>
                      navigate(`/shield-provider?provider=near-confidential${modeQuery}`)
                    }
                  />
                ))}
              </div>
            )}
          </section>
        )}
        {zcashGroup &&
          [zcashGroup].map(group => {
            const heldEntries = group.entries.filter(
              entry => BigInt(entry.asset.balance.totalRaw) > 0n
            )
            if (heldEntries.length === 0) return null
            const provider = SHIELD_PROVIDERS[group.id]
            const expanded = !collapsedProviders.has(group.id)
            return (
              <section key={group.id} aria-label={`${provider.name} Shield assets`}>
                <button
                  type="button"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${provider.name} Shield assets`}
                  aria-expanded={expanded}
                  onClick={() =>
                    setCollapsedProviders(current => {
                      const next = new Set(current)
                      if (next.has(group.id)) next.delete(group.id)
                      else next.add(group.id)
                      return next
                    })
                  }
                  className="wallet-interactive flex min-h-12 w-full items-center gap-2.5 px-4 text-left hover:bg-white/[0.05] active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                >
                  <ShieldProviderLogo provider={group.id} size={24} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {provider.name}
                  </span>
                  <span className="shrink-0 text-sm font-medium">
                    {balancesHidden
                      ? '••••'
                      : group.fiat === null
                        ? pricesLoading
                          ? '…'
                          : '—'
                        : formatFiatAmount(group.fiat, { showSign: true })}
                  </span>
                  <Icon
                    icon="lucide:chevron-down"
                    width={14}
                    height={14}
                    className={`shrink-0 text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
                  />
                </button>
                {expanded && (
                  <div role="region" aria-label={`${provider.name} Shield token balances`}>
                    {heldEntries.map(entry => (
                      <PortfolioChainAssetRow
                        key={entry.asset.asset.id}
                        entry={entry}
                        domain="shield"
                        prices={prices}
                        pricesLoading={pricesLoading}
                        balancesHidden={balancesHidden}
                        onSelectAsset={onSelectAsset}
                      />
                    ))}
                  </div>
                )}
              </section>
            )
          })}
      </div>
      <Dialog open={pendingAction !== null} onOpenChange={open => !open && setPendingAction(null)}>
        <DialogContent
          position="bottom"
          className="gap-2 bg-[var(--color-wallet-surface)] p-4 pb-6"
        >
          <DialogTitle className="text-base font-medium">
            {pendingAction === 'withdraw' ? 'Withdraw from' : 'Deposit to'}
          </DialogTitle>
          <DialogDescription className="sr-only">Choose a Shield provider</DialogDescription>
          {providers.map(provider => (
            <button
              key={provider}
              type="button"
              disabled={pendingAction === null || !canUseProvider(provider, pendingAction)}
              onClick={() => pendingAction && runProviderAction(provider, pendingAction)}
              className="wallet-interactive flex h-12 items-center gap-3 rounded-lg bg-background px-3 text-left text-sm enabled:hover:bg-white/10 enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
            >
              <ShieldProviderLogo provider={provider} size={26} />
              {SHIELD_PROVIDERS[provider].name}
            </button>
          ))}
        </DialogContent>
      </Dialog>
      {shieldSheet}
    </div>
  )
}
