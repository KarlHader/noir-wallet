import type { MultisigThreshold } from '@/core/multisig/types'
import { cn } from '@/lib/utils'
import { Pill } from './Pill'

interface ThresholdOptionCardProps {
  threshold: MultisigThreshold
  selected: boolean
  onSelect: () => void
}

interface ThresholdCopy {
  title: string
  label: string
  labelColor: string
  // The first line states who signs; the second states what losing a device means.
  lines: readonly [string, string]
}

const THRESHOLD_COPY: Record<MultisigThreshold, ThresholdCopy> = {
  '2-of-2': {
    title: '2 of 2',
    label: 'Both Required',
    labelColor: 'text-muted',
    lines: [
      'Both Noir wallet and device must sign for a transaction.',
      'Lose one device > funds will be locked.'
    ]
  },
  '2-of-3': {
    title: '2 of 3',
    label: 'Recommended',
    labelColor: 'text-primary',
    lines: [
      'Noir wallet and anyone of 2 devices are required for a transaction.',
      'Lose one device > You can still send and migrate.'
    ]
  },
  '3-of-3': {
    title: '3 of 3',
    label: 'Top Level Security',
    labelColor: 'text-[#FFCC00]',
    lines: ['All three sign every time.', 'Lose any device > funds will be locked.']
  }
}

/** Radio card for choosing the signing threshold; render several inside a radiogroup. */
export function ThresholdOptionCard({ threshold, selected, onSelect }: ThresholdOptionCardProps) {
  const copy = THRESHOLD_COPY[threshold]

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'w-full rounded-xl border bg-foreground/5 p-4 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected ? 'border-primary' : 'border-border hover:bg-foreground/10'
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          {/* The marker keeps the selected state readable without relying on color alone. */}
          <span
            aria-hidden="true"
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded-full border-2',
              selected ? 'border-primary' : 'border-muted'
            )}
          >
            {selected && <span className="size-2 rounded-full bg-primary" />}
          </span>
          <span className="text-base font-bold">{copy.title}</span>
        </span>
        <Pill
          tone="muted"
          className={cn('h-5 bg-foreground/10 px-2 py-0 text-xs font-normal', copy.labelColor)}
        >
          {copy.label}
        </Pill>
      </span>
      <span className="mt-2 block pl-6 text-xs text-muted">
        {copy.lines.map(line => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </span>
    </button>
  )
}
