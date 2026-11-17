import { test } from 'node:test'
import { expect } from '@playwright/test'
import { filterManuallyHiddenSwapTokens } from '../../../src/popup/services/swap-token-visibility.ts'

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

test('manually hidden wallet assets are excluded from Swap tokens', () => {
  const tokens = [impostor, native, otherChain, curated]
  expect(filterManuallyHiddenSwapTokens(tokens, new Set())).toBe(tokens)
  expect(
    filterManuallyHiddenSwapTokens(tokens, new Set([`eip155:1/erc20:${impostor.contractAddress}`]))
  ).toEqual([native, otherChain, curated])
})

test('a hidden asset only removes its exact chain and contract', () => {
  const tokens = [impostor, otherChain, native]
  expect(
    filterManuallyHiddenSwapTokens(
      tokens,
      new Set([`eip155:8453/erc20:${otherChain.contractAddress}`])
    )
  ).toEqual([impostor, native])
})
