import { Icon } from '@iconify/react'
import type { ReactNode } from 'react'
import { Button } from '../ui/button'

export function TransactionActionReview({
  children,
  notice,
  backLabel = 'Back',
  onBack,
  confirmLabel,
  onConfirm,
  disabled,
  loading,
  backDisabled,
  destructive
}: {
  readonly children: ReactNode
  readonly notice?: ReactNode
  readonly backLabel?: string
  readonly onBack: () => void
  readonly confirmLabel: string
  readonly onConfirm: () => void
  readonly disabled?: boolean
  readonly loading?: boolean
  readonly backDisabled?: boolean
  readonly destructive?: boolean
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain pb-3">
        {children}
        {notice && (
          <div className="flex min-w-0 items-start gap-2 rounded-lg bg-warning/8 px-3 py-2.5 text-xs leading-4.5 text-foreground/85">
            <Icon
              icon="lucide:triangle-alert"
              className="mt-px size-3.5 shrink-0 text-warning"
              aria-hidden="true"
            />
            <div className="min-w-0">{notice}</div>
          </div>
        )}
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2.5 border-t border-border/60 pt-3">
        <Button type="button" variant="outline" disabled={backDisabled} onClick={onBack}>
          {backLabel}
        </Button>
        <Button
          type="button"
          variant={destructive ? 'destructive' : 'default'}
          disabled={disabled || loading}
          isLoading={loading}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}

export function TransactionActionRows({ children }: { readonly children: ReactNode }) {
  return <dl className="divide-y divide-border/60 border-y border-border/60">{children}</dl>
}

export function TransactionActionRow({
  label,
  children
}: {
  readonly label: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="flex min-h-10 min-w-0 items-center justify-between gap-3 py-2 text-sm">
      <dt className="min-w-0 text-muted">{label}</dt>
      <dd className="min-w-0 max-w-[60%] break-words text-right tabular-nums">{children}</dd>
    </div>
  )
}

export function TransactionActionDetails({
  children,
  label = 'Advanced'
}: {
  readonly children: ReactNode
  readonly label?: string
}) {
  return (
    <details className="group">
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-md text-xs font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        {label}
        <Icon
          icon="lucide:chevron-down"
          className="size-4 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      {children}
    </details>
  )
}
