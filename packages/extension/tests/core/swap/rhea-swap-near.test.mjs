import { test } from 'node:test'
import { expect } from '@playwright/test'

import { RheaSwapNearCoordinator } from '../../../src/background/rhea-swap-near.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'

const sender = 'alice.near'
const sourceHashes = ['1'.repeat(32), `${'1'.repeat(31)}2`]
const fingerprints = ['a'.repeat(64), 'b'.repeat(64)]

function binding() {
  return {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:near-one',
    executionId: 'execution-near-one',
    router: 'near-intents',
    sourceTarget: 'router.near',
    sender,
    originAmountRaw: '1000',
    expiresAt: 5_000,
    isCrossChain: true,
    origin: {
      chainId: 'near:mainnet',
      assetId: 'near:mainnet/slip44:397',
      protocolChainId: 'near',
      protocolAssetId: 'native'
    },
    destination: {
      chainId: 'zcash:mainnet',
      assetId: 'zcash:mainnet/slip44:133',
      protocolChainId: 'zcash',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '900',
      minimumAmountRaw: '850'
    }
  }
}

function plan() {
  return {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    chain: 'near',
    transactions: [
      {
        signerId: sender,
        receiverId: 'router.near',
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'swap',
              args: { amount: '1000' },
              gas: '1000000000000',
              deposit: '1'
            }
          }
        ]
      },
      {
        signerId: sender,
        receiverId: 'recipient.near',
        actions: [{ type: 'Transfer', params: { deposit: '2' } }]
      }
    ]
  }
}

function activeContext() {
  return {
    accountIndex: 0,
    publicKey: `ed25519:${'1'.repeat(32)}`,
    keyDomainSource: { kind: 'mnemonic' },
    chainAccount: {
      id: 'chain-account-near',
      scope: {
        keyDomainId: 'wallet:near',
        accountId: 'account:near',
        chainId: 'near:mainnet'
      },
      identity: { kind: 'account-identifier', value: sender }
    }
  }
}

function createStore() {
  const values = new Map()
  return {
    values,
    async get(handle) {
      return values.get(handle) ?? null
    },
    async list() {
      return [...values.values()]
    },
    async put(value) {
      values.set(value.quoteHandle, value)
    },
    async delete(handle) {
      values.delete(handle)
    }
  }
}

function createHarness(overrides = {}) {
  let now = 1_000
  let id = 0
  let preparedIndex = 0
  let confirmedIndex = 0
  const calls = []
  const store = createStore()
  const repository = new InMemoryTransactionRepository()
  const submission = {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    router: 'near-intents',
    sourceHash: sourceHashes[1],
    orderId: 'order-near-one',
    statusChainId: 'near',
    reportStatus: 'pending'
  }
  const service = {
    async readNearTransactionBatchPlan() {
      calls.push('read-plan')
      return plan()
    },
    async recordTransactionSubmission(_handle, sourceHash) {
      calls.push(`record:${sourceHash}`)
      return submission
    },
    async reportSubmission() {
      calls.push('report')
      return submission
    },
    async discard() {
      calls.push('discard')
    },
    ...overrides.service
  }
  const signer = {
    async prepare(_keyDomainId, payload) {
      const index = preparedIndex++
      calls.push(`prepare:${index}`)
      return {
        commandId: `command-near-${index}`,
        chainId: 'near:mainnet',
        operation: 'transaction',
        summary: {
          schema: 'near.transaction.v1',
          chainId: 'near:mainnet',
          operation: 'transaction',
          review: { level: 'standard', issues: [] },
          fields: {
            signerId: sender,
            publicKey: activeContext().publicKey,
            nonce: payload.transaction.nonce,
            receiverId: payload.transaction.receiverId,
            blockHash: '1'.repeat(32),
            actions: []
          }
        },
        payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprints[index] },
        execution: overrides.ledger
          ? { kind: 'external', request: { encoding: 'base64', value: 'AQ==' } }
          : { kind: 'internal' },
        expiresAt: 5_000
      }
    },
    async confirm() {
      const index = confirmedIndex++
      calls.push(`confirm:${index}`)
      return {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: index === 0 ? 'AQ==' : 'Ag==' },
        transactionId: sourceHashes[index]
      }
    },
    async cancel(_keyDomainId, commandId) {
      calls.push(`cancel:${commandId}`)
    },
    ...overrides.signer
  }
  const rpc = {
    async assertExpectedChain() {
      calls.push('assert-chain')
    },
    async getAccessKey() {
      calls.push('access-key')
      return {
        accountId: sender,
        publicKey: activeContext().publicKey,
        nonce: '40',
        permission: { kind: 'full-access' },
        blockHash: '1'.repeat(32),
        blockHeight: 10
      }
    },
    async broadcastSignedTransaction(transaction) {
      const index = transaction === 'AQ==' ? 0 : 1
      calls.push(`broadcast:${index}`)
      return sourceHashes[index]
    },
    async getTransactionStatus() {
      calls.push('status')
      return { status: 'unknown' }
    },
    ...overrides.rpc
  }
  const coordinator = new RheaSwapNearCoordinator({
    service,
    signer,
    rpc,
    pending: store,
    repository,
    loadContext:
      overrides.loadContext ??
      (async () => ({
        ...activeContext(),
        ...(overrides.ledger ? { keyDomainSource: { kind: 'hardware', vendor: 'ledger' } } : {})
      })),
    scheduleMonitoring: async () => calls.push('schedule'),
    now: () => now,
    createId: () => `stable-near-${++id}`
  })
  return {
    coordinator,
    calls,
    repository,
    store,
    setNow(value) {
      now = value
    }
  }
}

