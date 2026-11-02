import { test } from 'node:test'
import { expect } from '@playwright/test'

import { formatChainName, formatExplorerUrl, getChainFromAssetId } from '../../../src/lib/format.ts'
import { getSwapTransactionReference } from '../../../src/popup/components/swap/swap-status-model.ts'

test('maps every released EVM 1Click protocol identity to the canonical chain UI', () => {
  const cases = [
    ['nep141:eth.omft.near', 'ethereum', 'Ethereum'],
    ['nep141:arb.omft.near', 'arbitrum', 'Arbitrum'],
    ['nep141:base.omft.near', 'base', 'Base'],
    ['nep245:v2_1.omni.hot.tg:10_11111111111111111111', 'optimism', 'Optimism'],
    ['nep245:v2_1.omni.hot.tg:56_11111111111111111111', 'bsc', 'BNB Chain'],
    ['nep245:v2_1.omni.hot.tg:137_11111111111111111111', 'polygon', 'Polygon'],
    ['nep245:v2_1.omni.hot.tg:143_11111111111111111111', 'monad', 'Monad'],
    ['nep245:v2_1.omni.hot.tg:196_11111111111111111111', 'xlayer', 'X Layer'],
    ['nep245:v2_1.omni.hot.tg:43114_11111111111111111111', 'avalanche', 'Avalanche']
  ]

  for (const [assetId, chain, label] of cases) {
    expect(getChainFromAssetId(assetId)).toBe(chain)
    expect(formatChainName(chain)).toBe(label)
    expect(formatExplorerUrl(chain, '0x123')).toContain('/tx/0x123')
  }
})

test('does not infer an unsupported NEP-245 EVM chain identity', () => {
  expect(getChainFromAssetId('nep245:v2_1.omni.hot.tg:999_11111111111111111111')).toBe('nep245')
})

test('links CAIP EVM swap hashes to the matching network explorer', () => {
  const mainnetHash = getSwapTransactionReference(
    'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'eip155',
    '0x123',
    'mainnet'
  )
  expect(mainnetHash).toEqual({ label: 'Ethereum', url: 'https://etherscan.io/tx/0x123' })

  const testnetHash = getSwapTransactionReference(
    'eip155:11155111/slip44:60',
    'eip155',
    '0x456',
    'testnet'
  )
  expect(testnetHash).toEqual({
    label: 'Ethereum Sepolia',
    url: 'https://sepolia.etherscan.io/tx/0x456'
  })
})
