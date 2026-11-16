import type { AccountData, AddressType, ZcashBalance } from '@/types'
import { safeBig } from '@/lib/big'

export interface FormattedAddress {
  type: AddressType
  address: string
  balance: string
  balanceFormatted: string
  balanceValue: number
  pending?: string
  items: FormattedAddress[]
  fiatValue: number
}

export function getAccountAddresses(
  account: AccountData | null,
  balance: ZcashBalance | null,
  zecPrice = 0
): FormattedAddress[] {
  if (!account) return []

  return (['shielded', 'transparent'] as const).flatMap(type => {
    const address = account.addresses[type]
    if (!address) return []

    const balanceString = balance?.[type] || '0'
    const balanceValue = safeBig(balanceString).toNumber()
    return [
      {
        type,
        address,
        balance: balanceString,
        balanceFormatted: `${balanceString} ZEC`,
        balanceValue,
        pending: balance?.pending?.[type],
        fiatValue: balanceValue * zecPrice,
        items: []
      }
    ]
  })
}
