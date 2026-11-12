import type { ChainAccountId } from '@/core/accounts/domain'
import { parseChainId, type AssetRegistry } from '@/core/chains/registry'
import {
  parseTransactionGraph,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionLifecycleStatus,
  type TransactionSegmentId
} from '@/core/transactions/domain'

export interface StarknetTransferGraphInput {
  readonly chainId: string
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly invokeSegmentId: TransactionSegmentId
  readonly deploySegmentId?: TransactionSegmentId
  readonly assetId: string
  readonly feeAssetId: string
  readonly amountRaw: string
  readonly maxFeeRaw: string
  readonly sender: string
  readonly recipient: string
  readonly chainAccountId?: ChainAccountId
  readonly createdAt: number
  readonly status?: TransactionLifecycleStatus
  readonly invokeHash?: string
  readonly deployHash?: string
}

function decimal(value: string, label: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid Starknet ${label}`)
  return value
}

export function createStarknetTransferGraph(input: StarknetTransferGraphInput): TransactionGraph {
  const chainId = parseChainId(input.chainId)
  if (chainId.namespace !== 'starknet')
    throw new Error('Starknet transfer graph requires a Starknet chain')
  const status = input.status ?? 'prepared'
  const segmentIds = input.deploySegmentId
    ? [input.deploySegmentId, input.invokeSegmentId]
    : [input.invokeSegmentId]
  const segment = (
    id: TransactionSegmentId,
    dependsOn: readonly TransactionSegmentId[],
    hash: string | undefined
  ) => ({
    id,
    transactionId: input.transactionId,
    role: 'origin' as const,
    target: {
      kind: 'onchain' as const,
      chainId: chainId.id,
      ...(input.chainAccountId === undefined ? {} : { chainAccountId: input.chainAccountId })
    },
    status,
    requiredForFinality: true,
    dependsOn,
    ...(hash === undefined
      ? { evidence: { requiredConfirmations: 1 } }
      : { evidence: { transactionHash: hash, requiredConfirmations: 1 } }),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    revision: 0
  })
  return parseTransactionGraph({
    root: {
      id: input.transactionId,
      scope: input.scope,
      kind: 'transfer',
      status,
      segmentIds,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: input.sender === input.recipient ? 'self' : 'outgoing',
        primaryAmount: { assetId: input.assetId, amountRaw: decimal(input.amountRaw, 'amount') },
        feeLimit: { assetId: input.feeAssetId, amountRaw: decimal(input.maxFeeRaw, 'maximum fee') },
        sender: { chainId: chainId.id, address: input.sender },
        recipient: { chainId: chainId.id, address: input.recipient }
      }
    },
    segments: input.deploySegmentId
      ? [
          segment(input.deploySegmentId, [], input.deployHash),
          segment(input.invokeSegmentId, [input.deploySegmentId], input.invokeHash)
        ]
      : [segment(input.invokeSegmentId, [], input.invokeHash)]
  })
}

export function assertStarknetGraphMatches(
  graph: TransactionGraph,
  assets: AssetRegistry,
  expected: {
    readonly assetId: string
    readonly amountRaw: string
    readonly recipient: string
    readonly maxFeeRaw: string
  }
): void {
  const amount = graph.root.intent?.primaryAmount
  const fee = graph.root.intent?.feeLimit
  const recipient = graph.root.intent?.recipient?.address
  if (
    graph.root.kind !== 'transfer' ||
    amount?.assetId !== expected.assetId ||
    amount.amountRaw !== expected.amountRaw ||
    fee?.amountRaw !== expected.maxFeeRaw ||
    recipient !== expected.recipient ||
    !assets.get(expected.assetId)
  ) {
    throw new Error('Starknet review does not match the requested transfer')
  }
}
