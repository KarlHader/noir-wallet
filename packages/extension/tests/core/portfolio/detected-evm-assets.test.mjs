import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createInitialProductChainRegistry } from '../../../src/core/chains/registry/index.ts'
import {
  createDetectedEvmAssetRecord,
  detectedEvmAssetToDefinition,
  parseDetectedEvmAssetRecord
} from '../../../src/core/chains/user-assets/index.ts'
import {
  ChromeDetectedEvmAssetCatalogRepository,
  DetectedEvmAssetCoordinator,
  EvmTokenDiscoveryClient,
  getDetectedEvmAssetCatalogStorageKey
} from '../../../src/infrastructure/chains/evm/index.ts'
import { EvmTokenDiscoverySchedule } from '../../../src/infrastructure/chains/evm/evm-token-discovery-schedule.ts'
import {
  ChromeTokenVisibilityRepository,
  getTokenVisibilityStorageKey
} from '../../../src/infrastructure/portfolio/chrome-token-visibility.ts'

const NOW = 1_800_000_000_000
const ADDRESS = `0x${'1'.repeat(40)}`
const CONTRACT = `0x${'2'.repeat(40)}`
const ASSET_ID = `eip155:1/erc20:${CONTRACT}`

function memoryChrome() {
  const storage = new Map()
  return {
    storage,
    chrome: {
      storage: {
        local: {
          get: async key => {
            const keys = Array.isArray(key) ? key : [key]
            return Object.fromEntries(
              keys
                .filter(candidate => storage.has(candidate))
                .map(candidate => [candidate, storage.get(candidate)])
            )
          },
          set: async values => {
            for (const [key, value] of Object.entries(values)) storage.set(key, value)
          },
          remove: async key => {
            for (const candidate of Array.isArray(key) ? key : [key]) storage.delete(candidate)
          }
        }
      }
    }
  }
}

function memoryDiscoverySession() {
  const values = new Map()
  return {
    get: async key => ({ [key]: structuredClone(values.get(key)) }),
    set: async update => {
      for (const [key, value] of Object.entries(update)) values.set(key, structuredClone(value))
    }
  }
}

test('strictly represents auto-detected Tokens without promoting them to trusted assets', () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const record = createDetectedEvmAssetRecord(chains, {
    chainId: 'eip155:1',
    contractAddress: CONTRACT,
    metadata: { name: 'Tether USD', symbol: 'USDT', decimals: 6 },
    detectedAt: NOW,
    lastSeenAt: NOW
  })
  expect(parseDetectedEvmAssetRecord(chains, record)).toEqual(record)
  expect(detectedEvmAssetToDefinition(record)).toMatchObject({
    source: 'discovered',
    verification: 'unverified',
    reference: CONTRACT
  })
  expect(() => parseDetectedEvmAssetRecord(chains, { ...record, lastSeenAt: NOW - 1 })).toThrow(
    /timestamps/
  )
})

