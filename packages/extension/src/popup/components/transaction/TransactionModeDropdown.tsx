import { Icon } from '@iconify/react'
import type { BalanceDomain } from '@/popup/components/account/BalanceDomainTabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/popup/components/ui/dropdown-menu'

const modeLabels = {
  public: 'Public',
  private: 'Incognito',
  shield: 'Shield'
} satisfies Record<BalanceDomain, string>

export const swapModeLabels = {
  public: 'Swap(Public)',
  private: 'Swap(Incognito)',
  shield: 'Private swap'
} satisfies Record<BalanceDomain, string>

export function TransactionModeDropdown({
  action,
  value,
  options,
  onChange,
  disabled
}: {
  readonly action: 'Send' | 'Swap'
  readonly value: BalanceDomain
  readonly options: readonly BalanceDomain[]
  readonly onChange: (mode: BalanceDomain) => void
  readonly disabled?: boolean
}) {
  const getLabel = (mode: BalanceDomain) =>
    action === 'Swap' ? swapModeLabels[mode] : `${modeLabels[mode]} ${action}`
  const title = getLabel(value)

  if (options.length < 2) return <span className="block truncate">{title}</span>

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="wallet-interactive group inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg px-2 enabled:hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-70"
        >
          <span className="truncate">{title}</span>
          <Icon
            icon="lucide:chevron-down"
            width={13}
            className="shrink-0 text-muted group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="min-w-44" aria-label={`${action} mode`}>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={next => {
            const option = options.find(mode => mode === next)
            if (option && option !== value) onChange(option)
          }}
        >
          {options.map(mode => (
            <DropdownMenuRadioItem key={mode} value={mode} className="min-h-10 justify-center px-8">
              {getLabel(mode)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
