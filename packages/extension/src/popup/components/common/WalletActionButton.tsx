import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import shieldFundsIcon from '@/images/figma-shield-funds.svg'

export function WalletShieldFundsIcon() {
  return (
    <span
      aria-hidden="true"
      className="size-5 shrink-0 bg-current"
      style={{
        maskImage: `url("${shieldFundsIcon}")`,
        WebkitMaskImage: `url("${shieldFundsIcon}")`,
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskSize: 'contain',
        WebkitMaskSize: 'contain'
      }}
    />
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
        'wallet-action-button flex min-w-0 flex-1 flex-col items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active && 'rounded-xl ring-2 ring-primary',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      )}
    >
      <span className="wallet-action-surface wallet-interactive flex h-[74px] w-full flex-col items-center justify-center gap-2 rounded-xl bg-wallet-surface text-foreground">
        <span className="wallet-action-icon flex size-5 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="text-xs text-wallet-secondary">{label}</span>
      </span>
    </button>
  )
}
