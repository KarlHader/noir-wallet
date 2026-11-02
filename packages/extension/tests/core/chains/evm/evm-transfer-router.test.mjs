import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundEvmTransferRouter } from '../../../../src/background/evm-transfer-router.ts'

const ethereum = 'eip155:1'
const base = 'eip155:8453'
const scope = Object.freeze({
  keyDomainId: 'key-domain:active',
  accountId: 'account:active'
})

function controller(chainId, calls) {
  return {
    prepare: async (intent, nearIntents, feeTier, executionMode) => {
      calls.push(['prepare', chainId, intent.assetId, nearIntents, feeTier, executionMode])
      return {
        graph: { root: { id: `transaction:${chainId}` } },
        review: {
          chainId,
          operation: 'transaction',
          summary: { schema: 'evm.transaction.v1' },
          payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
          expiresAt: 5_000
        }
      }
    },
    getPendingApproval: async transactionId => {
      calls.push(['pending', chainId, transactionId])
      return { chainId, transactionId }
    },
    approve: async transactionId => {
      calls.push(['approve', chainId, transactionId])
      return { status: 'broadcast', graph: { root: { id: transactionId } } }
    },
    getExternalSigningRequest: async transactionId => {
      calls.push(['external', chainId, transactionId])
      return null
    },
    submitExternalSignature: async transactionId => {
      calls.push(['submit', chainId, transactionId])
      return { status: 'broadcast', graph: { root: { id: transactionId } } }
    },
    reject: async transactionId => {
      calls.push(['reject', chainId, transactionId])
      return { root: { id: transactionId } }
    },
    rejectForScope: async (transactionId, value) => {
      calls.push(['reject-scope', chainId, transactionId, value])
      return { root: { id: transactionId } }
    },
    resumeBroadcast: async transactionId => {
      calls.push(['resume', chainId, transactionId])
      return { status: 'broadcast', graph: { root: { id: transactionId } } }
    },
    cancelAwaitingApprovalsForScope: async value => {
      calls.push(['cancel-scope', chainId, value])
      return 1
    },
    cancelAwaitingApprovalsExceptScope: async value => {
      calls.push(['cancel-except', chainId, value])
      return 1
    },
    clearPendingTransfers: async () => {
      calls.push(['clear', chainId])
      return 1
    },
    cancelAllAwaitingApprovals: async () => {
      calls.push(['cancel-all', chainId])
      return 1
    }
  }
}

function createRouter(pendingById, graphsById = new Map(), calls = []) {
  return {
    calls,
    router: new BackgroundEvmTransferRouter({
      controllers: new Map([
        [ethereum, controller(ethereum, calls)],
        [base, controller(base, calls)]
      ]),
      pendingStore: {
        get: async transactionId => pendingById.get(transactionId) ?? null
      },
      transactions: {
        get: async (_scope, transactionId) => graphsById.get(transactionId) ?? null
      }
    })
  }
}

test('routes wallet transfers by the exact CAIP-2 chain in the AssetId', async () => {
  const { router, calls } = createRouter(new Map())
  await expect(
    router.prepare(
      {
        assetId: `${base}/slip44:60`,
        recipient: '0x2222222222222222222222222222222222222222',
        amountRaw: '1'
      },
      undefined,
      'fast',
      'private'
    )
  ).resolves.toMatchObject({ review: { chainId: base } })
  expect(calls).toEqual([['prepare', base, `${base}/slip44:60`, undefined, 'fast', 'private']])

  await expect(
    router.prepare({
      assetId: 'eip155:999/slip44:60',
      recipient: '0x2222222222222222222222222222222222222222',
      amountRaw: '1'
    })
  ).rejects.toThrow(/network is unavailable/i)
})

test('restores awaiting-approval routing from the persisted pending record after restart', async () => {
  const transactionId = 'transaction:evm:base-pending'
  const pendingById = new Map([
    [
      transactionId,
      {
        phase: 'awaiting-approval',
        transactionId,
        scope,
        prepared: { chainId: base }
      }
    ]
  ])

  const first = createRouter(pendingById)
  const second = createRouter(pendingById)
  await expect(second.router.getPendingApproval(transactionId)).resolves.toEqual({
    chainId: base,
    transactionId
  })
  await expect(second.router.approve(transactionId, 'a'.repeat(64))).resolves.toMatchObject({
    status: 'broadcast'
  })
  expect(first.calls).toEqual([])
  expect(second.calls).toEqual([
    ['pending', base, transactionId],
    ['approve', base, transactionId]
  ])
})

test('restores signed-pending broadcast routing from the durable transaction graph', async () => {
  const transactionId = 'transaction:evm:base-signed'
  const pendingById = new Map([[transactionId, { phase: 'signed', transactionId, scope }]])
  const graphsById = new Map([
    [
      transactionId,
      {
        root: {
          intent: {
            sender: { chainId: base },
            primaryAmount: { assetId: `${base}/slip44:60` },
            feeLimit: { assetId: `${base}/slip44:60` }
          }
        },
        segments: [{ role: 'origin', target: { kind: 'onchain', chainId: base } }]
      }
    ]
  ])
  const { router, calls } = createRouter(pendingById, graphsById)
  await expect(router.resumeBroadcast(transactionId)).resolves.toMatchObject({
    status: 'broadcast'
  })
  expect(calls).toEqual([['resume', base, transactionId]])

  graphsById.set(transactionId, {
    root: {
      intent: {
        sender: { chainId: ethereum },
        primaryAmount: { assetId: `${base}/slip44:60` },
        feeLimit: { assetId: `${base}/slip44:60` }
      }
    },
    segments: [{ role: 'origin', target: { kind: 'onchain', chainId: base } }]
  })
  await expect(router.resumeBroadcast(transactionId)).rejects.toThrow(/chain binding is invalid/i)
})

test('returns null for absent review state and uses one shared maintenance controller', async () => {
  const { router, calls } = createRouter(new Map())
  await expect(router.getPendingApproval('transaction:evm:missing')).resolves.toBeNull()
  await expect(router.getExternalSigningRequest('transaction:evm:missing')).resolves.toBeNull()
  await expect(router.reject('transaction:evm:missing')).rejects.toThrow(/was not found/i)
  await expect(router.rejectForScope('transaction:evm:missing', scope)).resolves.toBe(false)
  await expect(router.cancelAllAwaitingApprovals()).resolves.toBe(1)
  await expect(router.clearPendingTransfers()).resolves.toBe(1)
  expect(calls).toEqual([
    ['cancel-all', ethereum],
    ['clear', ethereum]
  ])
})

test('rejects a persisted dApp operation through its recorded scope', async () => {
  const transactionId = 'transaction:evm:scoped-reject'
  const pendingById = new Map([
    [
      transactionId,
      { phase: 'awaiting-approval', transactionId, scope, prepared: { chainId: base } }
    ]
  ])
  const { router, calls } = createRouter(pendingById)
  await expect(router.rejectForScope(transactionId, scope)).resolves.toBe(true)
  expect(calls).toEqual([['reject-scope', base, transactionId, scope]])
})
