import { Icon } from '@iconify/react'
import { useCopyToClipboard } from '../common/CopyToast'
import { formatSortAddress } from '@/lib/format'
import { formatTokenQuantity, formatFiatAmount } from '@/lib/number-format'
import { AddressTypeLabel } from './AddressType'
import { type AddressType } from '@/types/wallet'

import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { safeBig } from '@/lib/big'

export interface AddressOption {
  type: AddressType
  address: string
  balance?: string
}

function useAddressOptions(): AddressOption[] {
  const currentAccount = useWalletStore(state => state.getCurrentAccount())
  const balance = useAccountDataStore(state => state.getCurrentBalance())

  if (!currentAccount) return []

  return [
    {
      type: 'shielded',
      address: currentAccount.addresses.shielded,
      balance: balance?.shielded || '0'
    },
    {
      type: 'transparent',
      address: currentAccount.addresses.transparent,
      balance: balance?.transparent || '0'
    }
  ]
}

interface AddressSelectorModalProps {
  selectedType?: AddressType
  onSelect: (type: AddressType) => void
  showCopy?: boolean
}

export function AddressSelectorModal({
  selectedType,
  onSelect,
  showCopy = true
}: AddressSelectorModalProps) {
  const { copyToClipboard } = useCopyToClipboard()
  const zecPrice = useWalletStore(state => state.zecPrice)
  const addresses = useAddressOptions()

  const handleCopy = (e: React.MouseEvent, address: AddressOption) => {
    e.stopPropagation()
    copyToClipboard(address.address)
  }

  return (
    <div className="py-2">
      <div className="space-y-3">
        {addresses.map(address => (
          <button
            key={address.type}
            onClick={() => onSelect(address.type)}
            className={`w-full p-4 rounded-2xl transition-colors cursor-pointer relative border ${
              selectedType === address.type
                ? 'bg-[#1C1C28] border-primary'
                : 'bg-card border-transparent hover:bg-white/5'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1 text-left">
                <div className="font-mono text-sm text-muted break-all pr-8 mb-2">
                  {formatSortAddress(address.address)}
                </div>
                <div className="flex items-center gap-2">
                  <AddressTypeLabel type={address.type} />
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-sm font-medium">
                  {formatTokenQuantity(address.balance)} ZEC
                </span>
                <span className="text-xs text-muted">
                  {formatFiatAmount(
                    safeBig(address.balance || '0')
                      .times(zecPrice)
                      .toNumber(),
                    { showSign: true }
                  )}
                </span>
              </div>
              {showCopy && (
                <button
                  onClick={e => handleCopy(e, address)}
                  className="absolute top-4 right-4 text-muted hover:text-white transition-colors"
                >
                  <Icon icon="lucide:copy" width={16} height={16} />
                </button>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
