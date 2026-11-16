import { cn } from '@/lib/utils'

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-md bg-white/[0.08] motion-reduce:animate-none',
        className
      )}
    />
  )
}

export function ListSkeleton({
  rows = 3,
  label = 'Loading content',
  className,
  card = false
}: {
  readonly rows?: number
  readonly label?: string
  readonly className?: string
  readonly card?: boolean
}) {
  return (
    <div role="status" aria-label={label} className={cn('space-y-2', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn(
            'flex min-h-14 items-center gap-3 px-1 py-2.5',
            card && 'rounded-xl bg-card px-3'
          )}
        >
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2.5 w-20 bg-white/[0.05]" />
          </div>
          <div className="shrink-0 space-y-2">
            <Skeleton className="ml-auto h-3 w-16" />
            <Skeleton className="ml-auto h-2.5 w-12 bg-white/[0.05]" />
          </div>
        </div>
      ))}
    </div>
  )
}
