import { cn } from '@/lib/utils'

interface StepBarsProps {
  total: 3
  current: 1 | 2 | 3
}

/** Three-segment progress bar for the create flow; completed and current segments are filled. */
export function StepBars({ total, current }: StepBarsProps) {
  const steps = Array.from({ length: total }, (_, index) => index + 1)

  return (
    <div
      role="progressbar"
      aria-label="Multisig setup progress"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-valuetext={`Step ${current} of ${total}`}
      className="flex gap-2"
    >
      {steps.map(step => (
        <span
          key={step}
          className={cn('h-[3px] flex-1 rounded-full', step <= current ? 'bg-primary' : 'bg-card')}
        />
      ))}
    </div>
  )
}
