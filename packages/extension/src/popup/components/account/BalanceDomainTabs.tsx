import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type BalanceDomain = 'public' | 'private' | 'shield'

const LABELS: Record<BalanceDomain, string> = {
  public: 'Public',
  private: 'Private',
  shield: 'Shield'
}

export function BalanceDomainTabs({
  value,
  available = ['public', 'private', 'shield'],
  labels,
  onChange,
  allowReselect = false,
  optimistic = false,
  className,
  disabled = false,
  pending = false
}: {
  readonly value: BalanceDomain
  readonly available?: readonly BalanceDomain[]
  readonly labels?: Partial<Record<BalanceDomain, string>>
  readonly onChange: (value: BalanceDomain) => void
  readonly allowReselect?: boolean
  readonly optimistic?: boolean
  readonly className?: string
  readonly disabled?: boolean
  readonly pending?: boolean
}) {
  const [intent, setIntent] = useState<BalanceDomain | null>(null)
  const sawPending = useRef(false)
  useEffect(() => {
    if (pending) sawPending.current = true
    if (intent !== null && (value === intent || (sawPending.current && !pending))) {
      sawPending.current = false
      setIntent(null)
    }
  }, [intent, pending, value])
  const visualValue = optimistic ? (intent ?? value) : value
  const resolvedLabels = { ...LABELS, ...labels }
  return (
    <div
      role="group"
      aria-label="Account type"
      aria-busy={pending}
      className={cn('flex items-center gap-2', className)}
    >
      {available.map(domain => (
        <button
          key={domain}
          type="button"
          aria-pressed={value === domain}
          disabled={disabled}
          onClick={() => {
            if (allowReselect || value !== domain) {
              sawPending.current = false
              if (optimistic) setIntent(domain)
              onChange(domain)
            }
          }}
          className={cn(
            'relative isolate min-h-7 rounded-full border bg-white/5 px-3 py-1 text-sm leading-[18px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50',
            visualValue !== domain &&
              'border-white/10 bg-white/5 font-medium text-muted hover:bg-white/10',
            visualValue === domain && 'font-medium',
            visualValue === domain && domain === 'public' && 'border-white bg-white text-black',
            visualValue === domain &&
              domain === 'private' &&
              'border-private-action bg-private-action text-white',
            visualValue === domain &&
              domain === 'shield' &&
              'border-success bg-success text-black shadow-[0_0_6px_var(--color-success)]'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-0 -z-10 rounded-[inherit] will-change-[opacity,transform]',
              domain === 'public' && 'bg-white',
              domain === 'private' && 'bg-private-action',
              domain === 'shield' && 'bg-success',
              visualValue === domain
                ? 'scale-100 opacity-100 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none'
                : 'scale-95 opacity-0 transition-none'
            )}
          />
          {resolvedLabels[domain]}
        </button>
      ))}
    </div>
  )
}
