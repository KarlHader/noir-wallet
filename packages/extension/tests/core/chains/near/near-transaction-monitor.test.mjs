import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import {
  createNearTransferGraph,
  NearTransactionMonitor
} from '../../../../src/infrastructure/chains/near/index.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/index.ts'

const chainId = 'near:testnet'
const signerId = '00'.repeat(32)
const scope = { keyDomainId: 'key-domain:near', accountId: 'account:near:0' }
const transactionHash = '11111111111111111111111111111111'
const chains = createInitialProductChainRegistry('testnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('testnet'))

async function setup(status) {
  const repository = new InMemoryTransactionRepository()
  const transactionId = `transaction:near:monitor:${status.status}`
  const segmentId = `segment:near:monitor:${status.status}`
  const graph = createNearTransferGraph({
    prepared: {
      chainId,
      accountIndex: 0,
      signerId,
      publicKey: `ed25519:${'1'.repeat(32)}`,
      receiverId: 'alice.testnet',
      depositYocto: '2000000000000000000000000',
      estimatedFeeYocto: '44636512500000000000',
      maximumFeeYocto: '446365125000000000000',
      storageReserveYocto: '1000000000000000000000',
      totalRequiredYocto: '2001446365125000000000000',
      transaction: {
        chainId,
        accountIndex: 0,
        signerId,
        receiverId: 'alice.testnet',
        nonce: '42',
        blockHash: transactionHash,
        actions: [{ type: 'transfer', depositYocto: '2000000000000000000000000' }]
      }
    },
    scope,
    transactionId,
    segmentId,
    assets,
    createdAt: 1_000
  })
  await repository.create(graph)
  await repository.applySegmentEvent({
    scope,
    transactionId,
    segmentId,
    event: {
      id: `event:near:broadcast:${status.status}`,
      status: 'broadcast',
      cause: 'progress',
      observedAt: 1_001,
      evidence: { transactionHash }
    },
    expectedRootRevision: 0,
    expectedSegmentRevision: 0
  })
  let eventId = 0
  const calls = []
  const monitor = new NearTransactionMonitor({
    repository,
    chainId,
    rpc: {
      getTransactionStatus: async (hash, sender) => {
        calls.push([hash, sender])
        return status
      }
    },
    now: () => 2_000,
    createEventId: () => `test-${++eventId}`
  })
  return { repository, transactionId, monitor, calls }
}

test('advances known NEAR transactions to confirming and final', async () => {
  const confirming = await setup({ status: 'confirming' })
  await expect(confirming.monitor.poll([scope])).resolves.toEqual({
    checked: 1,
    applied: 1,
    unchanged: 0,
    errors: 0
  })
  await expect(confirming.repository.get(scope, confirming.transactionId)).resolves.toMatchObject({
    root: { status: 'confirming' },
    segments: [{ status: 'confirming', evidence: { confirmations: 0 } }]
  })
  expect(confirming.calls).toEqual([[transactionHash, signerId]])

  const finalized = await setup({ status: 'final' })
  await finalized.monitor.poll([scope])
  await expect(finalized.repository.get(scope, finalized.transactionId)).resolves.toMatchObject({
    root: { status: 'final' },
    segments: [{ status: 'final', evidence: { confirmations: 1 } }]
  })
})

test('maps NEAR execution failure and leaves unknown transactions unchanged', async () => {
  const failed = await setup({ status: 'failed' })
  await failed.monitor.poll([scope])
  await expect(failed.repository.get(scope, failed.transactionId)).resolves.toMatchObject({
    root: { status: 'failed' },
    segments: [{ status: 'failed', failure: { code: 'reverted' } }]
  })

  const unknown = await setup({ status: 'unknown' })
  await expect(unknown.monitor.poll([scope])).resolves.toEqual({
    checked: 1,
    applied: 0,
    unchanged: 1,
    errors: 0
  })
  await expect(unknown.repository.get(scope, unknown.transactionId)).resolves.toMatchObject({
    root: { status: 'broadcast' }
  })
})
