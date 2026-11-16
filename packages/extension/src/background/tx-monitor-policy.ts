import type { TxLookup } from '@/lib/zcash-node-rpc'
import { isRecoverableZcashFailure } from '@/lib/transaction-status'
import type { Transaction } from '@/types/wallet'

export function shouldRestoreZcashOriginMonitor(
  transaction: Pick<Transaction, 'id' | 'type' | 'status' | 'txHash'>
): boolean {
  const activeOriginType =
    transaction.type === 'send' ||
    transaction.type === 'shield' ||
    transaction.type === 'unshield' ||
    transaction.type === 'supply' ||
    transaction.type === 'swap'
  return (
    !transaction.id.startsWith('wasm_') &&
    ((activeOriginType &&
      (transaction.status === 'pending' || transaction.status === 'confirming')) ||
      isRecoverableZcashFailure(transaction)) &&
    !!transaction.txHash?.trim()
  )
}

/** Action the monitor should take for a pending tx after a single check. */
export type MonitorAction = 'confirm' | 'expire' | 'timeout' | 'clear' | 'wait'

export interface MonitorDecisionInput {
  lookup: TxLookup
  minConfirmations: number
  /** Result of `isExpiredAtTip`; only meaningful for a not-found lookup. */
  expired: boolean
  elapsedMs: number
  timeoutMs: number
  /** Whether a node RPC is configured and thus can answer authoritatively. */
  hasNode: boolean
  /** Whether the tx is already recorded as confirmed locally. */
  confirmedInDb: boolean
}

/** True once the chain tip has moved safely past a tx's expiry height. */
export function isExpiredAtTip(
  tip: number | null,
  expiryHeight: number | undefined,
  bufferBlocks: number
): boolean {
  return tip != null && expiryHeight != null && tip >= expiryHeight + bufferBlocks
}

/**
 * Pure outcome for one monitor poll. Confirmation wins first; an authoritative
 * "not found" past expiry fails fast; otherwise only the wall-clock fallback can
 * fail a tx, and only when the node authoritatively lacks it (or none exists).
 * A transient RPC/network error or a mined-but-immature tx keeps waiting, so a
 * flaky lookup never turns a live tx into a failure.
 */
export function decideMonitorSignal(input: MonitorDecisionInput): MonitorAction {
  const { lookup, minConfirmations, expired, elapsedMs, timeoutMs, hasNode, confirmedInDb } = input

  if (lookup.status === 'confirmed' && lookup.confirmations >= minConfirmations) {
    return 'confirm'
  }
  if (lookup.status === 'notfound' && expired) {
    return 'expire'
  }
  if (elapsedMs <= timeoutMs) {
    return 'wait'
  }
  if (confirmedInDb) {
    return 'clear'
  }

  const nodeConfirmsMissing = !hasNode || lookup.status === 'notfound'
  return nodeConfirmsMissing ? 'timeout' : 'wait'
}
