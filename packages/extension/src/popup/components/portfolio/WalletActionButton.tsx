import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type WalletActionButtonProps = {
  readonly icon: ReactNode
  readonly label: string
  readonly active?: boolean
  readonly title?: string
} & (
  | { readonly onClick: () => void; readonly disabled?: boolean; readonly href?: never }
  | { readonly href: string; readonly onClick?: never; readonly disabled?: never }
)

export function WalletActionButton({
  icon,
  label,
  onClick,
  href,
  active = false,
  disabled = false,
  title
}: WalletActionButtonProps) {
  const className = cn(
    'wallet-action-button flex min-w-0 flex-1 flex-col items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    active && 'rounded-xl ring-2 ring-primary',
    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
  )
  const content = (
    <span className="wallet-action-surface wallet-interactive flex h-[74px] w-full flex-col items-center justify-center gap-2 rounded-xl bg-wallet-surface text-foreground">
      <span className="wallet-action-icon flex size-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="wallet-action-label text-xs text-wallet-secondary">{label}</span>
    </span>
  )

  if (href !== undefined) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={className}>
        {content}
      </a>
    )
  }

  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={className}>
      {content}
    </button>
  )
}
