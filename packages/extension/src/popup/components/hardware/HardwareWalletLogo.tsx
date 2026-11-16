import type { HardwareConnectVendor } from '@/lib/hardware-connect-options'
// Ledger lettermark source: https://brand.ledger.com/brand-design/logo
import LedgerLogo from '@/images/ledger-logo.svg'
import KeystoneLogo from '@/images/keystone-mark.png'

export function HardwareWalletLogo({ vendor }: { vendor: HardwareConnectVendor }) {
  return (
    <img
      src={vendor === 'ledger' ? LedgerLogo : KeystoneLogo}
      alt=""
      aria-hidden="true"
      className="size-6 object-contain"
    />
  )
}