test('strictly parses the credential-free discovery proxy response', async () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const requests = []
  const client = new EvmTokenDiscoveryClient({
    chains,
    origin: 'https://history.example',
    fetch: async input => {
      requests.push(String(input))
      return new Response(
        JSON.stringify({
          version: 1,
          partial: false,
          assets: [
            {
              chainId: 'eip155:1',
              contractAddress: CONTRACT,
              balanceRawInteger: '1000000',
              metadata: {
                name: 'Ignored Hint',
                symbol: 'USDT',
                decimals: 6,
                iconUrl:
                  'https://history.example/token-icon?source=https%3A%2F%2Fassets-cdn.trustwallet.com%2Fblockchains%2Fethereum%2Fassets%2Ftoken%2Flogo.png'
              }
            }
          ]
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
  })
  await expect(client.discover(ADDRESS, ['eip155:1'])).resolves.toEqual([
    {
      assetId: ASSET_ID,
      chainId: 'eip155:1',
      contractAddress: CONTRACT,
      iconUrl:
        'https://history.example/token-icon?source=https%3A%2F%2Fassets-cdn.trustwallet.com%2Fblockchains%2Fethereum%2Fassets%2Ftoken%2Flogo.png'
    }
  ])
  expect(requests).toEqual([`https://history.example/balances?address=${ADDRESS}&chainIds=1`])
})

test('manual discovery joins an in-flight request but bypasses the persisted automatic cooldown', async () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const session = memoryDiscoverySession()
  const record = createDetectedEvmAssetRecord(chains, {
    chainId: 'eip155:1',
    contractAddress: CONTRACT,
    metadata: { name: 'Example Token', symbol: 'EXT', decimals: 18 },
    detectedAt: NOW,
    lastSeenAt: NOW
  })
  const firstRequest = Promise.withResolvers()
  let discoveryRequests = 0
  const options = {
    chains,
    repository: {
      list: async () => [record],
      upsert: async () => false
    },
    discovery: {
      available: true,
      discover: async () => {
        discoveryRequests++
        if (discoveryRequests === 1) await firstRequest.promise
        return [
          {
            assetId: ASSET_ID,
            chainId: 'eip155:1',
            contractAddress: CONTRACT
          }
        ]
      }
    },
    resolveRpc: () => {
      throw new Error('Existing Token metadata must not be queried again')
    },
    now: () => NOW
  }
  const schedule = new EvmTokenDiscoverySchedule('mainnet', session)
  const coordinator = new DetectedEvmAssetCoordinator({ ...options, schedule })
  const reconfigured = new DetectedEvmAssetCoordinator({ ...options, schedule })
  const target = { address: ADDRESS, chainIds: ['eip155:1', 'eip155:137'] }
  const automatic = coordinator.refresh([target])
  const concurrentManual = reconfigured.refresh(
    [{ ...target, chainIds: [...target.chainIds].reverse() }],
    { force: true }
  )
  firstRequest.resolve()
  await Promise.all([automatic, concurrentManual])
  expect(discoveryRequests).toBe(1)

  const restarted = new DetectedEvmAssetCoordinator({
    ...options,
    schedule: new EvmTokenDiscoverySchedule('mainnet', session)
  })
  await restarted.refresh([target])
  expect(discoveryRequests).toBe(1)
  await Promise.all([restarted.refresh([target]), restarted.refresh([target], { force: true })])
  expect(discoveryRequests).toBe(2)
})

test('waits three minutes after each failed discovery and returns to one minute on success', async () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const session = memoryDiscoverySession()
  const target = { address: ADDRESS, chainIds: ['eip155:1'] }
  const requests = []
  const minute = 60_000
  let now = NOW
  let unavailable = true
  const createCoordinator = () =>
    new DetectedEvmAssetCoordinator({
      chains,
      repository: { list: async () => [], upsert: async () => false },
      discovery: {
        available: true,
        discover: async (_address, chainIds) => {
          requests.push(chainIds)
          if (unavailable) {
            now += 10_000
            throw new Error('Discovery timed out')
          }
          return []
        }
      },
      schedule: new EvmTokenDiscoverySchedule('mainnet', session, () => now),
      resolveRpc: () => {
        throw new Error('No candidate metadata is needed')
      },
      now: () => now
    })

  await createCoordinator().refresh([target])
  const restarted = createCoordinator()
  now += 3 * minute - 1
  await restarted.refresh([target])
  expect(requests).toEqual([['eip155:1']])
  now += 1
  await restarted.refresh([target])
  await restarted.refresh([{ ...target, chainIds: ['eip155:137'] }])
  expect(requests).toEqual([['eip155:1'], ['eip155:1'], ['eip155:137']])

  now += 3 * minute - 10_000 - 1
  await restarted.refresh([target])
  expect(requests).toHaveLength(3)
  now += 1
  unavailable = false
  await restarted.refresh([target])
  expect(requests).toHaveLength(4)

  now += minute - 1
  await restarted.refresh([target])
  expect(requests).toHaveLength(4)
  now += 1
  await restarted.refresh([target])
  expect(requests).toHaveLength(5)
})

test('uses the Four.Meme icon only when discovery and stored metadata have no icon', async () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const record = createDetectedEvmAssetRecord(chains, {
    chainId: 'eip155:1',
    contractAddress: CONTRACT,
    metadata: { name: 'Example Token', symbol: 'EXT', decimals: 18 },
    detectedAt: NOW,
    lastSeenAt: NOW
  })
  const saved = []
  let iconReads = 0
  let discoveryIcon
  const coordinator = new DetectedEvmAssetCoordinator({
    chains,
    repository: {
      list: async () => [record],
      upsert: async records => {
        saved.push(...records)
        return true
      }
    },
    discovery: {
      available: true,
      discover: async () => [
        {
          assetId: ASSET_ID,
          chainId: 'eip155:1',
          contractAddress: CONTRACT,
          ...(discoveryIcon ? { iconUrl: discoveryIcon } : {})
        }
      ]
    },
    schedule: new EvmTokenDiscoverySchedule('mainnet', memoryDiscoverySession()),
    resolveRpc: () => {
      throw new Error('Existing Token metadata must not be queried again')
    },
    resolveIconUrl: async () => {
      iconReads++
      return 'https://static.four.meme/market/example.png'
    },
    now: () => NOW
  })

  await coordinator.refresh([{ address: ADDRESS, chainIds: ['eip155:1'] }])
  expect(saved[0].metadata.iconUrl).toBe('https://static.four.meme/market/example.png')
  expect(iconReads).toBe(1)

  discoveryIcon = 'https://history.example/token-icon?source=example'
  await coordinator.refresh([{ address: ADDRESS, chainIds: ['eip155:1'] }], { force: true })
  expect(saved[1].metadata.iconUrl).toBe(discoveryIcon)
  expect(iconReads).toBe(1)
})

