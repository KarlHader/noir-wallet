import { cn } from '@/lib/utils'
import { Icon } from '@iconify/react'

export type TransactionStatus =
  | 'loading'
  | 'submitted'
  | 'neutral'
  | 'success'
  | 'failed'
  | 'warning'

interface TransactionResultProps {
  status: TransactionStatus
  title: string
  description?: string
  layout?: 'default' | 'single-asset'
  onClose?: () => void
  closeDisabled?: boolean
  showStatus?: boolean
  children?: React.ReactNode
  footer?: React.ReactNode
  className?: string
  bodyClassName?: string
}

const statusConfig = {
  loading: {
    iconClass: 'animate-spin text-foreground/70',
    bgClass: 'bg-foreground/10'
  },
  submitted: {
    iconClass: 'text-foreground/70',
    bgClass: 'bg-foreground/10'
  },
  neutral: {
    iconClass: 'text-foreground/70',
    bgClass: 'bg-foreground/10'
  },
  success: {
    iconClass: 'text-primary',
    bgClass: 'bg-primary/20'
  },
  failed: {
    iconClass: 'text-danger',
    bgClass: 'bg-danger/15'
  },
  warning: {
    iconClass: 'text-warning',
    bgClass: 'bg-warning-surface'
  }
}

function ResultStatusIcon({ status, className }: { status: TransactionStatus; className: string }) {
  if (status === 'loading') {
    return (
      <span
        className="size-9 animate-spin rounded-full border-[3px] border-primary/20 border-t-primary"
        aria-hidden="true"
      />
    )
  }

  return (
    <Icon
      icon={
        status === 'submitted'
          ? 'lucide:send'
          : status === 'neutral'
            ? 'lucide:circle-minus'
            : status === 'success'
              ? 'lucide:check'
              : status === 'failed'
                ? 'lucide:x'
                : 'lucide:rotate-ccw'
      }
      width={36}
      height={36}
      className={className}
      aria-hidden="true"
    />
  )
}

export function TransactionResult({
  status,
  title,
  description,
  layout = 'default',
  onClose,
  closeDisabled = false,
  showStatus = true,
  children,
  footer,
  className,
  bodyClassName
}: TransactionResultProps) {
  const config = statusConfig[status]
  const singleAsset = layout === 'single-asset'

  return (
    <div
      className={cn(
        'relative flex min-h-0 flex-1 flex-col items-center px-5 pb-5',
        singleAsset ? 'pt-14' : 'pt-5',
        className
      )}
    >
      {onClose && (
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          disabled={closeDisabled}
          className="absolute right-5 top-3 z-10 flex size-8 items-center justify-center rounded-md bg-background hover:bg-accent disabled:opacity-50"
        >
          <Icon icon="lucide:x" width={22} height={22} />
        </button>
      )}
      <div className="flex-1 flex flex-col items-center w-full overflow-y-auto min-h-0">
        {showStatus && (
          <>
            <div
              data-result-icon
              role={status === 'loading' ? 'status' : undefined}
              aria-live={status === 'loading' ? 'polite' : undefined}
              aria-label={status === 'loading' ? title : undefined}
              className={cn(
                'rounded-full flex items-center justify-center mb-4 shrink-0',
                singleAsset ? 'size-16' : 'size-20',
                config.bgClass
              )}
            >
              <ResultStatusIcon status={status} className={config.iconClass} />
            </div>

            <h2 className="mb-2 text-center text-xl font-semibold">{title}</h2>
            {description && <p className="text-sm text-muted mb-5 text-center">{description}</p>}
          </>
        )}

        <div
          className={cn(
            'w-full space-y-4',
            singleAsset ? 'mt-10 mb-4' : showStatus ? 'my-4' : 'mb-4',
            bodyClassName
          )}
        >
          {children}
        </div>
      </div>

      <div className="w-full mt-4 shrink-0">{footer}</div>
    </div>
  )
}

export function TransactionResultDetailRow({
  label,
  children
}: {
  readonly label: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border/60 py-4 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 break-all text-right font-medium">{children}</span>
    </div>
  )
}
