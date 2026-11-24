import { Icon } from '@iconify/react'
import incognitoWatermark from '@/images/figma-incognito-watermark.svg'
import { cn } from '@/lib/utils'
import { formatAssetDomainFiat } from '@/popup/services/asset-domains'
import type { HomeAssetDomainDisplay } from '@/popup/services/home-asset-breakdown'
import type { HomeAssetDomain } from '@/popup/services/home-navigation'
import { BalanceSkeleton } from '../ui/skeleton'

const balanceCards = [
  { domain: 'shield', label: 'Shield' },
  { domain: 'public', label: 'Public' },
  { domain: 'private', label: 'Incognito' }
] as const

export interface HomeBalanceOverviewProps {
  readonly domain: HomeAssetDomain
  readonly display: HomeAssetDomainDisplay
  readonly showIncognito: boolean
  readonly incognitoEnabled: boolean
  readonly hidden: boolean
  readonly modeSelectionDisabled: boolean
  readonly onToggleHidden: () => void
  readonly onSelect: (domain: HomeAssetDomain) => void
}

export function HomeBalanceOverview({
  domain,
  display,
  showIncognito,
  incognitoEnabled,
  hidden,
  modeSelectionDisabled,
  onToggleHidden,
  onSelect
}: HomeBalanceOverviewProps) {
  const cards = balanceCards.filter(card => showIncognito || card.domain !== 'private')
  const activeIndex = cards.findIndex(card => card.domain === domain)

  function balance(cardDomain: HomeAssetDomain | 'all', skeleton: string) {
    if (hidden) return <span aria-label="Balance hidden">••••</span>
    if (display.loading[cardDomain]) return <BalanceSkeleton className={skeleton} />
    return (
      <span className="tabular-nums wrap-anywhere">
        {formatAssetDomainFiat(display.totals[cardDomain], display.partial[cardDomain])}
      </span>
    )
  }

  return (
    <section aria-label="Wallet balances" className="shrink-0 px-4 pt-2 pb-3">
      <div className="mb-2.5 flex items-center gap-1">
        <div data-testid="home-total-assets" className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-sm font-medium text-muted">Total</span>
          <div className="min-w-0 text-xl leading-7 font-semibold">
            {balance('all', 'h-5 w-24')}
          </div>
        </div>
        <button
          type="button"
          aria-label={hidden ? 'Show balances' : 'Hide balances'}
          aria-pressed={hidden}
          onClick={onToggleHidden}
          className="wallet-interactive flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Icon icon={hidden ? 'lucide:eye-off' : 'lucide:eye'} width={15} />
        </button>
      </div>

      <div
        role="group"
        aria-label="Wallet balance mode"
        className="relative isolate grid h-[104px]"
        style={{
          gridTemplateColumns: cards
            .map(card => (card.domain === domain ? 'minmax(0, 1fr)' : 'min(23%, 96px)'))
            .join(' ')
        }}
      >
        {cards.map(({ domain: cardDomain, label }, index) => {
          const isIncognito = cardDomain === 'private'
          const setup = isIncognito && !incognitoEnabled
          const selected = cardDomain === domain
          const distance = Math.abs(activeIndex - index)
          return (
            <button
              key={cardDomain}
              type="button"
              aria-label={setup ? 'Enable Incognito' : `${label} balance`}
              aria-pressed={setup ? undefined : selected}
              disabled={modeSelectionDisabled}
              onClick={() => onSelect(cardDomain)}
              className={cn(
                'home-balance-card wallet-interactive relative isolate flex min-w-0 flex-col justify-center gap-1 rounded-xl enabled:hover:brightness-105 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                selected ? 'items-start px-4 text-left' : 'items-center px-1 text-center'
              )}
              style={{ marginBlock: distance * 6, zIndex: cards.length - distance }}
              data-balance-domain={cardDomain}
              data-peek={selected ? undefined : index < activeIndex ? 'left' : 'right'}
              data-balance-setup={setup || undefined}
            >
              {isIncognito && selected && (
                <img
                  src={incognitoWatermark}
                  alt=""
                  width={32}
                  height={32}
                  className="home-balance-watermark pointer-events-none absolute right-1 bottom-1 -z-10"
                />
              )}
              <span
                className={cn(
                  'flex min-w-0 items-center gap-1 font-medium',
                  selected ? 'text-sm leading-5' : 'text-xs leading-5'
                )}
              >
                <span className="home-balance-indicator size-1.5 shrink-0 rounded-full" />
                {label}
              </span>
              {setup ? (
                <span className="home-balance-plus grid size-5 place-items-center rounded-full border">
                  <Icon icon="lucide:plus" width={13} aria-hidden="true" />
                </span>
              ) : (
                <span
                  className={cn(
                    'home-balance-amount min-w-0 max-w-full overflow-hidden font-semibold',
                    selected ? 'text-[28px] leading-9' : 'text-xs leading-5'
                  )}
                >
                  {balance(cardDomain, 'h-3.5 w-12 bg-current/15')}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
