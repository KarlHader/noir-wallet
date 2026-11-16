import type { Transaction } from '@/types/wallet'

export function isValidAddTransactionResponse(
  response: unknown
): response is { success: true; transaction: Transaction } {
  if (typeof response !== 'object' || response === null) return false
  const candidate = response as Record<string, unknown>
  if (candidate.success !== true) return false
  if (typeof candidate.transaction !== 'object' || candidate.transaction === null) return false
  const transaction = candidate.transaction as Record<string, unknown>
  const types = new Set([
    'send',
    'receive',
    'shield',
    'unshield',
    'swap',
    'supply',
    'withdraw',
    'claim'
  ])
  return (
    typeof transaction.id === 'string' &&
    transaction.id.trim().length > 0 &&
    typeof transaction.txHash === 'string' &&
    transaction.status === 'pending' &&
    typeof transaction.type === 'string' &&
    types.has(transaction.type) &&
    typeof transaction.amount === 'string' &&
    typeof transaction.to === 'string' &&
    typeof transaction.from === 'string' &&
    (transaction.fromType === 'shielded' || transaction.fromType === 'transparent') &&
    typeof transaction.fee === 'string' &&
    (transaction.network === 'mainnet' || transaction.network === 'testnet') &&
    typeof transaction.timestamp === 'number' &&
    Number.isFinite(transaction.timestamp) &&
    transaction.timestamp > 0
  )
}
