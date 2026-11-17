import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  getCuratedSwapChainIds,
  loadCuratedSwapTokens,
  readCachedCuratedSwapTokens,
  selectDefaultSwapTokens
} from '../../../src/popup/services/swap-curated-catalog.ts'

function token(assetId, chainId, address, symbol, isNative = false) {
  return {
    assetId,
    blockchain: chainId === 1 ? 'eth' : 'base',
    contractAddress: isNative ? null : address,
    decimals: 18,
    price: 1,
    priceUpdatedAt: '2026-01-01T00:00:00.000Z',
    symbol,
    rheaChainId: String(chainId),
    tokenListChainId: chainId,
    rheaAddress: address,
    isNative,
    sources: ['near-intents']
  }
}

const curated = token('eth-usdc', 1, '0x1111111111111111111111111111111111111111', 'USDC')
const impostor = token('eth-fake', 1, '0x2222222222222222222222222222222222222222', 'USDC')
const otherChain = token('base-usdc', 8453, '0x1111111111111111111111111111111111111111', 'USDC')
const native = token('eth-native', 1, 'native', 'ETH', true)

test('curated Swap defaults match chain and contract, then native gas and owned assets', () => {
  const tokens = [impostor, native, otherChain, curated]
  const rows = [
    { chainId: 1, address: '0x0000000000000000000000000000000000000000', order: 0 },
    { chainId: 1, address: curated.contractAddress, order: 1 }
  ]
  expect(getCuratedSwapChainIds(tokens)).toEqual([1, 8453])
  expect(selectDefaultSwapTokens(tokens, rows)).toEqual([native, curated])
  expect(
    selectDefaultSwapTokens(tokens, rows, {
      balances: new Map([
        [impostor.assetId, '0.01'],
        [otherChain.assetId, '0']
      ])
    })
  ).toEqual([native, curated, impostor])
})

test('preserves case-sensitive non-EVM addresses when matching curated rows', () => {
  const sol = {
    ...token('sol-token', 501, 'AbCd123', 'SOLX'),
    blockchain: 'sol',
    rheaChainId: 'solana'
  }
  expect(selectDefaultSwapTokens([sol], [{ chainId: 501, address: 'abcd123', order: 0 }])).toEqual(
    []
  )
  expect(selectDefaultSwapTokens([sol], [{ chainId: 501, address: 'AbCd123', order: 0 }])).toEqual([
    sol
  ])
})

test('registered EVM contracts stay visible when curated catalog is unavailable', () => {
  const tokens = [impostor, otherChain, native]
  const matching = {
    chainId: 'eip155:8453',
    contractAddress: otherChain.contractAddress,
    source: 'user-added'
  }
  expect(selectDefaultSwapTokens(tokens, [], { customAssets: [matching] })).toEqual([
    native,
    otherChain
  ])
  expect(
    selectDefaultSwapTokens(tokens, [], {
      customAssets: [{ ...matching, source: 'intents-catalog' }]
    })
  ).toEqual([native, otherChain])
})

test('local Swap defaults use exact configured contracts without fetching a recommendation list', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = () => {
    throw new Error('Recommendation list must stay local')
  }
  const updates = []
  const rows = readCachedCuratedSwapTokens([1, 8453])
  expect(await loadCuratedSwapTokens([1, 8453], value => updates.push(value))).toEqual(rows)
  expect(updates).toEqual([rows])
  expect(rows.some(row => row.chainId === 1 && row.address === curated.contractAddress)).toBe(false)
  const configured = token(
    'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    1,
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    'USDC'
  )
  expect(selectDefaultSwapTokens([impostor, configured], rows)).toEqual([configured])
})
