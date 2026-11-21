import { Icon } from '@iconify/react'
import type { DAppExecutionMode, DAppExecutionModeState } from '@/core/dapp/dapp-execution-mode'
import { cn } from '@/lib/utils'
import { Tooltip } from '../ui/tooltip'

export function WalletModeSwitch({
  state,
  busy,
  onChange
}: {
  readonly state: DAppExecutionModeState | null
  readonly busy: boolean
  readonly onChange: (mode: DAppExecutionMode) => void
}) {
  const isPrivate = state?.mode === 'private'
  const canToggle = state !== null && !busy && (isPrivate || state.privateAvailable)
  const tooltip = busy
    ? 'DApp address updating'
    : canToggle
      ? isPrivate
        ? 'DApp address: Private'
        : 'DApp address: Public'
      : 'Private DApp address unavailable'

  return (
    <Tooltip content={tooltip} side="bottom">
      <button
        type="button"
        aria-label="Private DApp address"
        aria-pressed={isPrivate}
        aria-disabled={!canToggle}
        aria-busy={busy || undefined}
        onClick={() => {
          if (canToggle) onChange(isPrivate ? 'main' : 'private')
        }}
        className={cn(
          'wallet-interactive flex size-8 items-center justify-center rounded-md border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          isPrivate
            ? 'border-private/35 bg-private/12 text-private aria-disabled:opacity-65'
            : 'border-transparent text-wallet-secondary aria-disabled:opacity-45',
          canToggle ? 'hover:bg-white/10 active:bg-white/15' : 'cursor-default'
        )}
      >
        <Icon icon="noir:private-assets" width={19} height={19} aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
