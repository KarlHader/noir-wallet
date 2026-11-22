import type { ActivityItem } from '@/core/activity'
import { parseAssetId } from '@/core/chains/registry'

export type ActivityExecutionAddressModes = ReadonlyMap<string, 'Public' | 'Confidential'>

export function activityAddressKey(chainId: string, address: string): string {
  return `${chainId}:${chainId.startsWith('eip155:') ? address.toLowerCase() : address}`
}

export function getActivityAddressMode(
  modes: ActivityExecutionAddressModes | undefined,
  chainId: string | undefined,
  address: string | undefined
) {
  return chainId && address ? modes?.get(activityAddressKey(chainId, address)) : undefined
}

export function resolveOwnedActivitySettlement(
  item: ActivityItem,
  modes?: ActivityExecutionAddressModes
) {
  if (item.status !== 'final' || item.reconfirming || item.snapshot?.shield) return undefined
  const snapshot = item.snapshot
  const protocol = snapshot?.protocol
  const walletRoute =
    item.source === 'wallet-v2' &&
    protocol?.provider === 'rhea-cross-chain-dex' &&
    protocol.isCrossChain &&
    (item.kind === 'transfer' || item.kind === 'swap')
  const zcashRoute =
    item.source === 'zcash-v1' &&
    (item.kind === 'swap' ||
      (item.kind === 'transfer' && item.segments.some(segment => segment.role === 'relay')))
  if (!walletRoute && !zcashRoute) return undefined

  const chainId = walletRoute ? protocol.destination.chainId : snapshot?.recipient?.chainId
  const address = walletRoute ? protocol.destination.recipient : snapshot?.recipient?.address
  const assetId = walletRoute ? protocol.destination.assetId : snapshot?.counterAmount?.assetId
  if (!chainId?.startsWith('eip155:') || !assetId || parseAssetId(assetId).chainId !== chainId) {
    return undefined
  }
  const mode = getActivityAddressMode(modes, chainId, address)
  if (!mode) return undefined
  const hasIndependentSettlement = item.segments.some(segment => {
    const hash = segment.evidence?.transactionHash?.toLowerCase()
    return (
      segment.role === 'destination' &&
      segment.status === 'final' &&
      !segment.reconfirming &&
      segment.target.kind === 'onchain' &&
      segment.target.chainId === chainId &&
      hash !== undefined &&
      /^0x[0-9a-f]{64}$/.test(hash) &&
      (!walletRoute ||
        segment.evidence?.blockHeight !== undefined ||
        segment.evidence?.blockHash !== undefined) &&
      !item.segments.some(
        origin =>
          origin.role === 'origin' && origin.evidence?.transactionHash?.toLowerCase() === hash
      )
    )
  })
  if (!hasIndependentSettlement) return undefined
  return {
    chainId,
    assetId,
    domain: mode === 'Public' ? ('public' as const) : ('private' as const)
  }
}
