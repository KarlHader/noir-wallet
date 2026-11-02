import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  DEFAULT_NETWORK_FEE_TIER,
  getNetworkFeeTierLabel,
  parseNetworkFeeTier
} from '../../../../src/core/transactions/domain/network-fee-tier.ts'
import { bitcoinFeeTargetBlocks } from '../../../../src/infrastructure/chains/bitcoin/bitcoin-fee-tier.ts'
import {
  deriveEvmFeeTierQuote,
  formatEvmPriorityFeeGwei,
  parseEvmFeeSelection,
  parseEvmPriorityFeeGwei
} from '../../../../src/infrastructure/chains/evm/evm-fee-tier.ts'

test('maps the shared fee presets to Bitcoin confirmation targets', () => {
  expect(DEFAULT_NETWORK_FEE_TIER).toBe('standard')
  expect(bitcoinFeeTargetBlocks('low')).toBe(24)
  expect(bitcoinFeeTargetBlocks('standard')).toBe(6)
  expect(bitcoinFeeTargetBlocks('fast')).toBe(2)
  expect(getNetworkFeeTierLabel(parseNetworkFeeTier('fast'))).toBe('Fast')
  expect(() => parseNetworkFeeTier('instant')).toThrow(/fee tier/i)
})

test('derives bounded EIP-1559 caps for Low, Standard, and Fast', () => {
  const input = {
    baseFeePerGas: 2_000_000_000n,
    suggestedPriorityFeePerGas: 1_000_000_000n
  }
  expect(deriveEvmFeeTierQuote({ ...input, tier: 'low' })).toEqual({
    selection: { kind: 'tier', tier: 'low' },
    maxFeePerGas: 3_300_000_000n,
    maxPriorityFeePerGas: 800_000_000n
  })
  expect(deriveEvmFeeTierQuote({ ...input, tier: 'standard' })).toEqual({
    selection: { kind: 'tier', tier: 'standard' },
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n
  })
  expect(deriveEvmFeeTierQuote({ ...input, tier: 'fast' })).toEqual({
    selection: { kind: 'tier', tier: 'fast' },
    maxFeePerGas: 6_500_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n
  })
})

test('parses exact custom priority GWEI and derives the EIP-1559 max fee cap', () => {
  const selection = parseEvmPriorityFeeGwei('2.123456789')
  expect(selection).toEqual({
    kind: 'custom',
    maxPriorityFeePerGasWei: '2123456789'
  })
  expect(formatEvmPriorityFeeGwei(selection)).toBe('2.123456789')
  expect(
    deriveEvmFeeTierQuote({
      selection,
      baseFeePerGas: 2_000_000_000n,
      suggestedPriorityFeePerGas: 999n
    })
  ).toEqual({
    selection,
    maxFeePerGas: 6_123_456_789n,
    maxPriorityFeePerGas: 2_123_456_789n
  })
})

test('rejects malformed, zero, over-precise, and excessive custom priority fees', () => {
  expect(() => parseEvmPriorityFeeGwei('0')).toThrow(/between/i)
  expect(() => parseEvmPriorityFeeGwei('1.0000000001')).toThrow(/9 decimal/i)
  expect(() => parseEvmPriorityFeeGwei('-1')).toThrow(/valid priority fee/i)
  expect(() => parseEvmPriorityFeeGwei('10000.000000001')).toThrow(/10,000 GWEI/i)
  expect(() =>
    parseEvmFeeSelection({ kind: 'custom', maxPriorityFeePerGasWei: '1', extra: true })
  ).toThrow(/selection/i)
})
