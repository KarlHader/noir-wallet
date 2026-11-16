import { parseChainId } from '@/core/chains/registry'
import type {
  TransactionEventId,
  TransactionSegment,
  TransactionSegmentEvent
} from '@/core/transactions/domain'
import { BITCOIN_MAINNET_CHAIN_ID, BITCOIN_TESTNET_CHAIN_ID } from './bitcoin-transaction-model'
import type { BitcoinTransactionObservation } from './bitcoin-transaction-observer'

export interface CreateBitcoinTransactionSegmentEventInput {
  readonly segment: TransactionSegment
  readonly observation: BitcoinTransactionObservation
  readonly eventId: TransactionEventId
  readonly observedAt: number
}

function assertBitcoinSegment(segment: TransactionSegment): void {
  if (
    segment.target.kind !== 'onchain' ||
    (segment.target.chainId !== BITCOIN_MAINNET_CHAIN_ID &&
      segment.target.chainId !== BITCOIN_TESTNET_CHAIN_ID) ||
    parseChainId(segment.target.chainId).namespace !== 'bip122'
  ) {
    throw new Error('Bitcoin observations require a Bitcoin on-chain transaction segment')
  }
}

function assertObservationBinding(
  segment: TransactionSegment,
  observation: BitcoinTransactionObservation
): void {
  if (
    segment.evidence?.transactionHash !== undefined &&
    segment.evidence.transactionHash !== observation.transactionId
  ) {
    throw new Error('Bitcoin observation transaction ID does not match the transaction segment')
  }
  if (
    segment.evidence?.requiredConfirmations !== undefined &&
    segment.evidence.requiredConfirmations !== observation.requiredConfirmations
  ) {
    throw new Error('Bitcoin confirmation policy changed for an existing transaction')
  }
}

function createEvent(
  input: CreateBitcoinTransactionSegmentEventInput,
  event: Omit<TransactionSegmentEvent, 'id' | 'observedAt'>
): TransactionSegmentEvent {
  return Object.freeze({ id: input.eventId, observedAt: input.observedAt, ...event })
}

export function createBitcoinTransactionSegmentEvent(
  input: CreateBitcoinTransactionSegmentEventInput
): TransactionSegmentEvent | null {
  assertBitcoinSegment(input.segment)
  assertObservationBinding(input.segment, input.observation)
  if (input.segment.status === 'final' || input.segment.status === 'failed') return null

  if (input.observation.status === 'broadcast') {
    if (input.segment.status === 'confirming') {
      return createEvent(input, {
        status: 'broadcast',
        cause: 'reorg',
        evidence: {
          transactionHash: input.observation.transactionId,
          confirmations: 0,
          requiredConfirmations: input.observation.requiredConfirmations
        }
      })
    }
    if (
      input.segment.status === 'broadcast' &&
      input.segment.evidence?.requiredConfirmations === input.observation.requiredConfirmations
    ) {
      return null
    }
    return createEvent(input, {
      status: 'broadcast',
      cause: 'progress',
      evidence: {
        transactionHash: input.observation.transactionId,
        confirmations: 0,
        requiredConfirmations: input.observation.requiredConfirmations
      }
    })
  }

  const evidence = {
    transactionHash: input.observation.transactionId,
    blockHash: input.observation.blockHash,
    blockHeight: input.observation.blockHeight,
    confirmations: input.observation.confirmations,
    requiredConfirmations: input.observation.requiredConfirmations
  }
  const existing = input.segment.evidence
  const inclusionChanged =
    (existing?.blockHash !== undefined && existing.blockHash !== input.observation.blockHash) ||
    (existing?.blockHeight !== undefined && existing.blockHeight !== input.observation.blockHeight)
  const confirmationsDecreased =
    existing?.confirmations !== undefined &&
    input.observation.confirmations < existing.confirmations
  if (inclusionChanged || confirmationsDecreased) {
    if (input.segment.status !== 'confirming') {
      throw new Error('Only a confirming Bitcoin transaction can replace block evidence')
    }
    return createEvent(input, { status: 'confirming', cause: 'reorg', evidence })
  }
  if (input.observation.status === 'final') {
    return createEvent(input, { status: 'final', cause: 'progress', evidence })
  }
  if (
    input.segment.status === 'confirming' &&
    existing?.blockHash === input.observation.blockHash &&
    existing.blockHeight === input.observation.blockHeight &&
    existing.confirmations === input.observation.confirmations
  ) {
    return null
  }
  return createEvent(input, { status: 'confirming', cause: 'progress', evidence })
}
