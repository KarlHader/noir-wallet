import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { address, initEccLib, networks, payments, Psbt, Transaction } from 'bitcoinjs-lib'

import { parseChainId } from '../../../../src/core/chains/registry/index.ts'
import {
  assertBitcoinSigningSummaryMatchesPrepared,
  buildBitcoinPsbt,
  finalizeBitcoinPsbt,
  selectBitcoinCoins
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'

initEccLib(secp256k1)

const MAINNET = parseChainId('bip122:000000000019d6689c085ae165831e93').id
const MASTER_FINGERPRINT = '0x01020304'
const LOCK_TIME = 900_000

function keyMaterial(privateKeyDigit, addressType) {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = privateKeyDigit
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const payment =
    addressType === 'p2pkh'
      ? payments.p2pkh({ pubkey: publicKey, network: networks.bitcoin })
      : addressType === 'p2sh-p2wpkh'
        ? payments.p2sh({
            redeem: payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin }),
            network: networks.bitcoin
          })
        : addressType === 'p2wpkh'
          ? payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin })
          : payments.p2tr({
              internalPubkey: publicKey.subarray(1),
              network: networks.bitcoin
            })
  if (!payment.address || !payment.output) throw new Error('Unable to derive test Bitcoin address')
  return { privateKey, publicKey, address: payment.address, payment }
}

function profile(addressType) {
  return addressType === 'p2pkh'
    ? { purpose: 44, addressScheme: 'bitcoin-p2pkh', derivationScheme: 'bip44' }
    : addressType === 'p2sh-p2wpkh'
      ? { purpose: 49, addressScheme: 'bitcoin-p2sh-p2wpkh', derivationScheme: 'bip49' }
      : addressType === 'p2wpkh'
        ? { purpose: 84, addressScheme: 'bitcoin-p2wpkh', derivationScheme: 'bip84' }
        : { purpose: 86, addressScheme: 'bitcoin-p2tr', derivationScheme: 'bip86' }
}

function spendable(key, addressType, valueSats = '100000', outpoint = {}) {
  const { purpose } = profile(addressType)
  return {
    chainId: MAINNET,
    addressType,
    accountIndex: 0,
    change: false,
    addressIndex: 0,
    address: key.address,
    derivationPath: `m/${purpose}'/0'/0'/0/0`,
    publicKey: `0x${key.publicKey.toString('hex')}`,
    transactionId: outpoint.transactionId ?? 'ab'.repeat(32),
    outputIndex: outpoint.outputIndex ?? 1,
    valueSats,
    blockHeight: 899_999
  }
}

function changeAddress(key, addressType) {
  const { purpose, addressScheme, derivationScheme } = profile(addressType)
  return {
    chainId: MAINNET,
    addressType,
    accountIndex: 0,
    change: true,
    addressIndex: 0,
    address: key.address,
    addressScheme,
    derivationScheme,
    derivationPath: `m/${purpose}'/0'/0'/1/0`,
    publicKey: `0x${key.publicKey.toString('hex')}`,
    ...(addressType === 'p2pkh' || addressType === 'p2sh-p2wpkh'
      ? { scriptPubKey: `0x${key.payment.output.toString('hex')}` }
      : {}),
    ...(addressType === 'p2sh-p2wpkh'
      ? { redeemScript: `0x${key.payment.redeem.output.toString('hex')}` }
      : {})
  }
}

function fundingTransaction(key, valueSats = 100000) {
  const transaction = new Transaction()
  transaction.version = 2
  transaction.addInput(Buffer.alloc(32), 0xffffffff)
  transaction.addOutput(address.toOutputScript(key.address, networks.bitcoin), valueSats)
  return transaction
}

