import { test } from 'node:test'
import { expect } from '@playwright/test'

import { resolveChainIconAlias } from '../../../../src/lib/chain-icon.ts'

test('resolves each built-in EVM family to its chain-specific icon', () => {
  expect(resolveChainIconAlias('evm', 'Ethereum Sepolia')).toBe('eth')
  expect(resolveChainIconAlias('evm', 'BSC Testnet')).toBe('bsc')
  expect(resolveChainIconAlias('evm', 'Arbitrum Sepolia')).toBe('arbitrum')
  expect(resolveChainIconAlias('evm', 'Base Sepolia')).toBe('base')
  expect(resolveChainIconAlias('evm', 'OP Sepolia')).toBe('optimism')
  expect(resolveChainIconAlias('evm', 'Polygon Amoy')).toBe('polygon')
  expect(resolveChainIconAlias('evm', 'Avalanche Fuji')).toBe('avax')
  expect(resolveChainIconAlias('evm', 'Monad')).toBe('monad')
  expect(resolveChainIconAlias('evm', 'Gnosis')).toBe('gnosis')
  expect(resolveChainIconAlias('evm', 'Plasma')).toBe('plasma')
  expect(resolveChainIconAlias('evm', 'X Layer')).toBe('xlayer')
  expect(resolveChainIconAlias('evm', 'Berachain')).toBe('bera')
  expect(resolveChainIconAlias('bitcoin', 'Bitcoin Testnet')).toBe('btc')
  expect(resolveChainIconAlias('zcash', 'Zcash Testnet')).toBe('zec')
})
