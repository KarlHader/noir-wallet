import { test } from 'node:test'
import { expect } from '@playwright/test'

import { QuantusTransferOrchestrator } from '../../../../src/infrastructure/chains/quantus/quantus-transfer-orchestrator.ts'
import { QuantusRpcError } from '../../../../src/infrastructure/chains/quantus/quantus-rpc-client.ts'

const scope = { keyDomainId: 'wallet:quantus:test', accountId: 'account:quantus:test:0' }
const transactionId = 'transaction:quantus:sign-only'

/**
 * Signed-only deliveries live in their own session store and are never written
 * to the pending-transfer store or the transaction repository, because Activity
 * records only transactions the wallet broadcast. The wallet resume paths read
 * the pending-transfer store alone, so these records must never be submitted.
 */
function harness(signedOnlyRecords = [signedOnlyRecord()]) {
  const pending = new Map()
  const submitted = []
  const signedOnlyStore = {
    async get(id) {
      return signedOnlyRecords.find(record => record.transactionId === id) ?? null
    },
    async list() {
      return [...signedOnlyRecords]
    },
    async put() {},
    async delete() {},
    async clear() {
      return 0
    },
    async clearScope() {
      return 0
    }
  }
  const pendingStore = {
    async get(id) {
      return pending.get(id) ?? null
    },
    async list() {
      return [...pending.values()]
    },
    async getReviewGraph() {
      return null
    },
    async put(record) {
      pending.set(record.transactionId, record)
    },
    async delete(id) {
      pending.delete(id)
    },
    async clear() {
      const count = pending.size
      pending.clear()
      return count
    }
  }
  const orchestrator = new QuantusTransferOrchestrator({
    repository: {
      async get() {
        return null
      },
      async create() {
        throw new Error('A signed-only Quantus transfer must not be recorded')
      }
    },
    pendingStore,
    signedOnlyStore,
    signer: {},
    rpc: {
      async submitExtrinsic(extrinsic) {
        submitted.push(extrinsic)
        return `0x${'00'.repeat(32)}`
      },
      async getPendingExtrinsics() {
        return []
      }
    },
    assets: {}
  })
  return { orchestrator, pending, signedOnlyRecords, submitted }
}

function signedOnlyRecord() {
  return { transactionId, phase: 'signed-for-delivery', extrinsicHex: '0x088400' }
}

test('a signed-only Quantus delivery is never resumed or broadcast by the wallet', async () => {
  const state = harness()
  await expect(state.orchestrator.resumePendingBroadcasts()).resolves.toEqual({
    attempted: 0,
    broadcast: 0,
    pending: 0,
    errors: 0
  })
  expect(state.submitted).toEqual([])
  // The signed bytes stay with the dApp-owned record.
  expect(state.signedOnlyRecords.some(record => record.transactionId === transactionId)).toBe(true)
  expect(state.pending.has(transactionId)).toBe(false)
})

test('a definitive bad-signature response retains the record without resubmitting its bytes', async () => {
  const state = harness([])
  const hash = `0x${'11'.repeat(32)}`
  const segmentId = 'segment:quantus:sign-only'
  const graph = {
    root: { id: transactionId, status: 'signed' },
    segments: [{ id: segmentId, status: 'signed', evidence: { transactionHash: hash } }]
  }
  const pending = {
    transactionId,
    segmentId,
    scope,
    phase: 'signed',
    extrinsicHash: hash,
    extrinsicHex: '0x088400'
  }
  state.pending.set(transactionId, pending)
  let submissions = 0
  const orchestrator = new QuantusTransferOrchestrator({
    repository: { get: async () => graph },
    pendingStore: {
      get: async id => state.pending.get(id) ?? null,
      list: async () => [...state.pending.values()],
      put: async record => state.pending.set(record.transactionId, record)
    },
    signedOnlyStore: { list: async () => [] },
    signer: {},
    rpc: {
      submitExtrinsic: async () => {
        submissions += 1
        throw new QuantusRpcError(
          'bad-signature',
          'Quantus rejected the extrinsic: invalid signature'
        )
      },
      getPendingExtrinsics: async () => {
        throw new Error('A rejected signature must not be checked as a transient pool failure')
      }
    },
    assets: {}
  })
  await expect(orchestrator.resumeBroadcast({ scope, transactionId })).resolves.toMatchObject({
    status: 'signed-pending-broadcast'
  })
  expect(state.pending.get(transactionId)?.broadcastRejectedAt).toEqual(expect.any(Number))
  await expect(orchestrator.resumePendingBroadcasts()).resolves.toEqual({
    attempted: 0,
    broadcast: 0,
    pending: 0,
    errors: 0
  })
  await expect(orchestrator.resumeBroadcast({ scope, transactionId })).resolves.toMatchObject({
    status: 'signed-pending-broadcast'
  })
  expect(submissions).toBe(1)
  expect(state.pending.has(transactionId)).toBe(true)
})

test('an expired signed transfer is retained for reconciliation but not rebroadcast', async () => {
  const state = harness([])
  const hash = `0x${'11'.repeat(32)}`
  const segmentId = 'segment:quantus:sign-only'
  const graph = {
    root: { id: transactionId, status: 'signed' },
    segments: [{ id: segmentId, status: 'signed', evidence: { transactionHash: hash } }]
  }
  state.pending.set(transactionId, {
    transactionId,
    segmentId,
    scope,
    phase: 'signed',
    extrinsicHash: hash,
    extrinsicHex: '0x088400',
    eraBlockNumber: 100,
    eraPeriod: 64
  })
  const orchestrator = new QuantusTransferOrchestrator({
    repository: { get: async () => graph },
    pendingStore: {
      get: async id => state.pending.get(id) ?? null,
      list: async () => [...state.pending.values()]
    },
    signedOnlyStore: { list: async () => [] },
    signer: {},
    rpc: {
      getBestHead: async () => `0x${'22'.repeat(32)}`,
      getHeader: async () => ({ number: 165 }),
      submitExtrinsic: async () => {
        throw new Error('Expired bytes must not be submitted')
      }
    },
    assets: {}
  })
  await expect(orchestrator.resumeBroadcast({ scope, transactionId })).resolves.toMatchObject({
    status: 'signed-pending-broadcast'
  })
  expect(state.pending.has(transactionId)).toBe(true)
})

test('the wallet resume path refuses a signed-only Quantus transaction', async () => {
  const state = harness()
  await expect(
    state.orchestrator.resumeBroadcast({ scope, transactionId })
  ).rejects.toThrow(/not found/i)
  expect(state.submitted).toEqual([])
})
