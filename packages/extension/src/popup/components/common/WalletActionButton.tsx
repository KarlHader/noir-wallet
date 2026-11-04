import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function WalletSwapIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <g transform="translate(1 1)">
        <path d="M7.5 2H2V7.5M10.5 16H16V10.5" />
        <circle cx="4.5" cy="13.5" r="3.5" />
        <circle cx="13.5" cy="4.5" r="3.5" />
      </g>
    </svg>
  )
}

interface WalletActionButtonProps {
  readonly icon: ReactNode
  readonly label: string
  readonly onClick: () => void
  readonly active?: boolean
  readonly disabled?: boolean
  readonly title?: string
}

export function WalletActionButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  title
}: WalletActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center gap-2',
        active && 'rounded-xl ring-2 ring-primary',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      )}
    >
      <span className="flex h-[74px] w-full flex-col items-center justify-center gap-2 rounded-xl bg-wallet-surface text-foreground transition-colors hover:bg-white/10">
        {icon}
        <span className="text-xs text-wallet-secondary">{label}</span>
      </span>
    </button>
  )
}
