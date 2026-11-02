import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface InlineErrorProps {
  readonly message: ReactNode
  readonly onRetry?: () => void
  readonly retrying?: boolean
  readonly retryLabel?: string
  readonly tone?: 'error' | 'warning'
  readonly className?: string
}

export function InlineError({
  message,
  onRetry,
  retrying = false,
  retryLabel = 'Retry',
  tone = 'error',
  className
}: InlineErrorProps) {
  if (!message) return null

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex min-w-0 items-start gap-3 text-xs', className)}
    >
      <span
        className={cn(
          'min-w-0 flex-1 break-words',
          tone === 'error' ? 'text-danger' : 'text-warning'
        )}
      >
        {message}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          aria-busy={retrying || undefined}
          className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50"
        >
          {retryLabel}
        </button>
      )}
    </div>
  )
}
