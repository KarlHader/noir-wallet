import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundSolanaTransferController } from '../../../../src/background/solana-transfer-controller.ts'

const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const recipient = 'SysvarRent111111111111111111111111111111111'
const chainAccount = Object.freeze({
  id: 'chain-account:solana:active',
  scope: {
    keyDomainId: 'key-domain:active',
    accountId: 'account:active',
    chainId
  },
  derivation: { scheme: 'slip10', path: "m/44'/501'/3'/0'" },
  identity: { kind: 'account-identifier', value: sender },
  createdAt: 1
})
const activeContext = Object.freeze({
  chainAccount,
  accountIndex: 3,
  keyDomainSource: { kind: 'software', mnemonicWordCount: 24 }
})

function setup(context = activeContext) {
  const calls = []
  const signing = Object.freeze({
    commandId: 'signing-command:solana:review',
    chainId,
    operation: 'transaction',
    summary: { schema: 'solana.transaction.v1' },
    payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
    execution: { kind: 'internal' },
    expiresAt: 5_000
  })
  const results = {
    prepared: Object.freeze({ graph: { root: { id: 'transaction:solana:prepared' } }, signing }),
    pending: Object.freeze({ graph: { root: { id: 'transaction:solana:pending' } }, signing }),
    approved: Object.freeze({ status: 'broadcast', graph: { root: { status: 'broadcast' } } }),
    rejected: Object.freeze({ root: { status: 'failed' } }),
    resumed: Object.freeze({
      status: 'signed-pending-broadcast',
      graph: { root: { status: 'signed' } }
    })
  }
  const orchestrator = {
    prepare: async input => {
      calls.push(['prepare', input])
      return results.prepared
    },
    getPendingApproval: async input => {
      calls.push(['get-pending', input])
      return results.pending
    },
    approve: async input => {
      calls.push(['approve', input])
      return results.approved
    },
    reject: async input => {
      calls.push(['reject', input])
      return results.rejected
    },
    resumeBroadcast: async input => {
      calls.push(['resume', input])
      return results.resumed
    }
  }
  return {
    calls,
    results,
    controller: new BackgroundSolanaTransferController({
      orchestrator,
      loadActiveContext: async () => context
    })
  }
}

test('binds a strict native transfer intent to the active Solana account index', async () => {
  const { calls, controller, results } = setup()
  const intent = { assetId: `${chainId}/slip44:501`, recipient, amountRaw: '5000' }
  await expect(controller.prepare(intent)).resolves.toEqual({
    graph: results.prepared.graph,
    review: {
      chainId,
      operation: 'transaction',
      summary: results.prepared.signing.summary,
      payloadFingerprint: results.prepared.signing.payloadFingerprint,
      expiresAt: 5_000
    }
  })
  expect(calls).toEqual([
    ['prepare', { chainAccount, accountIndex: 3, recipient, lamports: '5000' }]
  ])
  await expect(controller.prepare({ ...intent, memo: 'forged' })).rejects.toThrow(/invalid/i)
  await expect(controller.prepare({ ...intent, amountRaw: '0' })).rejects.toThrow(/invalid/i)
  expect(calls).toHaveLength(1)
})

test('rechecks dApp authorization inside the serialized Solana approval boundary', async () => {
  const { calls, controller } = setup()
  await expect(
    controller.approveForDApp('transaction:solana:prepared', 'a'.repeat(64), async context => {
      expect(context).toBe(activeContext)
      throw new Error('authorization revoked')
    })
  ).rejects.toThrow('authorization revoked')
  expect(calls).toEqual([])
})

test('rejects cross-network assets and unsupported hardware signing', async () => {
  const { calls, controller } = setup()
  await expect(
    controller.prepare({ assetId: 'solana:mainnet/slip44:501', recipient, amountRaw: '1' })
  ).rejects.toThrow(/active network/i)
  expect(calls).toEqual([])

  const hardware = setup({
    ...activeContext,
    keyDomainSource: {
      kind: 'hardware',
      vendor: 'keystone',
      firmwareProfile: 'multi-coin',
      capabilities: ['solana']
    }
  })
  await expect(
    hardware.controller.prepare({ assetId: `${chainId}/slip44:501`, recipient, amountRaw: '1' })
  ).rejects.toThrow(/cannot sign/i)
  expect(hardware.calls).toEqual([])
})

test('resolves the active scope for approval and signed broadcast recovery', async () => {
  const { calls, controller, results } = setup()
  await expect(controller.getPendingApproval('transaction:solana:pending')).resolves.toMatchObject({
    graph: results.pending.graph
  })
  await expect(controller.approve('transaction:solana:approved', 'a'.repeat(64))).resolves.toBe(
    results.approved
  )
  await expect(controller.reject('transaction:solana:rejected')).resolves.toBe(results.rejected)
  await expect(controller.resumeBroadcast('transaction:solana:resumed')).resolves.toBe(
    results.resumed
  )
  expect(calls).toEqual([
    ['get-pending', { scope: chainAccount.scope, transactionId: 'transaction:solana:pending' }],
    [
      'approve',
      {
        scope: chainAccount.scope,
        transactionId: 'transaction:solana:approved',
        payloadFingerprint: 'a'.repeat(64)
      }
    ],
    ['reject', { scope: chainAccount.scope, transactionId: 'transaction:solana:rejected' }],
    ['resume', { scope: chainAccount.scope, transactionId: 'transaction:solana:resumed' }]
  ])
})
