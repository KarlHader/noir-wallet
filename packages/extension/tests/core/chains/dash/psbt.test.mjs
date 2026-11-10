import { test } from 'node:test'
import { expect } from '@playwright/test'
import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { initEccLib, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'

import { DASH_CHAIN_IDS } from '../../../../src/core/chains/registry/chain-ids.ts'
import { DASH_P2PKH_DUST_RELAY_BYTES, dashP2pkhDustDuffs } from '../../../../src/infrastructure/chains/dash/config.ts'
import { buildDashPsbt } from '../../../../src/infrastructure/chains/dash/dash-psbt-builder.ts'
import { finalizeDashPsbt } from '../../../../src/infrastructure/chains/dash/dash-psbt-finalizer.ts'
import { dashBitcoinJsNetwork } from '../../../../src/infrastructure/chains/dash/dash-transaction-model.ts'
import { selectDashCoins } from '../../../../src/infrastructure/chains/dash/dash-coin-selection.ts'

initEccLib(secp256k1)

const CHAIN = DASH_CHAIN_IDS.mainnet
const NETWORK = dashBitcoinJsNetwork(CHAIN)
const FEE_RATE = 1000n

function keyPair() {
  const privateKey = Buffer.from('11'.repeat(32), 'hex')
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  return { privateKey, publicKey }
}

function addressFor(publicKey) {
  const address = payments.p2pkh({ pubkey: publicKey, network: NETWORK }).address
  if (!address) throw new Error('missing address')
  return address
}

function funding(script, value) {
  const transaction = new Transaction()
  transaction.version = 2
  transaction.addInput(Buffer.alloc(32, 7), 0)
  transaction.addOutput(script, value)
  return transaction
}

function fixture(value = 100_000) {
  const keys = keyPair()
  const address = addressFor(keys.publicKey)
  const script = payments.p2pkh({ pubkey: keys.publicKey, network: NETWORK }).output
  const previous = funding(script, value)
  const recipient = addressFor(Buffer.from(secp256k1.pointFromScalar(Buffer.from('22'.repeat(32), 'hex'), true)))
  const utxo = {
    chainId: CHAIN,
    accountIndex: 0,
    imported: false,
    change: false,
    addressIndex: 0,
    address,
    derivationPath: "m/44'/5'/0'/0/0",
    publicKey: `0x${keys.publicKey.toString('hex')}`,
    scriptHex: script.toString('hex'),
    transactionId: previous.getId(),
    outputIndex: 0,
    valueDuffs: value.toString(),
    rawTransactionHex: previous.toHex()
  }
  return { keys, address, recipient, utxo, script }
}

function preparedFor() {
  const { keys, recipient, utxo } = fixture()
  const selection = selectDashCoins({
    chainId: CHAIN,
    accountIndex: 0,
    imported: false,
    recipient,
    amount: { mode: 'max' },
    feeRateDuffsPerKb: FEE_RATE.toString(),
    utxos: [utxo]
  })
  const prepared = buildDashPsbt({
    selection,
    masterFingerprint: '0x01020304'
  })
  return { keys, prepared, selection }
}

function sign(prepared, keys) {
  const psbt = Psbt.fromBase64(prepared.psbtBase64, { network: NETWORK })
  psbt.signInput(0, {
    publicKey: keys.publicKey,
    sign: hash => Buffer.from(secp256k1.sign(hash, keys.privateKey))
  })
  return psbt
}

test('Dash PSBT network params are not Bitcoin BIP32 versions', () => {
  expect(NETWORK.pubKeyHash).toBe(76)
  expect(NETWORK.scriptHash).toBe(16)
  expect(NETWORK.wif).toBe(204)
  expect(NETWORK.bip32.public).toBe(0x02fe52cc)
  expect(NETWORK.bip32.private).toBe(0x02fe52f8)
  expect(NETWORK.bip32.public).not.toBe(0x0488b21e)
  const testnet = dashBitcoinJsNetwork(DASH_CHAIN_IDS.testnet)
  expect(testnet.pubKeyHash).toBe(140)
  expect(testnet.scriptHash).toBe(19)
  expect(testnet.wif).toBe(239)
  expect(testnet.bip32.public).toBe(0x3a805837)
  expect(testnet.bip32.private).toBe(0x3a8061b0)
})

test('accepts a classic signed Dash PSBT and rejects substituted funding data', () => {
  const { keys, prepared } = preparedFor()
  const signed = sign(prepared, keys)
  const finalized = finalizeDashPsbt({ prepared, signedPsbtBase64: signed.toBase64() })
  expect(finalized.transactionId).toMatch(/^[0-9a-f]{64}$/)

  const cases = [
    psbt => {
      psbt.data.inputs[0].nonWitnessUtxo = funding(Buffer.alloc(25, 1), 100_000).toBuffer()
    },
    psbt => {
      psbt.data.globalMap.unsignedTx.tx.ins[0].hash = Buffer.alloc(32, 9)
    },
    psbt => {
      const previous = Transaction.fromBuffer(psbt.data.inputs[0].nonWitnessUtxo)
      previous.outs[0].value = 50_000
      psbt.data.inputs[0].nonWitnessUtxo = previous.toBuffer()
    },
    psbt => {
      const previous = Transaction.fromBuffer(psbt.data.inputs[0].nonWitnessUtxo)
      previous.outs[0].script = Buffer.alloc(25, 2)
      psbt.data.inputs[0].nonWitnessUtxo = previous.toBuffer()
    },
    psbt => {
      psbt.data.inputs[0].bip32Derivation[0].path = "m/44'/5'/0'/1/4"
    }
  ]
  for (const tamper of cases) {
    const copy = Psbt.fromBase64(signed.toBase64(), { network: NETWORK })
    tamper(copy)
    expect(() => finalizeDashPsbt({ prepared, signedPsbtBase64: copy.toBase64() })).toThrow()
  }
})

test('dust threshold follows the Dash Core P2PKH relay formula', () => {
  expect(DASH_P2PKH_DUST_RELAY_BYTES).toBe(182n)
  expect(dashP2pkhDustDuffs(1000n)).toBe(182n)
  expect(dashP2pkhDustDuffs(1000n)).not.toBe(546n)
  expect(dashP2pkhDustDuffs(10_000_000n)).toBe(1_820_000n)
  const { utxo, recipient } = fixture(500)
  expect(() =>
    selectDashCoins({
      chainId: CHAIN,
      accountIndex: 0,
      imported: false,
      recipient,
      amount: { mode: 'exact', valueDuffs: '181' },
      feeRateDuffsPerKb: FEE_RATE.toString(),
      utxos: [utxo]
    })
  ).toThrow(/dust/i)
})
