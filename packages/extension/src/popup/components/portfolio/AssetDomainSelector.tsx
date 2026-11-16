import { useState } from 'react'
import { Icon } from '@iconify/react'
import { formatAssetDomainFiat, type AssetDomain } from '@/popup/services/asset-domains'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '@/lib/utils'
import { Skeleton } from '../ui/skeleton'

export const ASSET_DOMAIN_LABELS: Record<AssetDomain, string> = {
  all: 'Total assets',
  public: 'Public assets',
  shield: 'Shield assets',
  private: 'Private assets'
}

const ASSET_DOMAIN_ICONS: Record<AssetDomain, string> = {
  all: 'noir:total-assets',
  public: 'noir:public-assets',
  shield: 'noir:shield-assets',
  private: 'noir:private-assets'
}

export function AssetDomainSelector({
  value,
  totals,
  partialTotals,
  balancesHidden,
  loading,
  domains = Object.keys(ASSET_DOMAIN_LABELS) as AssetDomain[],
  onChange
}: {
  readonly value: AssetDomain
  readonly totals: Readonly<Record<AssetDomain, string | number | null>>
  readonly partialTotals?: Readonly<Record<AssetDomain, boolean>>
  readonly balancesHidden: boolean
  readonly loading?: Readonly<Record<AssetDomain, boolean>>
  readonly domains?: readonly AssetDomain[]
  readonly onChange: (domain: AssetDomain) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Asset category: ${ASSET_DOMAIN_LABELS[value]}`}
          className="wallet-interactive inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-sm text-foreground hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          <Icon
            icon={ASSET_DOMAIN_ICONS[value]}
            width={14}
            height={14}
            className={cn(
              value === 'shield'
                ? 'text-success'
                : value === 'private'
                  ? 'text-private'
                  : 'text-wallet-secondary'
            )}
          />
          {ASSET_DOMAIN_LABELS[value]}
          <Icon icon="lucide:chevron-down" width={12} height={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        sideOffset={8}
        className="w-[270px] max-w-[calc(100vw-24px)] border-0 px-0 py-2"
        aria-label="Asset categories"
      >
        <div role="radiogroup" aria-label="Asset category">
          {domains.map(domain => (
            <button
              key={domain}
              type="button"
              role="radio"
              aria-checked={value === domain}
              onClick={() => {
                onChange(domain)
                setOpen(false)
              }}
              className={cn(
                'wallet-interactive flex min-h-[38px] w-full items-center gap-2 px-3.5 py-2 text-left text-sm hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2',
                value === domain && 'bg-white/6'
              )}
            >
              <Icon
                icon={ASSET_DOMAIN_ICONS[domain]}
                width={15}
                height={15}
                className={cn(
                  'shrink-0',
                  (domain === 'all' || domain === 'public') && 'text-wallet-secondary',
                  domain === 'shield' && 'text-success',
                  domain === 'private' && 'text-private'
                )}
              />
              <span className="shrink-0">{ASSET_DOMAIN_LABELS[domain]}</span>
              {!balancesHidden && loading?.[domain] && totals[domain] === null ? (
                <Skeleton className="ml-auto h-4 w-16" />
              ) : (
                <span
                  className="ml-auto min-w-0 truncate text-right text-sm tabular-nums text-foreground"
                  title={
                    balancesHidden
                      ? undefined
                      : totals[domain] === null
                        ? '—'
                        : formatAssetDomainFiat(totals[domain], partialTotals?.[domain])
                  }
                >
                  {balancesHidden
                    ? '••••'
                    : totals[domain] === null
                      ? '—'
                      : formatAssetDomainFiat(totals[domain], partialTotals?.[domain])}
                </span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
