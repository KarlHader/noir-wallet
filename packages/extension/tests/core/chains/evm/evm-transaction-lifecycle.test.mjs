import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseAccountId } from '../../../../src/core/accounts/domain/index.ts'
import { parseChainId } from '../../../../src/core/chains/registry/index.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/index.ts'
import {
  applyTransactionSegmentEvent,
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import { createEvmTransactionSegmentEvent } from '../../../../src/infrastructure/chains/evm/index.ts'

const transactionHash = `0x${'a'.repeat(64)}`
const blockHash = `0x${'b'.repeat(64)}`
const reorgBlockHash = `0x${'c'.repeat(64)}`
const chainId = parseChainId('eip155:1').id

function eventId(name) {
  return parseTransactionEventId(`event:evm:${name}`)
}

function segment(overrides = {}) {
  return {
    id: parseTransactionSegmentId('segment:evm:origin'),
    transactionId: parseTransactionId('transaction:evm:transfer'),
    role: 'origin',
    target: { kind: 'onchain', chainId },
    status: 'signed',
    requiredForFinality: true,
    dependsOn: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 0,
    ...overrides
  }
}

function mapEvent(current, observation, name, observedAt = 1_100) {
  return createEvmTransactionSegmentEvent({
    segment: current,
    observation,
    eventId: eventId(name),
    observedAt
  })
}

function mined(status, overrides = {}) {
  return {
    status,
    transactionHash,
    blockHash,
    blockNumber: '100',
    ...(status === 'confirming' ? { receiptStatus: 'success' } : {}),
    ...(status === 'final' ? { receiptStatus: 'success' } : {}),
    ...(status === 'failed' ? { failureCode: 'execution-reverted' } : {}),
    ...overrides
  }
}

test.describe('EVM transaction lifecycle mapping', () => {
  test('maps broadcast, confirming, and finalized evidence without duplicate writes', () => {
    const signed = segment()
    const broadcastEvent = mapEvent(signed, { status: 'broadcast', transactionHash }, 'broadcast')
    const broadcast = applyTransactionSegmentEvent(signed, broadcastEvent)
    expect(broadcast.status).toBe('broadcast')
    expect(broadcast.evidence.transactionHash).toBe(transactionHash)
    expect(
      mapEvent(broadcast, { status: 'broadcast', transactionHash }, 'duplicate-broadcast')
    ).toBeNull()

    const confirmingEvent = mapEvent(broadcast, mined('confirming'), 'confirming', 1_200)
    const confirming = applyTransactionSegmentEvent(broadcast, confirmingEvent)
    expect(confirming.evidence).toMatchObject({
      transactionHash,
      blockHash,
      blockHeight: 100
    })
    expect(mapEvent(confirming, mined('confirming'), 'duplicate-confirming', 1_300)).toBeNull()

    const finalEvent = mapEvent(confirming, mined('final'), 'final', 1_400)
    const finalized = applyTransactionSegmentEvent(confirming, finalEvent)
    expect(finalized.status).toBe('final')
    expect(mapEvent(finalized, mined('confirming'), 'late-result', 1_500)).toBeNull()
  })

  test('turns a disappearing receipt into an explicit reorg and clears stale inclusion', () => {
    const confirming = segment({
      status: 'confirming',
      updatedAt: 1_200,
      revision: 2,
      evidence: { transactionHash, blockHash, blockHeight: 100 }
    })
    const reorgEvent = mapEvent(
      confirming,
      { status: 'broadcast', transactionHash },
      'receipt-disappeared',
      1_300
    )
    const reorged = applyTransactionSegmentEvent(confirming, reorgEvent)

    expect(reorged.status).toBe('broadcast')
    expect(reorged.evidence).toEqual({ transactionHash, confirmations: 0 })
  })

  test('records changed re-inclusion before allowing normal finality progress', () => {
    const confirming = segment({
      status: 'confirming',
      updatedAt: 1_200,
      revision: 2,
      evidence: { transactionHash, blockHash, blockHeight: 100 }
    })
    const reInclusion = mined('final', {
      blockHash: reorgBlockHash,
      blockNumber: '101'
    })
    const reorgEvent = mapEvent(confirming, reInclusion, 're-inclusion', 1_300)
    expect(reorgEvent).toMatchObject({ status: 'confirming', cause: 'reorg' })

    const reorged = applyTransactionSegmentEvent(confirming, reorgEvent)
    expect(reorged.evidence).toEqual({
      transactionHash,
      blockHash: reorgBlockHash,
      blockHeight: 101
    })

    const finalEvent = mapEvent(reorged, reInclusion, 're-inclusion-final', 1_400)
    expect(finalEvent).toMatchObject({ status: 'final', cause: 'progress' })
  })

  test('persists a reverted receipt as failed only after the observer proves finality', () => {
    const confirming = segment({
      status: 'confirming',
      updatedAt: 1_200,
      revision: 2,
      evidence: { transactionHash, blockHash, blockHeight: 100 }
    })
    const pendingFailure = mined('confirming', { receiptStatus: 'failed' })
    expect(mapEvent(confirming, pendingFailure, 'pending-revert', 1_300)).toBeNull()

    const failureEvent = mapEvent(confirming, mined('failed'), 'final-revert', 1_400)
    const failed = applyTransactionSegmentEvent(confirming, failureEvent)
    expect(failed.status).toBe('failed')
    expect(failed.failure).toEqual({ code: 'reverted', occurredAt: 1_400 })
  })

  test('rejects wrong account domains, hashes, and unsafe block heights', () => {
    expect(() =>
      mapEvent(
        segment({
          target: {
            kind: 'onchain',
            chainId: parseChainId('near:mainnet').id,
            chainAccountId: `${parseKeyDomainId('key-domain:1')}:${parseAccountId('account:1')}`
          }
        }),
        { status: 'broadcast', transactionHash },
        'wrong-chain'
      )
    ).toThrow(/EVM on-chain/)

    expect(() =>
      mapEvent(
        segment({ evidence: { transactionHash: `0x${'d'.repeat(64)}` } }),
        { status: 'broadcast', transactionHash },
        'wrong-hash'
      )
    ).toThrow(/hash does not match/)

    expect(() =>
      mapEvent(segment(), mined('confirming', { blockNumber: '9007199254740992' }), 'unsafe')
    ).toThrow(/cannot be represented/)
  })
})
