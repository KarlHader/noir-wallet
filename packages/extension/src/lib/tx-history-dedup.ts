import type { Transaction } from '@/types'

/**
 * Canonical form of a txid for equality checks. Broadcast APIs return a hex
 * string while WASM history yields reversed bytes; casing/whitespace can differ,
 * so all comparisons run on a trimmed lowercase form.
 */
export function normalizeTxHash(hash: string | null | undefined): string {
  return (hash ?? '').trim().toLowerCase()
}

export function isMultiStepZcashSend(
  tx: Pick<Transaction, 'type' | 'txHash' | 'chainHashes'>
): boolean {
  const chainHashes = tx.chainHashes ?? []
  return (
    tx.type === 'send' &&
    chainHashes.length > 1 &&
    chainHashes.every(chainHash => chainHash.chain.trim().toLowerCase() === 'zcash') &&
    normalizeTxHash(chainHashes.at(-1)?.hash) === normalizeTxHash(tx.txHash)
  )
}

/**
 * Transparent receives are reconstructed from the node independently and have no
 * local counterpart, so they must never be collapsed as duplicates.
 */
export function isTransparentReceive(tx: Transaction): boolean {
  return tx.type === 'receive' && tx.fromType === 'transparent'
}

/**
 * Canonical txids of local (non-WASM) records that carry a hash.
 * Also includes Zcash `chainHashes` from multi-step transfers and
 * `destinationTxHash` from withdraw/claim records so every WASM step is
 * deduplicated against the richer local record.
 */
export function localTxHashSet(txs: Transaction[]): Set<string> {
  const hashes = new Set<string>()
  for (const tx of txs) {
    if (tx.id.startsWith('wasm_')) continue
    const hash = normalizeTxHash(tx.txHash)
    if (hash) hashes.add(hash)
    for (const chainHash of tx.chainHashes ?? []) {
      if (chainHash.chain.trim().toLowerCase() !== 'zcash') continue
      const chainedHash = normalizeTxHash(chainHash.hash)
      if (chainedHash) hashes.add(chainedHash)
    }
    const destHash = normalizeTxHash(tx.destinationTxHash)
    if (destHash) hashes.add(destHash)
  }
  return hashes
}

/** Hashes of locally-created shielded sends that can reappear as a transparent receive. */
export function localShieldedSendHashSet(txs: Transaction[]): Set<string> {
  const hashes = new Set<string>()
  for (const tx of txs) {
    if (
      tx.id.startsWith('wasm_') ||
      (tx.type !== 'send' && tx.type !== 'unshield') ||
      tx.fromType !== 'shielded'
    ) {
      continue
    }
    const hash = normalizeTxHash(tx.txHash)
    if (hash) hashes.add(hash)
  }
  return hashes
}

/**
 * A WASM history row duplicates a local record when it shares the same txid and
 * is not a transparent receive. A swap/supply is a single on-chain send, so the
 * richer local record wins and the `wasm_` send row is dropped — including rows
 * already persisted from an earlier merge, which lets stale duplicates self-heal.
 *
 * Multi-step Zcash hashes and withdraw/claim `destinationTxHash` values are
 * included in the local hash set, so their lower-level WASM rows are also
 * suppressed.
 * Only exact txid matching is used — no amount/time/address fuzzy matching.
 */
export function isDuplicateWasmRow(
  tx: Transaction,
  localHashes: Set<string>,
  localShieldedSendHashes: Set<string> = new Set()
): boolean {
  return (
    tx.id.startsWith('wasm_') &&
    (isTransparentReceive(tx)
      ? localShieldedSendHashes.has(normalizeTxHash(tx.txHash))
      : localHashes.has(normalizeTxHash(tx.txHash)))
  )
}
