import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  parseChainId
} from '../../../../src/core/chains/registry/index.ts'
import {
  ChromeSessionNearPendingTransferStore,
  computeNearTransactionFingerprint,
  NearTransferOrchestrator
} from '../../../../src/infrastructure/chains/near/index.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/index.ts'
import { reportBackgroundSendBroadcast } from '../../../../src/background/analytics/send-broadcast.ts'

const chainId = parseChainId('near:testnet').id
const signerId = '00'.repeat(32)
const publicKey = `ed25519:${'1'.repeat(32)}`
const receiverId = 'alice.testnet'
const blockHash = '11111111111111111111111111111111'
const scope = { keyDomainId: 'key-domain:near', accountId: 'account:near:0' }
const account = {
  id: 'chain-account:near:0',
  scope: { ...scope, chainId },
  derivation: { scheme: 'slip10', path: "m/44'/397'/0'" },
  identity: { kind: 'account-identifier', value: signerId },
  createdAt: 1
}
const chains = createInitialProductChainRegistry('testnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('testnet'))

function memoryStorage() {
  const values = {}
  return {
    get: async key => {
      if (key === null) return structuredClone(values)
      return Object.prototype.hasOwnProperty.call(values, key)
        ? { [key]: structuredClone(values[key]) }
        : {}
    },
    set: async entries => Object.assign(values, structuredClone(entries)),
    remove: async keys => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]
    }
  }
}

function signer(calls) {
  return {
    prepare: async (keyDomainId, payload) => {
      calls.push(['prepare', keyDomainId, payload])
      return {
        commandId: 'signing-command:near:transfer',
        chainId,
        operation: 'transaction',
        summary: {
          schema: 'near.transaction.v1',
          chainId,
          operation: 'transaction',
          review: { level: 'standard', issues: [] },
          fields: {
            signerId,
            publicKey,
            nonce: '42',
            receiverId,
            blockHash,
            actions: [{ kind: 'transfer', depositYocto: '2000000000000000000000000' }]
          }
        },
        payloadFingerprint: {
          algorithm: 'sha256',
          digestHex: await computeNearTransactionFingerprint(payload.transaction)
        },
        execution: { kind: 'internal' },
        expiresAt: 5_000
      }
    },
    confirm: async (keyDomainId, commandId) => {
      calls.push(['confirm', keyDomainId, commandId])
      return {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: 'AQ==' },
        transactionId: blockHash
      }
    },
    cancel: async (keyDomainId, commandId) => calls.push(['cancel', keyDomainId, commandId])
  }
}

function rpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getAccount: async accountId => ({
      accountId,
      amountRaw: '5000000000000000000000000',
      lockedRaw: '0',
      storageUsage: 100,
      codeHash: blockHash,
      blockHash,
      blockHeight: 10
    }),
    getAccessKey: async (accountId, requestedPublicKey) => ({
      accountId,
      publicKey: requestedPublicKey,
      nonce: '41',
      permission: { kind: 'full-access' },
      blockHash,
      blockHeight: 10
    }),
    getGasPrice: async () => '100000000',
    getNativeTransferCostConfig: async () => ({
      chainId,
      minGasPurchasePriceRaw: '1000000000',
      storageAmountPerByteRaw: '10000000000000000000',
      actionReceiptCreation: {
        executionGas: '108059500000',
        sendNotSirGas: '108059500000',
        sendSirGas: '108059500000'
      },
      transfer: {
        executionGas: '115123062500',
        sendNotSirGas: '115123062500',
        sendSirGas: '115123062500'
      }
    }),
    getFinalBlock: async () => ({
      hash: blockHash,
      height: 10,
      timestampNanosec: '1',
      gasPriceRaw: '100000000'
    }),
    getFungibleTokenBalance: async () => {
      throw new Error('unused')
    },
    broadcastSignedTransaction: async () => blockHash,
    ...overrides
  }
}

function harness(options = {}) {
  const calls = []
  const pendingStore = new ChromeSessionNearPendingTransferStore(memoryStorage())
  const repository = new InMemoryTransactionRepository()
  let id = 0
  const orchestrator = new NearTransferOrchestrator({
    repository,
    pendingStore,
    signer: signer(calls),
    rpc: options.rpc ?? rpc(),
    assets,
    now: () => 1_000,
    createId: () => `test-${++id}`,
    onPendingBroadcast: options.onPendingBroadcast,
    onMonitoringRequired: options.onMonitoringRequired
  })
  return { orchestrator, repository, pendingStore, calls }
}

