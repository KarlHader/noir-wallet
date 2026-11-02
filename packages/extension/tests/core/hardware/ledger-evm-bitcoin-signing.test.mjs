import assert from 'node:assert/strict'
import { it } from 'node:test'
import { HDKey } from '@scure/bip32'
import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { Buffer } from 'buffer'
import { initEccLib, networks, payments, Psbt, script, Transaction } from 'bitcoinjs-lib'
import {
  deriveLedgerBitcoinAddress,
  ledgerBitcoinAppName,
  assertLedgerBitcoinApp,
  mergeLedgerBitcoinPartialSignature,
  verifyLedgerBitcoinPsbtResponse,
  verifyLedgerBitcoinBip322Signature,
  supportsLedgerBitcoinBip322
} from '../../../src/lib/ledger/bitcoin-model.ts'
import { ledgerBitcoinPsbtSummary } from '../../../src/background/ledger-bitcoin-dapp-review.ts'

const master = HDKey.fromMasterSeed(new Uint8Array(64).fill(3))
const account = master.derive("m/84'/0'/0'")
const child = account.derive('m/0/0')
const fingerprint = Buffer.from(master.fingerprint.toString(16).padStart(8, '0'), 'hex')
const address = deriveLedgerBitcoinAddress(account.publicExtendedKey, 'mainnet', false, 0)
const accountPath = "m/84'/0'/0'"

function toSpend(message) {
  const tagHash = sha256(Buffer.from('BIP0322-signed-message'))
  const digest = sha256(Buffer.concat([tagHash, tagHash, Buffer.from(message)]))
  const transaction = new Transaction()
  transaction.version = 0
  transaction.addInput(
    Buffer.alloc(32),
    0xffffffff,
    0,
    Buffer.concat([Buffer.from([0, 32]), digest])
  )
  transaction.addOutput(Buffer.from(address.scriptPubKey.slice(2), 'hex'), 0)
  return transaction
}

function messagePsbt(message) {
  const psbt = new Psbt({ network: networks.bitcoin })
  psbt.setVersion(0)
  psbt.addInput({
    hash: toSpend(message).getId(),
    index: 0,
    sequence: 0,
    witnessUtxo: { script: Buffer.from(address.scriptPubKey.slice(2), 'hex'), value: 0 },
    bip32Derivation: [
      {
        masterFingerprint: fingerprint,
        path: `${accountPath}/0/0`,
        pubkey: Buffer.from(child.publicKey)
      }
    ]
  })
  psbt.addOutput({ script: script.compile([script.OPS.OP_RETURN]), value: 0 })
  return psbt
}

it('derives the registered Native SegWit child and verifies Ledger-style BIP322 simple witness', () => {
  initEccLib(secp256k1)
  assert.equal(
    address.address,
    payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network: networks.bitcoin }).address
  )
  const message = 'Approve this account'
  const psbt = messagePsbt(message)
  psbt.signInput(0, {
    publicKey: Buffer.from(child.publicKey),
    sign: hash => Buffer.from(secp256k1.sign(hash, child.privateKey))
  })
  psbt.finalizeInput(0)
  const signature = `smp${psbt.data.inputs[0].finalScriptWitness.toString('base64')}`
  const binding = {
    message,
    signature,
    address: address.address,
    publicKey: address.publicKey,
    masterFingerprintHex: fingerprint.toString('hex'),
    accountPath,
    network: 'mainnet'
  }
  assert.equal(verifyLedgerBitcoinBip322Signature(binding), true)
  assert.equal(
    verifyLedgerBitcoinBip322Signature({ ...binding, message: 'Changed message' }),
    false
  )
  assert.equal(verifyLedgerBitcoinBip322Signature({ ...binding, address: 'bc1qinvalid' }), false)
})

