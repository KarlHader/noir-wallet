import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  portfolioChainIdsForAutomaticRefresh,
  portfolioChainIdsNeedingRefresh,
  shouldRefreshPortfolioFromNetwork,
  refreshPortfolioFromCache
} from '../../../src/popup/services/portfolio-cache.ts'

test('keeps a cold-cache automatic refresh limited to the selected chain', async () => {
  const previousChrome = globalThis.chrome
  const messages = []
  globalThis.chrome = {
    storage: { session: { get: async () => ({}), set: async () => {} } },
    runtime: {
      sendMessage: async message => {
        messages.push(message)
        throw new Error('Network unavailable')
      }
    }
  }
  try {
    await expect(
      refreshPortfolioFromCache(
        { walletId: 'cold-wallet', accountId: 'cold-account', endpointRuntimeKey: 'cold-swap' },
        null,
        { refreshChainIds: ['eip155:1'] }
      )
    ).rejects.toThrow('Network unavailable')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ action: 'refresh', chainIds: ['eip155:1'] })
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = previousChrome
  }
})

function model({ family = 'evm', status = 'ready', freshness = 'fresh', updatedAt = 9_500 } = {}) {
  const asset = { freshness, updatedAt }
  return {
    chains: [{ chain: { family }, status, assets: [asset] }],
    assets: [asset]
  }
}

test('reuses a fresh persistent public-chain Portfolio cache', () => {
  expect(shouldRefreshPortfolioFromNetwork(model(), 10_000, 1_000)).toBe(false)
})

test('refreshes stale and missing public-chain Portfolio caches', () => {
  expect(shouldRefreshPortfolioFromNetwork(model({ updatedAt: 8_000 }), 10_000, 1_000)).toBe(true)
  expect(
    shouldRefreshPortfolioFromNetwork(
      { ...model(), chains: [{ ...model().chains[0], status: 'loading', assets: [] }] },
      10_000,
      1_000
    )
  ).toBe(true)
  expect(
    shouldRefreshPortfolioFromNetwork(
      { ...model(), chains: [{ ...model().chains[0], status: 'error', assets: [] }] },
      10_000,
      1_000
    )
  ).toBe(true)
})

test('refreshes a retained stale cache when the Assets view mounts again', () => {
  const retained = model({ family: 'solana', updatedAt: 8_000 })
  retained.chains[0].chain.id = 'solana:mainnet'
  expect(portfolioChainIdsNeedingRefresh(retained, 10_000, 1_000)).toEqual(['solana:mainnet'])
})

test('returns only the public chains whose cache needs a network refresh', () => {
  const current = model()
  const staleChain = {
    ...current.chains[0],
    chain: { family: 'near', id: 'near:mainnet' },
    assets: [{ freshness: 'stale', updatedAt: 8_000 }]
  }
  const freshChain = {
    ...current.chains[0],
    chain: { family: 'evm', id: 'eip155:1' }
  }
  expect(
    portfolioChainIdsNeedingRefresh({ ...current, chains: [freshChain, staleChain] }, 10_000, 1_000)
  ).toEqual(['near:mainnet'])
})

test('limits an automatic detail refresh to its selected chain', () => {
  const current = model()
  const ethereum = {
    ...current.chains[0],
    chain: { family: 'evm', id: 'eip155:1' },
    assets: [{ freshness: 'stale', updatedAt: 8_000 }]
  }
  const near = {
    ...current.chains[0],
    chain: { family: 'near', id: 'near:mainnet' },
    assets: [{ freshness: 'stale', updatedAt: 8_000 }]
  }
  expect(
    portfolioChainIdsForAutomaticRefresh(
      { ...current, chains: [ethereum, near] },
      { refreshChainIds: ['eip155:1'] },
      10_000,
      1_000
    )
  ).toEqual(['eip155:1'])
})

test('does not repeatedly query fresh partial or confirmed-empty caches', () => {
  expect(shouldRefreshPortfolioFromNetwork(model({ status: 'partial' }), 10_000, 1_000)).toBe(false)
  expect(
    shouldRefreshPortfolioFromNetwork(
      { ...model(), chains: [{ ...model().chains[0], assets: [] }] },
      10_000,
      1_000
    )
  ).toBe(false)
})

test('leaves Zcash refresh scheduling to the Zcash sync runtime', () => {
  expect(
    shouldRefreshPortfolioFromNetwork(model({ family: 'zcash', updatedAt: 0 }), 10_000, 1_000)
  ).toBe(false)
})
