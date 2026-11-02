import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  getZcashChainId
} from '../../../../src/core/chains/registry/index.ts'
import { readZcashPortfolioSource } from '../../../../src/infrastructure/chains/zcash/index.ts'

const chainId = getZcashChainId('mainnet')
const chains = createInitialProductChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('mainnet'))
const chainAccount = {
  id: 'chain-account:zcash:1',
  scope: {
    keyDomainId: 'wallet:1',
    accountId: 'account:1',
    chainId
  },
  derivation: { scheme: 'zip32-unified', path: "m/32'/133'/0'" },
  identity: { kind: 'account-identifier', value: 'u1example' },
  createdAt: 1_000
}

function balance(overrides = {}) {
  return {
    transparent: '0.25',
    shielded: '1.25',
    total: '1.5',
    spendable: '1.2',
    available: '1.1999',
    shieldable: '0.2',
    pending: { shielded: '0.05', transparent: '0.01', total: '0.06' },
    ...overrides
  }
}

function read(overrides = {}) {
  return readZcashPortfolioSource({
    chainId,
    chainAccount,
    chains,
    assets,
    balance: balance(),
    status: 'ready',
    updatedAt: 2_000,
    ...overrides
  })
}

test.describe('Zcash Portfolio source', () => {
  test('converts every V1 ZEC balance facet to exact zatoshis', () => {
    expect(read()).toEqual({
      chainAccount,
      status: 'ready',
      balances: [
        {
          assetId: `${chainId}/slip44:133`,
          totalRaw: '150000000',
          spendableRaw: '120000000',
          availableRaw: '119990000',
          pendingRaw: '6000000',
          shieldableRaw: '20000000',
          shieldedRaw: '125000000',
          transparentRaw: '25000000',
          shieldedPendingRaw: '5000000',
          transparentPendingRaw: '1000000',
          updatedAt: 2_000
        }
      ]
    })
  })

  test('uses safe legacy fallbacks without converting total into available', () => {
    expect(
      read({
        balance: {
          transparent: '0.1',
          shielded: '0.4',
          total: '0.5'
        }
      }).balances[0]
    ).toMatchObject({
      totalRaw: '50000000',
      spendableRaw: '40000000',
      availableRaw: '40000000',
      pendingRaw: '0',
      shieldableRaw: '10000000',
      shieldedRaw: '40000000',
      transparentRaw: '10000000'
    })
  })

  test('does not turn an unknown ZEC balance into a confirmed zero', () => {
    expect(read({ balance: null, status: 'loading' })).toMatchObject({
      status: 'loading',
      balances: []
    })
    expect(
      read({ balance: null, status: 'error', errorCode: 'network-unavailable' })
    ).toMatchObject({
      status: 'error',
      balances: [],
      errorCode: 'network-unavailable'
    })
    expect(() => read({ balance: null, status: 'ready' })).toThrow(/requires a balance/i)
  })

  test('rejects lossy amounts and inconsistent balance facets', () => {
    for (const total of ['1.000000001', '-1', '1e-8', '01', ' 1']) {
      expect(() => read({ balance: balance({ total }) })).toThrow()
    }
    expect(() => read({ balance: balance({ available: '1.3' }) })).toThrow(/inconsistent/i)
    expect(() => read({ updatedAt: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/context/i)
    expect(() => read({ chainId: 'eip155:1' })).toThrow()
  })
})
