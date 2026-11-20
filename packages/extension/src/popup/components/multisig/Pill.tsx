import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type PillTone = 'primary' | 'warning' | 'muted' | 'danger' | 'suggested' | 'account'

interface PillProps {
  tone: PillTone
  className?: string
  children: ReactNode
}

// The primary tone mirrors the "Active" pill in AccountList so both read as one pill family.
const TONE_CLASSES: Record<PillTone, string> = {
  primary: 'bg-primary/20 text-primary',
  warning: 'bg-warning/15 text-warning',
  muted: 'bg-card text-muted',
  danger: 'bg-danger/15 text-danger',
  suggested: 'h-5 px-2 bg-[linear-gradient(90deg,#FFA200_0%,#996100_100%)] text-white',
  account: 'h-6 bg-foreground/10 px-3 py-0 text-base font-normal text-foreground'
}

/** Compact status label used for device roles, threshold hints, and the multisig badge. */
export function Pill({ tone, className, children }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        TONE_CLASSES[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