test('builds, validates, and finalizes a BIP-84 PSBT with explicit change key origin', () => {
  const source = keyMaterial(1, 'p2wpkh')
  const change = keyMaterial(2, 'p2wpkh')
  const recipient = keyMaterial(3, 'p2tr')
  const wrongSigner = keyMaterial(11, 'p2wpkh')
  const selection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: recipient.address,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable(source, 'p2wpkh')]
  })
  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: MASTER_FINGERPRINT,
    lockTime: LOCK_TIME,
    change: { address: changeAddress(change, 'p2wpkh'), outputPosition: 'first' }
  })

  expect(prepared).toMatchObject({
    schemaVersion: 1,
    transactionVersion: 2,
    lockTime: LOCK_TIME,
    rbf: true,
    inputCount: 1,
    outputCount: 2,
    recipientOutputIndex: 1,
    changeAddress: change.address,
    changeOutputIndex: 0,
    feeSats: '308',
    changeSats: '49692',
    estimatedVbytes: 154
  })
  const unsigned = Psbt.fromBase64(prepared.psbtBase64)
  expect(unsigned.version).toBe(2)
  expect(unsigned.locktime).toBe(LOCK_TIME)
  expect(unsigned.txInputs[0].sequence).toBe(0xfffffffd)
  expect(unsigned.data.inputs[0].nonWitnessUtxo).toBeUndefined()
  expect(unsigned.data.inputs[0].bip32Derivation).toEqual([
    expect.objectContaining({
      path: "m/84'/0'/0'/0/0",
      masterFingerprint: Buffer.from('01020304', 'hex'),
      pubkey: source.publicKey
    })
  ])
  expect(unsigned.data.outputs[0].bip32Derivation).toEqual([
    expect.objectContaining({ path: "m/84'/0'/0'/1/0", pubkey: change.publicKey })
  ])

  const signingSummary = {
    schema: 'bitcoin.psbt.v1',
    chainId: MAINNET,
    operation: 'transaction',
    review: { level: 'standard', issues: [] },
    fields: {
      psbtVersion: 0,
      signer: source.address,
      inputs: [
        {
          index: 0,
          transactionId: 'ab'.repeat(32),
          outputIndex: 1,
          amountSats: '100000',
          sequence: 0xfffffffd,
          scriptType: 'p2wpkh',
          sighashType: 'SIGHASH_ALL',
          ownership: 'signing-account'
        }
      ],
      outputs: unsigned.txOutputs.map((output, index) => ({
        index,
        address: index === 0 ? change.address : recipient.address,
        scriptPubKeyHex: `0x${output.script.toString('hex')}`,
        amountSats: output.value.toString(),
        classification: index === 0 ? 'change' : 'recipient'
      })),
      signingInputIndexes: [0],
      totalInputSats: '100000',
      totalOutputSats: '99692',
      feeSats: '308'
    }
  }
  expect(() =>
    assertBitcoinSigningSummaryMatchesPrepared(prepared, signingSummary, source.address)
  ).not.toThrow()
  for (const tampered of [
    { ...signingSummary, fields: { ...signingSummary.fields, signer: wrongSigner.address } },
    { ...signingSummary, fields: { ...signingSummary.fields, feeSats: '309' } },
    {
      ...signingSummary,
      fields: {
        ...signingSummary.fields,
        outputs: signingSummary.fields.outputs.map((output, index) =>
          index === 0 ? { ...output, classification: 'recipient' } : output
        )
      }
    }
  ]) {
    expect(() =>
      assertBitcoinSigningSummaryMatchesPrepared(prepared, tampered, source.address)
    ).toThrow(/does not match/)
  }

  unsigned.signAllInputs({
    publicKey: source.publicKey,
    sign: hash => Buffer.from(secp256k1.sign(hash, source.privateKey))
  })
  const finalized = finalizeBitcoinPsbt({
    prepared,
    signedPsbtBase64: unsigned.toBase64()
  })
  expect(finalized).toMatchObject({
    transactionId: prepared.unsignedTransactionId,
    feeSats: prepared.feeSats
  })
  expect(finalized.rawTransactionHex).toMatch(/^[0-9a-f]+$/)
  expect(finalized.vbytes).toBeLessThanOrEqual(prepared.estimatedVbytes)
  expect(finalized.feeRateSatsPerVbyte).toBeGreaterThanOrEqual(2)
})

