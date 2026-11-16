import { formatSortAddress } from '@/lib/format'
import { cn } from '@/lib/utils'

interface TransactionReferenceValueProps {
  readonly hash: string
  readonly url: string
  readonly compact?: boolean
}

export function TransactionReferenceValue({
  hash,
  url,
  compact = false
}: TransactionReferenceValueProps) {
  const content = <span className="font-mono">{formatSortAddress(hash)}</span>
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={hash}
      className={cn(
        'cursor-pointer break-all text-primary hover:underline',
        compact ? 'text-xs' : 'text-sm'
      )}
    >
      {content}
    </a>
  ) : (
    <span title={hash} className={cn('break-all', compact ? 'text-xs' : 'text-sm')}>
      {content}
    </span>
  )
}
