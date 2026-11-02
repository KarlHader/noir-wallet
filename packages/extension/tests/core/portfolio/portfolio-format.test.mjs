import { test } from 'node:test'
import { expect } from '@playwright/test'

import Big from '../../../src/lib/big.ts'
import {
  formatActivityTokenAmount,
  formatDisplayAmount,
  formatDisplayTokenAmount,
  formatNetworkDisplayName
} from '../../../src/popup/components/portfolio/portfolio-format.ts'

test('formats chain and network identity without repeating the network name', () => {
  expect(formatNetworkDisplayName('Ethereum Sepolia', 'sepolia')).toBe('Ethereum Sepolia')
  expect(formatNetworkDisplayName('Zcash Testnet', 'testnet')).toBe('Zcash Testnet')
  expect(formatNetworkDisplayName('Bitcoin Testnet', 'testnet3')).toBe('Bitcoin Testnet')
  expect(formatNetworkDisplayName('Ethereum', 'mainnet')).toBe('Ethereum')
  expect(formatNetworkDisplayName('OP Mainnet', 'op-mainnet')).toBe('OP')
})

test.describe('Portfolio display amount formatting', () => {
  test('bounds long fractional balances to significant digits', () => {
    // The reported overflow: 0.005867687705178373 ETH.
    expect(formatDisplayTokenAmount('5867687705178373', 18)).toBe('0.005867')
    expect(formatDisplayTokenAmount('5871510000000000', 18)).toBe('0.005871')
    expect(formatDisplayTokenAmount('12345678901234', 18)).toBe('0.00001234')
    expect(formatDisplayTokenAmount('1050000000000', 18)).toBe('0.00000105')
    expect(formatDisplayTokenAmount('500000000000000000', 18)).toBe('0.5')
  })

  test('adapts fraction digits to magnitude and strips trailing zeros', () => {
    expect(formatDisplayTokenAmount('1000000000000000000', 18)).toBe('1')
    expect(formatDisplayTokenAmount('64123400000000000000', 18)).toBe('64.1234')
    expect(formatDisplayTokenAmount('12345670', 2)).toBe('123,456.7')
  })

  test('preserves full whole units for very large balances', () => {
    expect(formatDisplayTokenAmount('1234567000000', 6)).toBe('1,234,567')
    expect(formatDisplayTokenAmount('5000000000000000000000000000', 18)).toBe('5,000,000,000')
  })

  test('keeps very small non-zero balances distinct from observed zero', () => {
    expect(formatDisplayTokenAmount('1', 18)).toBe('<0.00000001')
    expect(formatDisplayTokenAmount('0', 18)).toBe('0')
  })

  test('shares one strategy for already-decimal aggregate values', () => {
    expect(formatDisplayAmount(new Big('0.005867687705178373'))).toBe('0.005867')
    expect(formatDisplayAmount(new Big('1234.5678'))).toBe('1,234.56')
    expect(formatDisplayAmount(new Big(0))).toBe('0')
    expect(() => formatDisplayAmount(new Big(-1))).toThrow(/Invalid display amount/)
  })

  test('rejects invalid base-unit input', () => {
    expect(() => formatDisplayTokenAmount('-1', 18)).toThrow(/Invalid base-unit amount/)
    expect(() => formatDisplayTokenAmount('01', 18)).toThrow(/Invalid base-unit amount/)
    expect(() => formatDisplayTokenAmount('1', 256)).toThrow(/Invalid base-unit amount/)
  })
})

test.describe('Activity amount formatting', () => {
  test('shares the holdings profile for small amounts', () => {
    expect(formatActivityTokenAmount('10000000000000', 18)).toBe('0.00001')
    expect(formatActivityTokenAmount('1', 18)).toBe('<0.00000001')
    expect(formatActivityTokenAmount('500000000000000000', 18)).toBe('0.5')
  })
})
