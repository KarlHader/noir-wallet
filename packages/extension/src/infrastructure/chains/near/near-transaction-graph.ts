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

import type { PreparedNearTransfer } from './near-transfer-preparer'

export interface CreateNearTransferGraphInput {
  readonly prepared: PreparedNearTransfer
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
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid NEAR ${label}`)
  return value
}

export function createNearTransferGraph(input: CreateNearTransferGraphInput): TransactionGraph {
  const chainId = parseChainId(input.prepared.chainId)
  if (chainId.namespace !== 'near') throw new Error('NEAR transfer graph requires a NEAR chain')
  const amountRaw = parseCanonicalAmount(
    'kind' in input.prepared ? input.prepared.amountRaw : input.prepared.depositYocto,
    'amount'
  )
  const feeRaw = parseCanonicalAmount(input.prepared.maximumFeeYocto, 'maximum fee')
  const nativeAsset = input.assets.get(`${chainId.id}/slip44:397`)
  if (
    !nativeAsset ||
    nativeAsset.asset.chainId !== chainId.id ||
    nativeAsset.asset.kind !== 'native' ||
    nativeAsset.metadata.decimals !== 24
  ) {
    throw new Error('Invalid NEAR native asset definition')
  }
  const hasAsset = 'kind' in input.prepared
  const primaryAsset = hasAsset ? input.assets.get(input.prepared.assetId) : nativeAsset
  if (
    !primaryAsset ||
    primaryAsset.asset.chainId !== chainId.id ||
    ('kind' in input.prepared &&
      input.prepared.kind === 'token' &&
      (primaryAsset.asset.kind !== 'token' ||
        primaryAsset.asset.namespace !== 'nep141' ||
        primaryAsset.asset.reference.replace(/%5F/gi, '_') !== input.prepared.contractId))
  ) {
    throw new Error('Invalid NEAR transfer asset definition')
  }
  const recipient =
    'kind' in input.prepared ? input.prepared.recipientId : input.prepared.receiverId

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
        direction: input.prepared.signerId === recipient ? 'self' : 'outgoing',
        primaryAmount: { assetId: primaryAsset.asset.id, amountRaw },
        feeLimit: { assetId: nativeAsset.asset.id, amountRaw: feeRaw },
        sender: { chainId: chainId.id, address: input.prepared.signerId },
        recipient: { chainId: chainId.id, address: recipient }
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
