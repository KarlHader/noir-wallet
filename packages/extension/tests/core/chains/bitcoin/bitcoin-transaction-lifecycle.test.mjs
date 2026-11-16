import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  applyTransactionSegmentEvent,
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import {
  BitcoinRpcError,
  broadcastSignedBitcoinTransaction,
  createBitcoinTransactionSegmentEvent,
  observeBitcoinTransaction
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const transactionId = 'a'.repeat(64)
const blockHash = 'b'.repeat(64)
const replacementBlockHash = 'c'.repeat(64)

function eventId(name) {
  return parseTransactionEventId(`event:bitcoin:${name}`)
}

function segment(overrides = {}) {
  return {
    id: parseTransactionSegmentId('segment:bitcoin:origin'),
    transactionId: parseTransactionId('transaction:bitcoin:transfer'),
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
  return createBitcoinTransactionSegmentEvent({
    segment: current,
    observation,
    eventId: eventId(name),
    observedAt
  })
}

function mined(status, overrides = {}) {
  return {
    status,
    transactionId,
    blockHash,
    blockHeight: 100,
    confirmations: status === 'final' ? 6 : 3,
    requiredConfirmations: 6,
    ...overrides
  }
}

test.describe('Bitcoin transaction observation and lifecycle', () => {
  test('requires the RPC broadcast result to match the locally expected transaction ID', async () => {
    await expect(
      broadcastSignedBitcoinTransaction({
        rawTransactionHex: '02000000000100',
        expectedTransactionId: transactionId,
        rpc: { broadcastRawTransaction: async () => transactionId }
      })
    ).resolves.toBe(transactionId)

    await expect(
      broadcastSignedBitcoinTransaction({
        rawTransactionHex: '02000000000100',
        expectedTransactionId: transactionId,
        rpc: { broadcastRawTransaction: async () => 'd'.repeat(64) }
      })
    ).rejects.toMatchObject({ code: 'invalid-response' })
  })

  test('observes mempool, confirming, and explicit finality-threshold states', async () => {
    const rpc = {
      getTransactionStatus: async () => ({ confirmed: false }),
      getTipHeight: async () => 105
    }
    await expect(observeBitcoinTransaction(transactionId, 6, rpc)).resolves.toEqual({
      status: 'broadcast',
      transactionId,
      requiredConfirmations: 6
    })

    rpc.getTransactionStatus = async () => ({ confirmed: true, blockHeight: 100, blockHash })
    rpc.getTipHeight = async () => 102
    await expect(observeBitcoinTransaction(transactionId, 6, rpc)).resolves.toMatchObject({
      status: 'confirming',
      confirmations: 3,
      requiredConfirmations: 6
    })

    rpc.getTipHeight = async () => 105
    await expect(observeBitcoinTransaction(transactionId, 6, rpc)).resolves.toMatchObject({
      status: 'final',
      confirmations: 6,
      requiredConfirmations: 6
    })
  })

  test('rejects invalid finality policy and impossible tip evidence', async () => {
    const rpc = {
      getTransactionStatus: async () => ({ confirmed: true, blockHeight: 100, blockHash }),
      getTipHeight: async () => 99
    }
    await expect(observeBitcoinTransaction(transactionId, 0, rpc)).rejects.toThrow(
      /finality confirmation/
    )
    await expect(observeBitcoinTransaction(transactionId, 6, rpc)).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })

  test('maps broadcast, confirming, and final evidence without duplicate writes', () => {
    const signed = segment()
    const broadcastEvent = mapEvent(
      signed,
      { status: 'broadcast', transactionId, requiredConfirmations: 6 },
      'broadcast'
    )
    const broadcast = applyTransactionSegmentEvent(signed, broadcastEvent)
    expect(broadcast.evidence).toEqual({
      transactionHash: transactionId,
      confirmations: 0,
      requiredConfirmations: 6
    })
    expect(
      mapEvent(
        broadcast,
        { status: 'broadcast', transactionId, requiredConfirmations: 6 },
        'duplicate-broadcast'
      )
    ).toBeNull()

    const confirmingEvent = mapEvent(broadcast, mined('confirming'), 'confirming', 1_200)
    const confirming = applyTransactionSegmentEvent(broadcast, confirmingEvent)
    expect(confirming.evidence).toMatchObject({ blockHash, blockHeight: 100, confirmations: 3 })
    expect(mapEvent(confirming, mined('confirming'), 'duplicate-confirming', 1_300)).toBeNull()

    const finalEvent = mapEvent(confirming, mined('final'), 'final', 1_400)
    const finalized = applyTransactionSegmentEvent(confirming, finalEvent)
    expect(finalized.status).toBe('final')
    expect(mapEvent(finalized, mined('confirming'), 'late-result', 1_500)).toBeNull()
  })

  test('records disappearance, replacement, and confirmation decrease as explicit reorgs', () => {
    const confirming = segment({
      status: 'confirming',
      updatedAt: 1_200,
      revision: 2,
      evidence: {
        transactionHash: transactionId,
        blockHash,
        blockHeight: 100,
        confirmations: 4,
        requiredConfirmations: 6
      }
    })
    const disappearedEvent = mapEvent(
      confirming,
      { status: 'broadcast', transactionId, requiredConfirmations: 6 },
      'disappeared',
      1_300
    )
    const disappeared = applyTransactionSegmentEvent(confirming, disappearedEvent)
    expect(disappearedEvent).toMatchObject({ status: 'broadcast', cause: 'reorg' })
    expect(disappeared.evidence).toEqual({
      transactionHash: transactionId,
      confirmations: 0,
      requiredConfirmations: 6
    })

    const replacementEvent = mapEvent(
      confirming,
      mined('final', { blockHash: replacementBlockHash, blockHeight: 101 }),
      'replacement',
      1_300
    )
    expect(replacementEvent).toMatchObject({ status: 'confirming', cause: 'reorg' })
    const replaced = applyTransactionSegmentEvent(confirming, replacementEvent)
    expect(replaced.evidence).toMatchObject({
      blockHash: replacementBlockHash,
      blockHeight: 101,
      confirmations: 6
    })
    expect(
      mapEvent(
        replaced,
        mined('final', { blockHash: replacementBlockHash, blockHeight: 101 }),
        'replacement-final',
        1_400
      )
    ).toMatchObject({ status: 'final', cause: 'progress' })

    expect(
      mapEvent(confirming, mined('confirming', { confirmations: 2 }), 'confirmation-decrease')
    ).toMatchObject({ status: 'confirming', cause: 'reorg' })
  })

  test('rejects transaction ID and finality-policy changes on an existing segment', () => {
    const current = segment({
      status: 'broadcast',
      evidence: {
        transactionHash: transactionId,
        confirmations: 0,
        requiredConfirmations: 6
      }
    })
    expect(() =>
      mapEvent(
        current,
        { status: 'broadcast', transactionId: 'd'.repeat(64), requiredConfirmations: 6 },
        'wrong-id'
      )
    ).toThrow(/transaction ID does not match/)
    expect(() =>
      mapEvent(
        current,
        { status: 'broadcast', transactionId, requiredConfirmations: 3 },
        'changed-policy'
      )
    ).toThrow(/policy changed/)
  })

  test('preserves typed not-found observations for the monitor to interpret by lifecycle state', async () => {
    const error = new BitcoinRpcError('not-found', 'not found')
    await expect(
      observeBitcoinTransaction(transactionId, 6, {
        getTransactionStatus: async () => {
          throw error
        },
        getTipHeight: async () => 100
      })
    ).rejects.toBe(error)
  })
})
