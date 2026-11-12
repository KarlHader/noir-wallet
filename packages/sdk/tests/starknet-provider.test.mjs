import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STARKNET_CHAIN_IDS,
  STARKNET_FELT_CHAIN_IDS,
  STARKNET_WALLET_API_VERSION,
  STARKNET_WALLET_STANDARD_CHAIN_IDS,
  detectStarknetProvider,
  getStarknetProvider
} from '../dist/chains/starknet/index.mjs'
import { getNoirWallet } from '../dist/index.mjs'

function starknetProvider(overrides = {}) {
  return {
    id: 'noirwallet',
    name: 'Noir Wallet',
    version: '2.0.0',
    icon: 'icon',
    request: async () => null,
    on() {},
    off() {},
    ...overrides
  }
}

test('reads the Starknet provider from window.noirwallet.starknet', () => {
  const starknet = starknetProvider()
  globalThis.window = { noirwallet: { isNoirWallet: true, zcash: { request() {}, on() {} }, starknet } }
  try {
    assert.equal(getStarknetProvider(), starknet)
    assert.equal(getNoirWallet().starknet, starknet)
    assert.equal(STARKNET_WALLET_API_VERSION, '0.10.4')
    assert.equal(STARKNET_CHAIN_IDS.mainnet, 'starknet:SN_MAIN')
    assert.equal(STARKNET_CHAIN_IDS.sepolia, 'starknet:SN_SEPOLIA')
    assert.equal(STARKNET_FELT_CHAIN_IDS.mainnet, '0x534e5f4d41494e')
    assert.equal(STARKNET_WALLET_STANDARD_CHAIN_IDS.mainnet, 'starknet:0x534e5f4d41494e')
    assert.equal(STARKNET_WALLET_STANDARD_CHAIN_IDS.sepolia, 'starknet:0x534e5f5345504f4c4941')
  } finally {
    delete globalThis.window
  }
})

test('rejects a Starknet object that is not the Noir provider', () => {
  globalThis.window = {
    noirwallet: {
      starknet: { id: 'other', request() {}, on() {}, off() {} }
    }
  }
  try {
    assert.equal(getStarknetProvider(), null)
  } finally {
    delete globalThis.window
  }
})

test('detectStarknetProvider resolves a provider that is already injected', async () => {
  const starknet = starknetProvider()
  globalThis.window = {
    noirwallet: { starknet },
    addEventListener() {},
    removeEventListener() {}
  }
  try {
    assert.equal(await detectStarknetProvider({ timeoutMs: 0 }), starknet)
  } finally {
    delete globalThis.window
  }
})
