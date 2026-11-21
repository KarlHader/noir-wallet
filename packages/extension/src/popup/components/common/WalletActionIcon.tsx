import { Icon } from '@iconify/react'

export type WalletAction = 'send' | 'receive' | 'deposit' | 'withdraw' | 'swap'

export function WalletActionIcon({
  action,
  size = 20,
  className
}: {
  readonly action: WalletAction
  readonly size?: number
  readonly className?: string
}) {
  if (action === 'deposit' || action === 'withdraw') {
    return (
      <Icon
        icon={action === 'deposit' ? 'lucide:arrow-down-to-line' : 'lucide:arrow-up-from-line'}
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