it('marks externally owned PSBT inputs for caution and rejects non-default sighash', async () => {
  const psbt = new Psbt({ network: networks.bitcoin })
  for (let index = 0; index < 2; index += 1) {
    psbt.addInput({
      hash: Buffer.alloc(32, index + 1),
      index: 0,
      witnessUtxo: { script: Buffer.from(address.scriptPubKey.slice(2), 'hex'), value: 1000 }
    })
  }
  psbt.addOutput({ address: address.address, value: 1500 })
  const summary = await ledgerBitcoinPsbtSummary({
    chainId: 'bip122:000000000019d6689c085ae165831e93',
    network: 'mainnet',
    signer: address.address,
    psbt,
    ownsInput: async index => index === 0
  })
  assert.equal(summary.schema, 'bitcoin.psbt.v1')
  assert.deepEqual(summary.fields.signingInputIndexes, [0])
  assert.equal(summary.review.level, 'caution')
  psbt.updateInput(0, { sighashType: 3 })
  await assert.rejects(
    () =>
      ledgerBitcoinPsbtSummary({
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        network: 'mainnet',
        signer: address.address,
        psbt,
        ownsInput: async index => index === 0
      }),
    /SIGHASH_ALL/
  )
})

it('requires a released Bitcoin App version with BIP322 PSBT support', () => {
  assert.equal(supportsLedgerBitcoinBip322('2.1.2'), false)
  assert.equal(supportsLedgerBitcoinBip322('2.1.3'), true)
  assert.equal(supportsLedgerBitcoinBip322('2.2.0'), true)
  assert.equal(supportsLedgerBitcoinBip322('3.0.0'), true)
  assert.equal(supportsLedgerBitcoinBip322('2.1.3-rc1'), false)
  assert.equal(supportsLedgerBitcoinBip322('unknown'), false)
})

it('binds Bitcoin App identity to network and accepts the testnet public export', () => {
  assert.equal(ledgerBitcoinAppName('mainnet'), 'Bitcoin')
  assert.equal(ledgerBitcoinAppName('testnet'), 'Bitcoin Test')
  assert.doesNotThrow(() => assertLedgerBitcoinApp('mainnet', 'Bitcoin'))
  assert.doesNotThrow(() => assertLedgerBitcoinApp('testnet', 'Bitcoin Test'))
  assert.throws(() => assertLedgerBitcoinApp('mainnet', 'Bitcoin Test'), /Open the Bitcoin App/)
  assert.throws(() => assertLedgerBitcoinApp('testnet', 'Bitcoin'), /Open the Bitcoin Test App/)
  assert.throws(() => assertLedgerBitcoinApp('testnet', 'BOLOS'), /Open the Bitcoin Test App/)

  const testnetMaster = HDKey.fromMasterSeed(new Uint8Array(64).fill(4), {
    public: 0x043587cf,
    private: 0x04358394
  })
  const testnetAccount = testnetMaster.derive("m/84'/1'/0'")
  assert.match(testnetAccount.publicExtendedKey, /^tpub/)
  const derived = deriveLedgerBitcoinAddress(testnetAccount.publicExtendedKey, 'testnet', false, 0)
  assert.match(derived.address, /^tb1q/)
  assert.equal(
    derived.address,
    payments.p2wpkh({
      pubkey: Buffer.from(testnetAccount.derive('m/0/0').publicKey),
      network: networks.testnet
    }).address
  )
})

function partiallySignedPsbt() {
  initEccLib(secp256k1)
  const external = HDKey.fromMasterSeed(new Uint8Array(64).fill(8)).derive("m/84'/0'/0'/0/0")
  const externalScript = payments.p2wpkh({ pubkey: Buffer.from(external.publicKey) }).output
  const psbt = new Psbt({ network: networks.bitcoin })
  for (let index = 0; index < 3; index += 1) {
    psbt.addInput({
      hash: Buffer.alloc(32, index + 1),
      index: 0,
      witnessUtxo: {
        script: index === 2 ? externalScript : Buffer.from(address.scriptPubKey.slice(2), 'hex'),
        value: 1000
      },
      ...(index === 2
        ? {}
        : {
            bip32Derivation: [
              {
                masterFingerprint: fingerprint,
                path: `${accountPath}/0/0`,
                pubkey: Buffer.from(child.publicKey)
              }
            ]
          })
    })
  }
  psbt.addOutput({ address: address.address, value: 2500 })
  psbt.addUnknownKeyValToInput(2, { key: Buffer.from([0xfc, 1]), value: Buffer.from('external') })
  psbt.signInput(0, {
    publicKey: Buffer.from(child.publicKey),
    sign: hash => Buffer.from(secp256k1.sign(hash, child.privateKey))
  })
  psbt.signInput(2, {
    publicKey: Buffer.from(external.publicKey),
    sign: hash => Buffer.from(secp256k1.sign(hash, external.privateKey))
  })
  return psbt
}

