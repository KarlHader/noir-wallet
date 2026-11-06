import type { DAppExecutionMode, DAppExecutionModeState } from '@/core/dapp/dapp-execution-mode'
import { cn } from '@/lib/utils'

export function WalletModeSwitch({
  state,
  busy,
  onChange
}: {
  readonly state: DAppExecutionModeState | null
  readonly busy: boolean
  readonly onChange: (mode: DAppExecutionMode) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Wallet mode"
      aria-busy={busy}
      className="flex h-8 w-[141px] shrink-0 items-center gap-1 rounded-xl bg-white/6 p-1"
    >
      {(['main', 'private'] as const).map(mode => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-label={mode === 'main' ? 'Public mode' : 'Private mode'}
          aria-checked={(state?.mode ?? 'main') === mode}
          title={
            mode === 'private' && !state?.privateAvailable
              ? 'Private mode unavailable for this account'
              : undefined
          }
          disabled={busy || !state || (mode === 'private' && !state.privateAvailable)}
          onClick={() => onChange(mode)}
          className={cn(
            'wallet-interactive h-6 min-w-0 flex-1 rounded-lg text-[13px] font-normal leading-[17px] enabled:active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45',
            (state?.mode ?? 'main') === mode && 'font-medium',
            (state?.mode ?? 'main') === mode
              ? mode === 'private'
                ? 'bg-wallet-mode text-white'
                : 'bg-wallet-selected text-foreground'
              : 'text-muted enabled:hover:bg-white/[0.06] enabled:hover:text-foreground'
          )}
        >
          {mode === 'main' ? 'Public' : 'Private'}
        </button>
      ))}
    </div>
  )
}
