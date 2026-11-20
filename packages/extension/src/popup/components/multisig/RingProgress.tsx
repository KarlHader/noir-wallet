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
  // Clamp so an out-of-range step count can never draw a negative or overlapping arc.
  const ratio = total > 0 ? Math.min(Math.max(current / total, 0), 1) : 0

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
      {/* Rotated so the arc starts at 12 o'clock and fills clockwise. */}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          className="text-card"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          className="text-primary transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
        />
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
