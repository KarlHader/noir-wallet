import { afterEach, test } from 'node:test'
import { expect } from '@playwright/test'
import { Buffer } from 'buffer'
import { UR } from '@ngraveio/bc-ur'
import { keccak256, numberToHex, serializeTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  KEYSTONE_ETHEREUM_SIGN_REQUEST_UR_TYPE,
  createKeystoneEthereumSignRequest,
  createKeystoneEthereumSignRequestUREncoder,
  parseKeystoneEthereumSignature,
  parseKeystoneEthereumSignatureCborBase64
} from '../../../src/lib/keystone/index.ts'
import {
  cancelAllKeystoneEvmSigning,
  getKeystoneEvmSigningRequest,
  registerKeystoneEvmSigningTabLifecycle,
  requestKeystoneEvmPersonalSignature,
  requestKeystoneEvmTransactionSignature,
  submitKeystoneEvmSigningResponse
} from '../../../src/background/keystone-evm-message-signing.ts'

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

test.describe('Keystone signature-only session', () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
  const otherAccount = privateKeyToAccount(`0x${'22'.repeat(32)}`)
  const messageHex = '0x0068656c6c6fff'
  const accountBinding = {
    address: account.address,
    derivationPath: "m/44'/60'/0'/0/0",
    masterFingerprintHex: 'e9181cf3'
  }
  let nextTabId = 10
  let tabOpened
  let tabRemoved

  async function begin(request, overrides = {}) {
    const opened = new Promise(resolve => {
      tabOpened = resolve
    })
    const requestSignature =
      request.kind === 'personal-sign'
        ? requestKeystoneEvmPersonalSignature
        : requestKeystoneEvmTransactionSignature
    const result = requestSignature(
      { ...accountBinding, ...request },
      {
        scope: { chainId: 'eip155:1' },
        expiresAt: Date.now() + 5_000,
        payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
        validate: async () => {},
        ...overrides
      }
    )
    void result.catch(() => {})
    const { tabId, url } = await Promise.race([opened, result])
    const id = new URLSearchParams(new URL(url).hash.split('?')[1]).get('requestId')
    return { id, tabId, result }
  }

  async function submit(session, signature, id = session.id) {
    const ur = await signatureUr({ requestId: id, signatureHex: signature.slice(2) })
    await submitKeystoneEvmSigningResponse(session.id, session.tabId, ur.cbor.toString('base64'))
  }

  globalThis.chrome = {
    tabs: {
      async create() {
        return { id: nextTabId++ }
      },
      async update(tabId, { url }) {
        tabOpened({ tabId, url })
      },
      async remove(tabId) {
        tabRemoved(tabId)
      },
      onRemoved: {
        addListener(listener) {
          tabRemoved = listener
        }
      }
    },
    runtime: {
      getURL: path => `chrome-extension://wallet/${path}`,
      sendMessage: async () => {}
    }
  }
  registerKeystoneEvmSigningTabLifecycle()
  afterEach(() => cancelAllKeystoneEvmSigning('Test cleanup'))

  test('encodes the exact personal message and resolves a tab-bound signature once', async () => {
    const session = await begin({ kind: 'personal-sign', messageHex })
    await expect(getKeystoneEvmSigningRequest(session.id, session.tabId + 1)).rejects.toThrow(/tab/)
    const view = await getKeystoneEvmSigningRequest(session.id, session.tabId)
    const { CryptoKeypath, extend } = await registry()
    const data = extend.decodeToDataItem(Buffer.from(view.request.value, 'base64')).getData()
    expect(data[3]).toBe(3)
    expect(`0x${data[2].toString('hex')}`).toBe(messageHex)
    const keypath = CryptoKeypath.fromDataItem(data[5])
    expect(keypath.getSourceFingerprint().toString('hex')).toBe(accountBinding.masterFingerprintHex)
    expect(`m/${keypath.getPath()}`).toBe(accountBinding.derivationPath)
    const signature = await account.signMessage({ message: { raw: messageHex } })
    const ur = await signatureUr({ requestId: session.id, signatureHex: signature.slice(2) })
    const cbor = ur.cbor.toString('base64')
    await expect(
      submitKeystoneEvmSigningResponse(session.id, session.tabId + 1, cbor)
    ).rejects.toThrow(/tab/)
    await submitKeystoneEvmSigningResponse(session.id, session.tabId, cbor)
    await expect(session.result).resolves.toEqual({ signatureHex: signature })
    await expect(submitKeystoneEvmSigningResponse(session.id, session.tabId, cbor)).rejects.toThrow(
      /interrupted/
    )
  })

  test('rejects signatures for a different message, address, request, or changed account', async () => {
    const message = { raw: messageHex }
    const signature = await account.signMessage({ message })
    for (const scenario of [
      {
        signature: await account.signMessage({ message: { raw: '0x6869' } }),
        error: /approved payload/
      },
      { signature: await otherAccount.signMessage({ message }), error: /approved payload/ },
      { signature, id: requestId, error: /request ID/ },
      { signature: `0x${'00'.repeat(64)}1b`, error: /verify/ },
      { signature, revoke: true, error: /verify/ }
    ]) {
      let allowed = true
      const session = await begin(
        { kind: 'personal-sign', messageHex },
        {
          validate: async () => {
            if (!allowed) throw new Error('Account changed')
          }
        }
      )
      allowed = !scenario.revoke
      await expect(submit(session, scenario.signature, scenario.id)).rejects.toThrow(scenario.error)
      await expect(session.result).rejects.toThrow(scenario.error)
    }
  })

  test('returns normalized signatures for the exact EIP-1559 and legacy transactions', async () => {
    const legacyChainId = 137
    const legacyUnsigned = serializeTransaction({
      type: 'legacy',
      chainId: legacyChainId,
      nonce: 7,
      gasPrice: 1n,
      gas: 21000n,
      to: account.address,
      value: 123n
    })
    for (const { unsigned, type, chainId } of [
      { unsigned: unsignedTransactionHex, type: 4, chainId: 1 },
      { unsigned: legacyUnsigned, type: 1, chainId: legacyChainId }
    ]) {
      const request = { kind: 'transaction', unsignedTransactionHex: unsigned }
      const binding = { scope: { chainId: `eip155:${chainId}` } }
      const signed = await account.sign({ hash: keccak256(unsigned) })
      const parity = Number.parseInt(signed.slice(-2), 16) - 27
      const normalized = `${signed.slice(0, -2)}0${parity}`
      const recovery = type === 4 ? parity : 2 * chainId + 35 + parity
      const deviceSignature = `${signed.slice(0, -2)}${numberToHex(recovery, { size: type === 4 ? 1 : 2 }).slice(2)}`
      const session = await begin(request, binding)
      const view = await getKeystoneEvmSigningRequest(session.id, session.tabId)
      const { extend } = await registry()
      const data = extend.decodeToDataItem(Buffer.from(view.request.value, 'base64')).getData()
      expect(data[3]).toBe(type)
      expect(data[4]).toBe(chainId)
      expect(`0x${data[2].toString('hex')}`).toBe(unsigned)
      await submit(session, deviceSignature)
      await expect(session.result).resolves.toEqual({ signatureHex: normalized })

      const wrongPayload = await begin(request, binding)
      const wrongSignature = await account.signMessage({ message: { raw: unsigned } })
      await expect(
        submit(wrongPayload, `${wrongSignature.slice(0, -2)}${deviceSignature.slice(130)}`)
      ).rejects.toThrow(/approved payload/)
      await expect(wrongPayload.result).rejects.toThrow(/approved payload/)
    }
  })

  test('tab closure invalidates a pending signature', async () => {
    const session = await begin({ kind: 'personal-sign', messageHex })
    tabRemoved(session.tabId)
    await expect(session.result).rejects.toThrow(/closed/)
    await expect(getKeystoneEvmSigningRequest(session.id, session.tabId)).rejects.toThrow(
      /interrupted/
    )
  })

  test('rejects a matching signature after the reviewed deadline', async context => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
    const signature = await account.signMessage({ message: { raw: messageHex } })
    const session = await begin(
      { kind: 'personal-sign', messageHex },
      { expiresAt: Date.now() + 10 }
    )
    context.mock.timers.tick(10)
    await expect(session.result).rejects.toThrow(/expired/)
    await expect(submit(session, signature)).rejects.toThrow(/interrupted/)
  })
})
