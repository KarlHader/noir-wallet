import { parseChainId } from '@/core/chains/registry'
import type {
  TransactionEventId,
  TransactionSegment,
  TransactionSegmentEvent
} from '@/core/transactions/domain'
import { PEARL_MAINNET_CHAIN_ID, PEARL_TESTNET_CHAIN_ID } from './pearl-transaction-model'
import type { PearlTransactionObservation } from './pearl-transaction-observer'

export interface CreatePearlTransactionSegmentEventInput {
  readonly segment: TransactionSegment
  readonly observation: PearlTransactionObservation
  readonly eventId: TransactionEventId
  readonly observedAt: number
}

function assertPearlSegment(segment: TransactionSegment): void {
  if (
    segment.target.kind !== 'onchain' ||
    (segment.target.chainId !== PEARL_MAINNET_CHAIN_ID &&
      segment.target.chainId !== PEARL_TESTNET_CHAIN_ID) ||
    parseChainId(segment.target.chainId).namespace !== 'bip122'
  ) {
    throw new Error('Pearl observations require a Pearl on-chain transaction segment')
  }
}

function assertObservationBinding(
  segment: TransactionSegment,
  observation: PearlTransactionObservation
): void {
  if (
    segment.evidence?.transactionHash !== undefined &&
    segment.evidence.transactionHash !== observation.transactionId
  ) {
    throw new Error('Pearl observation transaction ID does not match the transaction segment')
  }
  if (
    segment.evidence?.requiredConfirmations !== undefined &&
    segment.evidence.requiredConfirmations !== observation.requiredConfirmations
  ) {
    throw new Error('Pearl confirmation policy changed for an existing transaction')
  }
}

function createEvent(
  input: CreatePearlTransactionSegmentEventInput,
  event: Omit<TransactionSegmentEvent, 'id' | 'observedAt'>
): TransactionSegmentEvent {
  return Object.freeze({ id: input.eventId, observedAt: input.observedAt, ...event })
}

export function createPearlTransactionSegmentEvent(
  input: CreatePearlTransactionSegmentEventInput
): TransactionSegmentEvent | null {
  assertPearlSegment(input.segment)
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
      throw new Error('Only a confirming Pearl transaction can replace block evidence')
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
