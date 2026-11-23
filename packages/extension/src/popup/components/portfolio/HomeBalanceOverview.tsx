import { Icon } from '@iconify/react'
import incognitoWatermark from '@/images/figma-incognito-watermark.svg'
import shieldProviderMarks from '@/images/figma-shield-provider-marks.svg'
import { cn } from '@/lib/utils'
import { formatAssetDomainFiat } from '@/popup/services/asset-domains'
import type { HomeAssetDomain } from '@/popup/services/home-navigation'
import type { HomeAssetDomainDisplay } from '@/popup/services/home-asset-breakdown'
import { BalanceSkeleton } from '../ui/skeleton'

export function HomeBalanceOverview({
  domain,
  display,
  walletTotal,
  showIncognito,
  hidden,
  modeSelectionDisabled,
  onToggleHidden,
  onSelect
}: {
  readonly domain: HomeAssetDomain
  readonly display: HomeAssetDomainDisplay
  readonly walletTotal: string | null
  readonly showIncognito: boolean
  readonly hidden: boolean
  readonly modeSelectionDisabled: boolean
  readonly onToggleHidden: () => void
  readonly onSelect: (domain: 'public' | 'private') => void
}) {
  function balance(value: string | null, loading: boolean, skeleton: string) {
    if (hidden) return <span aria-label="Balance hidden">••••</span>
    if (loading) return <BalanceSkeleton className={skeleton} />
    return (
      <span className="block truncate tabular-nums" title={formatAssetDomainFiat(value)}>
        {formatAssetDomainFiat(value)}
      </span>
    )
  }

  const visibilityToggle = (
    <button
      type="button"
      aria-label={hidden ? 'Show balances' : 'Hide balances'}
      aria-pressed={hidden}
      onClick={onToggleHidden}
      className="wallet-interactive flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Icon icon={hidden ? 'lucide:eye-off' : 'lucide:eye'} width={15} />
    </button>
  )

  if (domain === 'shield') {
    return (
      <section aria-label="Shield balance" className="px-4 pt-3 pb-3 text-center">
        <div className="mx-auto flex w-fit max-w-full items-center gap-1 pl-8">
          <div
            data-testid="home-total-assets"
            className="min-w-0 text-[32px] leading-[38px] font-semibold"
          >
            {balance(display.totals.shield, display.loading.shield, 'h-9 w-36')}
          </div>
          {visibilityToggle}
        </div>
        <p className="mt-[3px] text-sm text-wallet-secondary">Shield balance</p>
        <img
          src={shieldProviderMarks}
          alt=""
          width={156}
          height={18}
          className="mx-auto mt-5 block max-w-full"
        />
        <p className="mt-2 text-[13px] leading-[17px] text-muted">
          Your combined balance across privacy providers.
        </p>
      </section>
    )
  }

  return (
    <section aria-label="Wallet balances" className="px-4 pt-2 pb-3">
      <div className="mb-2.5 flex h-[21px] items-center gap-1 text-base leading-[21px] font-medium text-muted">
        <div data-testid="home-total-assets" className="flex min-w-0 items-center gap-1.5">
          <span>Total</span>
          {balance(
            walletTotal,
            display.loading.public || (showIncognito && display.loading.private),
            'h-4 w-16'
          )}
        </div>
        {visibilityToggle}
      </div>
      <div role="group" aria-label="Wallet balance mode" className="relative isolate h-28">
        {(['public', 'private'] as const)
          .filter(mode => showIncognito || mode === 'public')
          .map(mode => {
            const selected = domain === mode
            const incognito = mode === 'private'
            const label = incognito ? 'Incognito' : 'Public'
            return (
              <button
                key={mode}
                type="button"
                aria-label={`${label} balance`}
                aria-pressed={selected}
                disabled={modeSelectionDisabled}
                onClick={() => onSelect(mode)}
                className={cn(
                  'home-balance-card wallet-interactive absolute flex min-w-0 flex-col overflow-hidden rounded-xl border px-[13px] text-left enabled:hover:brightness-110 focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  selected
                    ? 'top-0 z-10 h-28 w-[61.225%] gap-2 pt-[18px]'
                    : 'top-3.5 h-[84px] w-[42%] gap-2 pt-4',
                  incognito ? 'right-0' : 'left-0',
                  incognito && !selected && 'pl-5',
                  !showIncognito && 'w-full'
                )}
                data-balance-domain={mode}
              >
                <span className="relative z-10 flex min-w-0 items-center gap-[6px] text-sm leading-[18px]">
                  <span className="home-balance-indicator size-[7px] shrink-0 rounded-full" />
                  <span className="truncate">{label}</span>
                </span>
                {incognito && (
                  <img
                    src={incognitoWatermark}
                    alt=""
                    width={40}
                    height={40}
                    className="home-balance-watermark pointer-events-none absolute top-[15px] right-[14px]"
                  />
                )}
                <span
                  className={cn(
                    'home-balance-amount relative z-10 min-w-0 font-semibold',
                    selected ? 'text-[26px] leading-[37px]' : 'text-sm leading-[18px]'
                  )}
                >
                  {balance(
                    display.totals[mode],
                    display.loading[mode],
                    'h-5 w-16 max-w-full bg-current/15'
                  )}
                </span>
              </button>
            )
          })}
      </div>
    </section>
  )
}
