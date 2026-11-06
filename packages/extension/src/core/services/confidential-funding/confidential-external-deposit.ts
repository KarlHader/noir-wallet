import type { Network } from '@/types'
import type { ConfidentialQuote } from './confidential-funding-model'
import { parseAccountId } from '@/core/accounts/domain'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionGraph
} from '@/core/transactions/domain'

export interface ExternalShieldDeposit {
  readonly schemaVersion: 1
  readonly depositId: string
  readonly transactionId: string
  readonly network: Network
  readonly keyDomainId: string
  readonly accountId: string
  readonly source: Readonly<{
    chainId: string
    chainName: string
    assetId: string
    protocolAssetId: string
    amountRaw: string
  }>
  readonly destinationAssetId: string
  readonly sourceSymbol: string
  readonly sourceDecimals: number
  readonly signerId: string
  readonly depositAddress: string
  readonly depositMemo?: string
  readonly refundAddress: string
  readonly amountRaw: string
  readonly expectedOutputRaw: string
  readonly minimumOutputRaw: string
  readonly settledOutputRaw?: string
  readonly depositedAmountRaw?: string
  readonly providerStatus?: string
  readonly balanceRefreshedAt?: number
  readonly slippageBps: number
  readonly expiresAt: number
  readonly phase: 'awaiting-payment' | 'processing' | 'ready' | 'refunded' | 'failed'
  readonly errorStatus?: string
  readonly requestId?: string
  readonly quote: ConfidentialQuote
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateExternalShieldDepositInput {
  readonly network: Network
  readonly keyDomainId: string
  readonly accountId: string
  readonly source: ExternalShieldDeposit['source']
  readonly refundAddress: string
  readonly requestId?: string
}

export type ExternalShieldDepositScope = Pick<
  ExternalShieldDeposit,
  'network' | 'keyDomainId' | 'accountId'
>

export function createExternalShieldDepositGraph(record: ExternalShieldDeposit): TransactionGraph {
  const transactionId = parseTransactionId(record.transactionId)
  const originId = parseTransactionSegmentId(
    `segment:confidential-external:${record.depositId}:origin`
  )
  const relayId = parseTransactionSegmentId(
    `segment:confidential-external:${record.depositId}:relay`
  )
  const destinationId = parseTransactionSegmentId(
    `segment:confidential-external:${record.depositId}:destination`
  )
  const sourceChainId = parseChainId(record.source.chainId).id
  return parseTransactionGraph({
    root: {
      id: transactionId,
      scope: {
        keyDomainId: parseKeyDomainId(record.keyDomainId),
        accountId: parseAccountId(record.accountId)
      },
      kind: 'shield',
      status: 'created',
      segmentIds: [originId, relayId, destinationId],
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'incoming',
        shield: {
          schemaVersion: 1,
          operation: 'deposit',
          sourceDomain: 'public',
          destinationDomain: 'shield'
        },
        primaryAmount: {
          assetId: parseAssetId(record.source.assetId).id,
          amountRaw: record.amountRaw
        },
        counterAmount: {
          assetId: parseAssetId(record.source.assetId).id,
          amountRaw: record.expectedOutputRaw
        },
        recipient: { chainId: sourceChainId, address: record.depositAddress }
      }
    },
    segments: [
      {
        id: originId,
        transactionId,
        role: 'origin',
        target: { kind: 'onchain', chainId: sourceChainId },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [],
        evidence: { externalReference: record.depositAddress },
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        revision: 0
      },
      {
        id: relayId,
        transactionId,
        role: 'relay',
        target: { kind: 'protocol', provider: 'Confidential Intents', account: record.signerId },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [originId],
        evidence: { externalReference: `quote:${record.quote.correlationId}` },
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        revision: 0
      },
      {
        id: destinationId,
        transactionId,
        role: 'destination',
        target: { kind: 'protocol', provider: 'Confidential Intents', account: record.signerId },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [relayId],
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        revision: 0
      }
    ]
  })
}

export function projectExternalShieldDepositActivityGraph(
  graph: TransactionGraph,
  record: ExternalShieldDeposit
): TransactionGraph {
  if (
    record.phase !== 'refunded' ||
    record.transactionId !== graph.root.id ||
    record.keyDomainId !== graph.root.scope.keyDomainId ||
    record.accountId !== graph.root.scope.accountId ||
    graph.root.status !== 'failed' ||
    !graph.root.failure ||
    graph.root.failure?.code === 'refunded' ||
    !graph.root.id.startsWith('tx:confidential-external:')
  ) {
    return graph
  }
  return parseTransactionGraph({
    root: {
      ...graph.root,
      failure: { ...graph.root.failure, code: 'refunded' },
      updatedAt: Math.max(graph.root.updatedAt, record.updatedAt)
    },
    segments: graph.segments.map(segment =>
      segment.status === 'failed' && segment.failure
        ? { ...segment, failure: { ...segment.failure, code: 'refunded' } }
        : segment
    )
  })
}
