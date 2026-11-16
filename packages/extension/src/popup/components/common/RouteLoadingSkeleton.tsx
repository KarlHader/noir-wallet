import { PageHeader } from './PageHeader'
import { ListSkeleton, Skeleton } from '../ui/skeleton'

export function RouteLoadingSkeleton({
  title = 'Noir Wallet',
  variant = 'list'
}: {
  title?: string
  variant?: 'list' | 'form'
}) {
  return (
    <div className="page-container" role="status" aria-label={`Loading ${title}`}>
      <PageHeader title={title} />
      <div className="page-content space-y-5">
        {variant === 'form' ? (
          <>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="mt-6 h-11 w-full rounded-lg" />
          </>
        ) : (
          <>
            <Skeleton className="h-5 w-32" />
            <ListSkeleton rows={3} card />
          </>
        )}
      </div>
    </div>
  )
}
