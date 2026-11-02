import { InlineError } from './InlineError'

interface BlockingWalletFailureProps {
  title: string
  description: string
  assurance: string
  isRetrying: boolean
  onRetry: () => void
}

export function BlockingWalletFailure({
  title,
  description,
  assurance,
  isRetrying,
  onRetry
}: BlockingWalletFailureProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-5 py-8 text-center">
        <div className="mb-6 flex size-16 items-center justify-center rounded-full border border-warning/30 bg-warning/10 text-warning">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width={30}
            height={30}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
            <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </div>
        <h1 className="mb-3 text-xl font-semibold text-foreground">{title}</h1>
        <InlineError
          className="w-full max-w-sm text-left"
          message={description}
          onRetry={onRetry}
          retrying={isRetrying}
        />
        <div className="mt-6 flex w-full max-w-sm gap-3 rounded-2xl border border-border bg-card p-4 text-left">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width={20}
            height={20}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mt-0.5 shrink-0 text-primary"
          >
            <path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <p className="text-sm leading-relaxed text-muted">{assurance}</p>
        </div>
      </div>
    </div>
  )
}
