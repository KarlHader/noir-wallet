import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../src/core/chains/registry/index.ts'
import {
  createUserEvmAssetCandidate,
  createUserEvmAssetRecord,
  parseUserEvmAssetRecord,
  userEvmAssetToDefinition
} from '../../../src/core/chains/user-assets/index.ts'
import {
  ChromeUserEvmAssetCatalogRepository,
  UserEvmAssetCoordinator,
  getUserEvmAssetCatalogStorageKey,
  parseUserEvmAssetCatalogSnapshot
} from '../../../src/infrastructure/chains/evm/index.ts'

const NOW = Date.parse('2026-08-15T03:00:00.000Z')
const CONTRACT = '0x1111111111111111111111111111111111111111'
const ASSET_ID = `eip155:1/erc20:${CONTRACT}`

function createContext() {
  const chains = createInitialProductChainRegistry('mainnet')
  const bundledAssets = createAssetRegistry(
    chains,
    getBundledInitialProductAssetDefinitions('mainnet')
  )
  return { chains, bundledAssets }
}

function createMemoryRepository() {
  const assets = new Map()
  return {
    assets,
    repository: {
      list: async () => Object.freeze([...assets.values()]),
      get: async assetId => assets.get(assetId) ?? null,
      insert: async asset => {
        if (assets.has(asset.assetId)) throw new Error('This Token is already added')
        assets.set(asset.assetId, asset)
      },
      update: async asset => {
        if (!assets.has(asset.assetId)) throw new Error('This Token is not in the user catalog')
        assets.set(asset.assetId, asset)
      },
      remove: async assetId => assets.delete(assetId)
    }
  }
}

function createMetadataRpc(readMetadata) {
  let readCount = 0
  const stringResult = value => {
    const bytes = new TextEncoder().encode(value)
    const word = number => BigInt(number).toString(16).padStart(64, '0')
    const data = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
    return `0x${word(32)}${word(bytes.length)}${data.padEnd(Math.ceil(bytes.length / 32) * 64, '0')}`
  }
  return {
    get readCount() {
      return readCount
    },
    rpc: {
      assertExpectedChain: async () => {},
      getCode: async () => '0x6001600055',
      callContract: async (_contract, selector) => {
        const metadata = readMetadata(Math.floor(readCount / 3))
        readCount += 1
        if (selector === '0x06fdde03') return stringResult(metadata.name)
        if (selector === '0x95d89b41') return stringResult(metadata.symbol)
        if (selector === '0x313ce567') {
          return `0x${BigInt(metadata.decimals).toString(16).padStart(64, '0')}`
        }
        throw new Error('Unexpected selector')
      }
    }
  }
}

test('normalizes and strictly validates user-approved ERC-20 records', () => {
  const { chains } = createContext()
  const candidate = createUserEvmAssetCandidate(chains, {
    chainId: 'eip155:1',
    contractAddress: CONTRACT.toUpperCase().replace('0X', '0x'),
    metadata: { name: 'Test Token', symbol: 'TEST', decimals: 18 },
    inspectedAt: NOW
  })
  expect(candidate).toMatchObject({
    assetId: ASSET_ID,
    contractAddress: CONTRACT,
    metadata: { name: 'Test Token', symbol: 'TEST', decimals: 18 }
  })
  const record = createUserEvmAssetRecord(chains, candidate, NOW + 1)
  expect(record.source).toBe('user-added')
  expect(parseUserEvmAssetRecord(chains, record)).toEqual(record)
  expect(userEvmAssetToDefinition(record)).toMatchObject({
    chainId: 'eip155:1',
    namespace: 'erc20',
    source: 'user-added',
    verification: 'user-approved'
  })

  expect(() =>
    createUserEvmAssetCandidate(chains, {
      chainId: 'eip155:1',
      contractAddress: CONTRACT,
      metadata: { name: ' Test Token', symbol: 'TEST', decimals: 18 },
      inspectedAt: NOW
    })
  ).toThrow(/asset name/)
  expect(() => parseUserEvmAssetRecord(chains, { ...record, extra: true })).toThrow(/Invalid/)
  const { source: _source, ...legacyRecord } = record
  expect(parseUserEvmAssetRecord(chains, legacyRecord).source).toBe('user-added')
})

