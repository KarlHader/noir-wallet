import type { ChainAccountId } from '@/core/accounts/domain'
import { parseChainId, type AssetRegistry } from '@/core/chains/registry'
import {
  bindNearIntentsTransactionGraph,
  type NearIntentsGraphSegmentIds,
  type NearIntentsTransactionBinding,
  parseTransactionGraph,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import type { PreparedSolanaTransfer } from './solana-transfer-preparer'

export interface CreateSolanaTransferGraphInput {
  readonly prepared: PreparedSolanaTransfer
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly assets: AssetRegistry
  readonly createdAt: number
  readonly chainAccountId?: ChainAccountId
  readonly nearIntents?: Readonly<{
    binding: NearIntentsTransactionBinding
    segmentIds: NearIntentsGraphSegmentIds
  }>
}

function parseCanonicalAmount(value: string, label: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid Solana ${label}`)
  return value
}

export function createSolanaTransferGraph(input: CreateSolanaTransferGraphInput): TransactionGraph {
  const chainId = parseChainId(input.prepared.chainId)
  if (chainId.namespace !== 'solana')
    throw new Error('Solana transfer graph requires a Solana chain')
  const amountRaw = parseCanonicalAmount(
    'kind' in input.prepared ? input.prepared.amountRaw : input.prepared.lamports,
    'amount'
  )
  const feeRaw = parseCanonicalAmount(input.prepared.feeLamports, 'fee')
  const nativeAsset = input.assets.get(`${chainId.id}/slip44:501`)
  if (
    !nativeAsset ||
    nativeAsset.asset.chainId !== chainId.id ||
    nativeAsset.asset.kind !== 'native' ||
    nativeAsset.metadata.decimals !== 9
  ) {
    throw new Error('Invalid Solana native asset definition')
  }
  const primaryAsset =
    'kind' in input.prepared ? input.assets.get(input.prepared.assetId) : nativeAsset
  if (
    !primaryAsset ||
    primaryAsset.asset.chainId !== chainId.id ||
    ('kind' in input.prepared &&
      (primaryAsset.asset.kind !== 'token' ||
        primaryAsset.asset.namespace !== 'token' ||
        primaryAsset.asset.reference !== input.prepared.mint ||
        primaryAsset.metadata.decimals !== input.prepared.decimals))
  ) {
    throw new Error('Invalid Solana transfer asset definition')
  }

  const graph = parseTransactionGraph({
    root: {
      id: input.transactionId,
      scope: input.scope,
      kind: 'transfer',
      status: 'prepared',
      segmentIds: [input.segmentId],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: input.prepared.sender === input.prepared.recipient ? 'self' : 'outgoing',
        primaryAmount: { assetId: primaryAsset.asset.id, amountRaw },
        feeLimit: { assetId: nativeAsset.asset.id, amountRaw: feeRaw },
        sender: { chainId: chainId.id, address: input.prepared.sender },
        recipient: { chainId: chainId.id, address: input.prepared.recipient }
      }
    },
    segments: [
      {
        id: input.segmentId,
        transactionId: input.transactionId,
        role: 'origin',
        target: {
          kind: 'onchain',
          chainId: chainId.id,
          ...(input.chainAccountId === undefined ? {} : { chainAccountId: input.chainAccountId })
        },
        status: 'prepared',
        requiredForFinality: true,
        dependsOn: [],
        evidence: { requiredConfirmations: 1 },
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        revision: 0
      }
    ]
  })
  return input.nearIntents
    ? bindNearIntentsTransactionGraph({
        graph,
        binding: input.nearIntents.binding,
        segmentIds: input.nearIntents.segmentIds,
        now: input.createdAt
      })
    : graph
}
