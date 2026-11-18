import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  buildInitialSwapCatalogPlan,
  findSwapTokenInCatalog,
  findSwapTokenForDisplaySeed,
  getSwapCatalogDisplaySeeds,
  loadTokenCatalogByChain,
  mergeTokenCatalogs,
  pickProvisionalSwapSource
} from '../../../src/popup/services/swap-catalog-loading.ts'

const zcashChain = {
  id: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  family: 'zcash',
  network: { kind: 'mainnet' }
}
const ethereumChain = { id: 'eip155:1', family: 'evm', network: { kind: 'mainnet' } }
const bitcoinChain = {
  id: 'bip122:000000000019d6689c085ae165831e93',
  family: 'bitcoin',
  network: { kind: 'mainnet' }
}
const polygonChain = { id: 'eip155:137', family: 'evm', network: { kind: 'mainnet' } }
const arbitrumChain = { id: 'eip155:42161', family: 'evm', network: { kind: 'mainnet' } }
const nearChain = { id: 'near:mainnet', family: 'near', network: { kind: 'mainnet' } }

test('loads only the current pair chains on entry and reuses source tokens for same-chain swaps', () => {
  expect(buildInitialSwapCatalogPlan({})).toEqual({
    sourceChainIds: [],
    destinationChainIds: []
  })
  expect(
    buildInitialSwapCatalogPlan({
      sourceAssetId: 'nep141:btc.omft.near',
      destinationAssetId: 'nep141:eth.omft.near',
      enabledChains: [bitcoinChain]
    })
  ).toEqual({ sourceChainIds: [900002], destinationChainIds: [1] })
  expect(
    buildInitialSwapCatalogPlan({
      sourceAssetId: `${zcashChain.id}/slip44:133`,
      destinationAssetId: 'nep141:eth.omft.near',
      enabledChains: [bitcoinChain, zcashChain, ethereumChain]
    })
  ).toEqual({ sourceChainIds: [900010], destinationChainIds: [1] })
  expect(
    buildInitialSwapCatalogPlan({
      sourceAssetId: 'nep245:v2_1.omni.hot.tg:137_11111111111111111111',
      destinationApiChainId: '137',
      enabledChains: [polygonChain]
    })
  ).toEqual({ sourceChainIds: [137], destinationChainIds: [] })
  expect(
    buildInitialSwapCatalogPlan({
      defaultSourceChainId: bitcoinChain.id,
      enabledChains: [bitcoinChain, ethereumChain]
    })
  ).toEqual({
    sourceChainIds: [900002],
    destinationChainIds: [1]
  })
  expect(
    buildInitialSwapCatalogPlan({
      sourceAssetId: 'eip155:42161/native:ETH',
      enabledChains: [arbitrumChain]
    })
  ).toEqual({
    sourceChainIds: [42161],
    destinationChainIds: []
  })
  expect(
    buildInitialSwapCatalogPlan({ sourceAssetId: 'nep141:wrap.near', enabledChains: [nearChain] })
  ).toEqual({
    sourceChainIds: [900001],
    destinationChainIds: []
  })
  expect(buildInitialSwapCatalogPlan({ enabledChains: [zcashChain, ethereumChain] })).toEqual({
    sourceChainIds: [900010],
    destinationChainIds: [1]
  })
  expect(
    buildInitialSwapCatalogPlan({
      sourceAssetId: 'nep141:zec.omft.near',
      enabledChains: [ethereumChain]
    })
  ).toEqual({ sourceChainIds: [1], destinationChainIds: [] })
})

test('publishes a healthy chain before slow chains finish and stops queued work after cancellation', async () => {
  let release
  const pending = new Promise(resolve => {
    release = resolve
  })
  let cancelled = false
  const calls = []
  const published = []
  const token = { tokenListChainId: 1, rheaChainId: '1', rheaAddress: 'eth', symbol: 'ETH' }
  const loading = loadTokenCatalogByChain(
    'from',
    [1, 10, 56, 137],
    false,
    tokens => {
      published.push(...tokens)
      cancelled = true
    },
    () => cancelled,
    {
      listTokens: async input => {
        const chain = input.tokenListChainIds[0]
        calls.push(chain)
        if (chain === 10) {
          await pending
          throw new Error('Unavailable')
        }
        return { tokens: [token], failedChainIds: [] }
      }
    }
  )
  await expect.poll(() => published).toEqual([token])
  expect(calls).toEqual([1, 10])
  release()
  expect(await loading).toEqual([token])
})

test('publishes cached chains immediately and requests only missing chains', async () => {
  let release
  const pending = new Promise(resolve => {
    release = resolve
  })
  const cached = {
    ...ethereumChain,
    assetId: 'cached',
    tokenListChainId: 1,
    rheaChainId: '1',
    rheaAddress: 'eth'
  }
  const fresh = {
    ...polygonChain,
    assetId: 'fresh',
    tokenListChainId: 137,
    rheaChainId: '137',
    rheaAddress: 'pol'
  }
  const calls = []
  const updates = []
  const loading = loadTokenCatalogByChain(
    'from',
    [1, 137, 1],
    false,
    tokens => updates.push(tokens),
    () => false,
    {
      readCachedTokens: input =>
        input.tokenListChainIds[0] === 1 ? { tokens: [cached], failedChainIds: [] } : null,
      listTokens: async input => {
        calls.push(input.tokenListChainIds[0])
        await pending
        return { tokens: [fresh], failedChainIds: [] }
      }
    }
  )
  expect(updates).toEqual([[cached]])
  expect(calls).toEqual([137])
  release()
  expect(await loading).toEqual([cached, fresh])
  expect(updates).toEqual([[cached], [fresh]])
})

