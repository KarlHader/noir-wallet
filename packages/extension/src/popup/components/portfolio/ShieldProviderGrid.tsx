import { Icon } from '@iconify/react'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import { formatFiatAmount } from '@/lib/number-format'
import type { Network } from '@/types'
import { useShieldBalances } from '@/popup/hooks/useShieldBalances'
import { useNavigate } from '@/popup/provider/Router'
import type { AccountNetworksView } from '@/popup/services/account-networks-client'
import { buildShieldProviderGroups, type ShieldProviderGroup } from '@/popup/services/asset-domains'
import type { NearConfidentialSummary } from '@/popup/services/near-confidential-holdings'
import type { PortfolioSnapshot } from '@/popup/services/portfolio-snapshot-store'
import type { selectShieldActions } from '@/popup/services/shield-action-selection'
import {
  nearConfidentialVaultIcons,
  zcashShieldVaultIcons
} from '@/popup/services/shield-vault-display-icons'
import {
  resolveShieldZcashVaultEntry,
  shieldZcashEnablePath
} from '@/popup/services/shield-zcash-entry'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
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
  const { connecting, error, refreshBalances } = useShieldBalances({
    active: true,
    enabled: canManageNear && near.status !== 'ready',
    scopeKey: `${network}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`,
    scope: account ? { network, keyDomainId: account.walletId, accountId: account.accountId } : null
  })
  const zcash = model
    ? buildShieldProviderGroups(model, prices).find(group => group.id === 'zcash-shield')
    : undefined
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
      <ShieldProviderGrid
        network={network}
        account={account}
        mode="public"
        near={near}
        zcash={zcash}
        canManageNear={canManageNear}
        hasZcash={hasZcash}
        balancesHidden={balancesHidden}
        loading={status === 'loading'}
        nearLoading={connecting}
        pricesLoading={pricesLoading}
      />
    </div>
  )
}

export function ShieldProviderGrid({
  network,
  account,
  mode,
  near,
  zcash,
  canManageNear,
  hasZcash,
  balancesHidden,
  loading,
  nearLoading,
  pricesLoading
}: {
  readonly network: Network
  readonly account: AccountNetworksView | null
  readonly mode: 'public' | 'private'
  readonly near: NearConfidentialSummary
  readonly zcash: ShieldProviderGroup | undefined
  readonly canManageNear: boolean
  readonly hasZcash: boolean
  readonly balancesHidden: boolean
  readonly loading: boolean
  readonly nearLoading: boolean
  readonly pricesLoading: boolean
}) {
  const { navigate } = useNavigate()
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
      loading: loading || nearLoading,
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
    <div className="grid grid-cols-2 gap-3">
      {cards
        .filter(card => card.visible)
        .map(card => {
          const { provider } = card
          const { name, tint } = SHIELD_PROVIDERS[provider]
          const needsZcash = provider === 'zcash-shield' && !zcashEntry.hasActiveZcash
          const enablePath = needsZcash ? enableZcashPath : null
          const label = needsZcash
            ? '—'
            : balancesHidden
              ? '••••'
              : card.fiat === null
                ? card.loading
                  ? '…'
                  : '—'
                : formatFiatAmount(card.fiat, { showSign: true })

          return (
            <button
              key={provider}
              type="button"
              onClick={() =>
                navigate(enablePath ?? `/shield-provider?provider=${provider}&mode=${mode}`)
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
                    <span
                      className="min-w-0 truncate tabular-nums"
                      title={balancesHidden ? undefined : label}
                    >
                      {label}
                    </span>
                  </>
                )}
              </span>
            </button>
          )
        })}
    </div>
  )
}