it('preserves an existing owned signature and all external PSBT data while adding the missing signature', () => {
  const original = partiallySignedPsbt()
  const signed = Psbt.fromBase64(original.toBase64(), { network: networks.bitcoin })
  const existing = Buffer.from(signed.data.inputs[0].partialSig[0].signature)
  mergeLedgerBitcoinPartialSignature(signed, 0, Buffer.from(child.publicKey), Buffer.from([1]))
  signed.signInput(1, {
    publicKey: Buffer.from(child.publicKey),
    sign: hash => Buffer.from(secp256k1.sign(hash, child.privateKey))
  })
  const verified = verifyLedgerBitcoinPsbtResponse({
    original,
    signed,
    ownedIndexes: [0, 1],
    masterFingerprintHex: fingerprint.toString('hex'),
    accountPath
  })
  assert.deepEqual(verified.data.inputs[0].partialSig[0].signature, existing)
  assert.deepEqual(verified.data.inputs[2].partialSig, original.data.inputs[2].partialSig)
  assert.deepEqual(verified.data.inputs[2].unknownKeyVals, original.data.inputs[2].unknownKeyVals)
  assert.equal(verified.data.inputs[1].partialSig.length, 1)
})

it('rejects tampering with an existing owned signature or external PSBT data', () => {
  const original = partiallySignedPsbt()
  const signed = Psbt.fromBase64(original.toBase64(), { network: networks.bitcoin })
  signed.signInput(1, {
    publicKey: Buffer.from(child.publicKey),
    sign: hash => Buffer.from(secp256k1.sign(hash, child.privateKey))
  })
  const binding = {
    original,
    signed,
    ownedIndexes: [0, 1],
    masterFingerprintHex: fingerprint.toString('hex'),
    accountPath
  }
  const changedSignature = Buffer.from(signed.data.inputs[0].partialSig[0].signature)
  changedSignature[5] ^= 1
  signed.data.inputs[0].partialSig[0].signature = changedSignature
  assert.throws(() => verifyLedgerBitcoinPsbtResponse(binding), /existing owned signature/)

  signed.data.inputs[0].partialSig[0].signature = Buffer.from(
    original.data.inputs[0].partialSig[0].signature
  )
  signed.data.inputs[2].unknownKeyVals[0].value = Buffer.from('changed')
  assert.throws(() => verifyLedgerBitcoinPsbtResponse(binding), /unapproved fields/)

  const corruptOriginal = partiallySignedPsbt()
  corruptOriginal.data.inputs[0].partialSig[0].signature = Buffer.from([1, 2, 1])
  assert.throws(
    () =>
      mergeLedgerBitcoinPartialSignature(
        corruptOriginal,
        0,
        Buffer.from(child.publicKey),
        Buffer.from([1])
      ),
    /Existing Ledger Bitcoin signature is invalid/
  )

  const unsigned = partiallySignedPsbt()
  delete unsigned.data.inputs[1].partialSig
  const wrongInputSignature = Buffer.from(unsigned.data.inputs[0].partialSig[0].signature)
  assert.throws(
    () =>
      mergeLedgerBitcoinPartialSignature(
        unsigned,
        1,
        Buffer.from(child.publicKey),
        wrongInputSignature
      ),
    /Ledger Bitcoin signature is invalid/
  )
})
