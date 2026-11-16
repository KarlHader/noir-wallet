import { test } from 'node:test'
import { expect } from '@playwright/test'
import { Buffer } from 'buffer'
import { UR } from '@ngraveio/bc-ur'

import {
  KEYSTONE_ETHEREUM_SIGN_REQUEST_UR_TYPE,
  createKeystoneEthereumSignRequest,
  createKeystoneEthereumSignRequestUREncoder,
  parseKeystoneEthereumSignature,
  parseKeystoneEthereumSignatureCborBase64
} from '../../../src/lib/keystone/index.ts'

const requestId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const unsignedTransactionHex =
  '0x02e80107843b9aca0085012a05f2008252089422222222222222222222222222222222222222227b80c0'

async function registry() {
  return import('@keystonehq/bc-ur-registry')
}

async function signatureUr(overrides = {}) {
  const { DataItem, extend } = await registry()
  const id = Buffer.from((overrides.requestId ?? requestId).replaceAll('-', ''), 'hex')
  const signature = Buffer.from(
    overrides.signatureHex ?? `${'11'.repeat(32)}${'22'.repeat(32)}01`,
    'hex'
  )
  const map = {
    1: new DataItem(id, extend.RegistryTypes.UUID.getTag()),
    2: signature,
    3: 'Keystone'
  }
  const cbor = Buffer.from(extend.encodeDataItem(new DataItem(map)))
  return new UR(cbor, overrides.type ?? 'eth-signature')
}

test.describe('Keystone Ethereum UR protocol', () => {
  test('encodes the official eth-sign-request schema with exact account bindings', async () => {
    const value = createKeystoneEthereumSignRequest({
      requestId,
      unsignedTransactionHex,
      chainId: 1,
      derivationPath: "m/44'/60'/0'/0/0",
      masterFingerprintHex: 'e9181cf3',
      address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'
    })
    const { CryptoKeypath, DataItem, extend } = await registry()
    const decoded = extend.decodeToDataItem(Buffer.from(value.cborBase64, 'base64')).getData()
    expect(Object.keys(decoded).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(decoded[1]).toBeInstanceOf(DataItem)
    expect(decoded[1].getTag()).toBe(extend.RegistryTypes.UUID.getTag())
    expect(Buffer.from(decoded[1].getData()).toString('hex')).toBe(requestId.replaceAll('-', ''))
    expect(Buffer.from(decoded[2]).toString('hex')).toBe(unsignedTransactionHex.slice(2))
    expect(decoded[3]).toBe(4)
    expect(decoded[4]).toBe(1)
    expect(CryptoKeypath.fromDataItem(decoded[5]).getPath()).toBe("44'/60'/0'/0/0")
    expect(
      Buffer.from(CryptoKeypath.fromDataItem(decoded[5]).getSourceFingerprint()).toString('hex')
    ).toBe('e9181cf3')
    expect(Buffer.from(decoded[6]).toString('hex')).toBe('7e5f4552091a69125d5dfcb7b8c2659029395bdf')
    expect(decoded[7]).toBe('Noir Wallet')

    const encoder = createKeystoneEthereumSignRequestUREncoder(
      new Uint8Array(Buffer.from(value.cborBase64, 'base64'))
    )
    expect(encoder.nextPart().toLowerCase()).toContain(
      `ur:${KEYSTONE_ETHEREUM_SIGN_REQUEST_UR_TYPE}/`
    )
  })

  test('requires a UUID-bound 65-byte low-level firmware signature envelope', async () => {
    const ur = await signatureUr()
    expect(parseKeystoneEthereumSignature(ur)).toEqual({
      requestId,
      signatureHex: `0x${'11'.repeat(32)}${'22'.repeat(32)}01`,
      origin: 'Keystone'
    })
    expect(
      parseKeystoneEthereumSignatureCborBase64(Buffer.from(ur.cbor).toString('base64'))
    ).toEqual(parseKeystoneEthereumSignature(ur))

    await expect(async () =>
      parseKeystoneEthereumSignature(
        await signatureUr({ signatureHex: `${'11'.repeat(32)}${'22'.repeat(32)}1b` })
      )
    ).rejects.toThrow(/recovery ID/)
    await expect(async () =>
      parseKeystoneEthereumSignature(await signatureUr({ type: 'crypto-psbt' }))
    ).rejects.toThrow(/expected eth-signature/)
  })

  test('rejects noncanonical request IDs, paths, addresses, and transaction envelopes', () => {
    const base = {
      requestId,
      unsignedTransactionHex,
      chainId: 1,
      derivationPath: "m/44'/60'/0'/0/0",
      masterFingerprintHex: 'e9181cf3',
      address: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
    }
    for (const input of [
      { ...base, requestId: 'request-1' },
      { ...base, unsignedTransactionHex: '0xf86c' },
      { ...base, chainId: 0 },
      { ...base, derivationPath: "m/44'/60'/0'/0/*" },
      { ...base, masterFingerprintHex: 'e918' },
      { ...base, address: '0x1234' }
    ]) {
      expect(() => createKeystoneEthereumSignRequest(input)).toThrow()
    }
  })
})
