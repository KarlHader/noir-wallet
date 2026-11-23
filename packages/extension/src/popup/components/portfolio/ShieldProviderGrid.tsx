import { Icon } from '@iconify/react'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import type { Network } from '@/types'
import { useShieldBalances } from '@/popup/hooks/useShieldBalances'
import { useNavigate } from '@/popup/provider/Router'
import type { AccountNetworksView } from '@/popup/services/account-networks-client'
import { buildShieldProviderGroups } from '@/popup/services/asset-domains'
import type { PortfolioSnapshot } from '@/popup/services/portfolio-snapshot-store'
import type { selectShieldActions } from '@/popup/services/shield-action-selection'
import { formatShieldProviderFiat } from '@/popup/services/shield-provider-presentation'
import {
  nearConfidentialVaultIcons,
  zcashShieldVaultIcons
} from '@/popup/services/shield-vault-display-icons'
import {
  resolveShieldZcashVaultEntry,
  shieldZcashEnablePath
} from '@/popup/services/shield-zcash-entry'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { BalanceSkeleton } from '@/popup/components/ui/skeleton'
import { ShieldProviderLogo, SHIELD_PROVIDERS } from './shield-providers'

export function HomeShieldProviders({
  network,
  account,
  model,
  status,
  refresh,
  prices,
  pricesLoading,
  balancesHidden,
  actions: { near, canManageNear, hasZcash }
}: {
  readonly network: Network
  readonly account: AccountNetworksView | null
  readonly model: PortfolioReadModel | null
  readonly status: PortfolioSnapshot['status']
  readonly refresh: (force?: boolean) => Promise<void>
  readonly prices: AssetPriceReadModel | null
  readonly pricesLoading: boolean
  readonly balancesHidden: boolean
  readonly actions: Pick<
    ReturnType<typeof selectShieldActions>,
    'near' | 'canManageNear' | 'hasZcash'
  >
}) {
  const {
    loading: loadingShieldBalances,
    error,
    refreshBalances
  } = useShieldBalances({
    active: true,
    enabled: canManageNear && near.status !== 'ready',
    scopeKey: `${network}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`,
    scope: account ? { network, keyDomainId: account.walletId, accountId: account.accountId } : null
  })
  const zcash = model
    ? buildShieldProviderGroups(model, prices).find(group => group.id === 'zcash-shield')
    : undefined
  const { navigate } = useNavigate()
  const loading = status === 'loading'
  const zcashEntry = resolveShieldZcashVaultEntry({
    network,
    walletSource: account?.walletSource ?? null,
    hasPortfolioZcash: hasZcash,
    enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
  })
  const enableZcashPath =
    zcashEntry.canEnableZcash && account
      ? shieldZcashEnablePath(account.walletId, account.accountId)
      : null
  const cards = [
    {
      provider: 'near-confidential',
      visible: canManageNear || near.entries.length > 0,
      fiat: near.fiat,
      loading: near.status !== 'ready' && (loading || loadingShieldBalances),
      icons: nearConfidentialVaultIcons(near.entries)
    },
    {
      provider: 'zcash-shield',
      visible: zcashEntry.showVaultCard,
      fiat: zcash?.fiat ?? null,
      loading: loading || pricesLoading,
      icons: zcashShieldVaultIcons(zcash?.entries.map(entry => entry.asset) ?? [])
    }
  ] as const

  return (
    <div className="px-4 pt-5 pb-5">
      {(error || status === 'error') && (
        <button
          type="button"
          className="mb-2 ml-auto block text-xs text-primary"
          onClick={() => void (error ? refreshBalances(true) : refresh(true))}
        >
          Retry
        </button>
      )}
      <div className="grid grid-cols-2 gap-3">
        {cards
          .filter(card => card.visible)
          .map(card => {
            const { provider } = card
            const { name, tint } = SHIELD_PROVIDERS[provider]
            const needsZcash = provider === 'zcash-shield' && !zcashEntry.hasActiveZcash
            const enablePath = needsZcash ? enableZcashPath : null
            const label = needsZcash ? '—' : formatShieldProviderFiat(card.fiat, balancesHidden)
            const showSkeleton = !needsZcash && !balancesHidden && card.fiat == null && card.loading

            return (
              <button
                key={provider}
                type="button"
                onClick={() =>
                  navigate(enablePath ?? `/shield-provider?provider=${provider}&mode=public`)
                }
                className="wallet-interactive flex h-[154px] min-w-0 flex-col overflow-hidden rounded-lg bg-wallet-surface text-left hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              >
                <span
                  className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-2 text-center"
                  style={{
                    backgroundImage: `radial-gradient(ellipse at 50% 0%, ${tint}88, transparent 80%)`
                  }}
                >
                  <ShieldProviderLogo provider={provider} size={38} />
                  <span className="text-sm font-medium leading-tight">{name}</span>
                </span>
                <span className="flex h-9 items-center justify-between gap-1 bg-white/5 px-2.5 text-xs">
                  {enablePath ? (
                    <span className="flex w-full items-center justify-between gap-1 text-primary">
                      <span>Enable Zcash</span>
                      <Icon icon="lucide:chevron-right" width={14} height={14} aria-hidden="true" />
                    </span>
                  ) : (
                    <>
                      <span className="flex min-w-0 shrink-0 items-center">
                        {card.icons.map((entry, index) => (
                          <TokenIcon
                            key={entry.key}
                            assetId={entry.assetId}
                            symbol={entry.symbol}
                            icon={entry.icon}
                            size={16}
                            className={index ? '-ml-1 shrink-0' : 'shrink-0'}
                          />
                        ))}
                      </span>
                      {showSkeleton ? (
                        <BalanceSkeleton />
                      ) : (
                        <span
                          className="min-w-0 truncate tabular-nums"
                          title={balancesHidden ? undefined : label}
                        >
                          {label}
                        </span>
                      )}
                    </>
                  )}
                </span>
              </button>
            )
          })}
      </div>
    </div>
  )
}
