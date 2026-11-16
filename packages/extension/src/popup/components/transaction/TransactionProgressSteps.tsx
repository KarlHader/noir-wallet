import { Icon } from '@iconify/react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { TransactionProgressStep } from '@/popup/services/transaction-progress'

interface TransactionProgressStepsProps {
  readonly steps: readonly TransactionProgressStep[]
  readonly className?: string
  readonly referenceByStepId?: ReadonlyMap<string, ReactNode>
}

export function TransactionProgressSteps({
  steps,
  className,
  referenceByStepId
}: TransactionProgressStepsProps) {
  return (
    <section
      aria-label="Transaction progress"
      aria-live="polite"
      className={cn('w-full', className)}
    >
      <h3 className="mb-3 text-sm font-medium">Transaction progress</h3>
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className="flex gap-3"
            data-progress-step={step.id}
            data-progress-state={step.state}
            aria-current={step.state === 'active' ? 'step' : undefined}
          >
            <div className="relative flex w-5 shrink-0 justify-center">
              {index < steps.length - 1 && (
                <span className="absolute bottom-[-8px] top-5 w-px bg-border" />
              )}
              <span
                className={cn(
                  'relative z-10 flex size-5 items-center justify-center rounded-full border bg-background',
                  step.state === 'complete'
                    ? 'border-primary text-primary'
                    : step.state === 'failed'
                      ? 'border-danger text-danger'
                      : step.state === 'warning'
                        ? 'border-warning text-warning'
                        : step.state === 'active'
                          ? 'border-transparent text-primary'
                          : 'border-muted text-muted'
                )}
              >
                {step.state !== 'pending' && (
                  <Icon
                    icon={
                      step.state === 'complete'
                        ? 'lucide:check'
                        : step.state === 'failed'
                          ? 'lucide:x'
                          : step.state === 'warning'
                            ? 'lucide:triangle-alert'
                            : 'lucide:loader-circle'
                    }
                    width={step.state === 'active' ? 20 : 12}
                    height={step.state === 'active' ? 20 : 12}
                    className={step.state === 'active' ? 'animate-spin' : undefined}
                    aria-hidden="true"
                  />
                )}
              </span>
            </div>
            <div className="min-w-0 flex-1 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p
                    className={cn('text-xs font-medium', step.state === 'pending' && 'text-muted')}
                  >
                    {step.label}
                  </p>
                  {step.detail && <p className="mt-0.5 text-[11px] text-muted">{step.detail}</p>}
                  {referenceByStepId?.get(step.id) && (
                    <div className="mt-1.5 text-xs">{referenceByStepId.get(step.id)}</div>
                  )}
                </div>
                <span
                  className={cn(
                    'shrink-0 text-[11px] font-medium',
                    step.statusLabel === 'Submitted'
                      ? 'text-muted'
                      : step.state === 'complete'
                        ? 'text-primary'
                        : step.state === 'failed'
                          ? 'text-danger'
                          : step.state === 'warning'
                            ? 'text-warning'
                            : step.state === 'active'
                              ? 'text-foreground/80'
                              : 'text-muted'
                  )}
                >
                  {step.statusLabel}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
