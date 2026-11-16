import { Icon } from '@iconify/react'
import { useId, type ReactNode } from 'react'
import type { IconifyIcon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { WALLET_OPTION_ICONS } from './wallet-option-icons'

export function WalletOptionButton({
  label,
  description,
  icon,
  onClick
}: {
  label: string
  description?: string
  icon: IconifyIcon | ReactNode
  onClick: () => void
}) {
  const descriptionId = useId()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        'flex min-h-16 w-full items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
        description && 'min-h-[86px] gap-5 rounded-[10px] bg-white/5 px-[18px] py-4'
      )}
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/60 text-foreground',
          description && 'size-6 rounded-none bg-transparent text-muted'
        )}
      >
        {icon && typeof icon === 'object' && 'body' in icon ? (
          <Icon
            icon={icon}
            width={description ? 24 : 20}
            height={description ? 24 : 20}
            aria-hidden="true"
          />
        ) : (
          icon
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-sm font-medium',
            description && 'text-lg font-medium leading-6'
          )}
        >
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="mt-2 block text-sm leading-5 text-muted">
            {description}
          </span>
        )}
      </span>
      {!description && (
        <Icon
          icon={WALLET_OPTION_ICONS.next}
          width={18}
          height={18}
          className="shrink-0 text-muted"
          aria-hidden="true"
        />
      )}
    </button>
  )
}
