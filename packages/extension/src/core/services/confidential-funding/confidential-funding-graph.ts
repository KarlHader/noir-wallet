import {
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionGraph
} from '@/core/transactions/domain'

export function createConfidentialFundingGraph(input: {
  readonly planId: string
  readonly operation?: 'deposit' | 'withdraw' | 'cluster' | 'swap'
  readonly sourceDomain?: 'public' | 'private' | 'shield'
  readonly destinationDomain?: 'public' | 'private' | 'shield'
  readonly scope: TransactionAccountScope
  readonly source: Readonly<{
    chainId: string
    assetId: string
    amountRaw: string
    address: string
    feeAssetId?: string
    maximumFeeRaw?: string
    transactionHash?: string
  }>
  readonly destination: Readonly<{
    chainId: string
    assetId: string
    expectedAmountRaw: string
    address: string
  }>
  readonly externalRecipient?: boolean
  readonly withdrawDepositAddresses: readonly (string | null)[]
  readonly requiresDeposit: boolean
  readonly signedWithdrawFingerprint?: string
  readonly now: number
}): TransactionGraph {
  if (
    input.operation &&
    ((input.operation === 'deposit' &&
      (!['public', 'private'].includes(input.sourceDomain ?? '') ||
        input.destinationDomain !== 'shield')) ||
      (input.operation === 'withdraw' &&
        (input.sourceDomain !== 'shield' ||
          !['public', 'private'].includes(input.destinationDomain ?? ''))) ||
      (input.operation === 'swap' &&
        (input.sourceDomain !== 'shield' || input.destinationDomain !== 'shield')) ||
      (input.operation === 'cluster' &&
        (!['public', 'private', 'shield'].includes(input.sourceDomain ?? '') ||
          !['public', 'private'].includes(input.destinationDomain ?? '') ||
          input.sourceDomain === input.destinationDomain)))
  )
    throw new Error('Confidential funding graph route is invalid')
  if (!input.requiresDeposit && !/^[0-9a-f]{64}$/.test(input.signedWithdrawFingerprint ?? '')) {
    throw new Error('Confidential funding graph requires a frozen signed withdraw batch')
  }
  const transactionId = parseTransactionId(`tx:confidential:${input.planId}`)
  const originId = parseTransactionSegmentId(`segment:confidential:${input.planId}:origin`)
  const relayId = parseTransactionSegmentId(`segment:confidential:${input.planId}:relay`)
  const destinationIds = input.withdrawDepositAddresses.map((_, index) =>
    parseTransactionSegmentId(`segment:confidential:${input.planId}:withdraw:${index}`)
  )
  const refundId = parseTransactionSegmentId(`segment:confidential:${input.planId}:refund`)
  const segmentIds = [originId, relayId, ...destinationIds, refundId]
  return parseTransactionGraph({
    root: {
      id: transactionId,
      scope: input.scope,
      kind:
        input.operation === 'deposit'
          ? 'shield'
          : input.operation === 'withdraw' || input.operation === 'cluster'
            ? 'withdraw'
            : 'swap',
      status: input.requiresDeposit ? 'signed' : 'confirming',
      segmentIds,
      createdAt: input.now,
      updatedAt: input.now,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: input.operation && !input.externalRecipient ? 'self' : 'outgoing',
        ...(input.operation
          ? {
              shield: {
                schemaVersion: 1 as const,
                operation: input.operation,
                sourceDomain: input.sourceDomain!,
                destinationDomain: input.destinationDomain!
              }
            }
          : {}),
        primaryAmount: { assetId: input.source.assetId, amountRaw: input.source.amountRaw },
        counterAmount: {
          assetId: input.destination.assetId,
          amountRaw: input.destination.expectedAmountRaw
        },
        ...(input.source.feeAssetId && input.source.maximumFeeRaw
          ? {
              feeLimit: {
                assetId: input.source.feeAssetId,
                amountRaw: input.source.maximumFeeRaw
              }
            }
          : {}),
        sender: { chainId: input.source.chainId, address: input.source.address },
        recipient: { chainId: input.destination.chainId, address: input.destination.address }
      }
    },
    segments: [
      {
        id: originId,
        transactionId,
        role: 'origin',
        target: input.requiresDeposit
          ? { kind: 'onchain', chainId: input.source.chainId }
          : { kind: 'protocol', provider: 'Confidential Intents', account: input.source.address },
        status: input.requiresDeposit ? 'signed' : 'final',
        requiredForFinality: true,
        dependsOn: [],
        ...(input.source.transactionHash
          ? { evidence: { transactionHash: input.source.transactionHash } }
          : !input.requiresDeposit
            ? {
                evidence: {
                  externalReference: `signed-payload:sha256:${input.signedWithdrawFingerprint}`
                }
              }
            : {}),
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: relayId,
        transactionId,
        role: 'relay',
        target: {
          kind: 'protocol',
          provider: 'Confidential Intents',
          account: input.source.address
        },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [originId],
        evidence: { externalReference: input.planId },
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      ...destinationIds.map((id, index) => ({
        id,
        transactionId,
        role: 'destination' as const,
        target:
          input.operation === 'swap'
            ? {
                kind: 'protocol' as const,
                provider: 'Confidential Intents',
                account: input.destination.address
              }
            : { kind: 'onchain' as const, chainId: input.destination.chainId },
        status: 'created' as const,
        requiredForFinality: false,
        dependsOn: [relayId],
        ...(input.withdrawDepositAddresses[index]
          ? { evidence: { externalReference: input.withdrawDepositAddresses[index] } }
          : {}),
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      })),
      {
        id: refundId,
        transactionId,
        role: 'refund',
        target:
          input.operation === 'deposit'
            ? { kind: 'onchain', chainId: input.source.chainId }
            : {
                kind: 'protocol',
                provider: 'Confidential Intents',
                account: input.source.address
              },
        status: 'created',
        requiredForFinality: false,
        dependsOn: [relayId],
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      }
    ]
  })
}
