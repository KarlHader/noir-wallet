import { Icon } from '@iconify/react'
import shieldReceiveIcon from '@/images/shield-receive.svg'
import shieldSendIcon from '@/images/shield-send.svg'
import { cn } from '@/lib/utils'

const LUCIDE_ACTION_ICONS = {
  deposit: 'lucide:arrow-down-to-line',
  withdraw: 'lucide:arrow-up-from-line',
  shield: 'lucide:shield',
  unshield: 'lucide:shield-off'
} as const

export type WalletAction = 'send' | 'receive' | 'swap' | keyof typeof LUCIDE_ACTION_ICONS

export function WalletActionIcon({
  action,
  shielded = false,
  size = 20,
  className
}: {
  readonly action: WalletAction
  readonly shielded?: boolean
  readonly size?: number
  readonly className?: string
}) {
  if (shielded && (action === 'send' || action === 'receive')) {
    return (
      <img
        src={action === 'send' ? shieldSendIcon : shieldReceiveIcon}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn('shrink-0 object-contain', className)}
      />
    )
  }

  if (action !== 'send' && action !== 'receive' && action !== 'swap') {
    return (
      <Icon
        icon={LUCIDE_ACTION_ICONS[action]}
        width={size}
        height={size}
        className={className}
        aria-hidden="true"
      />
    )
  }

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      className={className}
    >
      {action === 'send' && <path d="M4 4H16V16M16 4L4 16" stroke="currentColor" strokeWidth="2" />}
      {action === 'receive' && (
        <path d="M4 4V16H16M4 16L16 4" stroke="currentColor" strokeWidth="2" />
      )}
      {action === 'swap' && (
        <g stroke="currentColor" strokeWidth="2" transform="translate(1 1)">
          <path d="M7.5 2H2V7.5M10.5 16H16V10.5" />
          <circle cx="4.5" cy="13.5" r="3.5" />
          <circle cx="13.5" cy="4.5" r="3.5" />
        </g>
      )}
    </svg>
  )
}
