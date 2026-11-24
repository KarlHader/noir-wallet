import { Icon } from '@iconify/react'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

export interface DAppAddressModeControl {
  readonly busy: boolean
  readonly incognitoAvailable: boolean
  readonly onChange: (mode: DAppExecutionMode) => void
}

export function DAppAddressModeSelector({
  executionMode,
  palette,
  control,
  compact = false,
  disabled = false
}: {
  readonly executionMode: DAppExecutionMode | null
  readonly palette?: 'public'
  readonly control: DAppAddressModeControl
  readonly compact?: boolean
  readonly disabled?: boolean
}) {
  const incognito = executionMode === 'private'
  const label = incognito ? 'Incognito' : 'Public'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={executionMode ? `DApp address: ${label}` : 'DApp address'}
          aria-busy={control.busy || undefined}
          data-incognito={incognito || undefined}
          disabled={!executionMode || control.busy || disabled}
          className={cn(
            'dapp-connection-control wallet-interactive flex shrink-0 items-center gap-1.5 rounded-lg px-2 text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60',
            compact ? 'h-8 text-xs' : 'h-10 text-sm'
          )}
        >
          <Icon
            icon={incognito ? 'noir:private-assets' : 'lucide:eye'}
            className="shrink-0"
            width={14}
            aria-hidden="true"
          />
          {executionMode ? label : '—'}
          <Icon icon="lucide:chevron-up" width={12} className="ml-auto" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" data-wallet-palette={palette}>
        <DropdownMenuRadioGroup
          value={executionMode ?? ''}
          onValueChange={value => {
            if (value === 'main' || value === 'private') control.onChange(value)
          }}
        >
          <DropdownMenuRadioItem value="main">
            <Icon icon="lucide:eye" aria-hidden="true" />
            Public
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="private" disabled={!control.incognitoAvailable}>
            <Icon icon="noir:private-assets" className="text-private" aria-hidden="true" />
            Incognito
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
