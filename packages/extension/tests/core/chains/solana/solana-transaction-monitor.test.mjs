import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import {
  createSolanaTransferGraph,
  SolanaTransactionMonitor
} from '../../../../src/infrastructure/chains/solana/index.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/index.ts'

const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const scope = { keyDomainId: 'key-domain:solana', accountId: 'account:solana:0' }
const signature = '2'.repeat(88)
const chains = createInitialProductChainRegistry('testnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('testnet'))

async function setup(status) {
  const repository = new InMemoryTransactionRepository()
  const transactionId = parseTransactionId(`transaction:solana:monitor:${status.status}`)
  const segmentId = parseTransactionSegmentId(`segment:solana:monitor:${status.status}`)
  const graph = createSolanaTransferGraph({
    prepared: {
      chainId,
      sender: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
      recipient: 'SysvarRent111111111111111111111111111111111',
      lamports: '5000',
      feeLamports: '5000',
      totalDebitLamports: '10000',
      recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
      lastValidBlockHeight: 99,
      transactionBase64: 'AQ==',
      messageBase64: 'AQ==',
      simulationUnitsConsumed: 150
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
      id: `event:solana:broadcast:${status.status}`,
      status: 'broadcast',
      cause: 'progress',
      observedAt: 1_001,
      evidence: { transactionHash: signature }
    },
    expectedRootRevision: 0,
    expectedSegmentRevision: 0
  })
  let eventId = 0
  const monitor = new SolanaTransactionMonitor({
    repository,
    chainId,
    rpc: { getSignatureStatus: async () => status },
    now: () => 2_000,
    createEventId: () => `test-${++eventId}`
  })
  return { repository, transactionId, monitor }
}

test('advances confirmed Solana signatures to confirming and finalized to final', async () => {
  const confirmed = await setup({
    status: 'confirmed',
    contextSlot: 20,
    slot: 19,
    confirmations: 2
  })
  await expect(confirmed.monitor.poll([scope])).resolves.toEqual({
    checked: 1,
    applied: 1,
    unchanged: 0,
    errors: 0
  })
  await expect(confirmed.repository.get(scope, confirmed.transactionId)).resolves.toMatchObject({
    root: { status: 'confirming' },
    segments: [{ status: 'confirming', evidence: { confirmations: 1 } }]
  })

  const finalized = await setup({
    status: 'finalized',
    contextSlot: 21,
    slot: 19,
    confirmations: null
  })
  await finalized.monitor.poll([scope])
  await expect(finalized.repository.get(scope, finalized.transactionId)).resolves.toMatchObject({
    root: { status: 'final' },
    segments: [{ status: 'final', evidence: { confirmations: 1 } }]
  })
})

test('maps an on-chain Solana failure and leaves unknown signatures unchanged', async () => {
  const failed = await setup({
    status: 'failed',
    contextSlot: 20,
    slot: 19,
    confirmations: null
  })
  await failed.monitor.poll([scope])
  await expect(failed.repository.get(scope, failed.transactionId)).resolves.toMatchObject({
    root: { status: 'failed' },
    segments: [{ status: 'failed', failure: { code: 'reverted' } }]
  })

  const unknown = await setup({ status: 'unknown', contextSlot: 20 })
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
