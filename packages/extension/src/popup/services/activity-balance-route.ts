import { isActivityReceive, type ActivityItem } from '@/core/activity'
import {
  getActivityBalanceDomains,
  type ActivityBalanceDomain
} from '@/core/activity/activity-balance-domains'
import { parseAssetId } from '@/core/chains/registry'
import { ZCASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import type { TransactionAssetAmount } from '@/core/transactions/domain'
import { supportsZcashMemo } from '@/lib/zcash-memo'

export type ActivityExecutionAddressModes = ReadonlyMap<string, 'Public' | 'Confidential'>
export {
  getActivityBalanceDomains,
  isExternalShieldDepositActivity,
  type ActivityBalanceDomain
} from '@/core/activity/activity-balance-domains'

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

function receiptIdentity(
  item: ActivityItem,
  domain: ActivityBalanceDomain,
  amount: TransactionAssetAmount,
  hash: string
): string {
  const chainId = parseAssetId(amount.assetId).chainId
  return JSON.stringify([
    item.scope.keyDomainId,
    item.scope.accountId,
    domain,
    amount.assetId,
    amount.amountRaw,
    chainId.startsWith('eip155:') ? hash.toLowerCase() : hash
  ])
}

export function resolveActivityReceipts(
  items: readonly ActivityItem[],
  domain: ActivityBalanceDomain,
  modes?: ActivityExecutionAddressModes
): {
  readonly projected: readonly ActivityItem[]
  readonly depositReceiptIds: ReadonlySet<string>
} {
  const receipts = new Map<string, string | null>()
  const depositReceiptIds = new Set<string>()
  for (const item of items) {
    if (
      item.status !== 'final' ||
      item.reconfirming ||
      !isActivityReceive(item) ||
      !getActivityBalanceDomains(item).includes(domain)
    )
      continue
    const hash = item.segments.find(
      segment =>
        segment.role === 'origin' && segment.target.kind === 'onchain' && segment.status === 'final'
    )?.evidence?.transactionHash
    if (!hash) continue
    const primary = item.snapshot?.primaryAmount
    if (primary) {
      const key = receiptIdentity(item, domain, primary, hash)
      receipts.set(key, receipts.has(key) ? null : item.id)
    }
  }

  const projected: ActivityItem[] = []
  for (const item of items) {
    const snapshot = item.snapshot
    const recipient = snapshot?.recipient
    if (
      item.status !== 'final' ||
      item.reconfirming ||
      !snapshot ||
      !recipient ||
      getActivityBalanceDomains(item).includes(domain)
    )
      continue
    const shield = snapshot.shield
    const incognitoDeposit =
      domain === 'private' &&
      snapshot.direction === 'self' &&
      ((shield?.operation === 'withdraw' && shield.sourceDomain === 'shield') ||
        (shield?.operation === 'cluster' && shield.sourceDomain === 'public'))
    if (
      shield &&
      domain === 'public' &&
      (recipient.chainId === ZCASH_CHAIN_IDS.mainnet ||
        recipient.chainId === ZCASH_CHAIN_IDS.testnet) &&
      supportsZcashMemo(recipient.address)
    )
      continue
    const settlement = shield ? undefined : resolveOwnedActivitySettlement(item, modes)
    const ownedMode = getActivityAddressMode(modes, recipient.chainId, recipient.address)
    const recipientIsOwned =
      snapshot.direction === 'self' ||
      (domain === 'public' && ownedMode === 'Public') ||
      (domain === 'private' && ownedMode === 'Confidential')
    if (
      shield
        ? shield.destinationDomain !== domain || !recipientIsOwned
        : settlement?.domain !== domain
    )
      continue
    const assetId = settlement?.assetId ?? snapshot.counterAmount?.assetId
    if (!assetId) continue

    for (const segment of item.segments) {
      const evidence = segment.evidence
      const hash = evidence?.transactionHash
      const shieldCredit =
        domain === 'shield' &&
        segment.target.kind === 'protocol' &&
        segment.target.provider === 'Confidential Intents' &&
        segment.target.account === recipient.address
      const onchainCredit =
        segment.target.kind === 'onchain' && segment.target.chainId === recipient.chainId && hash
      const amount: TransactionAssetAmount | undefined =
        evidence?.settledAmount ??
        evidence?.assetEffects?.changes.find(
          change => change.assetId === assetId && change.direction === 'incoming'
        )
      if (
        segment.role !== 'destination' ||
        segment.status !== 'final' ||
        segment.reconfirming ||
        evidence?.replacementTransactionHash ||
        (!shieldCredit && !onchainCredit) ||
        !amount ||
        amount.assetId !== assetId ||
        !/^[1-9]\d*$/.test(amount.amountRaw)
      )
        continue
      if (onchainCredit) {
        const key = receiptIdentity(item, domain, amount, onchainCredit)
        const observedReceiptId = receipts.get(key)
        if (incognitoDeposit && observedReceiptId) depositReceiptIds.add(observedReceiptId)
        if (receipts.has(key)) continue
      }
      const fundingAccount =
        shieldCredit && shield?.operation === 'deposit'
          ? item.segments.find(segment => segment.role === 'relay')?.target
          : undefined
      const sender =
        fundingAccount?.kind === 'protocol' &&
        fundingAccount.provider === 'Confidential Intents' &&
        fundingAccount.account &&
        snapshot.sender
          ? { chainId: snapshot.sender.chainId, address: fundingAccount.account }
          : undefined
      projected.push({
        id: `receive:${segment.id}`,
        source: item.source,
        scope: item.scope,
        kind: 'receive',
        ...(incognitoDeposit ? { incognitoDeposit: true as const } : {}),
        ...(domain === 'private' ? { accountMode: 'private' as const } : {}),
        ...(domain === 'shield' ? { assetDomains: ['shield'] as const } : {}),
        status: 'final',
        completeness: 'complete',
        snapshot: {
          schemaVersion: 1,
          direction: 'incoming',
          primaryAmount: { assetId: amount.assetId, amountRaw: amount.amountRaw },
          ...(sender ? { sender } : {}),
          ...(shieldCredit ? {} : { recipient })
        },
        segments: [
          {
            id: segment.id,
            role: 'origin',
            status: 'final',
            target: segment.target,
            ...(onchainCredit
              ? {
                  evidence: {
                    transactionHash: onchainCredit,
                    ...(evidence?.blockHeight !== undefined
                      ? { blockHeight: evidence.blockHeight }
                      : {}),
                    ...(evidence?.blockHash !== undefined ? { blockHash: evidence.blockHash } : {})
                  }
                }
              : {})
          }
        ],
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt
      })
    }
  }
  return { projected, depositReceiptIds }
}
