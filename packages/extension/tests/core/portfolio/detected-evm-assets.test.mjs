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

test('manual discovery refresh bypasses the automatic request cooldown', async () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const record = createDetectedEvmAssetRecord(chains, {
    chainId: 'eip155:1',
    contractAddress: CONTRACT,
    metadata: { name: 'Example Token', symbol: 'EXT', decimals: 18 },
    detectedAt: NOW,
    lastSeenAt: NOW
  })
  let discoveryRequests = 0
  const coordinator = new DetectedEvmAssetCoordinator({
    chains,
    repository: {
      list: async () => [record],
      upsert: async () => false
    },
    discovery: {
      available: true,
      discover: async () => {
        discoveryRequests++
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
  })

  await coordinator.refresh([{ address: ADDRESS, chainIds: ['eip155:1'] }])
  await coordinator.refresh([{ address: ADDRESS, chainIds: ['eip155:1'] }])
  await coordinator.refresh([{ address: ADDRESS, chainIds: ['eip155:1'] }], { force: true })

  expect(discoveryRequests).toBe(2)
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
      { assetId: nearAssetId, visible: false }
    ]
  })
  globalThis.chrome = memory.chrome
  try {
    const visibility = new ChromeTokenVisibilityRepository('mainnet')
    await visibility.synchronizeProtocolDefaults([
      { assetId: solanaAssetId, visibleByDefault: false },
      { assetId: nearAssetId, visibleByDefault: true }
    ])
    await visibility.revealHeldProtocolAssets([solanaAssetId, nearAssetId])

    await expect(visibility.list()).resolves.toEqual([nearAssetId])
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
