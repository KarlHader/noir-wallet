import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundNearTransferController } from '../../../../src/background/near-transfer-controller.ts'

const chainId = 'near:testnet'
const signerId = '00'.repeat(32)
const publicKey = `ed25519:${'1'.repeat(32)}`
const recipient = 'alice.testnet'
const chainAccount = Object.freeze({
  id: 'chain-account:near:active',
  scope: { keyDomainId: 'key-domain:active', accountId: 'account:active', chainId },
  derivation: { scheme: 'slip10', path: "m/44'/397'/3'" },
  identity: { kind: 'account-identifier', value: signerId },
  createdAt: 1
})
const activeContext = Object.freeze({
  chainAccount,
  accountIndex: 3,
  publicKey,
  keyDomainSource: { kind: 'software', mnemonicWordCount: 24 }
})

function setup(context = activeContext) {
  const calls = []
  const signing = Object.freeze({
    commandId: 'signing-command:near:review',
    chainId,
    operation: 'transaction',
    summary: { schema: 'near.transaction.v1' },
    payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
    execution: { kind: 'internal' },
    expiresAt: 5_000
  })
  const prepared = Object.freeze({
    graph: { root: { id: 'transaction:near:prepared' } },
    signing,
    debit: { maximumFeeRaw: '10', storageReserveRaw: '20' }
  })
  const orchestrator = {
    prepare: async input => (calls.push(['prepare', input]), prepared),
    getPendingApproval: async input => (calls.push(['get-pending', input]), prepared),
    approve: async input => (calls.push(['approve', input]), { status: 'broadcast', graph: {} }),
    reject: async input => (calls.push(['reject', input]), { root: { status: 'failed' } }),
    resumeBroadcast: async input => (
      calls.push(['resume', input]),
      { status: 'signed-pending-broadcast', graph: {} }
    )
  }
  return {
    calls,
    controller: new BackgroundNearTransferController({
      orchestrator,
      loadActiveContext: async () => context
    })
  }
}

test('binds a strict native transfer intent to the active NEAR account index', async () => {
  const { calls, controller } = setup()
  const intent = {
    assetId: `${chainId}/slip44:397`,
    recipient,
    amountRaw: '1000000000000000000000'
  }
  await expect(controller.prepare(intent)).resolves.toMatchObject({
    graph: { root: { id: 'transaction:near:prepared' } },
    debit: { maximumFeeRaw: '10', storageReserveRaw: '20' },
    review: { chainId, operation: 'transaction' }
  })
  expect(calls).toEqual([
    [
      'prepare',
      {
        chainAccount,
        accountIndex: 3,
        publicKey,
        receiverId: recipient,
        depositYocto: '1000000000000000000000'
      }
    ]
  ])
  await expect(controller.prepare({ ...intent, memo: 'forged' })).rejects.toThrow(/invalid/i)
  await expect(controller.prepare({ ...intent, amountRaw: '0' })).rejects.toThrow(/invalid/i)
  expect(calls).toHaveLength(1)
})

test('rechecks dApp authorization inside the serialized NEAR approval boundary', async () => {
  const { calls, controller } = setup()
  await expect(
    controller.approveForDApp('transaction:near:prepared', 'a'.repeat(64), async context => {
      expect(context).toBe(activeContext)
      throw new Error('authorization revoked')
    })
  ).rejects.toThrow('authorization revoked')
  expect(calls).toEqual([])
})

test('rejects cross-network assets and unsupported hardware signing', async () => {
  const { calls, controller } = setup()
  await expect(
    controller.prepare({ assetId: 'near:mainnet/slip44:397', recipient, amountRaw: '1' })
  ).rejects.toThrow(/active network/i)
  expect(calls).toEqual([])

  const hardware = setup({
    ...activeContext,
    keyDomainSource: {
      kind: 'hardware',
      vendor: 'keystone',
      firmwareProfile: 'multi-coin',
      capabilities: ['near']
    }
  })
  await expect(
    hardware.controller.prepare({ assetId: `${chainId}/slip44:397`, recipient, amountRaw: '1' })
  ).rejects.toThrow(/cannot sign/i)
  expect(hardware.calls).toEqual([])
})
