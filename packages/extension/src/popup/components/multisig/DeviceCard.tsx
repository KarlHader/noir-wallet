import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'
import type { DeviceRole, DeviceSlot } from '@/core/multisig/types'
import { cn } from '@/lib/utils'
import { Pill } from './Pill'

export type DeviceCardStatus =
  | 'signed'
  | 'pending'
  | 'connected'
  | 'not_connected'
  | 'empty'
  | 'confirmed'
  | 'waiting'

interface DeviceCardProps {
  slot: DeviceSlot
  role: DeviceRole
  title: string
  subtitle?: string
  status: DeviceCardStatus
  highlighted?: boolean
  onClick?: () => void
  trailing?: ReactNode
}

interface StatusView {
  label?: string
  leading?: 'check' | 'spinner' | 'chevron'
  className: string
}

const STATUS_VIEWS: Record<DeviceCardStatus, StatusView> = {
  signed: { label: 'Signed', leading: 'check', className: 'text-primary' },
  connected: { label: 'Connected', leading: 'check', className: 'text-primary' },
  confirmed: { label: 'Confirmed', leading: 'check', className: 'text-primary' },
  pending: { label: 'Pending', leading: 'spinner', className: 'text-warning' },
  waiting: { label: 'Waiting…', leading: 'spinner', className: 'text-muted' },
  not_connected: { label: 'Not Connected', className: 'text-muted' },
  empty: { leading: 'chevron', className: 'text-muted' }
}

const LEADING_ICONS = {
  check: 'lucide:check',
  spinner: 'lucide:loader-2',
  chevron: 'lucide:chevron-right'
} as const

function DeviceStatus({ status }: { status: DeviceCardStatus }) {
  const view = STATUS_VIEWS[status]
  const iconSize = view.leading === 'chevron' ? 16 : 14

  return (
    <span className={cn('flex shrink-0 items-center gap-1 text-xs', view.className)}>
      {view.leading && (
        <Icon
          icon={LEADING_ICONS[view.leading]}
          width={iconSize}
          height={iconSize}
          className={view.leading === 'spinner' ? 'animate-spin' : undefined}
          aria-hidden="true"
        />
      )}
      {view.label}
    </span>
  )
}

/** One participant row of a multisig group: slot, role, device name, and connection state. */
export function DeviceCard({
  slot,
  role,
  title,
  subtitle,
  status,
  highlighted = false,
  onClick,
  trailing
}: DeviceCardProps) {
  // Slot 1 is always the extension itself; every other slot is a phone.
  const deviceIcon = slot === 1 ? 'lucide:puzzle' : 'lucide:smartphone'

  // Spans only: phrasing content keeps the markup valid when the card renders as a <button>.
  const content = (
    <>
      <Icon
        icon={deviceIcon}
        width={24}
        height={24}
        className={cn('shrink-0', status === 'empty' ? 'text-muted/60' : 'text-foreground')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-xs text-muted">
          <span>Device {slot}</span>
          {role === 'owner' ? (
            <Pill tone="primary">Owner</Pill>
          ) : (
            <Pill tone="warning">Guardians</Pill>
          )}
        </span>
        <span className="mt-0.5 block truncate text-sm font-medium">{title}</span>
        {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
      </span>
      {trailing ?? <DeviceStatus status={status} />}
    </>
  )

  // The border is always present so highlighting never shifts the layout.
  const cardClassName = cn(
    'flex w-full items-center gap-3 rounded-xl border bg-card p-4 text-left',
    highlighted ? 'border-primary' : 'border-transparent'
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-current={highlighted ? 'true' : undefined}
        className={cn(
          cardClassName,
          'cursor-pointer transition-colors hover:bg-accent',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
        )}
      >
        {content}
      </button>
    )
  }

  return (
    <div aria-current={highlighted ? 'true' : undefined} className={cardClassName}>
      {content}
    </div>
  )
}