test('strict single-chain search preserves the provider failure', async () => {
  const failure = new Error('Provider unavailable')
  const calls = []
  await expect(
    loadTokenCatalogByChain(
      'cross-chain-to',
      [137],
      false,
      tokens => calls.push(tokens),
      () => false,
      {
        listTokens: async () => {
          throw failure
        }
      },
      { strict: true }
    )
  ).rejects.toBe(failure)
  expect(calls).toEqual([])
  await expect(
    loadTokenCatalogByChain(
      'cross-chain-to',
      [137],
      false,
      tokens => calls.push(tokens),
      () => false,
      {
        listTokens: async () => ({
          tokens: [{ tokenListChainId: 1, assetId: 'wrong-chain' }],
          failedChainIds: []
        })
      },
      { strict: true }
    )
  ).rejects.toThrow(/chain 137/)
  expect(calls).toEqual([])
})

test('strict single-chain search accepts an authoritative empty catalog', async () => {
  const updates = []
  const result = await loadTokenCatalogByChain(
    'cross-chain-to',
    [137],
    false,
    tokens => updates.push(tokens),
    () => false,
    { listTokens: async () => ({ tokens: [], failedChainIds: [] }) },
    { strict: true }
  )
  expect(result).toEqual([])
  expect(updates).toEqual([])
})

test('excludes deprecated routes from cached and live Swap catalogs', async () => {
  const contract = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
  const legacy = {
    assetId: 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r',
    blockchain: 'bsc',
    contractAddress: contract,
    symbol: 'USDC(DEPRECATED)',
    rheaChainId: '56',
    rheaAddress: contract,
    tokenListChainId: 56
  }
  const current = {
    ...legacy,
    assetId: `nep141:bnb-${contract}.omdep.near`,
    symbol: 'USDC'
  }
  const cached = mergeTokenCatalogs([current, legacy])
  expect(cached).toEqual([current])
  expect(pickProvisionalSwapSource(cached, legacy.assetId)).toEqual(current)

  const published = []
  const loaded = await loadTokenCatalogByChain(
    'from',
    [56],
    false,
    tokens => published.push(...tokens),
    () => false,
    { listTokens: async () => ({ tokens: [legacy, current], failedChainIds: [] }) }
  )
  expect(published).toEqual([current])
  expect(loaded).toEqual([current])
})

test('distinguishes a selected token from an asset on another chain', () => {
  const usdc = {
    assetId: 'usdc',
    blockchain: 'eth',
    tokenListChainId: 1,
    rheaChainId: '1',
    rheaAddress: 'usdc'
  }
  const polygon = {
    assetId: 'usdc',
    blockchain: 'polygon',
    tokenListChainId: 137,
    rheaChainId: '137',
    rheaAddress: 'usdc'
  }
  expect(findSwapTokenInCatalog([polygon], usdc)).toBeUndefined()
  expect(findSwapTokenInCatalog([polygon], polygon)).toBe(polygon)
  expect(
    findSwapTokenInCatalog([usdc], { ...usdc, rheaAddress: 'different-contract' })
  ).toBeUndefined()
})

test('display seeds cover configured native and USDC assets and resolve only to exact catalog identities', () => {
  const seeds = getSwapCatalogDisplaySeeds([1, 56, 137, 8453, 501, 900002, 900010])
  expect(
    seeds
      .filter(token => token.isNative)
      .map(token => token.tokenListChainId)
      .sort((a, b) => a - b)
  ).toEqual([1, 56, 137, 501, 8453, 900002, 900010])
  const baseUsdc = seeds.find(token => token.tokenListChainId === 8453 && token.symbol === 'USDC')
  expect(baseUsdc).toMatchObject({
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    isDisplaySeed: true
  })
  const catalogToken = { ...baseUsdc, isDisplaySeed: undefined, sources: ['nearintents'] }
  expect(findSwapTokenForDisplaySeed([catalogToken], baseUsdc)).toBe(catalogToken)
  expect(mergeTokenCatalogs([baseUsdc], [catalogToken])).toEqual([catalogToken])
  const nativeSeed = seeds.find(token => token.tokenListChainId === 56 && token.isNative)
  const resolvedNative = {
    ...nativeSeed,
    rheaAddress: '0x0000000000000000000000000000000000000000',
    isDisplaySeed: undefined,
    sources: []
  }
  expect(mergeTokenCatalogs([nativeSeed], [resolvedNative])).toEqual([resolvedNative])
  expect(
    findSwapTokenForDisplaySeed(
      [{ ...catalogToken, contractAddress: '0x1111111111111111111111111111111111111111' }],
      baseUsdc
    )
  ).toBeUndefined()
})
