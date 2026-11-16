import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'

export interface EndpointProbeResult {
  status: 'pending' | 'ok' | 'unreachable'
  latencyMs?: number
}

export function EndpointLatencyBadge({ result }: { result?: EndpointProbeResult }) {
  if (!result) return <span className="text-xs text-muted">--</span>
  if (result.status === 'pending') {
    return <Icon icon="lucide:loader-2" className="size-3.5 animate-spin text-muted" />
  }
  if (result.status === 'unreachable' || result.latencyMs === undefined) {
    return <span className="text-xs text-danger">Offline</span>
  }
  const tone =
    result.latencyMs < 200
      ? 'text-primary'
      : result.latencyMs < 500
        ? 'text-warning'
        : 'text-danger'
  return <span className={cn('text-xs tabular-nums', tone)}>{result.latencyMs} ms</span>
}

export function EndpointSelectionIndicator({
  selected,
  applying
}: {
  selected: boolean
  applying: boolean
}) {
  if (applying) {
    return <Icon icon="lucide:loader-2" className="size-4 animate-spin text-primary" />
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full border',
        selected ? 'border-primary bg-primary/15' : 'border-white/15'
      )}
    >
      {selected && <span className="size-2 rounded-full bg-primary" />}
    </span>
  )
}