test('persists detected inventory and exact hidden AssetIds in network-isolated storage', async () => {
  const previousChrome = globalThis.chrome
  const memory = memoryChrome()
  globalThis.chrome = memory.chrome
  try {
    const chains = createInitialProductChainRegistry('mainnet')
    const record = createDetectedEvmAssetRecord(chains, {
      chainId: 'eip155:1',
      contractAddress: CONTRACT,
      metadata: { name: 'Tether USD', symbol: 'USDT', decimals: 6 },
      detectedAt: NOW,
      lastSeenAt: NOW
    })
    const catalog = new ChromeDetectedEvmAssetCatalogRepository('mainnet', chains)
    await expect(catalog.upsert([record])).resolves.toBe(true)
    await expect(catalog.list()).resolves.toEqual([record])
    await expect(catalog.upsert([{ ...record, lastSeenAt: NOW + 1 }])).resolves.toBe(false)

    const visibility = new ChromeTokenVisibilityRepository('mainnet')
    await visibility.setHidden(ASSET_ID, true)
    await expect(visibility.list()).resolves.toEqual([ASSET_ID])
    await visibility.synchronizeProtocolDefaults([
      { assetId: 'near:mainnet/nep141:usdt.tether-token.near', visibleByDefault: true },
      {
        assetId:
          'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        visibleByDefault: false
      }
    ])
    await expect(visibility.list()).resolves.toEqual([
      ASSET_ID,
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    ])
    await visibility.revealHeldProtocolAssets([
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    ])
    await visibility.revealUserSelectedAsset(ASSET_ID)
    await expect(visibility.list()).resolves.toEqual([ASSET_ID])
    await visibility.setHidden(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      true
    )
    await visibility.revealHeldProtocolAssets([
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    ])
    await expect(visibility.list()).resolves.toEqual([
      ASSET_ID,
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    ])
    await visibility.setHidden(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      false
    )
    await visibility.setHidden(ASSET_ID, false)
    await expect(visibility.list()).resolves.toEqual([])
    await expect(visibility.readUserOverrides()).resolves.toEqual({
      hiddenAssetIds: [],
      visibleAssetIds: expect.arrayContaining([ASSET_ID])
    })
    const futureChainAssetId = 'tron:mainnet/trc20:TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj'
    await visibility.setHidden(futureChainAssetId, true)
    await expect(visibility.list()).resolves.toEqual([futureChainAssetId])
    expect(memory.storage.has(getDetectedEvmAssetCatalogStorageKey('mainnet'))).toBe(true)
    expect(memory.storage.has(getDetectedEvmAssetCatalogStorageKey('testnet'))).toBe(false)
    expect(memory.storage.has(getTokenVisibilityStorageKey('mainnet'))).toBe(true)
  } finally {
    globalThis.chrome = previousChrome
  }
})

test('migrates legacy protocol defaults without overriding an explicit hidden preference', async () => {
  const previousChrome = globalThis.chrome
  const memory = memoryChrome()
  const solanaAssetId =
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS'
  const nearAssetId = 'near:mainnet/nep141:usdt.tether-token.near'
  memory.storage.set(getTokenVisibilityStorageKey('mainnet'), {
    version: 1,
    preferences: [
      { assetId: solanaAssetId, visible: false },
      { assetId: nearAssetId, visible: false },
      { assetId: ASSET_ID, visible: true }
    ]
  })
  globalThis.chrome = memory.chrome
  try {
    const visibility = new ChromeTokenVisibilityRepository('mainnet')
    await visibility.synchronizeProtocolDefaults([
      { assetId: solanaAssetId, visibleByDefault: false },
      { assetId: nearAssetId, visibleByDefault: true },
      { assetId: ASSET_ID, visibleByDefault: false }
    ])
    await visibility.revealHeldProtocolAssets([solanaAssetId, nearAssetId])

    await expect(visibility.list()).resolves.toEqual([ASSET_ID, nearAssetId].sort())
    await expect(visibility.readUserOverrides()).resolves.toEqual({
      hiddenAssetIds: [nearAssetId],
      visibleAssetIds: []
    })
    expect(memory.storage.get(getTokenVisibilityStorageKey('mainnet'))).toMatchObject({
      version: 2,
      preferences: expect.arrayContaining([
        { assetId: solanaAssetId, visible: true, source: 'balance' },
        { assetId: nearAssetId, visible: false, source: 'user' }
      ])
    })
  } finally {
    globalThis.chrome = previousChrome
  }
})
