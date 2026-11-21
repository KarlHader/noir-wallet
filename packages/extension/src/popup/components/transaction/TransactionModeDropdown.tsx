import { Icon } from '@iconify/react'
import type { BalanceDomain } from '@/popup/components/account/BalanceDomainTabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/popup/components/ui/dropdown-menu'

const modes = {
  public: { label: 'Public', icon: 'lucide:wallet', color: 'text-wallet-secondary' },
  private: { label: 'Private', icon: 'noir:private-assets', color: 'text-private' },
  shield: { label: 'Shield', icon: 'noir:shield-assets', color: 'text-success' }
} satisfies Record<BalanceDomain, { label: string; icon: string; color: string }>

export function TransactionModeDropdown({
  value,
  options,
  onChange,
  disabled
}: {
  readonly value: BalanceDomain
  readonly options: readonly BalanceDomain[]
  readonly onChange: (mode: BalanceDomain) => void
  readonly disabled?: boolean
}) {
  const selected = modes[value]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Mode: ${selected.label}`}
          disabled={disabled || options.length < 2}
          className="wallet-interactive inline-flex h-8 min-w-[96px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-wallet-surface px-2 text-xs font-medium enabled:hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-70"
        >
          <Icon icon={selected.icon} width={14} className={selected.color} aria-hidden="true" />
          <span className="flex-1 text-left">{selected.label}</span>
          {options.length > 1 && (
            <Icon icon="lucide:chevron-down" width={13} className="text-muted" aria-hidden="true" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Transaction mode">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={next => {
            const option = options.find(mode => mode === next)
            if (option && option !== value) onChange(option)
          }}
        >
          {options.map(mode => (
            <DropdownMenuRadioItem key={mode} value={mode}>
              <Icon icon={modes[mode].icon} className={modes[mode].color} aria-hidden="true" />
              {modes[mode].label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
