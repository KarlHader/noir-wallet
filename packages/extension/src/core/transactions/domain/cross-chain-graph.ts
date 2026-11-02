import { parseTransactionGraph } from './parsing'
import type { TransactionAccountScope, TransactionGraph } from './transaction'
import type { TransactionId, TransactionSegmentId } from './identity'
import {
  assertNearIntentsTransferBinding,
  getTransactionProtocolIntentKind,
  parseRheaSwapTransactionBinding,
  type NearIntentsTransactionBinding,
  type RheaSwapTransactionBinding
} from './protocol'

export interface NearIntentsGraphSegmentIds {
  readonly relay: TransactionSegmentId
  readonly destination: TransactionSegmentId
  readonly refund: TransactionSegmentId
}

export type RheaSwapGraphSegmentIds = NearIntentsGraphSegmentIds

export function createRheaSwapSignedOrderGraph(input: {
  readonly transactionId: TransactionId
  readonly scope: TransactionAccountScope
  readonly binding: RheaSwapTransactionBinding
  readonly orderId: string
  readonly segmentIds: Readonly<{ origin: TransactionSegmentId } & RheaSwapGraphSegmentIds>
  readonly now: number
}): TransactionGraph {
  const binding = parseRheaSwapTransactionBinding(input.binding)
  const ids = [
    input.segmentIds.origin,
    input.segmentIds.relay,
    input.segmentIds.destination,
    input.segmentIds.refund
  ]
  if (
    new Set(ids).size !== ids.length ||
    input.orderId.length === 0 ||
    input.orderId.length > 512 ||
    input.orderId.trim() !== input.orderId ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0
  ) {
    throw new Error('Invalid RHEA Swap signed-order graph input')
  }
  return parseTransactionGraph({
    root: {
      id: input.transactionId,
      scope: input.scope,
      kind: getTransactionProtocolIntentKind(binding),
      status: 'broadcast',
      segmentIds: ids,
      createdAt: input.now,
      updatedAt: input.now,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: {
          assetId: binding.origin.assetId,
          amountRaw: binding.originAmountRaw
        },
        counterAmount: {
          assetId: binding.destination.assetId,
          amountRaw: binding.destination.expectedAmountRaw,
          ...(binding.destination.metadata ? { metadata: binding.destination.metadata } : {})
        },
        sender: { chainId: binding.origin.chainId, address: binding.sender },
        recipient: {
          chainId: binding.destination.chainId,
          address: binding.destination.recipient
        },
        protocol: binding
      }
    },
    segments: [
      {
        id: input.segmentIds.origin,
        transactionId: input.transactionId,
        role: 'origin',
        target: { kind: 'relay', provider: 'RHEA Signed Order' },
        status: 'broadcast',
        requiredForFinality: true,
        dependsOn: [],
        evidence: { externalReference: input.orderId },
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: input.segmentIds.relay,
        transactionId: input.transactionId,
        role: 'relay',
        target: { kind: 'relay', provider: 'RHEA CrossChainDex' },
        status: 'created',
        requiredForFinality: binding.isCrossChain,
        dependsOn: [input.segmentIds.origin],
        evidence: { externalReference: binding.quoteHandle },
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: input.segmentIds.destination,
        transactionId: input.transactionId,
        role: 'destination',
        target: { kind: 'onchain', chainId: binding.destination.chainId },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [input.segmentIds.relay],
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: input.segmentIds.refund,
        transactionId: input.transactionId,
        role: 'refund',
        target: { kind: 'onchain', chainId: binding.origin.chainId },
        status: 'created',
        requiredForFinality: false,
        dependsOn: [input.segmentIds.relay],
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      }
    ]
  })
}

