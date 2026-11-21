import { useState } from 'react'
import { Icon } from '@iconify/react'
import { formatAssetDomainFiat, type AssetDomain } from '@/popup/services/asset-domains'
import type { HomeAssetDomain } from '@/popup/services/home-navigation'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '@/lib/utils'
import { Skeleton } from '../ui/skeleton'

const BALANCE_MODES = {
  public: { label: 'Public', icon: 'lucide:wallet', color: 'text-wallet-secondary' },
  private: { label: 'Private', icon: 'noir:private-assets', color: 'text-private' },
  shield: { label: 'Shield', icon: 'noir:shield-assets', color: 'text-success' }
} satisfies Record<HomeAssetDomain, { label: string; icon: string; color: string }>

const BALANCE_DOMAINS = ['public', 'private', 'shield'] as const

export function AssetDomainSelector({
  value,
  totals,
  balancesHidden,
  loading,
  domains = BALANCE_DOMAINS,
  onChange
}: {
  readonly value: HomeAssetDomain
  readonly totals: Readonly<Record<AssetDomain, string | number | null>>
  readonly balancesHidden: boolean
  readonly loading?: Readonly<Record<AssetDomain, boolean>>
  readonly domains?: readonly HomeAssetDomain[]
  readonly onChange: (domain: HomeAssetDomain) => void
}) {
  const [open, setOpen] = useState(false)
  const mode = BALANCE_MODES[value]
  const renderAmount = (domain: AssetDomain, className: string) => {
    const total = totals[domain]
    if (!balancesHidden && total === null && loading?.[domain]) {
      return (
        <Skeleton className={cn('h-4 w-12 max-w-full', className)} aria-label="Loading balance" />
      )
    }
    const amount = balancesHidden ? '••••' : total === null ? '—' : formatAssetDomainFiat(total)
    return (
      <span
        className={cn('min-w-0 truncate tabular-nums', className)}
        title={balancesHidden ? undefined : amount}
      >
        {amount}
      </span>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="wallet-interactive inline-flex h-8 w-[164px] max-w-full items-center gap-2 rounded-lg bg-white/6 px-2.5 text-sm text-foreground hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 data-[state=open]:bg-white/10"
        >
          <Icon
            icon={mode.icon}
            width={16}
            height={16}
            className={cn('shrink-0', mode.color)}
            aria-hidden="true"
          />
          <span className="whitespace-nowrap">{mode.label} balance</span>
          <Icon
            icon="lucide:chevron-down"
            width={15}
            height={15}
            className={cn('ml-auto shrink-0 text-wallet-secondary', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        sideOffset={8}
        className="w-[270px] max-w-[calc(100vw-24px)] border-white/10 p-2 text-left"
        aria-label="Balance breakdown"
      >
        <div className="mb-1 flex min-h-9 items-center gap-2 pl-2.5 pr-[34px] text-sm">
          <span className="shrink-0 text-wallet-secondary">Total balance</span>
          {renderAmount('all', 'ml-auto text-right font-medium text-foreground')}
        </div>
        <div role="group" aria-label="Balance mode" className="grid gap-0.5">
          {domains.map(domain => {
            const option = BALANCE_MODES[domain]
            return (
              <button
                key={domain}
                type="button"
                aria-pressed={value === domain}
                onClick={() => {
                  onChange(domain)
                  setOpen(false)
                }}
                className="wallet-interactive grid min-h-10 min-w-0 grid-cols-[24px_auto_minmax(0,1fr)_14px] items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-wallet-secondary hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 aria-pressed:bg-white/9 aria-pressed:text-foreground"
              >
                <span className="grid size-6 place-items-center rounded-md bg-white/5">
                  <Icon
                    icon={option.icon}
                    width={15}
                    height={15}
                    className={option.color}
                    aria-hidden="true"
                  />
                </span>
                <span className="font-medium">{option.label}</span>
                {renderAmount(domain, 'justify-self-end text-right')}
                <Icon
                  icon="lucide:check"
                  width={14}
                  height={14}
                  className={cn('text-primary', value !== domain && 'invisible')}
                  aria-hidden="true"
                />
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