test('keeps the selected Ledger account root in inputs and change', () => {
  const source = keyMaterial(1, 'p2wpkh')
  const change = keyMaterial(2, 'p2wpkh')
  const recipient = keyMaterial(3, 'p2tr')
  const root = "m/84'/0'/5'"
  const selection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: recipient.address,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [{ ...spendable(source, 'p2wpkh'), derivationPath: `${root}/0/0` }]
  })
  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: MASTER_FINGERPRINT,
    lockTime: LOCK_TIME,
    change: {
      address: { ...changeAddress(change, 'p2wpkh'), derivationPath: `${root}/1/0` },
      outputPosition: 'first'
    }
  })
  const psbt = Psbt.fromBase64(prepared.psbtBase64)
  expect(psbt.data.inputs[0].bip32Derivation[0].path).toBe(`${root}/0/0`)
  expect(psbt.data.outputs[0].bip32Derivation[0].path).toBe(`${root}/1/0`)
  psbt.signAllInputs({
    publicKey: source.publicKey,
    sign: hash => Buffer.from(secp256k1.sign(hash, source.privateKey))
  })
  expect(() => finalizeBitcoinPsbt({ prepared, signedPsbtBase64: psbt.toBase64() })).not.toThrow()
  expect(() =>
    buildBitcoinPsbt({
      selection,
      masterFingerprint: MASTER_FINGERPRINT,
      lockTime: LOCK_TIME,
      change: { address: changeAddress(change, 'p2wpkh'), outputPosition: 'first' }
    })
  ).toThrow(/selected account/)
})

test('builds BIP-86 key-path metadata without requiring change', () => {
  const source = keyMaterial(4, 'p2tr')
  const recipient = keyMaterial(5, 'p2wpkh')
  const selection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2tr',
    recipient: recipient.address,
    amount: { mode: 'max' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable(source, 'p2tr')]
  })
  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: MASTER_FINGERPRINT,
    lockTime: LOCK_TIME
  })
  const psbt = Psbt.fromBase64(prepared.psbtBase64)

  expect(prepared).toMatchObject({
    addressType: 'p2tr',
    changeAddress: null,
    changeOutputIndex: null,
    outputCount: 1
  })
  expect(psbt.data.inputs[0].bip32Derivation).toBeUndefined()
  expect(psbt.data.inputs[0].tapInternalKey).toEqual(source.publicKey.subarray(1))
  expect(psbt.data.inputs[0].tapBip32Derivation).toEqual([
    expect.objectContaining({
      path: "m/86'/0'/0'/0/0",
      masterFingerprint: Buffer.from('01020304', 'hex'),
      pubkey: source.publicKey.subarray(1),
      leafHashes: []
    })
  ])
})

test('builds, signs, and finalizes a BIP-49 nested SegWit PSBT', () => {
  const source = keyMaterial(12, 'p2sh-p2wpkh')
  const change = keyMaterial(13, 'p2sh-p2wpkh')
  const recipient = keyMaterial(14, 'p2pkh')
  const selection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2sh-p2wpkh',
    recipient: recipient.address,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable(source, 'p2sh-p2wpkh')]
  })
  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: MASTER_FINGERPRINT,
    lockTime: LOCK_TIME,
    change: { address: changeAddress(change, 'p2sh-p2wpkh'), outputPosition: 'last' }
  })
  const psbt = Psbt.fromBase64(prepared.psbtBase64)
  expect(psbt.data.inputs[0]).toMatchObject({
    witnessUtxo: { value: 100000 },
    redeemScript: source.payment.redeem.output
  })
  expect(psbt.data.inputs[0].nonWitnessUtxo).toBeUndefined()
  expect(psbt.data.outputs[1].redeemScript).toEqual(change.payment.redeem.output)
  psbt.signAllInputs({
    publicKey: source.publicKey,
    sign: hash => Buffer.from(secp256k1.sign(hash, source.privateKey))
  })
  expect(() => finalizeBitcoinPsbt({ prepared, signedPsbtBase64: psbt.toBase64() })).not.toThrow()
})

test('requires and validates the full previous transaction for BIP-44 P2PKH inputs', () => {
  const source = keyMaterial(15, 'p2pkh')
  const recipient = keyMaterial(16, 'p2wpkh')
  const funding = fundingTransaction(source)
  const selection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2pkh',
    recipient: recipient.address,
    amount: { mode: 'max' },
    feeRateSatsPerVbyte: 2,
    utxos: [
      spendable(source, 'p2pkh', '100000', {
        transactionId: funding.getId(),
        outputIndex: 0
      })
    ]
  })
  expect(() =>
    buildBitcoinPsbt({
      selection,
      masterFingerprint: MASTER_FINGERPRINT,
      lockTime: LOCK_TIME
    })
  ).toThrow(expect.objectContaining({ code: 'invalid-intent' }))

  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: MASTER_FINGERPRINT,
    lockTime: LOCK_TIME,
    previousTransactions: [{ transactionId: funding.getId(), rawTransactionHex: funding.toHex() }]
  })
  const psbt = Psbt.fromBase64(prepared.psbtBase64)
  expect(psbt.data.inputs[0].witnessUtxo).toBeUndefined()
  expect(psbt.data.inputs[0].nonWitnessUtxo).toEqual(funding.toBuffer())
  psbt.signAllInputs({
    publicKey: source.publicKey,
    sign: hash => Buffer.from(secp256k1.sign(hash, source.privateKey))
  })
  expect(() => finalizeBitcoinPsbt({ prepared, signedPsbtBase64: psbt.toBase64() })).not.toThrow()
})

