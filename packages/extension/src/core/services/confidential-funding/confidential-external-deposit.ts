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
  readonly amountMode?: 'minimum'
  readonly expectedOutputRaw: string
  readonly minimumOutputRaw: string
  readonly settledOutputRaw?: string
  readonly depositedAmountRaw?: string
  readonly fundingObservedAt?: number
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
  readonly source: Omit<ExternalShieldDeposit['source'], 'amountRaw'> &
    Readonly<{ amountRaw?: string }>
  readonly refundAddress: string
  readonly slippageBps?: number
  readonly requestId?: string
}

export type ExternalShieldDepositScope = Pick<
  ExternalShieldDeposit,
  'network' | 'keyDomainId' | 'accountId'
>

export type ExternalShieldDepositFailureStage =
  | 'request'
  | 'account'
  | 'quote'
  | 'authorization'
  | 'storage'

export class ExternalShieldDepositError extends Error {
  constructor(
    readonly stage: ExternalShieldDepositFailureStage,
    readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : 'Receiving address unavailable')
    this.name = 'ExternalShieldDepositError'
  }
}

export function externalShieldDepositFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Wallet is locked' || message === 'Credential is not unlocked')
    return 'Unlock your wallet, then try again.'
  if (message === 'Quoting for this pair is not available')
    return 'This token and network are temporarily unavailable. Try again or select another network.'
  if (
    message === 'External Shield deposit asset catalog changed' ||
    message === 'External Shield deposit request is invalid'
  )
    return 'Could not prepare this receiving address. Select your token and network again.'
  if (
    message === 'Confidential funding requires an active software EVM Account' ||
    message === 'External Shield deposit Account has no EVM identity'
  )
    return 'Select a software account with Ethereum enabled, then try again.'
  if (
    message === 'External Shield deposit refund address is invalid' ||
    message === 'External Shield deposit requires a transparent Zcash refund address'
  )
    return 'A receiving address is unavailable for this account on the selected network.'
  const stage = (error as { depositStage?: unknown } | null)?.depositStage
  if (stage === 'account')
    return 'Could not access this account. Unlock your wallet again and retry.'
  if (stage === 'quote') return 'Could not get a receiving address from the provider. Try again.'
  if (stage === 'authorization') return 'Could not connect this account to the provider. Try again.'
  if (stage === 'storage') return 'Could not save the receiving address. Try again.'
  return 'Receiving address unavailable. Try again.'
}

const UNFUNDED_AUTO_REFRESH_MS = 3 * 60 * 60 * 1000

type ExternalShieldDepositLifecycle = Pick<
  ExternalShieldDeposit,
  | 'phase'
  | 'fundingObservedAt'
  | 'depositedAmountRaw'
  | 'providerStatus'
  | 'updatedAt'
  | 'expiresAt'
>

export function hasExternalShieldDepositFunding(record: ExternalShieldDepositLifecycle): boolean {
  return (
    record.fundingObservedAt !== undefined ||
    BigInt(record.depositedAmountRaw ?? '0') > 0n ||
    record.phase === 'processing' ||
    record.phase === 'ready' ||
    record.phase === 'refunded' ||
    ['INCOMPLETE_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'PENDING'].includes(
      record.providerStatus ?? ''
    )
  )
}

export function isExternalShieldDepositExpired(
  record: ExternalShieldDepositLifecycle,
  now = Date.now()
): boolean {
  return now >= record.expiresAt || record.providerStatus?.trim().toUpperCase() === 'EXPIRED'
}

export function isExternalShieldDepositPending(
  record: ExternalShieldDepositLifecycle,
  now = Date.now()
): boolean {
  return (
    record.phase === 'processing' ||
    (record.phase === 'awaiting-payment' &&
      (!isExternalShieldDepositExpired(record, now) || hasExternalShieldDepositFunding(record)))
  )
}

export function shouldAutoRefreshExternalShieldDeposit(
  record: ExternalShieldDepositLifecycle,
  now = Date.now()
): boolean {
  if (record.phase === 'ready' || record.phase === 'refunded') return false
  // Amounts may be absent while a deposit or refund is already in flight.
  return (
    hasExternalShieldDepositFunding(record) || now - record.updatedAt < UNFUNDED_AUTO_REFRESH_MS
  )
}

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
