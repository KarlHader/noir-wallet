import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  ChromeSessionNearPendingTransferStore,
  parsePendingNearTransfer
} from '../../../../src/infrastructure/chains/near/index.ts'

const chainId = 'near:testnet'
const signerId = '00'.repeat(32)
const publicKey = `ed25519:${'1'.repeat(32)}`
const receiverId = 'alice.testnet'
const blockHash = '11111111111111111111111111111111'
const transactionId = 'transaction:near:pending'
const segmentId = 'segment:near:pending'
const scope = { keyDomainId: 'key-domain:near', accountId: 'account:near:0' }
const transaction = {
  chainId,
  accountIndex: 0,
  signerId,
  receiverId,
  nonce: '42',
  blockHash,
  actions: [{ type: 'transfer', depositYocto: '2000000000000000000000000' }]
}
const prepared = {
  chainId,
  accountIndex: 0,
  signerId,
  publicKey,
  receiverId,
  depositYocto: '2000000000000000000000000',
  estimatedFeeYocto: '44636512500000000000',
  maximumFeeYocto: '446365125000000000000',
  storageReserveYocto: '1000000000000000000000',
  totalRequiredYocto: '2001446365125000000000000',
  transaction
}

function awaitingRecord() {
  return {
    schemaVersion: 1,
    phase: 'awaiting-approval',
    transactionId,
    segmentId,
    scope,
    prepared,
    signingSummary: {
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
        actions: [{ kind: 'transfer', depositYocto: prepared.depositYocto }]
      }
    },
    signingCommandId: 'signing-command:near:pending',
    payloadFingerprint: createHash('sha256').update(JSON.stringify(transaction)).digest('hex'),
    expiresAt: 2_000
  }
}

function signedRecord() {
  return {
    schemaVersion: 1,
    phase: 'signed',
    transactionId,
    segmentId,
    scope,
    transactionBase64: 'AQ==',
    transactionHash: blockHash,
    signerId,
    signedAt: 1_500
  }
}

function memoryStorage() {
  const values = {}
  return {
    values,
    get: async keys => {
      if (keys === null) return structuredClone(values)
      return Object.prototype.hasOwnProperty.call(values, keys)
        ? { [keys]: structuredClone(values[keys]) }
        : {}
    },
    set: async items => Object.assign(values, structuredClone(items)),
    remove: async keys => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]
    }
  }
}

test('round-trips awaiting and signed NEAR transfers through session storage', async () => {
  const storage = memoryStorage()
  const store = new ChromeSessionNearPendingTransferStore(storage)
  await store.put(awaitingRecord())
  await expect(store.get(transactionId)).resolves.toEqual(
    parsePendingNearTransfer(awaitingRecord())
  )
  await store.put(signedRecord())
  await expect(store.list()).resolves.toEqual([parsePendingNearTransfer(signedRecord())])
  await store.delete(transactionId)
  await expect(store.get(transactionId)).resolves.toBeNull()
})

test('fails closed for tampered approvals, signed payloads, and storage keys', async () => {
  expect(() =>
    parsePendingNearTransfer({
      ...awaitingRecord(),
      prepared: { ...prepared, receiverId: 'mallory.testnet' }
    })
  ).toThrow(/approval fields/)
  expect(() =>
    parsePendingNearTransfer({ ...signedRecord(), transactionBase64: 'not-base64' })
  ).toThrow(/signed NEAR transaction/)

  const storage = memoryStorage()
  const store = new ChromeSessionNearPendingTransferStore(storage)
  storage.values['near_pending_transfer:transaction%3Anear%3Awrong'] = signedRecord()
  await expect(store.list()).rejects.toThrow(/key mismatch/)
})