test('rejects mismatched ownership, malformed fingerprints, and missing change reservations', () => {
  const source = keyMaterial(6, 'p2wpkh')
  const unrelated = keyMaterial(7, 'p2wpkh')
  const recipient = keyMaterial(8, 'p2wpkh')
  const selection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: recipient.address,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable(source, 'p2wpkh')]
  })

  expect(() =>
    buildBitcoinPsbt({ selection, masterFingerprint: '0x0102030A', lockTime: LOCK_TIME })
  ).toThrow(expect.objectContaining({ code: 'invalid-intent' }))
  expect(() =>
    buildBitcoinPsbt({ selection, masterFingerprint: MASTER_FINGERPRINT, lockTime: LOCK_TIME })
  ).toThrow(expect.objectContaining({ code: 'invalid-intent' }))
  expect(() =>
    buildBitcoinPsbt({
      selection: {
        ...selection,
        selectedUtxos: [
          { ...selection.selectedUtxos[0], publicKey: `0x${unrelated.publicKey.toString('hex')}` }
        ]
      },
      masterFingerprint: MASTER_FINGERPRINT,
      lockTime: LOCK_TIME,
      change: { address: changeAddress(unrelated, 'p2wpkh'), outputPosition: 'last' }
    })
  ).toThrow(expect.objectContaining({ code: 'invalid-intent' }))
  expect(() =>
    buildBitcoinPsbt({
      selection,
      masterFingerprint: MASTER_FINGERPRINT,
      lockTime: LOCK_TIME,
      change: {
        address: {
          ...changeAddress(unrelated, 'p2wpkh'),
          masterFingerprint: '0x05060708'
        },
        outputPosition: 'last'
      }
    })
  ).toThrow(expect.objectContaining({ code: 'invalid-intent' }))
})

test('rejects unsigned, signature-tampered, and transaction-tampered PSBTs', () => {
  const source = keyMaterial(9, 'p2wpkh')
  const recipient = keyMaterial(10, 'p2wpkh')
  const selection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: recipient.address,
    amount: { mode: 'max' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable(source, 'p2wpkh')]
  })
  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: MASTER_FINGERPRINT,
    lockTime: LOCK_TIME
  })
  expect(() => finalizeBitcoinPsbt({ prepared, signedPsbtBase64: prepared.psbtBase64 })).toThrow(
    expect.objectContaining({ code: 'invalid-signed-transaction' })
  )

  const signed = Psbt.fromBase64(prepared.psbtBase64)
  signed.signAllInputs({
    publicKey: source.publicKey,
    sign: hash => Buffer.from(secp256k1.sign(hash, source.privateKey))
  })
  const partialSignature = signed.data.inputs[0].partialSig?.[0].signature
  if (!partialSignature) throw new Error('Expected a test signature')
  partialSignature[10] ^= 1
  expect(() => finalizeBitcoinPsbt({ prepared, signedPsbtBase64: signed.toBase64() })).toThrow(
    expect.objectContaining({ code: 'invalid-signed-transaction' })
  )

  const changedTransaction = Psbt.fromBase64(prepared.psbtBase64)
  changedTransaction.setLocktime(LOCK_TIME + 1)
  changedTransaction.signAllInputs({
    publicKey: source.publicKey,
    sign: hash => Buffer.from(secp256k1.sign(hash, source.privateKey))
  })
  expect(() =>
    finalizeBitcoinPsbt({ prepared, signedPsbtBase64: changedTransaction.toBase64() })
  ).toThrow(expect.objectContaining({ code: 'invalid-signed-transaction' }))
})
