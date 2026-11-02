import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  parseChainId
} from '../../../../src/core/chains/registry/index.ts'
import {
  ChromeSessionSolanaPendingTransferStore,
  computeSolanaTransactionFingerprint,
  parseSignedSolanaTransaction,
  SolanaTransferOrchestrator
} from '../../../../src/infrastructure/chains/solana/index.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/index.ts'
import { reportBackgroundSendBroadcast } from '../../../../src/background/analytics/send-broadcast.ts'

const chainId = parseChainId('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1').id
const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const recipient = 'SysvarRent111111111111111111111111111111111'
const recentBlockhash = 'SysvarC1ock11111111111111111111111111111111'
const scope = { keyDomainId: 'key-domain:solana', accountId: 'account:solana:0' }
const account = {
  id: 'chain-account:solana:0',
  scope: { ...scope, chainId },
  derivation: { scheme: 'slip10', path: "m/44'/501'/0'/0'" },
  identity: { kind: 'account-identifier', value: sender },
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

function makeSignedTransaction(unsignedBase64, fill = 7) {
  const bytes = Buffer.from(unsignedBase64, 'base64')
  bytes.fill(fill, 1, 65)
  return parseSignedSolanaTransaction(bytes.toString('base64'), base58(bytes.subarray(1, 65)))
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`)
  let encoded = ''
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded
    value /= 58n
  }
  let leadingZeroes = 0
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1
  return '1'.repeat(leadingZeroes) + encoded
}

function signer(calls, options = {}) {
  let preparedPayload
  return {
    prepare: async (keyDomainId, payload) => {
      calls.push(['prepare', keyDomainId, payload])
      preparedPayload = payload
      const data = Buffer.alloc(12)
      data.writeUInt32LE(2, 0)
      data.writeBigUInt64LE(5_000n, 4)
      return {
        commandId: 'signing-command:solana:transfer',
        chainId,
        operation: 'transaction',
        summary: {
          schema: 'solana.transaction.v1',
          chainId,
          operation: 'transaction',
          review: { level: 'standard', issues: [] },
          fields: {
            messageVersion: 'legacy',
            feePayer: sender,
            recentBlockhash,
            requiredSigners: [sender],
            staticAccountKeys: [sender, recipient, '11111111111111111111111111111111'],
            addressTableLookups: [],
            feeLamports: null,
            computeUnitLimit: null,
            computeUnitPriceMicroLamports: null,
            maximumPriorityFeeLamports: null,
            simulationStatus: 'not-run',
            simulationUnitsConsumed: null,
            instructions: [
              {
                index: 0,
                programId: '11111111111111111111111111111111',
                accounts: [
                  { address: sender, signer: true, writable: true, source: 'static' },
                  { address: recipient, signer: false, writable: true, source: 'static' }
                ],
                data: {
                  encoding: 'base64',
                  value: data.toString('base64'),
                  byteLength: data.length,
                  sha256: createHash('sha256').update(data).digest('hex')
                },
                interpretation: {
                  kind: 'system-transfer',
                  from: sender,
                  to: recipient,
                  lamports: '5000'
                }
              }
            ]
          }
        },
        payloadFingerprint: {
          algorithm: 'sha256',
          digestHex: await computeSolanaTransactionFingerprint(payload.transaction)
        },
        execution: { kind: 'internal' },
        expiresAt: 5_000
      }
    },
    confirm: async (keyDomainId, commandId) => {
      calls.push(['confirm', keyDomainId, commandId])
      const signed = makeSignedTransaction(preparedPayload.transaction, options.signatureFill ?? 7)
      if (options.tamperMessage) {
        const different = Buffer.from(signed.transactionBase64, 'base64')
        different[different.length - 1] ^= 1
        const tamperedBase64 = different.toString('base64')
        return {
          kind: 'signed-payload',
          payload: { encoding: 'base64', value: tamperedBase64 },
          transactionId: signed.transactionHash
        }
      }
      return {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: signed.transactionBase64 },
        transactionId: signed.transactionHash
      }
    },
    cancel: async (keyDomainId, commandId) => {
      calls.push(['cancel', keyDomainId, commandId])
    }
  }
}

function rpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getBalanceSnapshot: async () => ({ amountRaw: '1000000', contextSlot: 10 }),
    getLatestBlockhash: async () => ({ blockhash: recentBlockhash, lastValidBlockHeight: 99 }),
    getFeeForMessage: async () => ({ feeLamports: '5000', contextSlot: 10 }),
    simulateTransaction: async () => ({ contextSlot: 10, unitsConsumed: 150 }),
    getBlockHeight: async () => 90,
    broadcastSignedTransaction: async transactionBase64 =>
      parseSignedSolanaTransaction(
        transactionBase64,
        base58(Buffer.from(transactionBase64, 'base64').subarray(1, 65))
      ).transactionHash,
    getSignatureStatus: async () => ({ status: 'unknown', contextSlot: 10 }),
    ...overrides
  }
}

function harness(options = {}) {
  const calls = []
  const pendingStore = new ChromeSessionSolanaPendingTransferStore(memoryStorage())
  const repository = new InMemoryTransactionRepository()
  let id = 0
  const orchestrator = new SolanaTransferOrchestrator({
    repository,
    pendingStore,
    signer: options.signer ?? signer(calls, options.signerOptions),
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
    recipient,
    lamports: '5000'
  })
}

test('prepares, approves, signs and broadcasts a native Solana transfer', async () => {
  let monitoringCalls = 0
  const { orchestrator, repository, pendingStore, calls } = harness({
    onMonitoringRequired: () => {
      monitoringCalls += 1
    }
  })
  const approval = await prepare(orchestrator)
  expect(approval.graph.root.status).toBe('prepared')
  expect(approval.signing.payloadFingerprint.digestHex).toMatch(/^[0-9a-f]{64}$/)
  await expect(repository.get(scope, approval.graph.root.id)).resolves.toBeNull()
  await expect(pendingStore.getReviewGraph(approval.graph.root.id)).resolves.toEqual(approval.graph)

  const result = await orchestrator.approve({
    scope,
    transactionId: approval.graph.root.id,
    payloadFingerprint: approval.signing.payloadFingerprint.digestHex
  })
  expect(result.status).toBe('broadcast')
  expect(result.graph.root.status).toBe('broadcast')
  expect(result.graph.segments[0].evidence.transactionHash).toBeTruthy()
  await expect(pendingStore.get(approval.graph.root.id)).resolves.toBeNull()
  expect(calls.map(call => call[0])).toEqual(['prepare', 'confirm'])
  expect(monitoringCalls).toBe(1)
})

test('persists a signed transaction before broadcast and resumes without signing again', async () => {
  let allowBroadcast = false
  let pendingBroadcastCalls = 0
  const analytics = []
  const testRpc = rpc({
    broadcastSignedTransaction: async transactionBase64 => {
      if (!allowBroadcast) throw new Error('response lost')
      return base58(Buffer.from(transactionBase64, 'base64').subarray(1, 65))
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

test('fails an expired blockhash before consuming the signing command', async () => {
  const { orchestrator, repository, calls } = harness({
    rpc: rpc({ getBlockHeight: async () => 100 })
  })
  const approval = await prepare(orchestrator)
  await expect(
    orchestrator.approve({
      scope,
      transactionId: approval.graph.root.id,
      payloadFingerprint: approval.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/blockhash expired/)
  const graph = await orchestrator.getPendingApproval({
    scope,
    transactionId: approval.graph.root.id
  })
  expect(graph).toBeNull()
  await expect(repository.get(scope, approval.graph.root.id)).resolves.toBeNull()
  expect(calls.map(call => call[0])).toEqual(['prepare', 'cancel'])
})

test('does not persist a rejected Solana approval as Activity', async () => {
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

test('rejects a signed transaction whose message no longer matches the approval', async () => {
  const { orchestrator, repository } = harness({ signerOptions: { tamperMessage: true } })
  const approval = await prepare(orchestrator)
  await expect(
    orchestrator.approve({
      scope,
      transactionId: approval.graph.root.id,
      payloadFingerprint: approval.signing.payloadFingerprint.digestHex
    })
  ).rejects.toThrow(/integrity validation/)
  const graph = await repository.get(scope, approval.graph.root.id)
  expect(graph).toBeNull()
})
