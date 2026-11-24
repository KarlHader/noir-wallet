import { Icon } from '@iconify/react'
import { formatFiatAmount } from '@/lib/number-format'
import type { HomeAssetDomainDisplay } from '@/popup/services/home-asset-breakdown'
import type { HomeAssetDomain } from '@/popup/services/home-navigation'
import { BalanceSkeleton } from '../ui/skeleton'
import { IncognitoSetupButton } from '../account/IncognitoSetupButton'

const balanceCards = [
  { domain: 'shield', label: 'Shield', icon: 'lucide:shield-check' },
  { domain: 'public', label: 'Public', icon: 'lucide:eye' },
  { domain: 'private', label: 'Incognito', icon: 'noir:private-assets' }
] as const

export interface HomeBalanceOverviewProps {
  readonly domain: HomeAssetDomain
  readonly display: HomeAssetDomainDisplay
  readonly showIncognito: boolean
  readonly incognitoEnabled: boolean
  readonly onEnableIncognito?: () => Promise<boolean>
  readonly hidden: boolean
  readonly modeSelectionDisabled: boolean
  readonly quickShieldLabel?: string
  readonly onQuickShield?: (trigger: HTMLButtonElement) => void
  readonly onToggleHidden: () => void
  readonly onSelect: (domain: HomeAssetDomain) => void
}

export function HomeBalanceOverview({
  domain,
  display,
  showIncognito,
  incognitoEnabled,
  onEnableIncognito,
  hidden,
  modeSelectionDisabled,
  quickShieldLabel,
  onQuickShield,
  onToggleHidden,
  onSelect
}: HomeBalanceOverviewProps) {
  const canSetUpIncognito = showIncognito && !incognitoEnabled
  const cards = balanceCards.filter(
    card => card.domain !== 'private' || (showIncognito && incognitoEnabled)
  )

  function balance(cardDomain: HomeAssetDomain | 'all', skeleton: string) {
    if (hidden) return <span aria-label="Balance hidden">••••</span>
    if (display.loading[cardDomain]) return <BalanceSkeleton className={skeleton} />
    return (
      <span
        className="tabular-nums wrap-anywhere"
        title={
          display.partial[cardDomain] && display.totals[cardDomain] !== null
            ? 'Partial balance'
            : undefined
        }
      >
        {formatFiatAmount(display.totals[cardDomain], { showSign: true })}
      </span>
    )
  }

  return (
    <section aria-label="Wallet balances" className="shrink-0 px-4">
      <div className="mb-1.5 flex h-[27px] items-center gap-1">
        <div data-testid="home-total-assets" className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-sm text-[#bcbcc8]">Total</span>
          <div className="min-w-0 text-sm leading-5">{balance('all', 'h-4 w-20')}</div>
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
        className="home-balance-stack relative isolate"
        data-active-domain={domain}
      >
        {cards.map(({ domain: cardDomain, label, icon }) => {
          const selected = cardDomain === domain
          return (
            <div
              key={cardDomain}
              className="home-balance-card home-balance-stack-card relative isolate min-h-0 min-w-0 rounded-t-2xl"
              data-balance-domain={cardDomain}
              data-expanded={selected || undefined}
            >
              <div className="h-full overflow-hidden rounded-t-[inherit]">
                <button
                  type="button"
                  aria-label={`${label} balance`}
                  aria-pressed={selected}
                  disabled={modeSelectionDisabled}
                  onClick={() => onSelect(cardDomain)}
                  className="wallet-interactive home-balance-card-button flex w-full min-w-0 items-baseline justify-between gap-2 rounded-t-2xl px-3.5 text-left enabled:hover:brightness-110 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="home-balance-card-label flex shrink-0 items-center gap-2">
                    <span className="home-balance-indicator size-2 shrink-0 rounded-full" />
                    {label}
                  </span>
                  <span className="home-balance-card-amount min-w-0 text-right">
                    {balance(
                      cardDomain,
                      selected ? 'h-5 w-20 bg-current/15' : 'h-3.5 w-14 bg-current/15'
                    )}
                  </span>
                </button>
                <div className="home-balance-card-body" inert={!selected}>
                  <div className="min-h-0 overflow-hidden">
                    <div className="flex min-h-[84px] items-start gap-3 px-3.5 pb-1.5">
                      <Icon
                        icon={icon}
                        className="home-balance-watermark size-[60px] shrink-0"
                        aria-hidden="true"
                      />
                      {cardDomain === 'shield' && (
                        <div className="min-w-0 flex-1 pt-2 text-[13px] leading-[17px]">
                          <p className="home-balance-description">Total across privacy providers</p>
                          {quickShieldLabel && onQuickShield && (
                            <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2">
                              <span className="min-w-0 wrap-anywhere">
                                {quickShieldLabel} available to shield
                              </span>
                              <button
                                type="button"
                                aria-haspopup="dialog"
                                className="wallet-interactive inline-flex min-h-8 shrink-0 items-center gap-1 rounded text-[#28f4af] hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                                onClick={event => onQuickShield(event.currentTarget)}
                              >
                                Shield{' '}
                                <Icon icon="lucide:arrow-right" width={13} aria-hidden="true" />
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      {cardDomain === 'public' && canSetUpIncognito && onEnableIncognito && (
                        <IncognitoSetupButton
                          disabled={modeSelectionDisabled}
                          complete={onEnableIncognito}
                          onCompleted={() => onSelect('private')}
                          className="mt-auto ml-auto"
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
