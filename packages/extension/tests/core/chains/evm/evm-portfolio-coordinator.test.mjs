import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledEvmAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { EvmPortfolioCoordinator } from '../../../../src/infrastructure/chains/evm/index.ts'

const chains = createEvmBitcoinChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledEvmAssetDefinitions('mainnet'))
const chainAccount = {
  id: 'chain-account:evm:portfolio',
  scope: {
    keyDomainId: 'key-domain:1',
    accountId: 'account:1',
    chainId: 'eip155:1'
  },
  derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
  identity: {
    kind: 'account-identifier',
    value: '0x1111111111111111111111111111111111111111'
  },
  createdAt: 1_000
}
const pointer = {
  schemaVersion: 2,
  generationId: 'metadata:generation:portfolio',
  sourceFingerprint: 'a'.repeat(64),
  committedAt: 1_000
}
const snapshot = {
  manifest: {
    schemaVersion: 2,
    generationId: pointer.generationId,
    status: 'verified',
    sourceFingerprint: pointer.sourceFingerprint,
    createdAt: 1_000,
    verifiedAt: 1_000,
    entityCounts: { keyDomains: 1, accounts: 1, chainAccounts: 1, addresses: 1 },
    activeAccount: { keyDomainId: 'key-domain:1', accountId: 'account:1' }
  },
  keyDomains: [
    {
      id: chainAccount.scope.keyDomainId,
      credentialRef: 'credential-set:evm:portfolio',
      source: { kind: 'software', mnemonicWordCount: 24 },
      displayName: 'Wallet 1',
      createdAt: 1_000
    }
  ],
  accounts: [],
  chainAccounts: [chainAccount],
  addresses: []
}

function storage(overrides = {}) {
  return {
    getActivePointer: async () => pointer,
    getSnapshot: async () => snapshot,
    ...overrides
  }
}

function cache() {
  const values = new Map()
  return {
    get: async (generationId, chainAccountId) =>
      values.get(JSON.stringify([generationId, chainAccountId])) ?? null,
    list: async () => [],
    put: async record => {
      values.set(JSON.stringify([record.generationId, record.source.chainAccount.id]), record)
    },
    deleteByAccountScope: async () => 0,
    deleteGeneration: async () => 0
  }
}

function rpc(onRead = () => {}, overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getNativeBalance: async () => {
      onRead()
      return '1000000000000000000'
    },
    getErc20Balance: async () => '2000000',
    ...overrides
  }
}

