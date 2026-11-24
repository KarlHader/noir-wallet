import { useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import incognitoWatermark from '@/images/figma-incognito-watermark.svg'
import { formatAssetDomainFiat } from '@/popup/services/asset-domains'
import type { HomeAssetDomainDisplay } from '@/popup/services/home-asset-breakdown'
import type { HomeAssetDomain } from '@/popup/services/home-navigation'
import { BalanceSkeleton } from '../ui/skeleton'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

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
  hidden,
  modeSelectionDisabled,
  quickShieldLabel,
  onQuickShield,
  onToggleHidden,
  onSelect
}: HomeBalanceOverviewProps) {
  const [setupOpen, setSetupOpen] = useState(false)
  const setupTrigger = useRef<HTMLButtonElement>(null)
  const canSetUpIncognito = showIncognito && !incognitoEnabled
  const cards = balanceCards.filter(
    card => card.domain !== 'private' || (showIncognito && incognitoEnabled)
  )

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
                          <p className="home-balance-description">
                            Combined balance across privacy providers.
                          </p>
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
                      {cardDomain === 'public' && canSetUpIncognito && (
                        <button
                          ref={setupTrigger}
                          type="button"
                          aria-label="Enable Incognito"
                          aria-haspopup="dialog"
                          disabled={modeSelectionDisabled}
                          onClick={() => setSetupOpen(true)}
                          className="wallet-interactive mt-auto ml-auto min-h-8 shrink-0 rounded-md border border-dashed border-current/35 px-3 text-sm hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                        >
                          + Incognito
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <Dialog
        open={setupOpen && canSetUpIncognito && domain === 'public'}
        onOpenChange={setSetupOpen}
      >
        <DialogContent
          position="bottom"
          overlayClassName="bg-black/55 backdrop-blur-none"
          className="home-wallet-sheet h-[70dvh] gap-4 rounded-t-[20px] px-4 pt-4 pb-6"
          onCloseAutoFocus={event => {
            if (!setupTrigger.current) return
            event.preventDefault()
            setupTrigger.current.focus()
          }}
        >
          <DialogTitle className="pr-10 text-lg font-medium">+ Incognito</DialogTitle>
          <div className="mx-3 mt-3 space-y-4 text-center">
            <div
              data-balance-domain="private"
              data-expanded="true"
              aria-hidden="true"
              className="home-balance-card home-balance-preview relative isolate h-[140px] overflow-hidden rounded-xl p-3.5 text-left"
            >
              <div className="flex justify-between gap-2 text-sm">
                <span>Incognito</span>
                <span className="text-lg font-semibold">$••••</span>
              </div>
              <img className="mt-4 size-[70px] opacity-35" src={incognitoWatermark} alt="" />
            </div>
            <h3 className="text-lg font-medium">Incognito Wallet</h3>
            <DialogDescription className="px-3 pt-3 leading-[18px] text-wallet-secondary">
              Use a separate address for DeFi. Your existing recovery phrase backs up this wallet
              too.
            </DialogDescription>
            <Button
              size="wallet"
              className="mt-4 w-[94%]"
              disabled={modeSelectionDisabled}
              onClick={() => {
                setSetupOpen(false)
                onSelect('private')
              }}
            >
              Create Now
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
