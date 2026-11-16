import type { ChainAccountId } from '@/core/accounts/domain'
import type { AssetRegistry } from '@/core/chains/registry'
import {
  parseTransactionGraph,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import { parsePreparedBitcoinPsbt } from './bitcoin-prepared-psbt-validator'
import { parseBitcoinAddress, type PreparedBitcoinPsbt } from './bitcoin-transaction-model'
import { parseBitcoinFinalityConfirmations } from './bitcoin-transaction-observer'
import {
  bindNearIntentsTransactionGraph,
  bindRheaSwapTransactionGraph,
  type NearIntentsGraphSegmentIds,
  type NearIntentsTransactionBinding,
  type RheaSwapTransactionBinding
} from '@/core/transactions/domain'

export interface CreateBitcoinTransferGraphInput {
  readonly prepared: PreparedBitcoinPsbt
  readonly sender: string
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly assets: AssetRegistry
  readonly requiredConfirmations: number
  readonly createdAt: number
  readonly chainAccountId?: ChainAccountId
  readonly protocol?: Readonly<{
    binding: NearIntentsTransactionBinding | RheaSwapTransactionBinding
    segmentIds: NearIntentsGraphSegmentIds
  }>
}

export function createBitcoinTransferGraph(
  input: CreateBitcoinTransferGraphInput
): TransactionGraph {
  const { prepared } = parsePreparedBitcoinPsbt(input.prepared)
  const sender = parseBitcoinAddress(input.sender, prepared.chainId, prepared.addressType)
  const requiredConfirmations = parseBitcoinFinalityConfirmations(input.requiredConfirmations)
  const asset = input.assets.resolve(`${prepared.chainId}/slip44:0`)
  if (
    asset.asset.chainId !== prepared.chainId ||
    asset.asset.kind !== 'native' ||
    asset.metadata.decimals !== 8
  ) {
    throw new Error('Invalid Bitcoin native asset definition')
  }

  const graph = parseTransactionGraph({
    root: {
      id: input.transactionId,
      scope: {
        keyDomainId: input.scope.keyDomainId,
        accountId: input.scope.accountId
      },
      kind: 'transfer',
      status: 'prepared',
      segmentIds: [input.segmentId],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: sender === prepared.recipient ? 'self' : 'outgoing',
        primaryAmount: {
          assetId: asset.asset.id,
          amountRaw: prepared.amountSats
        },
        feeLimit: {
          assetId: asset.asset.id,
          amountRaw: prepared.feeSats
        },
        sender: {
          chainId: prepared.chainId,
          address: sender
        },
        recipient: {
          chainId: prepared.chainId,
          address: prepared.recipient
        }
      }
    },
    segments: [
      {
        id: input.segmentId,
        transactionId: input.transactionId,
        role: 'origin',
        target: {
          kind: 'onchain',
          chainId: prepared.chainId,
          ...(input.chainAccountId === undefined ? {} : { chainAccountId: input.chainAccountId })
        },
        status: 'prepared',
        requiredForFinality: true,
        dependsOn: [],
        evidence: { requiredConfirmations },
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        revision: 0
      }
    ]
  })
  return input.protocol
    ? input.protocol.binding.provider === 'near-intents'
      ? bindNearIntentsTransactionGraph({
          graph,
          binding: input.protocol.binding,
          segmentIds: input.protocol.segmentIds,
          now: input.createdAt
        })
      : bindRheaSwapTransactionGraph({
          graph,
          binding: input.protocol.binding,
          segmentIds: input.protocol.segmentIds,
          now: input.createdAt
        })
    : graph
}