export function createRheaSwapSignedSourceGraph(input: {
  readonly transactionId: TransactionId
  readonly scope: TransactionAccountScope
  readonly binding: RheaSwapTransactionBinding
  readonly sourceHash: string
  readonly segmentIds: Readonly<{ origin: TransactionSegmentId } & RheaSwapGraphSegmentIds>
  readonly now: number
}): TransactionGraph {
  const binding = parseRheaSwapTransactionBinding(input.binding)
  const ids = [
    input.segmentIds.origin,
    input.segmentIds.relay,
    input.segmentIds.destination,
    input.segmentIds.refund
  ]
  if (new Set(ids).size !== ids.length || !Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error('Invalid RHEA Swap signed-source graph input')
  }
  return parseTransactionGraph({
    root: {
      id: input.transactionId,
      scope: input.scope,
      kind: getTransactionProtocolIntentKind(binding),
      status: 'signed',
      segmentIds: ids,
      createdAt: input.now,
      updatedAt: input.now,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: {
          assetId: binding.origin.assetId,
          amountRaw: binding.originAmountRaw
        },
        counterAmount: {
          assetId: binding.destination.assetId,
          amountRaw: binding.destination.expectedAmountRaw,
          ...(binding.destination.metadata ? { metadata: binding.destination.metadata } : {})
        },
        sender: { chainId: binding.origin.chainId, address: binding.sender },
        recipient: {
          chainId: binding.destination.chainId,
          address: binding.destination.recipient
        },
        protocol: binding
      }
    },
    segments: [
      {
        id: input.segmentIds.origin,
        transactionId: input.transactionId,
        role: 'origin',
        target: { kind: 'onchain', chainId: binding.origin.chainId },
        status: 'signed',
        requiredForFinality: true,
        dependsOn: [],
        evidence: { transactionHash: input.sourceHash, requiredConfirmations: 1 },
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: input.segmentIds.relay,
        transactionId: input.transactionId,
        role: 'relay',
        target: { kind: 'relay', provider: 'RHEA CrossChainDex' },
        status: 'created',
        requiredForFinality: binding.isCrossChain,
        dependsOn: [input.segmentIds.origin],
        evidence: { externalReference: binding.quoteHandle },
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: input.segmentIds.destination,
        transactionId: input.transactionId,
        role: 'destination',
        target: { kind: 'onchain', chainId: binding.destination.chainId },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [input.segmentIds.relay],
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: input.segmentIds.refund,
        transactionId: input.transactionId,
        role: 'refund',
        target: { kind: 'onchain', chainId: binding.origin.chainId },
        status: 'created',
        requiredForFinality: false,
        dependsOn: [input.segmentIds.relay],
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      }
    ]
  })
}

export function createRheaSwapSignedBatchGraph(input: {
  readonly transactionId: TransactionId
  readonly scope: TransactionAccountScope
  readonly binding: RheaSwapTransactionBinding
  readonly sourceHashes: readonly string[]
  readonly segmentIds: Readonly<{
    origins: readonly TransactionSegmentId[]
    relay: TransactionSegmentId
    destination: TransactionSegmentId
    refund: TransactionSegmentId
  }>
  readonly now: number
}): TransactionGraph {
  const binding = parseRheaSwapTransactionBinding(input.binding)
  const ids = [
    ...input.segmentIds.origins,
    input.segmentIds.relay,
    input.segmentIds.destination,
    input.segmentIds.refund
  ]
  if (
    input.segmentIds.origins.length === 0 ||
    input.segmentIds.origins.length > 16 ||
    input.sourceHashes.length !== input.segmentIds.origins.length ||
    new Set(ids).size !== ids.length ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0
  ) {
    throw new Error('Invalid RHEA Swap signed-batch graph input')
  }
  return parseTransactionGraph({
    root: {
      id: input.transactionId,
      scope: input.scope,
      kind: getTransactionProtocolIntentKind(binding),
      status: 'signed',
      segmentIds: ids,
      createdAt: input.now,
      updatedAt: input.now,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: {
          assetId: binding.origin.assetId,
          amountRaw: binding.originAmountRaw
        },
        counterAmount: {
          assetId: binding.destination.assetId,
          amountRaw: binding.destination.expectedAmountRaw,
          ...(binding.destination.metadata ? { metadata: binding.destination.metadata } : {})
        },
        sender: { chainId: binding.origin.chainId, address: binding.sender },
        recipient: {
          chainId: binding.destination.chainId,
          address: binding.destination.recipient
        },
        protocol: binding
      }
    },
    segments: [
      ...input.segmentIds.origins.map((originId, index) => ({
        id: originId,
        transactionId: input.transactionId,
        role: 'origin' as const,
        target: { kind: 'onchain' as const, chainId: binding.origin.chainId },
        status: 'signed' as const,
        requiredForFinality: true,
        dependsOn: [],
        evidence: {
          transactionHash: input.sourceHashes[index],
          requiredConfirmations: 1
        },
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      })),
      {
        id: input.segmentIds.relay,
        transactionId: input.transactionId,
        role: 'relay',
        target: { kind: 'relay', provider: 'RHEA CrossChainDex' },
        status: 'created',
        requiredForFinality: binding.isCrossChain,
        dependsOn: input.segmentIds.origins,
        evidence: { externalReference: binding.quoteHandle },
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: input.segmentIds.destination,
        transactionId: input.transactionId,
        role: 'destination',
        target: { kind: 'onchain', chainId: binding.destination.chainId },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [input.segmentIds.relay],
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: input.segmentIds.refund,
        transactionId: input.transactionId,
        role: 'refund',
        target: { kind: 'onchain', chainId: binding.origin.chainId },
        status: 'created',
        requiredForFinality: false,
        dependsOn: [input.segmentIds.relay],
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      }
    ]
  })
}

