import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import {
  HARDWARE_CONNECT_OPTIONS,
  type HardwareConnectVendor
} from '@/lib/hardware-connect-options'
import { DialogHeader, DialogTitle } from '../ui/dialog'
import { HardwareWalletLogo } from '../hardware/HardwareWalletLogo'
import { WalletOptionButton } from './WalletOptionButton'
import { WALLET_OPTION_ICONS } from './wallet-option-icons'

export type AddWalletAction = 'import' | 'private-key' | 'create' | HardwareConnectVendor

export function AddWalletContent({ onSelect }: { onSelect: (action: AddWalletAction) => void }) {
  const [step, setStep] = useState<'wallet' | 'hardware'>('wallet')
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  return (
    <>
      <DialogHeader className="relative flex min-h-6 shrink-0 flex-row items-center justify-start pr-8 text-left">
        {step !== 'wallet' && (
          <button
            type="button"
            aria-label="Back to Add Wallet"
            onClick={() => setStep('wallet')}
            className="mr-2 flex size-6 shrink-0 items-center justify-center rounded text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <Icon icon={WALLET_OPTION_ICONS.back} width={18} height={18} aria-hidden="true" />
          </button>
        )}
        <DialogTitle
          ref={headingRef}
          tabIndex={-1}
          className="text-left text-base font-medium leading-6 outline-none"
        >
          {step === 'hardware' ? 'Connect Hardware Wallet' : 'Add wallet'}
        </DialogTitle>
      </DialogHeader>
      <div className="min-h-0 space-y-3.5 overflow-y-auto">
        {step === 'wallet' && (
          <>
            <WalletOptionButton
              label="Create New Wallet"
              description="Create a new seed phrase wallet"
              icon={WALLET_OPTION_ICONS.create}
              onClick={() => onSelect('create')}
            />
            <WalletOptionButton
              label="Import recovery phrase"
              description="Import accounts from another wallet"
              icon={WALLET_OPTION_ICONS.phrase}
              onClick={() => onSelect('import')}
            />
            <WalletOptionButton
              label="Import private key"
              description="Import a single-chain account"
              icon={WALLET_OPTION_ICONS.key}
              onClick={() => onSelect('private-key')}
            />
            <WalletOptionButton
              label="Connect a hardware wallet"
              description="Using a USB or a QR code"
              icon={WALLET_OPTION_ICONS.hardware}
              onClick={() => setStep('hardware')}
            />
          </>
        )}
        {step === 'hardware' &&
          HARDWARE_CONNECT_OPTIONS.map(device => (
            <WalletOptionButton
              key={device.vendor}
              label={device.name}
              icon={<HardwareWalletLogo vendor={device.vendor} />}
              onClick={() => onSelect(device.vendor)}
            />
          ))}
      </div>
    </>
  )
}
