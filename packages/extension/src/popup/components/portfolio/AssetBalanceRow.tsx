import type { ReactNode } from 'react'
import { WalletActionIcon } from '@/popup/components/common/WalletActionIcon'
import { Tooltip } from '@/popup/components/ui/tooltip'

export function AssetBalanceRow({
  label,
  subtitle,
  balance,
  fiat,
  pending,
  actions = []
}: {
  readonly label: string
  readonly subtitle?: ReactNode
  readonly balance: ReactNode
  readonly fiat: string
  readonly pending?: ReactNode
  readonly actions?: readonly {
    readonly action: 'send' | 'receive' | 'move' | 'swap'
    readonly label: string
    readonly onClick: () => void
    readonly disabled?: boolean
  }[]
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="group/balance flex min-h-[62px] items-center justify-between gap-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted">{subtitle}</div>
      </div>
      <div className="relative min-w-0 max-w-[48%] text-right">
        <div
          className={
            actions.length
              ? 'group-hover/balance:invisible group-focus-within/balance:invisible'
              : undefined
          }
        >
          <div className="truncate text-sm">{balance}</div>
          <p className="mt-1 text-xs text-muted">{fiat}</p>
          {pending && <p className="mt-1 text-xs text-muted">{pending}</p>}
        </div>
        {actions.length > 0 && (
          <div className="pointer-events-none absolute right-0 top-1/2 flex -translate-y-1/2 gap-1.5 bg-background opacity-0 group-hover/balance:pointer-events-auto group-hover/balance:opacity-100 group-focus-within/balance:pointer-events-auto group-focus-within/balance:opacity-100">
            {actions.map(({ action, label: actionLabel, onClick, disabled }) => (
              <Tooltip key={action} content={actionLabel}>
                <button
                  type="button"
                  aria-label={actionLabel}
                  onClick={onClick}
                  disabled={disabled}
                  className="wallet-interactive flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-card hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
                >
                  <WalletActionIcon action={action} size={18} />
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