export function bindNearIntentsTransactionGraph(input: {
  readonly graph: TransactionGraph
  readonly binding: NearIntentsTransactionBinding
  readonly segmentIds: NearIntentsGraphSegmentIds
  readonly now: number
}): TransactionGraph {
  const graph = parseTransactionGraph(input.graph)
  if (
    graph.root.kind !== 'transfer' ||
    graph.segments.length !== 1 ||
    graph.root.segmentIds.length !== 1 ||
    !graph.root.intent?.primaryAmount ||
    !graph.root.intent.sender ||
    !graph.root.intent.recipient
  ) {
    throw new Error('Near Intents binding requires a prepared single-chain transfer')
  }
  const origin = graph.segments[0]
  if (
    origin.role !== 'origin' ||
    origin.target.kind !== 'onchain' ||
    origin.target.chainId !== graph.root.intent.sender.chainId ||
    graph.root.intent.recipient.chainId !== origin.target.chainId
  ) {
    throw new Error('Near Intents origin segment does not match its transfer snapshot')
  }
  const binding = assertNearIntentsTransferBinding({
    binding: input.binding,
    chainId: origin.target.chainId,
    assetId: graph.root.intent.primaryAmount.assetId,
    recipient: graph.root.intent.recipient.address,
    amountRaw: graph.root.intent.primaryAmount.amountRaw,
    now: input.now
  })
  const uniqueIds = new Set([
    origin.id,
    input.segmentIds.relay,
    input.segmentIds.destination,
    input.segmentIds.refund
  ])
  if (uniqueIds.size !== 4) throw new Error('Near Intents segment IDs must be unique')

  return parseTransactionGraph({
    root: {
      ...graph.root,
      kind: binding.kind,
      segmentIds: [
        origin.id,
        input.segmentIds.relay,
        input.segmentIds.destination,
        input.segmentIds.refund
      ],
      intent: {
        ...graph.root.intent,
        counterAmount: {
          assetId: binding.destination.assetId,
          amountRaw: binding.destination.expectedAmountRaw
        },
        protocol: binding
      }
    },
    segments: [
      origin,
      {
        id: input.segmentIds.relay,
        transactionId: graph.root.id,
        role: 'relay',
        target: { kind: 'relay', provider: 'NEAR Intents' },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [origin.id],
        evidence: { externalReference: binding.depositAddress },
        createdAt: graph.root.createdAt,
        updatedAt: graph.root.createdAt,
        revision: 0
      },
      {
        id: input.segmentIds.destination,
        transactionId: graph.root.id,
        role: 'destination',
        target:
          binding.kind === 'supply'
            ? {
                kind: 'protocol',
                provider: 'RHEA Lending',
                account: binding.destination.recipient
              }
            : { kind: 'onchain', chainId: binding.destination.chainId },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [input.segmentIds.relay],
        createdAt: graph.root.createdAt,
        updatedAt: graph.root.createdAt,
        revision: 0
      },
      {
        id: input.segmentIds.refund,
        transactionId: graph.root.id,
        role: 'refund',
        target: { kind: 'onchain', chainId: binding.origin.chainId },
        status: 'created',
        requiredForFinality: false,
        dependsOn: [input.segmentIds.relay],
        createdAt: graph.root.createdAt,
        updatedAt: graph.root.createdAt,
        revision: 0
      }
    ]
  })
}