test.describe('EVM active Portfolio coordinator', () => {
  test('returns loading without cache, persists refresh, and serves cached balances as fresh', async () => {
    const cacheRepository = cache()
    const coordinator = new EvmPortfolioCoordinator({
      storageRepository: storage(),
      cacheRepository,
      chainId: 'eip155:1',
      chains,
      assets,
      rpc: rpc(),
      now: () => 2_000
    })

    await expect(coordinator.readCachedActive()).resolves.toMatchObject({
      status: 'loading',
      chains: [{ status: 'loading', assets: [] }]
    })
    await expect(coordinator.refreshActive()).resolves.toMatchObject({
      status: 'ready',
      assets: [
        { metadata: { symbol: 'ETH' }, freshness: 'fresh' },
        { metadata: { symbol: 'USDC' }, freshness: 'fresh' }
      ]
    })
    await expect(coordinator.readCachedActive()).resolves.toMatchObject({
      status: 'ready',
      assets: [
        { metadata: { symbol: 'ETH' }, freshness: 'fresh' },
        { metadata: { symbol: 'USDC' }, freshness: 'fresh' }
      ]
    })
  })

  test('preserves cached token balances after a partial refresh and clears the error after recovery', async () => {
    const cacheRepository = cache()
    let refreshedAt = 2_000
    let tokenReadFails = false
    let nativeBalance = '1000000000000000000'
    const coordinator = new EvmPortfolioCoordinator({
      storageRepository: storage(),
      cacheRepository,
      chainId: 'eip155:1',
      chains,
      assets,
      rpc: rpc(() => {}, {
        getNativeBalance: async () => nativeBalance,
        getErc20Balance: async () => {
          if (tokenReadFails) throw new Error('temporary token failure')
          return '2000000'
        }
      }),
      now: () => refreshedAt
    })

    await expect(coordinator.refreshActive()).resolves.toMatchObject({ status: 'ready' })

    refreshedAt = 3_000
    nativeBalance = '1500000000000000000'
    tokenReadFails = true
    const partial = await coordinator.refreshActive()
    expect(partial).toMatchObject({
      status: 'partial',
      chains: [{ status: 'partial', errorCodes: ['unknown'] }]
    })
    expect(partial.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ symbol: 'ETH' }),
          balance: expect.objectContaining({ totalRaw: nativeBalance }),
          updatedAt: 3_000
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ symbol: 'USDC' }),
          balance: expect.objectContaining({ totalRaw: '2000000' }),
          updatedAt: 2_000
        })
      ])
    )

    refreshedAt = 4_000
    tokenReadFails = false
    await expect(coordinator.refreshActive()).resolves.toMatchObject({
      status: 'ready',
      chains: [{ status: 'ready', errorCodes: [] }],
      assets: [
        { metadata: { symbol: 'ETH' }, updatedAt: 4_000 },
        { metadata: { symbol: 'USDC' }, updatedAt: 4_000 }
      ]
    })
  })

  test('deduplicates concurrent refreshes and discards a result after generation switch', async () => {
    let reads = 0
    let activePointer = pointer
    const coordinator = new EvmPortfolioCoordinator({
      storageRepository: storage({ getActivePointer: async () => activePointer }),
      cacheRepository: cache(),
      chainId: 'eip155:1',
      chains,
      assets,
      rpc: rpc(() => {
        reads += 1
        activePointer = { ...pointer, generationId: 'metadata:generation:next' }
      }),
      now: () => 2_000
    })

    const [first, second] = await Promise.all([
      coordinator.refreshActive(),
      coordinator.refreshActive()
    ])
    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(reads).toBe(1)
  })

  test('fails closed on a pointer mismatch and returns null without an active EVM account', async () => {
    const mismatch = new EvmPortfolioCoordinator({
      storageRepository: storage({
        getSnapshot: async () => ({
          ...snapshot,
          manifest: { ...snapshot.manifest, sourceFingerprint: 'b'.repeat(64) }
        })
      }),
      cacheRepository: cache(),
      chainId: 'eip155:1',
      chains,
      assets,
      rpc: rpc()
    })
    await expect(mismatch.readCachedActive()).rejects.toThrow(/does not match/)

    const absent = new EvmPortfolioCoordinator({
      storageRepository: storage({
        getSnapshot: async () => ({ ...snapshot, chainAccounts: [] })
      }),
      cacheRepository: cache(),
      chainId: 'eip155:1',
      chains,
      assets,
      rpc: rpc()
    })
    await expect(absent.readCachedActive()).resolves.toBeNull()
  })

  test('does not query or expose EVM for a hardware Wallet', async () => {
    let reads = 0
    const coordinator = new EvmPortfolioCoordinator({
      storageRepository: storage({
        getSnapshot: async () => ({
          ...snapshot,
          keyDomains: snapshot.keyDomains.map(keyDomain => ({
            ...keyDomain,
            source: {
              kind: 'hardware',
              vendor: 'keystone',
              firmwareProfile: 'cypherpunk',
              capabilities: ['zcash']
            }
          }))
        })
      }),
      cacheRepository: cache(),
      chainId: 'eip155:1',
      chains,
      assets,
      rpc: rpc(() => {
        reads += 1
      })
    })

    await expect(coordinator.readCachedActive()).resolves.toBeNull()
    await expect(coordinator.refreshActive()).resolves.toBeNull()
    expect(reads).toBe(0)
  })
})
