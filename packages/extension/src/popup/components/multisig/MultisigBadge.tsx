import { Icon } from '@iconify/react'
import type { MultisigThreshold } from '@/core/multisig/types'
import { Pill } from './Pill'

interface MultisigBadgeProps {
  threshold: MultisigThreshold
  onClick?: () => void
}

/** Shield badge marking a multisig account, labelled with its threshold such as `2/3`. */
export function MultisigBadge({ threshold, onClick }: MultisigBadgeProps) {
  // '2-of-3' -> '2/3'
  const label = threshold.replace('-of-', '/')

  const badge = (
    <Pill tone="primary">
      <Icon icon="lucide:shield" width={12} height={12} aria-hidden="true" />
      <span className="sr-only">Multisig </span>
      {label}
    </Pill>
  )
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={`Multisig ${label}, restore a phone`}
      className="wallet-interactive shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      {badge}
    </button>
  ) : (
    badge
  )
}
