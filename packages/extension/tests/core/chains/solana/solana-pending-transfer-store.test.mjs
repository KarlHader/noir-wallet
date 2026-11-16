import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import {
  ChromeSessionSolanaPendingTransferStore,
  parsePendingSolanaTransfer
} from '../../../../src/infrastructure/chains/solana/solana-pending-transfer-store.ts'
import { buildSolanaNativeTransfer } from '../../../../src/infrastructure/chains/solana/solana-transaction-builder.ts'

const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const recipient = 'SysvarRent111111111111111111111111111111111'
const recentBlockhash = 'SysvarC1ock11111111111111111111111111111111'
const scope = { keyDomainId: 'key-domain:solana', accountId: 'account:solana:0' }
const transactionId = parseTransactionId('transaction:solana:pending')
const segmentId = parseTransactionSegmentId('segment:solana:pending')
const built = buildSolanaNativeTransfer({
  chainId,
  sender,
  recipient,
  recentBlockhash,
  lamports: '5000'
})
const prepared = {
  chainId,
  sender,
  recipient,
  lamports: '5000',
  feeLamports: '5000',
  totalDebitLamports: '10000',
  recentBlockhash,
  lastValidBlockHeight: 99,
  transactionBase64: built.transactionBase64,
  messageBase64: built.messageBase64,
  simulationUnitsConsumed: 150
}

function signingSummary() {
  const data = Buffer.alloc(12)
  data.writeUInt32LE(2, 0)
  data.writeBigUInt64LE(5_000n, 4)
  return {
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
          interpretation: { kind: 'system-transfer', from: sender, to: recipient, lamports: '5000' }
        }
      ]
    }
  }
}

function awaitingRecord() {
  return {
    schemaVersion: 1,
    phase: 'awaiting-approval',
    transactionId,
    segmentId,
    scope,
    prepared,
    signingSummary: signingSummary(),
    signingCommandId: 'signing-command:solana:pending',
    payloadFingerprint: createHash('sha256')
      .update(Buffer.from(built.transactionBase64, 'base64'))
      .digest('hex'),
    expiresAt: 2_000
  }
}

function signedRecord() {
  const bytes = Buffer.from(built.transactionBase64, 'base64')
  bytes[64] = 1
  return {
    schemaVersion: 1,
    phase: 'signed',
    transactionId,
    segmentId,
    scope,
    transactionBase64: bytes.toString('base64'),
    transactionHash: `${'1'.repeat(63)}2`,
    messageBase64: built.messageBase64,
    lastValidBlockHeight: 99,
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

test('round-trips awaiting and signed Solana transfers through session storage', async () => {
  const storage = memoryStorage()
  const store = new ChromeSessionSolanaPendingTransferStore(storage)
  await store.put(awaitingRecord())
  await expect(store.get(transactionId)).resolves.toEqual(
    parsePendingSolanaTransfer(awaitingRecord())
  )
  await store.put(signedRecord())
  await expect(store.list()).resolves.toEqual([parsePendingSolanaTransfer(signedRecord())])
  await store.delete(transactionId)
  await expect(store.get(transactionId)).resolves.toBeNull()
})

test('fails closed for tampered wire bytes, signatures and storage keys', async () => {
  expect(() =>
    parsePendingSolanaTransfer({
      ...awaitingRecord(),
      prepared: { ...prepared, lamports: '5001', totalDebitLamports: '10001' }
    })
  ).toThrow(/bytes/)
  expect(() =>
    parsePendingSolanaTransfer({ ...signedRecord(), transactionHash: '1'.repeat(64) })
  ).toThrow(/hash/)

  const storage = memoryStorage()
  const store = new ChromeSessionSolanaPendingTransferStore(storage)
  storage.values['solana_pending_transfer:transaction%3Asolana%3Awrong'] = signedRecord()
  await expect(store.list()).rejects.toThrow(/key mismatch/)
})
