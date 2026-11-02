import { test } from 'node:test'
import { expect } from '@playwright/test'

import { RheaSwapSolanaCoordinator } from '../../../src/background/rhea-swap-solana.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'

const sender = '11111111111111111111111111111111'
const sourceHash = '1'.repeat(64)
const fingerprint = 'b'.repeat(64)

function binding() {
  return {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:solana-one',
    executionId: 'execution-solana-one',
    router: 'jupiter',
    sourceTarget: sender,
    sender,
    originAmountRaw: '1000',
    expiresAt: 5_000,
    isCrossChain: true,
    origin: {
      chainId: 'solana:mainnet',
      assetId: 'solana:mainnet/slip44:501',
      protocolChainId: 'solana',
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

function activeContext() {
  return {
    accountIndex: 0,
    keyDomainSource: { kind: 'mnemonic' },
    chainAccount: {
      id: 'chain-account-solana',
      scope: {
        keyDomainId: 'wallet:one',
        accountId: 'account:one',
        chainId: 'solana:mainnet'
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
  const calls = []
  const store = createStore()
  const repository = new InMemoryTransactionRepository()
  const plan = {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    chain: 'solana',
    transaction: 'AQ==',
    format: 'base64',
    metadata: {
      addressLookupTableAddresses: [],
      recentBlockhash: null,
      txValidUntil: null,
      transactionSize: 1
    }
  }
  const submission = {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    router: 'jupiter',
    sourceHash,
    orderId: 'order-solana-one',
    statusChainId: 'solana',
    reportStatus: 'pending'
  }
  const service = {
    async readSolanaTransactionPlan() {
      calls.push('read-plan')
      return plan
    },
    async recordTransactionSubmission(_handle, hash) {
      calls.push(`record:${hash}`)
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
    async prepare() {
      calls.push('prepare-signing')
      return {
        commandId: 'command-solana-one',
        chainId: 'solana:mainnet',
        operation: 'transaction',
        summary: {
          schema: 'solana.transaction.v1',
          fields: {
            requiredSigners: [sender],
            recentBlockhash: sourceHash,
            addressTableLookups: []
          }
        },
        payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprint },
        execution: overrides.ledger
          ? { kind: 'external', request: { encoding: 'base64', value: plan.transaction } }
          : { kind: 'internal' },
        expiresAt: 5_000
      }
    },
    async confirm() {
      calls.push('confirm-signing')
      return {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: 'Ag==' },
        transactionId: sourceHash
      }
    },
    async cancel() {
      calls.push('cancel-signing')
    },
    ...overrides.signer
  }
  const rpc = {
    async broadcastSignedTransaction() {
      calls.push('broadcast')
      return sourceHash
    },
    async getSignatureStatus() {
      calls.push('status')
      return { status: 'unknown' }
    },
    ...overrides.rpc
  }
  const coordinator = new RheaSwapSolanaCoordinator({
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
    createId: () => 'stable-solana-one'
  })
  return {
    coordinator,
    calls,
    store,
    setNow(value) {
      now = value
    }
  }
}

test('reviews, signs, persists, and broadcasts a RHEA Solana transaction', async () => {
  const harness = createHarness()
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  expect(review).toMatchObject({
    chainId: 'solana:mainnet',
    sender,
    payloadFingerprint: fingerprint
  })

  const result = await harness.coordinator.confirm(binding().quoteHandle, fingerprint)
  expect(result.graph.root.status).toBe('broadcast')
  expect(result.graph.segments[0].evidence.transactionHash).toBe(sourceHash)
  expect(harness.calls).toEqual([
    'read-plan',
    'prepare-signing',
    'read-plan',
    'confirm-signing',
    'broadcast',
    `record:${sourceHash}`,
    'schedule',
    'report'
  ])
})

test('does not sign twice when a Solana broadcast is recovered after quote expiry', async () => {
  let broadcasts = 0
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransaction() {
        harness.calls.push('broadcast')
        broadcasts += 1
        return broadcasts === 1 ? '2'.repeat(64) : sourceHash
      }
    }
  })
  await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(harness.coordinator.confirm(binding().quoteHandle, fingerprint)).rejects.toThrow(
    /waiting to broadcast/
  )

  harness.setNow(6_000)
  const result = await harness.coordinator.confirm(binding().quoteHandle, fingerprint)
  expect(result.graph.root.status).toBe('broadcast')
  expect(harness.calls.filter(call => call === 'confirm-signing')).toHaveLength(1)
  expect(harness.calls.filter(call => call === 'read-plan')).toHaveLength(2)
})

test('rejects metadata that is not bound to the serialized Solana transaction', async () => {
  const harness = createHarness({
    service: {
      async readSolanaTransactionPlan() {
        return {
          quoteHandle: binding().quoteHandle,
          executionId: binding().executionId,
          chain: 'solana',
          transaction: 'AQ==',
          format: 'base64',
          metadata: {
            addressLookupTableAddresses: [],
            recentBlockhash: null,
            txValidUntil: null,
            transactionSize: 2
          }
        }
      }
    }
  })
  await expect(harness.coordinator.prepare(binding().quoteHandle, binding())).rejects.toThrow(
    /size does not match/
  )
})

test('Ledger Solana review binds the exact plan and confirms only once', async () => {
  let changed = false
  let releaseSigning
  const signingGate = new Promise(resolve => {
    releaseSigning = resolve
  })
  const harness = createHarness({
    ledger: true,
    service: {
      async readSolanaTransactionPlan() {
        harness.calls.push('read-plan')
        return {
          quoteHandle: binding().quoteHandle,
          executionId: binding().executionId,
          chain: 'solana',
          transaction: changed ? 'Ag==' : 'AQ==',
          format: 'base64',
          metadata: {
            addressLookupTableAddresses: [],
            recentBlockhash: null,
            txValidUntil: null,
            transactionSize: 1
          }
        }
      }
    },
    signer: {
      async confirm() {
        harness.calls.push('confirm-signing')
        await signingGate
        return {
          kind: 'signed-payload',
          payload: { encoding: 'base64', value: 'Ag==' },
          transactionId: sourceHash
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  changed = true
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/changed after Ledger review/)
  expect(harness.calls).not.toContain('confirm-signing')

  changed = false
  const first = harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/already in progress/)
  releaseSigning()
  await expect(first).resolves.toMatchObject({ graph: { root: { status: 'broadcast' } } })
  expect(harness.calls.filter(call => call === 'confirm-signing')).toHaveLength(1)
})
