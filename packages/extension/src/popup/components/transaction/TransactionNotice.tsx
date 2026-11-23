import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const styles = {
  error: 'bg-danger/10 text-danger',
  warning: 'bg-warning-surface text-warning',
  muted: 'bg-wallet-surface text-wallet-secondary'
} as const

interface TransactionNoticeProps {
  readonly message: ReactNode
  readonly tone?: keyof typeof styles
  readonly onRetry?: () => void
  readonly retryLabel?: string
  readonly retrying?: boolean
  readonly role?: 'alert' | 'status'
  readonly id?: string
  readonly className?: string
}

export function TransactionNotice({
  message,
  onRetry,
  tone = onRetry ? 'warning' : 'error',
  retryLabel = 'Try again',
  retrying = false,
  role = tone === 'error' ? 'alert' : 'status',
  id,
  className
}: TransactionNoticeProps) {
  if (!message) return null

  return (
    <div
      id={id}
      role={role}
      data-transaction-notice={tone}
      className={cn(
        'min-h-9 min-w-0 rounded-lg px-3 py-[9px] text-center text-sm leading-[18px] [overflow-wrap:anywhere]',
        className,
        styles[tone]
      )}
    >
      {message}
      {onRetry && (
        <>
          {' '}
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            aria-busy={retrying || undefined}
            className="inline cursor-pointer whitespace-nowrap rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50"
          >
            {retryLabel}
          </button>
        </>
      )}
    </div>
  )
}
