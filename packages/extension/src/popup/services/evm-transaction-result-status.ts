import type { TransactionLifecycleStatus } from '@/core/transactions/domain'

export interface EvmTransactionStatusSnapshot {
  readonly status: TransactionLifecycleStatus
  readonly updatedAt: number
}

const STATUS_RANK: Readonly<Record<Exclude<TransactionLifecycleStatus, 'failed'>, number>> =
  Object.freeze({
    created: 0,
    prepared: 1,
    approved: 2,
    signed: 3,
    broadcast: 4,
    confirming: 5,
    final: 6
  })

export function shouldApplyOnchainTransactionStatus(
  current: EvmTransactionStatusSnapshot,
  next: EvmTransactionStatusSnapshot
): boolean {
  if (next.updatedAt < current.updatedAt) return false
  if (next.status === current.status) return true
  if (current.status === 'final' || current.status === 'failed') return false
  if (next.status === 'failed') return true

  // A persisted reorg is the only legitimate on-chain status regression: a transaction
  // that was previously observed can disappear before chain finality.
  if (current.status === 'confirming' && next.status === 'broadcast') return true

  return STATUS_RANK[next.status] >= STATUS_RANK[current.status]
}

export const shouldApplyEvmTransactionStatus = shouldApplyOnchainTransactionStatus
