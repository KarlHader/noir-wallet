import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'

export function HardwareSigningProgress({
  title,
  children
}: {
  readonly title: string
  readonly children?: ReactNode
}) {
  return (
    <div role="status" className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/60 px-4 py-3">
        <Icon
          icon="lucide:loader-2"
          width={18}
          height={18}
          className="shrink-0 animate-spin text-primary"
        />
        <p className="text-sm font-medium">{title}</p>
      </div>
      {children}
    </div>
  )
}