test('re-attests metadata on confirmation, persists the Token, and clears its Pool cache on removal', async () => {
  const { chains, bundledAssets } = createContext()
  const catalog = createMemoryRepository()
  const metadataRpc = createMetadataRpc(() => ({
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 18
  }))
  const deletedPoolMappings = []
  const coordinator = new UserEvmAssetCoordinator({
    chains,
    bundledAssets,
    repository: catalog.repository,
    resolveRpc: () => metadataRpc.rpc,
    poolCache: {
      get: async () => null,
      put: async () => {},
      delete: async assetId => deletedPoolMappings.push(assetId)
    },
    now: () => NOW
  })

  const candidate = await coordinator.inspect({
    chainId: 'eip155:1',
    contractAddress: CONTRACT
  })
  await expect(coordinator.add(candidate)).resolves.toMatchObject({
    assetId: ASSET_ID,
    metadata: { symbol: 'TEST', decimals: 18 }
  })
  expect(metadataRpc.readCount).toBe(6)
  await expect(coordinator.list()).resolves.toHaveLength(1)
  await expect(coordinator.add(candidate)).rejects.toThrow(/already added/)

  await expect(coordinator.remove(ASSET_ID)).resolves.toBe(true)
  expect(deletedPoolMappings).toEqual([ASSET_ID])
  await expect(coordinator.list()).resolves.toEqual([])
})

test('rejects built-in Tokens and metadata changes between review and confirmation', async () => {
  const { chains, bundledAssets } = createContext()
  const catalog = createMemoryRepository()
  const metadataRpc = createMetadataRpc(readIndex => ({
    name: 'Test Token',
    symbol: readIndex === 0 ? 'TEST' : 'CHANGED',
    decimals: 18
  }))
  const coordinator = new UserEvmAssetCoordinator({
    chains,
    bundledAssets,
    repository: catalog.repository,
    resolveRpc: () => metadataRpc.rpc,
    now: () => NOW
  })

  await expect(
    coordinator.inspect({
      chainId: 'eip155:1',
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    })
  ).rejects.toThrow(/built into/)
  expect(metadataRpc.readCount).toBe(0)

  const candidate = await coordinator.inspect({
    chainId: 'eip155:1',
    contractAddress: CONTRACT
  })
  await expect(coordinator.add(candidate)).rejects.toThrow(/changed before confirmation/)
  expect(catalog.assets.size).toBe(0)
})

test('enables an Intents Token with one on-chain inspection and reuses the stored record', async () => {
  const { chains, bundledAssets } = createContext()
  const catalog = createMemoryRepository()
  const metadataRpc = createMetadataRpc(() => ({
    name: 'Tether USD',
    symbol: 'USDT',
    decimals: 6
  }))
  const coordinator = new UserEvmAssetCoordinator({
    chains,
    bundledAssets,
    repository: catalog.repository,
    resolveRpc: () => metadataRpc.rpc,
    now: () => NOW
  })
  const iconUrl = 'https://assets.example/usdt.png'

  await expect(
    coordinator.ensure({ chainId: 'eip155:1', contractAddress: CONTRACT, iconUrl })
  ).resolves.toMatchObject({
    assetId: ASSET_ID,
    source: 'intents-catalog',
    metadata: { name: 'Tether USD', symbol: 'USDT', decimals: 6, iconUrl }
  })
  expect(metadataRpc.readCount).toBe(3)

  expect(userEvmAssetToDefinition(catalog.assets.get(ASSET_ID))).toMatchObject({
    source: 'discovered',
    verification: 'unverified'
  })

  await expect(
    coordinator.ensure({ chainId: 'eip155:1', contractAddress: CONTRACT, iconUrl })
  ).resolves.toMatchObject({ assetId: ASSET_ID })
  expect(metadataRpc.readCount).toBe(3)

  await expect(
    coordinator.ensure({
      chainId: 'eip155:1',
      contractAddress: CONTRACT,
      expectedSymbol: 'USDC',
      expectedDecimals: 6
    })
  ).resolves.toMatchObject({
    assetId: ASSET_ID,
    source: 'intents-catalog',
    metadata: { symbol: 'USDT', decimals: 6 }
  })

  await expect(
    coordinator.ensure({
      chainId: 'eip155:1',
      contractAddress: CONTRACT,
      expectedSymbol: 'USDT',
      expectedDecimals: 18
    })
  ).rejects.toThrow('Token decimals do not match the Intents catalog')
})