async function prepare(orchestrator) {
  return orchestrator.prepare({
    chainAccount: account,
    accountIndex: 0,
    publicKey,
    receiverId,
    depositYocto: '2000000000000000000000000'
  })
}

test('prepares, approves, signs and broadcasts a native NEAR transfer', async () => {
  let monitoringCalls = 0
  const { orchestrator, repository, pendingStore, calls } = harness({
    onMonitoringRequired: () => {
      monitoringCalls += 1
    }
  })
  const approval = await prepare(orchestrator)
  expect(approval.graph.root.status).toBe('prepared')
  expect(approval.signing.summary.fields).toMatchObject({
    signerId,
    publicKey,
    receiverId,
    nonce: '42'
  })
  await expect(repository.get(scope, approval.graph.root.id)).resolves.toBeNull()
  await expect(pendingStore.getReviewGraph(approval.graph.root.id)).resolves.toEqual(approval.graph)

  const result = await orchestrator.approve({
    scope,
    transactionId: approval.graph.root.id,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })
  expect(result.status).toBe('broadcast')
  expect(result.graph.root.status).toBe('broadcast')
  expect(result.graph.segments[0].evidence.transactionHash).toBe(blockHash)
  await expect(pendingStore.get(approval.graph.root.id)).resolves.toBeNull()
  expect(calls.map(call => call[0])).toEqual(['prepare', 'confirm'])
  expect(monitoringCalls).toBe(1)
})

test('persists signed bytes before broadcast and resumes without signing twice', async () => {
  let allowBroadcast = false
  let pendingBroadcastCalls = 0
  const analytics = []
  const testRpc = rpc({
    broadcastSignedTransaction: async () => {
      if (!allowBroadcast) throw new Error('response lost')
      return blockHash
    }
  })
  const { orchestrator, pendingStore, calls } = harness({
    rpc: testRpc,
    onPendingBroadcast: () => {
      pendingBroadcastCalls += 1
    },
    onMonitoringRequired: (graph, recovered) =>
      recovered &&
      reportBackgroundSendBroadcast(graph, (name, options) => {
        analytics.push({ name, options })
        return new Promise(() => {})
      })
  })
  const approval = await prepare(orchestrator)
  const first = await orchestrator.approve({
    scope,
    transactionId: approval.graph.root.id,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })
  expect(first.status).toBe('signed-pending-broadcast')
  expect(analytics).toHaveLength(0)
  expect((await pendingStore.get(approval.graph.root.id)).phase).toBe('signed')

  allowBroadcast = true
  const resumed = await orchestrator.resumeBroadcast({
    scope,
    transactionId: approval.graph.root.id
  })
  expect(resumed.status).toBe('broadcast')
  expect(analytics).toHaveLength(1)
  expect(analytics[0].options.idempotencyKey).toBe(`send-broadcast:${approval.graph.root.id}`)
  expect(calls.filter(call => call[0] === 'confirm')).toHaveLength(1)
  expect(pendingBroadcastCalls).toBe(1)
})

test('rejects a tampered persisted approval before consuming the signing command', async () => {
  const { orchestrator, pendingStore, repository, calls } = harness()
  const approval = await prepare(orchestrator)
  const pending = await pendingStore.get(approval.graph.root.id)
  await pendingStore.put({
    ...pending,
    signingSummary: {
      ...pending.signingSummary,
      fields: { ...pending.signingSummary.fields, receiverId: 'mallory.testnet' }
    }
  })
  await expect(
    orchestrator.approve({
      scope,
      transactionId: approval.graph.root.id,
      payloadFingerprint: approval.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/integrity check/)
  const graph = await repository.get(scope, approval.graph.root.id)
  expect(graph).toBeNull()
  expect(calls.map(call => call[0])).toEqual(['prepare', 'cancel'])
})

test('does not persist a rejected NEAR approval as Activity', async () => {
  const { orchestrator, repository, pendingStore, calls } = harness()
  const approval = await prepare(orchestrator)

  const rejected = await orchestrator.reject({
    scope,
    transactionId: approval.graph.root.id
  })

  expect(rejected.root.status).toBe('failed')
  expect(rejected.root.failure.code).toBe('user-rejected')
  await expect(repository.get(scope, approval.graph.root.id)).resolves.toBeNull()
  await expect(pendingStore.get(approval.graph.root.id)).resolves.toBeNull()
  await expect(pendingStore.getReviewGraph(approval.graph.root.id)).resolves.toBeNull()
  expect(calls.map(call => call[0])).toEqual(['prepare', 'cancel'])
})
