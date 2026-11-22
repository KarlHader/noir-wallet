interface RingProgressProps {
  current: number
  total: number
  size?: number
}

const STROKE_WIDTH = 4

/** Circular progress indicator with an "n/m" label in the center. */
export function RingProgress({ current, total, size = 72 }: RingProgressProps) {
  const radius = (size - STROKE_WIDTH) / 2
  const circumference = 2 * Math.PI * radius
  const segmentCount = Number.isInteger(total) && total > 0 ? total : 0
  const segmentLength = segmentCount > 0 ? circumference / segmentCount : 0
  // Center a narrow gap on every step boundary, including the one at 12 o'clock.
  const gap = segmentCount > 1 ? Math.min(1.2, segmentLength / 4) : 0

  return (
    <div
      role="progressbar"
      aria-label="Progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-valuetext={`${current} of ${total}`}
      className="relative shrink-0"
      style={{ width: size, height: size }}
    >
      {/* Rotated so the first segment starts at 12 o'clock and steps fill clockwise. */}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        {Array.from({ length: segmentCount }, (_, index) => (
          <circle
            key={index}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="butt"
            strokeDasharray={`${segmentLength - gap} ${circumference - segmentLength + gap}`}
            strokeDashoffset={-(index * segmentLength + gap / 2)}
            className={index < current ? 'text-primary' : 'text-card'}
          />
        ))}
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center text-sm font-medium"
      >
        {current}/{total}
      </span>
    </div>
  )
}
