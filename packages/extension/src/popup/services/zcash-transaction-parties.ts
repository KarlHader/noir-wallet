import type { AddressType, Transaction } from '@/types/wallet'
import { detectAddressType, formatSortAddress } from '@/lib/format'

export function getMissingZcashTransactionSource(
  type: Transaction['type'],
  fromType: Transaction['fromType']
): { label: string; type: AddressType } | null {
  const incoming = type === 'receive' || type === 'withdraw' || type === 'claim'
  const shieldedSend =
    (type === 'send' || type === 'shield' || type === 'unshield') && fromType === 'shielded'
  return incoming || shieldedSend ? { label: 'Shielded Pool', type: 'shielded' } : null
}

export function getZcashTransactionRecipient(transaction: Pick<Transaction, 'type' | 'to'>): {
  label: string
  type: AddressType | null
} | null {
  if (transaction.to) {
    return {
      label: formatSortAddress(transaction.to),
      type: detectAddressType(transaction.to)
    }
  }
  return transaction.type === 'receive' ? { label: 'Shielded Pool', type: 'shielded' } : null
}
