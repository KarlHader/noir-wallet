import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { initEccLib, payments, Psbt } from 'bitcoinjs-lib'

import { attachPearlOwnedInputOrigins } from '../../../../src/infrastructure/chains/pearl/pearl-psbt-key-origins.ts'
import { PEARL_BITCOINJS_TESTNET } from '../../../../src/infrastructure/chains/pearl/pearl-network.ts'

initEccLib(secp256k1)

const TESTNET = 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
const MASTER_FINGERPRINT = '0x01020304'
const PATH = "m/86'/1'/0'/0/0"

function keyMaterial(privateKeyDigit) {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = privateKeyDigit
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const payment = payments.p2tr({
    internalPubkey: publicKey.subarray(1),
    network: PEARL_BITCOINJS_TESTNET
  })
  if (!payment.address || !payment.output) throw new Error('Unable to derive Pearl test address')
  return {
    publicKey: `0x${publicKey.toString('hex')}`,
    address: payment.address,
    scriptPubKey: `0x${payment.output.toString('hex')}`,
    internalPubkey: publicKey.subarray(1),
    output: payment.output
  }
}

test('attaches BIP-86 origins to owned Pearl inputs and change outputs', () => {
  const source = keyMaterial(42)
  const recipient = keyMaterial(43)
  const draft = new Psbt({ network: PEARL_BITCOINJS_TESTNET })
  draft.setVersion(2)
  draft.addInput({
    hash: Buffer.alloc(32, 7),
    index: 1,
    sequence: 0xfffffffd,
    witnessUtxo: { script: source.output, value: 20_000 },
    tapInternalKey: source.internalPubkey
  })
  draft.addOutput({ address: recipient.address, value: 5_000 })
  draft.addOutput({ address: source.address, value: 14_500 })

  const enriched = Psbt.fromHex(
    attachPearlOwnedInputOrigins(
      draft.toHex(),
      {
        chainId: TESTNET,
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        address: source.address,
        addressScheme: 'pearl_p2tr',
        derivationScheme: 'bip86',
        derivationPath: PATH,
        publicKey: source.publicKey,
        masterFingerprint: MASTER_FINGERPRINT,
        scriptPubKey: source.scriptPubKey
      },
      TESTNET
    ),
    { network: PEARL_BITCOINJS_TESTNET }
  )

  expect(enriched.data.inputs[0].tapBip32Derivation).toEqual([
    expect.objectContaining({
      path: PATH,
      masterFingerprint: Buffer.from('01020304', 'hex'),
      pubkey: source.internalPubkey,
      leafHashes: []
    })
  ])
  expect(enriched.data.outputs[0].tapBip32Derivation).toBeUndefined()
  expect(enriched.data.outputs[1].tapBip32Derivation).toEqual([
    expect.objectContaining({
      path: PATH,
      masterFingerprint: Buffer.from('01020304', 'hex'),
      pubkey: source.internalPubkey,
      leafHashes: []
    })
  ])
  expect(enriched.data.outputs[1].tapInternalKey).toEqual(source.internalPubkey)
})
