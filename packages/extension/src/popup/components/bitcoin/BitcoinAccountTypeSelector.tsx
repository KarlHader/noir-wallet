import { useState } from 'react'
import { Icon } from '@iconify/react'
import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import {
  BITCOIN_ACCOUNT_TYPE_LABELS,
  BITCOIN_ACCOUNT_TYPE_ORDER
} from '@/popup/services/bitcoin-address-balances-client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'
import { cn } from '@/lib/utils'

const BITCOIN_ACCOUNT_TYPE_BIPS: Readonly<Record<BitcoinSupportedAddressType, number>> =
  Object.freeze({
    p2pkh: 44,
    'p2sh-p2wpkh': 49,
    p2wpkh: 84,
    p2tr: 86
  })

export function bitcoinAccountTypeDescription(addressType: BitcoinSupportedAddressType): string {
  return `${BITCOIN_ACCOUNT_TYPE_LABELS[addressType]} · BIP-${BITCOIN_ACCOUNT_TYPE_BIPS[addressType]}`
}

export function BitcoinAccountTypeSelector({
  value,
  onChange,
  hardware = false,
  className
}: {
  readonly value: BitcoinSupportedAddressType
  readonly onChange: (value: BitcoinSupportedAddressType) => Promise<void> | void
  readonly hardware?: boolean
  readonly className?: string
}) {
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)

  const handleChange = async (addressType: BitcoinSupportedAddressType) => {
    if (switching || addressType === value) {
      setOpen(false)
      return
    }
    setSwitching(true)
    setOpen(false)
    try {
      await onChange(addressType)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={switching}
        onClick={() => setOpen(true)}
        className={cn(
          'flex w-full items-center justify-between rounded-xl border border-border/60 bg-card/50 px-3 py-3 text-left transition-colors hover:border-primary/30',
          className
        )}
      >
        <div className="min-w-0">
          <p className="text-[11px] text-muted">Bitcoin account</p>
          <p className="mt-0.5 text-sm font-medium">{bitcoinAccountTypeDescription(value)}</p>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-2">
          <Icon
            icon={switching ? 'lucide:loader-circle' : 'lucide:chevron-down'}
            width={16}
            height={16}
            className={cn('text-muted', switching && 'animate-spin')}
          />
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent position="bottom" className="gap-0 p-0">
          <DialogHeader className="px-5 pb-3 pt-5">
            <DialogTitle className="text-center">Select Bitcoin Account</DialogTitle>
            <DialogDescription className="text-center text-xs leading-5">
              Each address type has its own balance and transaction history.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 px-5 pb-5">
            {BITCOIN_ACCOUNT_TYPE_ORDER.map(addressType => {
              const disabled = switching || (hardware && addressType !== 'p2wpkh')
              const selectedAccount = value === addressType
              return (
                <button
                  key={addressType}
                  type="button"
                  disabled={disabled}
                  onClick={() => void handleChange(addressType)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                    selectedAccount
                      ? 'border-primary/60 bg-primary/8'
                      : 'border-border/60 bg-card/60 hover:border-primary/30',
                    disabled && 'cursor-not-allowed opacity-45'
                  )}
                >
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full border',
                      selectedAccount ? 'border-primary' : 'border-muted/60'
                    )}
                  >
                    {selectedAccount && <span className="size-2.5 rounded-full bg-primary" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {BITCOIN_ACCOUNT_TYPE_LABELS[addressType]}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      BIP-{BITCOIN_ACCOUNT_TYPE_BIPS[addressType]}
                      {hardware && addressType !== 'p2wpkh' ? ' · Not supported by Keystone' : ''}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
