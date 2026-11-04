import { Icon } from '@iconify/react'
import shieldMark from '@/images/figma-shield-mark.svg'
import nearLogo from '@/images/figma-near-confidential.svg'
import zcashLogo from '@/images/figma-zcash-shield.svg'
import { formatFiatAmount } from '@/lib/number-format'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { useNavigate } from '@/popup/provider/Router'
import { buildShieldProviderGroups, type ShieldProvider } from '@/popup/services/asset-domains'

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
  pricesLoading
}: {
  readonly model: PortfolioReadModel
  readonly mode: 'public' | 'private'
  readonly prices: AssetPriceReadModel | null
  readonly balancesHidden: boolean
  readonly pricesLoading: boolean
  readonly onSelectAsset?: (assetId: string) => void
}) {
  const { navigate } = useNavigate()
  const groups = buildShieldProviderGroups(model, prices)
  const modeQuery = `&mode=${mode}`

  return (
    <div className="min-h-full pb-5">
      <section
        className="relative flex h-[127px] min-w-0 flex-col justify-center overflow-hidden px-5"
        aria-label="Shield actions"
      >
        <img
          src={shieldMark}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute right-[30px] top-6 h-[109px] w-[98px]"
        />
        <h2 className="relative text-base font-medium leading-5">Shield</h2>
        <div className="relative mt-4 flex gap-2.5">
          <button
            type="button"
            onClick={() => navigate(`/transfer?from=shield&to=private&mode=${mode}`)}
            className="flex h-[34px] min-w-24 items-center justify-center gap-1 rounded-lg bg-[var(--color-wallet-surface)] px-3 text-sm hover:bg-[var(--color-wallet-selected)]"
          >
            <Icon icon="lucide:shield-check" width={15} height={15} className="text-[#1bc891]" />
            Withdraw
          </button>
          <button
            type="button"
            onClick={() => navigate(`/transfer?from=public&to=shield&mode=${mode}`)}
            className="flex h-[34px] min-w-24 items-center justify-center gap-1 rounded-lg bg-[var(--color-wallet-surface)] px-3 text-sm hover:bg-[var(--color-wallet-selected)]"
          >
            <Icon icon="lucide:shield-check" width={15} height={15} className="text-[#1bc891]" />
            Deposit
          </button>
        </div>
      </section>

      {groups.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">No Shield accounts</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 px-4">
          {groups.map(group => {
            const provider = SHIELD_PROVIDERS[group.id]
            return (
              <button
                key={group.id}
                type="button"
                aria-label={`Open ${provider.name}`}
                onClick={() => navigate(`/shield-provider?provider=${group.id}${modeQuery}`)}
                className="relative flex min-h-[153px] min-w-0 flex-col overflow-hidden rounded-xl bg-[var(--color-wallet-surface)] text-left transition-colors hover:brightness-110"
                style={{
                  backgroundImage: `radial-gradient(ellipse at 50% 0%, ${provider.tint}88, transparent 75%)`
                }}
              >
                <span className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-2">
                  <ShieldProviderLogo provider={group.id} />
                  <span
                    className="w-full truncate text-center text-base font-medium"
                    title={provider.name}
                  >
                    {provider.name}
                  </span>
                </span>
                <span className="flex min-h-[38px] min-w-0 items-center justify-between gap-1 bg-[var(--color-wallet-selected)]/75 px-2.5 py-1">
                  <span className="flex min-w-0 items-center pl-1">
                    {group.entries.slice(0, 4).map((entry, index) => (
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
                  <span className="min-w-0 max-w-[72%] break-all text-right text-sm font-medium leading-4">
                    {balancesHidden
                      ? '••••'
                      : group.fiat === null
                        ? pricesLoading
                          ? '…'
                          : '—'
                        : formatFiatAmount(group.fiat, { showSign: true })}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
