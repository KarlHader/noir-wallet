export interface PearlConfirmedSpend {
  readonly transactionId: string
  readonly spentOutpoints: readonly string[]
  readonly confirmations: number
  readonly blockHash: string
  readonly blockHeight: number
}

export interface PearlFinalizedConflict {
  readonly transactionHash: string
  readonly spentOutpoint: string
  readonly blockHash: string
  readonly blockHeight: number
  readonly confirmations: number
}

/**
 * Selects a confirmed transaction that already spends one of the reserved
 * outpoints without being the transfer under observation. A missing
 * transaction is only a conflict when another spend of the same outpoint was
 * mined; an unconfirmed replacement is deliberately not treated as final.
 */
export function selectPearlFinalizedConflict(input: {
  readonly transactionHash: string
  readonly reservedOutpoints: readonly string[]
  readonly spends: readonly PearlConfirmedSpend[]
  readonly minimumConfirmations?: number
}): PearlFinalizedConflict | null {
  if (!/^[0-9a-f]{64}$/.test(input.transactionHash)) {
    throw new Error('Invalid Pearl conflict transaction hash')
  }
  if (input.reservedOutpoints.length === 0) {
    throw new Error('Pearl conflict detection requires reserved outpoints')
  }
  const minimumConfirmations = input.minimumConfirmations ?? 1
  if (!Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1) {
    throw new Error('Invalid Pearl conflict confirmation threshold')
  }
  const reserved = new Set(input.reservedOutpoints)
  const candidates: PearlFinalizedConflict[] = []
  for (const spend of input.spends) {
    if (spend.transactionId === input.transactionHash) continue
    if (
      !/^[0-9a-f]{64}$/.test(spend.transactionId) ||
      !/^[0-9a-f]{64}$/.test(spend.blockHash) ||
      !Number.isSafeInteger(spend.confirmations) ||
      !Number.isSafeInteger(spend.blockHeight) ||
      spend.blockHeight < 0 ||
      spend.confirmations < minimumConfirmations
    ) {
      continue
    }
    const spentOutpoint = [...spend.spentOutpoints]
      .filter(outpoint => reserved.has(outpoint))
      .sort()
    const outpoint = spentOutpoint[0]
    if (outpoint === undefined) continue
    candidates.push(
      Object.freeze({
        transactionHash: spend.transactionId,
        spentOutpoint: outpoint,
        blockHash: spend.blockHash,
        blockHeight: spend.blockHeight,
        confirmations: spend.confirmations
      })
    )
  }
  if (candidates.length === 0) return null
  candidates.sort(
    (left, right) =>
      right.confirmations - left.confirmations ||
      left.transactionHash.localeCompare(right.transactionHash)
  )
  return candidates[0]
}
