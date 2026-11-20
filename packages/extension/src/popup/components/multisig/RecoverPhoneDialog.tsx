import { Icon } from '@iconify/react'
import type { MultisigTransportKind } from '@/core/multisig/types'

interface RecoverPhoneDialogProps {
  onSelect: (transport: MultisigTransportKind) => void
  onClose: () => void
}

export function RecoverPhoneDialog({ onSelect, onClose }: RecoverPhoneDialogProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-muted">
        On your phone, choose Import wallet and enter your 32 backup words. Then choose how to
        connect this wallet to the phone.
      </div>
      <div role="group" aria-label="Restore method" className="flex flex-col gap-3">
        {(
          [
            ['ble', 'lucide:bluetooth', 'Bluetooth'],
            ['qr', 'lucide:qr-code', 'QR code']
          ] as const
        ).map(([transport, icon, title]) => (
          <button
            key={transport}
            type="button"
            onClick={() => onSelect(transport)}
            className="wallet-interactive flex items-center gap-3 rounded-xl border border-foreground/10 bg-card p-3 text-left hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Icon icon={icon} width={20} height={20} aria-hidden="true" />
            <span className="text-sm font-medium">{title}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="wallet-interactive h-10 text-sm text-muted"
      >
        Cancel
      </button>
    </div>
  )
}