export function bindRheaSwapTransactionGraph(input: {
  readonly graph: TransactionGraph
  readonly binding: RheaSwapTransactionBinding
  readonly segmentIds: RheaSwapGraphSegmentIds
  readonly now: number
}): TransactionGraph {
  const graph = parseTransactionGraph(input.graph)
  const binding = parseRheaSwapTransactionBinding(input.binding)
  const isTransfer = graph.root.kind === 'transfer'
  const isContractCall = graph.root.kind === 'contract-call'
  const intent = graph.root.intent
  if (
    (!isTransfer && !isContractCall) ||
    graph.segments.length !== 1 ||
    graph.root.segmentIds.length !== 1 ||
    !intent?.sender ||
    !intent.recipient ||
    binding.expiresAt <= input.now
  ) {
    throw new Error('RHEA Swap binding requires a fresh prepared source transaction')
  }
  const primaryAmount = intent.primaryAmount
  const origin = graph.segments[0]
  if (
    origin.role !== 'origin' ||
    origin.target.kind !== 'onchain' ||
    origin.target.chainId !== binding.origin.chainId ||
    (isTransfer &&
      (!primaryAmount ||
        primaryAmount.assetId !== binding.origin.assetId ||
        primaryAmount.amountRaw !== binding.originAmountRaw)) ||
    intent.sender.address !== binding.sender ||
    intent.recipient.address !== binding.sourceTarget
  ) {
    throw new Error('RHEA Swap binding does not match the source transfer')
  }
  const uniqueIds = new Set([
    origin.id,
    input.segmentIds.relay,
    input.segmentIds.destination,
    input.segmentIds.refund
  ])
  if (uniqueIds.size !== 4) throw new Error('RHEA Swap segment IDs must be unique')

  return parseTransactionGraph({
    root: {
      ...graph.root,
      kind: getTransactionProtocolIntentKind(binding),
      segmentIds: [
        origin.id,
        input.segmentIds.relay,
        input.segmentIds.destination,
        input.segmentIds.refund
      ],
      intent: {
        ...intent,
        primaryAmount: {
          assetId: binding.origin.assetId,
          amountRaw: binding.originAmountRaw
        },
        counterAmount: {
          assetId: binding.destination.assetId,
          amountRaw: binding.destination.expectedAmountRaw,
          ...(binding.destination.metadata ? { metadata: binding.destination.metadata } : {})
        },
        protocol: binding
      }
    },
    segments: [
      origin,
      {
        id: input.segmentIds.relay,
        transactionId: graph.root.id,
        role: 'relay',
        target: { kind: 'relay', provider: 'RHEA CrossChainDex' },
        status: 'created',
        requiredForFinality: binding.isCrossChain,
        dependsOn: [origin.id],
        evidence: { externalReference: binding.quoteHandle },
        createdAt: graph.root.createdAt,
        updatedAt: graph.root.createdAt,
        revision: 0
      },
      {
        id: input.segmentIds.destination,
        transactionId: graph.root.id,
        role: 'destination',
        target: { kind: 'onchain', chainId: binding.destination.chainId },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [input.segmentIds.relay],
        createdAt: graph.root.createdAt,
        updatedAt: graph.root.createdAt,
        revision: 0
      },
      {
        id: input.segmentIds.refund,
        transactionId: graph.root.id,
        role: 'refund',
        target: { kind: 'onchain', chainId: binding.origin.chainId },
        status: 'created',
        requiredForFinality: false,
        dependsOn: [input.segmentIds.relay],
        createdAt: graph.root.createdAt,
        updatedAt: graph.root.createdAt,
        revision: 0
      }
    ]
  })
}
