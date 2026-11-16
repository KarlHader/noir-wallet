import type { ActivityItem } from '@/core/activity'

export interface ActivityTransactionReference {
  readonly id: string
  readonly label: string
  readonly hash: string
  readonly chainId: string | null
}

export function isActivityTransactionHash(hash: string, chainId: string | null): boolean {
  if (chainId?.startsWith('eip155:')) return /^0x[0-9a-fA-F]{64}$/.test(hash)
  if (chainId?.startsWith('bip122:')) return /^[0-9a-fA-F]{64}$/.test(hash)
  return hash.length > 0 && !/^0x[0-9a-fA-F]{8}$/.test(hash)
}

function sameTransactionHash(
  left: ActivityTransactionReference,
  hash: string,
  chainId: string | null
): boolean {
  if (left.hash === hash) return true
  if (/^0x[0-9a-fA-F]{64}$/.test(left.hash) && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return left.hash.toLowerCase() === hash.toLowerCase()
  }
  if (
    left.chainId?.startsWith('bip122:') &&
    chainId?.startsWith('bip122:') &&
    /^[0-9a-fA-F]{64}$/.test(left.hash) &&
    /^[0-9a-fA-F]{64}$/.test(hash)
  ) {
    return left.hash.toLowerCase() === hash.toLowerCase()
  }
  return false
}

export function getActivityTransactionReferences(
  item: ActivityItem
): readonly ActivityTransactionReference[] {
  const roleOrder = { origin: 0, relay: 1, destination: 2, refund: 3 } as const
  const hashedSegments = item.segments
    .filter(
      segment =>
        segment.evidence?.transactionHash &&
        isActivityTransactionHash(
          segment.evidence.transactionHash,
          segment.target.kind === 'onchain' ? segment.target.chainId : null
        )
    )
    .sort((left, right) => roleOrder[left.role] - roleOrder[right.role])
  const references: ActivityTransactionReference[] = []
  for (const segment of hashedSegments) {
    const hash = segment.evidence?.transactionHash
    if (!hash) continue
    const chainId = segment.target.kind === 'onchain' ? segment.target.chainId : null
    const duplicateIndex = references.findIndex(
      reference =>
        sameTransactionHash(reference, hash, chainId) &&
        (!reference.chainId || !chainId || reference.chainId === chainId)
    )
    const label =
      segment.role === 'origin'
        ? 'Outgoing Hash'
        : segment.role === 'destination'
          ? 'Destination Hash'
          : segment.role === 'refund'
            ? 'Refund Hash'
            : 'Relay Hash'
    if (duplicateIndex >= 0) {
      if (!references[duplicateIndex]!.chainId && chainId) {
        references[duplicateIndex] = Object.freeze({ id: segment.id, label, hash, chainId })
      }
      continue
    }
    references.push(Object.freeze({ id: segment.id, label, hash, chainId }))
  }
  return references.length === 1
    ? [Object.freeze({ ...references[0]!, label: 'Transaction Hash' })]
    : references
}