test('signs and broadcasts every NEAR transaction before reporting the final hash', async () => {
  const harness = createHarness()
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())

  expect(review.summaries).toHaveLength(2)
  const result = await harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  expect(result.graph.root.status).toBe('broadcast')
  expect(
    result.graph.segments
      .filter(segment => segment.role === 'origin')
      .map(segment => segment.evidence.transactionHash)
  ).toEqual(sourceHashes)
  expect(harness.calls).toContain(`record:${sourceHashes[1]}`)
  expect(harness.calls.indexOf('broadcast:1')).toBeLessThan(
    harness.calls.indexOf(`record:${sourceHashes[1]}`)
  )
  expect(() => assertPersistableTransactionGraph(result.graph)).not.toThrow()
  expect(harness.store.values.size).toBe(0)
})

test('recovers a partially broadcast signed batch without signing again after expiry', async () => {
  let allowSecondBroadcast = false
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransaction(transaction) {
        const index = transaction === 'AQ==' ? 0 : 1
        harness.calls.push(`broadcast:${index}`)
        if (index === 1 && !allowSecondBroadcast) throw new Error('response unavailable')
        return sourceHashes[index]
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/transaction 2 is signed and waiting to broadcast/)

  const [pending] = await harness.store.list()
  expect(pending.signedTransactions).toHaveLength(2)
  const graph = await harness.repository.get(pending.scope, `tx:rhea-near:${pending.graphSuffix}`)
  expect(graph.segments.filter(segment => segment.role === 'origin')).toMatchObject([
    { status: 'broadcast', evidence: { transactionHash: sourceHashes[0] } },
    { status: 'signed', evidence: { transactionHash: sourceHashes[1] } }
  ])
  expect(() => assertPersistableTransactionGraph(graph)).not.toThrow()

  allowSecondBroadcast = true
  harness.setNow(6_000)
  await expect(harness.coordinator.recoverSigned()).resolves.toBe(1)
  expect(harness.calls.filter(call => call.startsWith('confirm:'))).toHaveLength(2)
  expect(harness.calls.filter(call => call === 'read-plan')).toHaveLength(2)
  expect(harness.calls.filter(call => call === 'broadcast:0')).toHaveLength(1)
})

test('cancels every unsigned NEAR command and discards the quote', async () => {
  const harness = createHarness()
  await harness.coordinator.prepare(binding().quoteHandle, binding())
  await harness.coordinator.cancel(binding().quoteHandle)

  expect(harness.calls).toContain('cancel:command-near-0')
  expect(harness.calls).toContain('cancel:command-near-1')
  expect(harness.calls).toContain('discard')
  expect(harness.store.values.size).toBe(0)
})

test('Ledger NEAR review binds the batch and prevents concurrent confirmation', async () => {
  let changed = false
  let releaseSigning
  const signingGate = new Promise(resolve => {
    releaseSigning = resolve
  })
  const harness = createHarness({
    ledger: true,
    service: {
      async readNearTransactionBatchPlan() {
        harness.calls.push('read-plan')
        const current = plan()
        if (changed) current.transactions[1].actions[0].params.deposit = '3'
        return current
      }
    },
    signer: {
      async confirm(_keyDomainId, commandId) {
        const index = Number(commandId.at(-1))
        harness.calls.push(`confirm:${index}`)
        await signingGate
        return {
          kind: 'signed-payload',
          payload: { encoding: 'base64', value: index === 0 ? 'AQ==' : 'Ag==' },
          transactionId: sourceHashes[index]
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  changed = true
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/changed after Ledger review/)
  expect(harness.calls).not.toContain('confirm:0')

  changed = false
  const first = harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/already in progress/)
  releaseSigning()
  await expect(first).resolves.toMatchObject({ graph: { root: { status: 'broadcast' } } })
  expect(harness.calls.filter(call => call.startsWith('confirm:'))).toHaveLength(2)
})
