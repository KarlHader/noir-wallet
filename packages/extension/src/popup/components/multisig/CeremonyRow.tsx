import { Icon } from '@iconify/react'

export type CeremonyRowStatus = 'done' | 'progress' | 'awaiting'

interface CeremonyRowProps {
  label: string
  status: CeremonyRowStatus
  /** Percentage (0-100) used while `status` is `progress`. */
  progress?: number
  /** Short counter shown on the right while in progress, for example `2/3`. */
  detail?: string
}

function barPercent(status: CeremonyRowStatus, progress: number | undefined): number {
  if (status === 'done') return 100
  if (status === 'awaiting') return 0
  return Math.min(Math.max(progress ?? 0, 0), 100)
}

/** One step of the key ceremony with its state and a thin progress bar. */
export function CeremonyRow({ label, status, progress, detail }: CeremonyRowProps) {
  const percent = barPercent(status, progress)

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-sm">{label}</span>
        {status === 'done' && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-primary">
            <Icon icon="lucide:check" width={14} height={14} aria-hidden="true" />
            Done
          </span>
        )}
        {status === 'progress' && detail && (
          <span className="shrink-0 text-xs text-foreground">{detail}</span>
        )}
        {status === 'awaiting' && <span className="shrink-0 text-xs text-muted">Awaiting</span>}
      </div>
      {/* bg-border is a light overlay, so the track stays visible on the card surface. */}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-border"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
