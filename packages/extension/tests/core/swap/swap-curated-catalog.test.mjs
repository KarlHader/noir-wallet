import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  getCuratedSwapChainIds,
  loadCuratedSwapTokens,
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

test('publishes completed chain catalogs while another chain is still loading', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let releaseFirst
  const first = new Promise(resolve => {
    releaseFirst = resolve
  })
  globalThis.fetch = async input => {
    const chainId = Number(new URL(String(input)).searchParams.get('chain'))
    if (chainId === 1) await first
    return new Response(
      JSON.stringify({
        code: 0,
        data: [{ chainId, address: `chain-${chainId}` }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  const updates = []
  let receivedFirst
  const firstUpdate = new Promise(resolve => {
    receivedFirst = resolve
  })
  const loading = loadCuratedSwapTokens([1, 8453], rows => {
    updates.push(rows.map(row => row.chainId))
    receivedFirst()
  })
  await firstUpdate
  releaseFirst()
  const rows = await loading
  expect(updates).toEqual([[8453], [1, 8453]])
  expect(rows.map(row => row.chainId)).toEqual([1, 8453])
})
