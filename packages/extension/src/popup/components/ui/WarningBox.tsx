import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'

interface WarningBoxProps {
  children: React.ReactNode
  className?: string
}

export function WarningBox({ children, className }: WarningBoxProps) {
  return (
    <div className={cn('flex items-start gap-3 p-3 bg-warning-surface rounded-lg', className)}>
      <div className="flex-shrink-0 mt-0.5">
        <Icon icon="lucide:triangle-alert" width={18} height={18} className="text-warning" />
      </div>
      <p className="text-xs text-warning leading-relaxed">{children}</p>
    </div>
  )
}
