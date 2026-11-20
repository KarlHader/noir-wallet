import type { MouseEvent } from 'react'
import { Icon } from '@iconify/react'

interface MultisigBannerProps {
  onClick: () => void
  onDismiss: () => void
}

/** Home banner introducing multisig; the whole card opens the flow and the × dismisses it. */
export function MultisigBanner({ onClick, onDismiss }: MultisigBannerProps) {
  const handleDismiss = (event: MouseEvent<HTMLButtonElement>) => {
    // Dismissing must never also open the flow if a clickable ancestor wraps the banner.
    event.stopPropagation()
    onDismiss()
  }

  // Two sibling buttons instead of a nested one: a <button> inside a <button> is invalid markup.
  return (
    <div className="relative rounded-xl bg-card">
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 rounded-xl p-3 pr-10 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Icon icon="lucide:shield" width={18} height={18} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">NoirWallet Multisig</span>
          <span className="block text-xs text-muted">
            Multiple devices. One secure authorization. Your keys, your control.
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={handleDismiss}
        className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Icon icon="lucide:x" width={14} height={14} aria-hidden="true" />
      </button>
    </div>
  )
}
