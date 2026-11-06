import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import { safeBig } from '@/lib/big'
import nearLogo from '@/images/figma-near-confidential.svg'
import zcashLogo from '@/images/figma-zcash-shield.svg'
import { formatFiatAmount } from '@/lib/number-format'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import type { FundingSource } from '@/types/wallet'
import { useAccountDataStore } from '@/store/account-data-store'
import { useWalletStore } from '@/store/wallet-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { WalletActionIcon } from '@/popup/components/common/WalletActionIcon'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { useNavigate } from '@/popup/provider/Router'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import { buildShieldProviderGroups, type ShieldProvider } from '@/popup/services/asset-domains'
import { summarizeNearConfidentialHoldings } from '@/popup/services/near-confidential-holdings'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { getAvailableZcashSelfMoveSources } from '@/popup/services/zcash-self-move'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
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

type ShieldAction = 'send' | 'receive' | 'move'

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
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const { activeAccount } = useActiveAccountNetworks()
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const zcashBalance = useAccountDataStore(state => state.getCurrentBalance())
  const zcashAccount = useWalletStore(state => state.getCurrentAccount())
  const zcashKeySource = useWalletStore(state => state.getCurrentWallet()?.keySource)
  const near = summarizeNearConfidentialHoldings(model, prices)
  const zcashGroup = buildShieldProviderGroups(model, prices).find(
    group => group.id === 'zcash-shield'
  )
  const nearChainIds = getPrivateTransferChainIds(activeAccount, currentNetwork === 'mainnet')
  const canManageNear = nearChainIds.length > 0
  const hasSpendableNear = near.entries.some(
    entry =>
      entry.asset.assetId &&
      nearChainIds.some(chainId => entry.asset.assetId?.startsWith(`${chainId}/`)) &&
      safeBig(entry.asset.availableRaw).gt(0)
  )
  const hasNear = canManageNear || near.entries.length > 0
  const providers: readonly ShieldProvider[] = [
    ...(hasNear ? (['near-confidential'] as const) : []),
    ...(zcashGroup ? (['zcash-shield'] as const) : [])
  ]
  const modeQuery = `&mode=${mode}`
  const [pendingAction, setPendingAction] = useState<ShieldAction | null>(null)
  const [zcashMoveOpen, setZcashMoveOpen] = useState(false)
  const [collapsedProviders, setCollapsedProviders] = useState<ReadonlySet<ShieldProvider>>(
    () => new Set()
  )
  useEffect(() => {
    setPendingAction(null)
    setZcashMoveOpen(false)
    setCollapsedProviders(new Set())
  }, [
    currentNetwork,
    model.scope.keyDomainId,
    model.scope.accountId,
    account?.walletId,
    account?.accountId
  ])
  const zcashMoveSources = zcashGroup
    ? getAvailableZcashSelfMoveSources({
        addresses: zcashAccount?.addresses,
        balance: zcashBalance,
        keySource: zcashKeySource,
        network: currentNetwork
      })
    : []
  const canUseProvider = (provider: ShieldProvider, action: ShieldAction) => {
    if (provider === 'near-confidential') {
      return canManageNear && (action !== 'send' || near.status !== 'ready' || hasSpendableNear)
    }
    if (action === 'send') {
      return safeBig(getFundingBalance(zcashBalance, 'shielded').available).gt(0)
    }
    return action === 'receive' ? account !== null : zcashMoveSources.length > 0
  }

  const runProviderAction = (provider: ShieldProvider, action: ShieldAction) => {
    setPendingAction(null)
    if (provider === 'zcash-shield') {
      if (action === 'send') navigate('/send/zcash?from=shielded')
      else if (action === 'receive' && account) {
        navigate(
          `/addresses-list?walletId=${encodeURIComponent(account.walletId)}&accountId=${encodeURIComponent(account.accountId)}&chain=zcash&privacy=shielded`
        )
      } else if (action === 'move') {
        if (zcashMoveSources.length === 1) {
          navigate(`/send/zcash?move=1&from=${zcashMoveSources[0]}`)
        } else if (zcashMoveSources.length > 1) {
          setZcashMoveOpen(true)
        }
      }
      return
    }

    if (action === 'move') {
      navigate(
        hasSpendableNear || near.status !== 'ready'
          ? '/transfer?from=shield&to=private&provider=near-confidential'
          : '/transfer?from=public&to=shield&provider=near-confidential'
      )
    } else {
      navigate(
        action === 'send'
          ? '/shield-withdraw?provider=near-confidential'
          : '/shield-deposit?provider=near-confidential'
      )
    }
  }

  const openAction = (action: ShieldAction) => {
    const available = providers.filter(provider => canUseProvider(provider, action))
    if (available.length === 1) runProviderAction(available[0]!, action)
    else if (available.length > 1) setPendingAction(action)
  }

  return (
    <div className="min-h-full pb-5">
      <section className="px-4 py-3" aria-label="Shield actions">
        <div className="grid grid-cols-3 gap-2.5">
          {(['send', 'receive', 'move'] as const).map(action => (
            <button
              key={action}
              type="button"
              onClick={() => openAction(action)}
              disabled={!providers.some(provider => canUseProvider(provider, action))}
              className="wallet-interactive flex h-[38px] min-w-0 items-center justify-center gap-1 rounded-lg bg-[var(--color-wallet-surface)] px-2 text-sm capitalize enabled:hover:bg-[var(--color-wallet-selected)] enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-45"
            >
              <WalletActionIcon action={action} size={16} />
              {action}
            </button>
          ))}
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
            {pendingAction === 'send'
              ? 'Send from'
              : pendingAction === 'receive'
                ? 'Receive with'
                : 'Move in'}
          </DialogTitle>
          <DialogDescription className="sr-only">Choose a Shield provider</DialogDescription>
          {providers
            .filter(provider => pendingAction && canUseProvider(provider, pendingAction))
            .map(provider => (
              <button
                key={provider}
                type="button"
                onClick={() => pendingAction && runProviderAction(provider, pendingAction)}
                className="wallet-interactive flex h-12 items-center gap-3 rounded-lg bg-background px-3 text-left text-sm hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
              >
                <ShieldProviderLogo provider={provider} size={26} />
                {SHIELD_PROVIDERS[provider].name}
              </button>
            ))}
        </DialogContent>
      </Dialog>
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
