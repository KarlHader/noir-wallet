import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Skeleton } from '../ui/skeleton'

export interface FeeOption<T extends string> {
  readonly id: T
  readonly label: string
  readonly caption?: string
  readonly amount?: ReactNode
  readonly loading?: boolean
}

export function FeeOptionList<T extends string>({
  options,
  value,
  onChange,
  disabled,
  label = 'Network fee speed'
}: {
  readonly options: readonly FeeOption<T>[]
  readonly value: T | null
  readonly onChange: (value: T) => void
  readonly disabled?: boolean
  readonly label?: string
}) {
  const name = useId()
  return (
    <fieldset disabled={disabled} className="@container min-w-0">
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          'grid grid-cols-1 gap-1.5',
          options.length === 2 ? '@min-[300px]:grid-cols-2' : '@min-[300px]:grid-cols-3'
        )}
      >
        {options.map(option => {
          const selected = option.id === value
          return (
            <label
              key={option.id}
              className={cn(
                'relative flex min-h-12 min-w-0 items-center justify-between gap-2.5 rounded-lg border border-border/70 bg-card/30 px-3 py-1.5',
                '@min-[300px]:min-h-[76px] @min-[300px]:flex-col @min-[300px]:items-start @min-[300px]:justify-start @min-[300px]:gap-1 @min-[300px]:px-2.5 @min-[300px]:py-2.5',
                'transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-primary',
                disabled ? 'opacity-70' : 'hover:bg-card/60',
                selected && 'border-primary/55 bg-primary/8'
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={selected}
                onChange={() => onChange(option.id)}
                aria-label={option.label}
                aria-describedby={`${name}-${option.id}-amount${option.caption ? ` ${name}-${option.id}-caption` : ''}`}
                className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
              />
              <div className="min-w-0 flex-1 @min-[300px]:w-full @min-[300px]:flex-none">
                <div className="text-sm font-medium leading-4.5">{option.label}</div>
                {option.caption && (
                  <div
                    id={`${name}-${option.id}-caption`}
                    className={cn(
                      'mt-0.5 text-xs leading-3.5 text-muted @min-[300px]:text-[11px]',
                      selected && 'text-foreground/75'
                    )}
                  >
                    {option.caption}
                  </div>
                )}
              </div>
              <div
                id={`${name}-${option.id}-amount`}
                className="min-w-0 max-w-[60%] [overflow-wrap:anywhere] text-right text-xs leading-4 text-muted tabular-nums @min-[300px]:max-w-full @min-[300px]:text-left"
              >
                {option.loading ? (
                  <span role="status" aria-label={`Estimating ${option.label} network fee`}>
                    <Skeleton className="ml-auto h-4 w-14 @min-[300px]:ml-0" />
                  </span>
                ) : (
                  (option.amount ?? <span aria-label="Fee unavailable">&ndash;</span>)
                )}
              </div>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
