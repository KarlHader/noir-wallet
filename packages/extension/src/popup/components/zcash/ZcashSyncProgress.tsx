import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/popup/components/ui/tooltip'

export interface ZcashSyncProgressState {
  readonly syncProgress: number
  readonly currentHeight: number
  readonly latestHeight: number
  readonly etaMs: number | null
}

interface ZcashSyncProgressProps extends ZcashSyncProgressState {
  readonly className?: string
  readonly showLabel?: boolean
}

function formatSyncHeight(height: number): string {
  return height > 0 ? height.toLocaleString() : '—'
}

function formatEta(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  if (totalSeconds < 60) return '<1 min'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.ceil((totalSeconds % 3600) / 60)
  if (hours > 0) return `~${hours}h ${minutes}m`
  return `~${minutes} min`
}

export function ZcashSyncProgress({
  syncProgress,
  currentHeight,
  latestHeight,
  etaMs,
  className,
  showLabel = false
}: ZcashSyncProgressProps) {
  const progressLabel = latestHeight > 0 && syncProgress > 0 ? `${syncProgress}%` : 'Syncing'

  return (
    <Tooltip
      content={
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-xs font-semibold">Zcash Syncing</span>
          <span className="font-mono text-[10px] opacity-80">
            Height: {formatSyncHeight(currentHeight)} / {formatSyncHeight(latestHeight)}
          </span>
          <span className="font-mono text-[10px] opacity-80">
            ETA:{' '}
            {etaMs != null && etaMs > 0
              ? formatEta(etaMs)
              : latestHeight > 0 && currentHeight >= latestHeight
                ? 'Finishing'
                : '—'}
          </span>
        </div>
      }
    >
      <div
        role="status"
        aria-label={`Zcash sync progress: ${progressLabel}`}
        className={cn(
          'flex h-5 items-center gap-1 rounded-full bg-primary/10 px-2 font-mono text-[10px] text-primary',
          className
        )}
      >
        <Icon icon="lucide:refresh-cw" width={10} height={10} className="animate-spin" />
        <span>
          {showLabel
            ? `Zcash Syncing${progressLabel === 'Syncing' ? '' : ` · ${progressLabel}`}`
            : progressLabel}
        </span>
      </div>
    </Tooltip>
  )
}
