import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { initEccLib, networks, payments, Psbt, Transaction } from 'bitcoinjs-lib'

import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import {
  buildBitcoinPsbt,
  ChromeSessionBitcoinPendingTransferStore,
  selectBitcoinCoins
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'

initEccLib(secp256k1)

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const transactionId = parseTransactionId('transaction:bitcoin:pending')
const segmentId = parseTransactionSegmentId('segment:bitcoin:pending')
const scope = { keyDomainId: 'key-domain:bitcoin', accountId: 'account:bitcoin:0' }

function sessionStore() {
  const values = new Map()
  return {
    values,
    area: {
      get: async key => {
        if (key === null) return Object.fromEntries(structuredClone([...values]))
        if (Array.isArray(key)) {
          return Object.fromEntries(
            key
              .filter(candidate => values.has(candidate))
              .map(candidate => [candidate, structuredClone(values.get(candidate))])
          )
        }
        return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}
      },
      set: async entries => {
        for (const [key, value] of Object.entries(entries)) {
          values.set(key, structuredClone(value))
        }
      },
      remove: async keys => {
        for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
      }
    }
  }
}

function preparedContext() {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = 1
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const signer = payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin }).address
  const recipientKey = Buffer.alloc(32)
  recipientKey[31] = 2
  const recipientPublicKey = Buffer.from(secp256k1.pointFromScalar(recipientKey, true))
  const recipient = payments.p2wpkh({
    pubkey: recipientPublicKey,
    network: networks.bitcoin
  }).address
  if (!signer || !recipient) throw new Error('Unable to derive Bitcoin test addresses')
  const selection = selectBitcoinCoins({
    chainId,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [
      {
        chainId,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        address: signer,
        derivationPath: "m/84'/0'/0'/0/0",
        publicKey: `0x${publicKey.toString('hex')}`,
        transactionId: 'a'.repeat(64),
        outputIndex: 0,
        valueSats: '50300',
        blockHeight: 899_999
      }
    ]
  })
  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: '0x01020304',
    lockTime: 900_000
  })
  const psbt = Psbt.fromBase64(prepared.psbtBase64)
  return {
    prepared,
    signer,
    summary: {
      schema: 'bitcoin.psbt.v1',
      chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        psbtVersion: 0,
        signer,
        inputs: [
          {
            index: 0,
            transactionId: 'a'.repeat(64),
            outputIndex: 0,
            amountSats: '50300',
            sequence: 0xfffffffd,
            scriptType: 'p2wpkh',
            sighashType: 'SIGHASH_ALL',
            ownership: 'signing-account'
          }
        ],
        outputs: psbt.txOutputs.map((output, index) => ({
          index,
          address: recipient,
          scriptPubKeyHex: `0x${output.script.toString('hex')}`,
          amountSats: output.value.toString(),
          classification: 'recipient'
        })),
        signingInputIndexes: [0],
        totalInputSats: '50300',
        totalOutputSats: '50000',
        feeSats: '300'
      }
    }
  }
}

function awaitingRecord() {
  const { prepared, signer, summary } = preparedContext()
  const chainAccount = {
    id: 'chain-account:bitcoin:pending',
    scope: { ...scope, chainId },
    derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
    identity: { kind: 'account-identifier', value: signer },
    createdAt: 1_000
  }
  return {
    schemaVersion: 3,
    phase: 'awaiting-approval',
    transactionId,
    segmentId,
    scope,
    requiredConfirmations: 6,
    changeReservation: null,
    inputReservation: {
      schemaVersion: 1,
      chainAccount,
      accountIndex: 0,
      addressType: 'p2wpkh',
      transactionId,
      state: 'reserved',
      outpoints: [{ transactionId: 'a'.repeat(64), outputIndex: 0 }],
      createdAt: 1_000,
      updatedAt: 1_000
    },
    prepared,
    signer,
    signingSummary: summary,
    signingCommandId: parseSigningCommandId('signing-command:bitcoin:pending'),
    signingExecution: { kind: 'internal' },
    payloadFingerprint: 'b'.repeat(64),
    expiresAt: 5_000
  }
}

function signedRecord() {
  const transaction = new Transaction()
  transaction.version = 2
  transaction.addInput(Buffer.alloc(32), 0, 0xfffffffd)
  transaction.addOutput(Buffer.from('00140000000000000000000000000000000000000000', 'hex'), 1_000)
  const signer = preparedContext().signer
  return {
    schemaVersion: 3,
    phase: 'signed',
    transactionId,
    segmentId,
    scope,
    requiredConfirmations: 6,
    changeReservation: null,
    inputReservation: {
      schemaVersion: 1,
      chainAccount: {
        id: 'chain-account:bitcoin:pending',
        scope: { ...scope, chainId },
        derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
        identity: { kind: 'account-identifier', value: signer },
        createdAt: 1_000
      },
      accountIndex: 0,
      addressType: 'p2wpkh',
      transactionId,
      state: 'reserved',
      outpoints: [{ transactionId: '0'.repeat(64), outputIndex: 0 }],
      createdAt: 1_000,
      updatedAt: 1_000
    },
    rawTransactionHex: transaction.toHex(),
    transactionHash: transaction.getId(),
    signedAt: 1_500
  }
}

test('round-trips strictly parsed awaiting-approval and signed Bitcoin records', async () => {
  const session = sessionStore()
  const store = new ChromeSessionBitcoinPendingTransferStore(session.area)
  const awaiting = awaitingRecord()
  await store.put(awaiting)
  await expect(store.get(transactionId)).resolves.toEqual(awaiting)
  await expect(store.list()).resolves.toEqual([awaiting])

  const signed = signedRecord()
  await store.put(signed)
  await expect(store.get(transactionId)).resolves.toEqual(signed)
  await expect(store.clear()).resolves.toBe(1)
  await expect(store.get(transactionId)).resolves.toBeNull()
})

test('lists and clears only Bitcoin pending transfer records', async () => {
  const session = sessionStore()
  const store = new ChromeSessionBitcoinPendingTransferStore(session.area)
  session.values.set('unrelated-session-state', { retained: true })
  await store.put(awaitingRecord())

  await expect(store.list()).resolves.toHaveLength(1)
  await expect(store.clear()).resolves.toBe(1)
  expect(session.values.get('unrelated-session-state')).toEqual({ retained: true })
})

test('rejects a tampered review binding and raw transaction/hash mismatch', async () => {
  const session = sessionStore()
  const store = new ChromeSessionBitcoinPendingTransferStore(session.area)
  const awaiting = awaitingRecord()
  const altered = structuredClone(awaiting)
  altered.signingSummary.fields.feeSats = '301'
  await expect(store.put(altered)).rejects.toThrow(/amounts do not balance|summary does not match/)

  const signed = signedRecord()
  await expect(store.put({ ...signed, transactionHash: 'c'.repeat(64) })).rejects.toThrow(
    /raw transaction/
  )
})
