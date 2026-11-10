import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'buffer'
import { payments, Psbt, Transaction } from 'bitcoinjs-lib'

import { DASH_CHAIN_IDS } from '../../../../src/core/chains/registry/chain-ids.ts'
import { hardwareCapabilitiesForNetwork } from '../../../../src/core/keyring/domain/hardware-credential.ts'
import { secp256k1 } from '@noble/curves/secp256k1'

import {
  assertDashHardwareMainnet,
  assertDashHardwareSignedTransactionMatchesReview,
  assertDashLedgerMessageSignature,
  assertLedgerDashDeviceSupported,
  dashMainnetPaymentNetwork,
  dashSignedMessageDigest,
  encodeLedgerDashMessageSignature,
  rejectDashHardwareMessageSigning
} from '../../../../src/lib/ledger/dash-model.ts'

function reviewedTransfer() {
  const network = dashMainnetPaymentNetwork()
  const pubkey = Buffer.from(`02${'11'.repeat(32)}`, 'hex')
  const output = payments.p2pkh({ pubkey, network }).output
  if (!output) throw new Error('fixture output missing')
  const previous = new Transaction()
  previous.version = 2
  previous.addInput(Buffer.alloc(32, 3), 1)
  previous.addOutput(output, 100_000)
  const review = new Psbt({ network })
  review.addInput({
    hash: previous.getHash(),
    index: 0,
    sequence: 0xfffffffe,
    nonWitnessUtxo: previous.toBuffer()
  })
  review.addOutput({ script: output, value: 60_000 })
  review.addOutput({ script: output, value: 39_000 })
  const signed = Transaction.fromBuffer(review.data.globalMap.unsignedTx.toBuffer())
  signed.ins[0].script = Buffer.from([0x47])
  return {
    review: review.toBase64(),
    signed: signed.toHex(),
    chainId: DASH_CHAIN_IDS.mainnet
  }
}

function mutate(hex, change) {
  const transaction = Transaction.fromHex(hex)
  change(transaction)
  return transaction.toHex()
}

test('Dash hardware accepts a signed transaction that matches the reviewed PSBT', () => {
  const fixture = reviewedTransfer()
  assert.doesNotThrow(() =>
    assertDashHardwareSignedTransactionMatchesReview(fixture.review, fixture.signed, fixture.chainId)
  )
})

test('Dash hardware rejects a signed transaction with a tampered input', () => {
  const fixture = reviewedTransfer()
  const signed = mutate(fixture.signed, transaction => {
    transaction.ins[0].index = 1
  })
  assert.throws(
    () => assertDashHardwareSignedTransactionMatchesReview(fixture.review, signed, fixture.chainId),
    /Dash hardware signature inputs do not match the review/
  )
})

test('Dash hardware rejects a signed transaction with a tampered output', () => {
  const fixture = reviewedTransfer()
  const signed = mutate(fixture.signed, transaction => {
    transaction.outs[0].script = Buffer.from('6a', 'hex')
  })
  assert.throws(
    () => assertDashHardwareSignedTransactionMatchesReview(fixture.review, signed, fixture.chainId),
    /Dash hardware signature outputs do not match the review/
  )
})

test('Dash hardware rejects a signed transaction with a tampered fee', () => {
  const fixture = reviewedTransfer()
  const signed = mutate(fixture.signed, transaction => {
    transaction.outs[0].value = 59_000
  })
  assert.throws(
    () => assertDashHardwareSignedTransactionMatchesReview(fixture.review, signed, fixture.chainId),
    /Dash hardware signature fee does not match the review/
  )
})

test('Dash hardware rejects a non-mainnet chain and testnet hardware capabilities', () => {
  const fixture = reviewedTransfer()
  assert.throws(
    () =>
      assertDashHardwareSignedTransactionMatchesReview(
        fixture.review,
        fixture.signed,
        DASH_CHAIN_IDS.testnet
      ),
    /Dash hardware wallets support mainnet only/
  )
  assert.throws(
    () => assertDashHardwareMainnet('bip122:000000000019d6689c085ae165831e93'),
    /Dash hardware wallets support mainnet only/
  )
  assert.deepEqual(hardwareCapabilitiesForNetwork(['bitcoin', 'dash'], 'testnet'), ['bitcoin'])
  assert.deepEqual(hardwareCapabilitiesForNetwork(['bitcoin', 'dash'], 'mainnet'), [
    'bitcoin',
    'dash'
  ])
  assert.throws(
    () => hardwareCapabilitiesForNetwork(['dash'], 'testnet'),
    /Dash hardware wallets support mainnet only/
  )
})

test('Dash hardware message signing is unsupported', () => {
  assert.throws(
    () => rejectDashHardwareMessageSigning(),
    /Dash hardware message signing is unsupported/
  )
})

test('Dash message digest matches Dash Core for the DarkCoin prefix', () => {
  assert.equal(
    Buffer.from(dashSignedMessageDigest('test')).reverse().toString('hex'),
    '9534c129a0eec7aaec6b6145d5014c2867d573f23a9827089ff09d5c357597dc'
  )
})

test('Ledger Dash message signature decodes to header, r, and s and verifies', () => {
  const message = 'Hello Noir Dash'
  const secret = secp256k1.utils.randomPrivateKey()
  const signed = secp256k1.sign(dashSignedMessageDigest(message), secret)
  const compact = signed.toCompactHex()
  const signature = encodeLedgerDashMessageSignature(
    signed.recovery,
    compact.slice(0, 64).replace(/^00/, ''),
    compact.slice(64).replace(/^00/, '')
  )
  const decoded = Buffer.from(signature, 'base64')
  const address = payments.p2pkh({
    pubkey: Buffer.from(secp256k1.getPublicKey(secret, true)),
    network: dashMainnetPaymentNetwork()
  }).address
  assert.equal(decoded.length, 65)
  assert.equal(decoded[0] - 31, signed.recovery)
  assert.equal(decoded.subarray(1, 33).toString('hex'), compact.slice(0, 64))
  assert.equal(decoded.subarray(33).toString('hex'), compact.slice(64))
  assert.doesNotThrow(() => assertDashLedgerMessageSignature(address, message, signature))
  assert.throws(
    () => assertDashLedgerMessageSignature(address, 'other message', signature),
    /Ledger Dash signature does not match the approved message/
  )
})

test('unknown Ledger models are not supported for the Dash app', () => {
  assert.throws(
    () => assertLedgerDashDeviceSupported('stax'),
    /This Ledger model is not supported for the Dash app/
  )
  assert.throws(
    () => assertLedgerDashDeviceSupported('flex'),
    /This Ledger model is not supported for the Dash app/
  )
  assert.doesNotThrow(() => assertLedgerDashDeviceSupported('nanoX'))
})