test('upgrades a legacy matching Token to Intents catalog provenance without another RPC read', async () => {
  const { chains, bundledAssets } = createContext()
  const catalog = createMemoryRepository()
  const metadataRpc = createMetadataRpc(() => ({
    name: 'Tether USD',
    symbol: 'USDT',
    decimals: 6
  }))
  const candidate = createUserEvmAssetCandidate(chains, {
    chainId: 'eip155:1',
    contractAddress: CONTRACT,
    metadata: { name: 'Tether USD', symbol: 'USDT', decimals: 6 },
    inspectedAt: NOW
  })
  catalog.assets.set(ASSET_ID, createUserEvmAssetRecord(chains, candidate, NOW))
  const coordinator = new UserEvmAssetCoordinator({
    chains,
    bundledAssets,
    repository: catalog.repository,
    resolveRpc: () => metadataRpc.rpc,
    now: () => NOW
  })

  await expect(
    coordinator.ensure({
      chainId: 'eip155:1',
      contractAddress: CONTRACT,
      expectedSymbol: 'USDT',
      expectedDecimals: 6
    })
  ).resolves.toMatchObject({ source: 'intents-catalog' })
  expect(catalog.assets.get(ASSET_ID)?.source).toBe('intents-catalog')
  expect(metadataRpc.readCount).toBe(0)
})

test('backfills a discovered icon into an existing manually added Token', async () => {
  const { chains, bundledAssets } = createContext()
  const catalog = createMemoryRepository()
  const record = createUserEvmAssetRecord(
    chains,
    createUserEvmAssetCandidate(chains, {
      chainId: 'eip155:1',
      contractAddress: CONTRACT,
      metadata: { name: 'Test Token', symbol: 'TEST', decimals: 18 },
      inspectedAt: NOW
    }),
    NOW
  )
  await catalog.repository.insert(record)
  const coordinator = new UserEvmAssetCoordinator({
    chains,
    bundledAssets,
    repository: catalog.repository,
    resolveRpc: () => {
      throw new Error('RPC is not needed for icon backfill')
    },
    now: () => NOW
  })
  const iconUrl =
    'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x1111111111111111111111111111111111111111/logo.png'

  await expect(coordinator.backfillIcons(new Map([[ASSET_ID, iconUrl]]))).resolves.toEqual([
    expect.objectContaining({
      metadata: { name: 'Test Token', symbol: 'TEST', decimals: 18, iconUrl }
    })
  ])
  await expect(catalog.repository.get(ASSET_ID)).resolves.toMatchObject({
    metadata: { iconUrl }
  })
})

test('serializes concurrent Chrome catalog writes and isolates mainnet from testnet storage', async () => {
  const previousChrome = globalThis.chrome
  const storage = new Map()
  globalThis.chrome = {
    storage: {
      local: {
        get: async key => ({ ...(storage.has(key) ? { [key]: storage.get(key) } : {}) }),
        set: async values => {
          await Promise.resolve()
          for (const [key, value] of Object.entries(values)) storage.set(key, value)
        },
        remove: async key => storage.delete(key)
      }
    }
  }
  try {
    const { chains } = createContext()
    const repository = new ChromeUserEvmAssetCatalogRepository('mainnet', chains)
    const first = createUserEvmAssetRecord(
      chains,
      createUserEvmAssetCandidate(chains, {
        chainId: 'eip155:1',
        contractAddress: CONTRACT,
        metadata: { name: 'First', symbol: 'ONE', decimals: 18 },
        inspectedAt: NOW
      }),
      NOW
    )
    const secondContract = '0x2222222222222222222222222222222222222222'
    const second = createUserEvmAssetRecord(
      chains,
      createUserEvmAssetCandidate(chains, {
        chainId: 'eip155:1',
        contractAddress: secondContract,
        metadata: { name: 'Second', symbol: 'TWO', decimals: 6 },
        inspectedAt: NOW
      }),
      NOW
    )

    await Promise.all([repository.insert(first), repository.insert(second)])
    await expect(repository.list()).resolves.toEqual([first, second])
    expect(
      parseUserEvmAssetCatalogSnapshot(
        chains,
        storage.get(getUserEvmAssetCatalogStorageKey('mainnet'))
      ).assets
    ).toEqual([first, second])
    expect(storage.has(getUserEvmAssetCatalogStorageKey('testnet'))).toBe(false)
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = previousChrome
  }
})
