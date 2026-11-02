import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  findBundledWalletMarketAssetId,
  isBundledWalletAsset
} from '../../../src/popup/components/tokens/token-display-policy.ts'

test('groups only explicitly mapped bundled assets across networks', () => {
  const ethereum = 'eip155:1/slip44:60'
  const base = 'eip155:8453/slip44:60'
  const sepolia = 'eip155:11155111/slip44:60'

  expect(isBundledWalletAsset(ethereum)).toBe(true)
  expect(isBundledWalletAsset(base)).toBe(true)
  expect(isBundledWalletAsset(sepolia)).toBe(true)
  expect(findBundledWalletMarketAssetId(ethereum)).toBe('ethereum')
  expect(findBundledWalletMarketAssetId(base)).toBe('ethereum')
  expect(findBundledWalletMarketAssetId(sepolia)).toBe('ethereum')
})

test('does not group a user-added Token by symbol', () => {
  const customUsdc = 'eip155:1/erc20:0x3333333333333333333333333333333333333333'

  expect(isBundledWalletAsset(customUsdc)).toBe(false)
  expect(findBundledWalletMarketAssetId(customUsdc)).toBeNull()
})
