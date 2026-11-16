import { Buffer } from 'node:buffer'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { CryptoPSBT } from '@keystonehq/bc-ur-registry'
import { UR } from '@ngraveio/bc-ur'
import { Psbt, networks } from 'bitcoinjs-lib'
import {
  KEYSTONE_BITCOIN_PSBT_UR_TYPE,
  assertKeystoneSignedBitcoinPsbtMatchesRequest,
  createBitcoinPsbtUREncoder,
  parseSignedBitcoinPsbt
} from '../../../src/lib/keystone/bitcoin-psbt-ur.ts'

function psbtBytes(locktime = 100) {
  const psbt = new Psbt({ network: networks.testnet })
  psbt.setVersion(2)
  psbt.setLocktime(locktime)
  psbt.addInput({
    hash: Buffer.alloc(32, 1),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: {
      script: Buffer.from('001479091972186c449eb1ded22b78e40d009bdf0089', 'hex'),
      value: 10_000
    }
  })
  psbt.addOutput({
    script: Buffer.from('001479091972186c449eb1ded22b78e40d009bdf0089', 'hex'),
    value: 9_000
  })
  return Uint8Array.from(psbt.toBuffer())
}

function cryptoPsbtUr(bytes) {
  const value = new CryptoPSBT(Buffer.from(bytes))
  return new UR(value.toCBOR(), KEYSTONE_BITCOIN_PSBT_UR_TYPE)
}

test.describe('Keystone Bitcoin crypto-psbt adapter', () => {
  test('encodes a strict crypto-psbt request and parses the signed response', () => {
    const requested = psbtBytes()
    const encoder = createBitcoinPsbtUREncoder(requested, 200)
    const decoded = parseSignedBitcoinPsbt(cryptoPsbtUr(requested))

    expect(encoder.nextPart()).toMatch(/^ur:crypto-psbt\//)
    expect(decoded).toEqual(requested)
    expect(() => assertKeystoneSignedBitcoinPsbtMatchesRequest(requested, decoded)).not.toThrow()
  })

  test('rejects wrong UR types, malformed payloads, and changed unsigned transactions', () => {
    const requested = psbtBytes()
    expect(() => parseSignedBitcoinPsbt(new UR(Buffer.from([0x41, 0x00]), 'bytes'))).toThrow(
      /expected crypto-psbt/
    )
    expect(() =>
      parseSignedBitcoinPsbt(new UR(Buffer.from([0x41, 0x00]), KEYSTONE_BITCOIN_PSBT_UR_TYPE))
    ).toThrow('Invalid signed Bitcoin PSBT')
    expect(() => assertKeystoneSignedBitcoinPsbtMatchesRequest(requested, psbtBytes(101))).toThrow(
      'does not match the request'
    )
  })

  test('rejects non-PSBT request bytes and unsafe fragment lengths', () => {
    expect(() => createBitcoinPsbtUREncoder(Uint8Array.from([1, 2, 3]))).toThrow(
      'Invalid unsigned Bitcoin PSBT'
    )
    expect(() => createBitcoinPsbtUREncoder(psbtBytes(), 4)).toThrow(
      'Invalid Bitcoin PSBT QR fragment length'
    )
  })
})
