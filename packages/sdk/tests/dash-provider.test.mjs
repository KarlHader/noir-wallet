import assert from 'node:assert/strict'
import test from 'node:test'

import { getNoirWallet } from '../dist/index.mjs'
import {
  DASH_CHAIN_IDS,
  DASH_UNSUPPORTED_SIGN_MESSAGE,
  detectDashProvider,
  getDashProvider,
  isDashChainId,
  isUnsupportedDashSignMessageError,
  parseDashDuffs
} from '../dist/chains/dash/index.mjs'

const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const ZCASH_MAINNET = 'bip122:00040fe8ec8471911baa1db1266ea15d'

function dashProvider(overrides = {}) {
  return {
    request: async () => null,
    connect: async () => ({ address: 'Xexample', publicKey: '02' }),
    requestAccounts: async () => [],
    getAccounts: async () => [],
    getNetwork: async () => 'mainnet',
    getChain: async () => ({
      chainId: DASH_CHAIN_IDS.mainnet,
      name: 'Dash',
      network: 'mainnet'
    }),
    getPublicKey: async () => '02',
    getBalance: async () => ({ confirmed: '0', unconfirmed: '0', total: '0' }),
    sendDash: async () => 'txid',
    signMessage: async () => 'signature',
    signPsbt: async value => value,
    signPsbts: async values => values,
    pushPsbt: async () => 'txid',
    pushTx: async () => 'txid',
    on() {
      return this
    },
    removeListener() {
      return this
    },
    disconnect: async () => {},
    ...overrides
  }
}

function unsupportedSignMessage() {
  const error = new Error('Dash hardware message signing is unsupported')
  error.code = DASH_UNSUPPORTED_SIGN_MESSAGE
  return error
}

test('detects the complete Dash provider surface without network switching', () => {
  const dash = dashProvider()
  globalThis.window = { noirwallet: { dash } }
  try {
    assert.equal(getDashProvider(), dash)
    assert.equal('switchNetwork' in dash, false)
    assert.equal('switchChain' in dash, false)
    delete dash.pushPsbt
    assert.equal(getDashProvider(), null)
  } finally {
    delete globalThis.window
  }
})

test('does not treat a Bitcoin-shaped provider as Dash', () => {
  globalThis.window = {
    noirwallet: {
      dash: {
        request: async () => null,
        connect: async () => ({ address: 'bc1example', publicKey: '02' }),
        getAccounts: async () => [],
        getNetwork: async () => 'livenet',
        sendBitcoin: async () => 'txid',
        signMessage: async () => 'signature',
        signPsbt: async value => value,
        signPsbts: async values => values,
        pushPsbt: async () => 'txid',
        pushTx: async () => 'txid',
        switchNetwork: async () => null,
        switchChain: async () => null,
        disconnect: async () => {}
      }
    }
  }
  try {
    assert.equal(getDashProvider(), null)
  } finally {
    delete globalThis.window
  }
})

test('exposes Dash only for the two Dash chain ids', () => {
  assert.equal(isDashChainId(DASH_CHAIN_IDS.mainnet), true)
  assert.equal(isDashChainId(DASH_CHAIN_IDS.testnet), true)
  assert.equal(isDashChainId(BITCOIN_MAINNET), false)
  assert.equal(isDashChainId(ZCASH_MAINNET), false)
  assert.equal(isDashChainId('bip122:00000fffffffffffffffffffffffffff'), false)
  assert.equal(isDashChainId('bip122:'), false)
})

test('accepts canonical duff strings and rejects numbers and bigint', () => {
  assert.equal(parseDashDuffs('100000000'), 100_000_000n)
  assert.equal(parseDashDuffs('1200000'), 1_200_000n)
  assert.equal(parseDashDuffs('0'), 0n)
  for (const rejected of [
    '1.5',
    '1.0',
    '0.1',
    '1.',
    '.5',
    '01',
    '-1',
    '1e8',
    '',
    1.5,
    Number.NaN,
    1200000,
    1200000n,
    0
  ]) {
    assert.throws(() => parseDashDuffs(rejected), TypeError)
  }
})

test('keeps an unsupported hardware message signature as an error', async () => {
  const dash = dashProvider({
    signMessage: async () => {
      throw unsupportedSignMessage()
    }
  })
  globalThis.window = { noirwallet: { dash } }
  try {
    await assert.rejects(dash.signMessage('Dash'), error => {
      assert.equal(isUnsupportedDashSignMessageError(error), true)
      assert.equal(error.code, 4200)
      assert.equal(typeof error, 'object')
      assert.notEqual(error, 'signature')
      return true
    })
  } finally {
    delete globalThis.window
  }
})

test('passes the injected Dash provider through getNoirWallet', () => {
  const dash = dashProvider()
  globalThis.window = {
    noirwallet: {
      isNoirWallet: true,
      zcash: {
        request: async () => null,
        on() {},
        disconnect: async () => {}
      },
      dash
    }
  }
  try {
    assert.equal(getNoirWallet()?.dash, dash)
  } finally {
    delete globalThis.window
  }
})

function installWindow(noirwallet) {
  globalThis.window = {
    ...(noirwallet ? { noirwallet } : {}),
    addEventListener() {},
    removeEventListener() {}
  }
}

test('discovers an already injected Dash provider and rejects a missing one', async () => {
  const dash = dashProvider()
  installWindow({ dash })
  try {
    assert.equal(await detectDashProvider(), dash)
  } finally {
    delete globalThis.window
  }

  installWindow()
  try {
    await assert.rejects(detectDashProvider({ timeoutMs: 0 }), /Dash provider was not found/)
  } finally {
    delete globalThis.window
  }

  const signal = AbortSignal.abort()
  installWindow()
  try {
    await assert.rejects(detectDashProvider({ signal }), error => {
      assert.equal(error.name, 'AbortError')
      return true
    })
  } finally {
    delete globalThis.window
  }
})
