import { parseChainId } from '@/core/chains/registry'
import type {
  TransactionEventId,
  TransactionSegment,
  TransactionSegmentEvent
} from '@/core/transactions/domain'
import type { EvmTransactionObservation } from './evm-transaction-observer'

export interface CreateEvmTransactionSegmentEventInput {
  readonly segment: TransactionSegment
  readonly observation: EvmTransactionObservation
  readonly eventId: TransactionEventId
  readonly observedAt: number
}

function parseBlockHeight(value: string): number {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new Error('EVM block number cannot be represented by the transaction repository')
  }
  const height = Number(value)
  if (!Number.isSafeInteger(height)) {
    throw new Error('EVM block number cannot be represented by the transaction repository')
  }
  return height
}

function assertEvmSegment(segment: TransactionSegment): void {
  if (
    segment.target.kind !== 'onchain' ||
    parseChainId(segment.target.chainId).namespace !== 'eip155'
  ) {
    throw new Error('EVM observations require an EVM on-chain transaction segment')
  }
}

function assertTransactionHashBinding(
  segment: TransactionSegment,
  observation: EvmTransactionObservation
): void {
  if (
    segment.evidence?.transactionHash != null &&
    segment.evidence.transactionHash !== observation.transactionHash
  ) {
    throw new Error('EVM observation transaction hash does not match the transaction segment')
  }
}

function hasDifferentInclusion(
  segment: TransactionSegment,
  blockHash: string,
  blockHeight: number
): boolean {
  const evidence = segment.evidence
  return (
    (evidence?.blockHash != null && evidence.blockHash !== blockHash) ||
    (evidence?.blockHeight != null && evidence.blockHeight !== blockHeight)
  )
}

function createEvent(
  input: CreateEvmTransactionSegmentEventInput,
  event: Omit<TransactionSegmentEvent, 'id' | 'observedAt'>
): TransactionSegmentEvent {
  return Object.freeze({
    id: input.eventId,
    observedAt: input.observedAt,
    ...event
  })
}

export function createEvmTransactionSegmentEvent(
  input: CreateEvmTransactionSegmentEventInput
): TransactionSegmentEvent | null {
  assertEvmSegment(input.segment)
  assertTransactionHashBinding(input.segment, input.observation)

  if (input.segment.status === 'final' || input.segment.status === 'failed') {
    return null
  }

  if (input.observation.status === 'broadcast') {
    if (input.segment.status === 'confirming') {
      return createEvent(input, {
        status: 'broadcast',
        cause: 'reorg',
        evidence: {
          transactionHash: input.observation.transactionHash,
          confirmations: 0
        }
      })
    }
    if (input.segment.status === 'broadcast') return null
    return createEvent(input, {
      status: 'broadcast',
      cause: 'progress',
      evidence: { transactionHash: input.observation.transactionHash }
    })
  }

  const blockHeight = parseBlockHeight(input.observation.blockNumber)
  const evidence = {
    transactionHash: input.observation.transactionHash,
    blockHash: input.observation.blockHash,
    blockHeight
  }
  const inclusionChanged = hasDifferentInclusion(
    input.segment,
    input.observation.blockHash,
    blockHeight
  )

  if (inclusionChanged) {
    if (input.segment.status !== 'confirming') {
      throw new Error('Only a confirming EVM transaction can replace its block evidence')
    }
    return createEvent(input, {
      status: 'confirming',
      cause: 'reorg',
      evidence
    })
  }

  if (input.observation.status === 'failed') {
    return createEvent(input, {
      status: 'failed',
      cause: 'failure',
      evidence,
      failure: {
        code: 'reverted',
        occurredAt: input.observedAt
      }
    })
  }

  if (input.observation.status === 'final') {
    return createEvent(input, {
      status: 'final',
      cause: 'progress',
      evidence
    })
  }

  if (
    input.segment.status === 'confirming' &&
    input.segment.evidence?.blockHash === input.observation.blockHash &&
    input.segment.evidence.blockHeight === blockHeight
  ) {
    return null
  }

  return createEvent(input, {
    status: 'confirming',
    cause: 'progress',
    evidence
  })
}
