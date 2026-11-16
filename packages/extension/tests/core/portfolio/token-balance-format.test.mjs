import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  calculateTokenFiatValue,
  parseTokenBalanceDecimal
} from '../../../src/popup/components/tokens/token-balance-format.ts'
import { formatBaseUnitDecimalAmount } from '../../../src/lib/number-format.ts'

test('keeps arithmetic amounts ungrouped and unabridged', () => {
  expect(formatBaseUnitDecimalAmount('1234567890000000000000', 18)).toBe('1234.56789')
  expect(formatBaseUnitDecimalAmount('1', 18)).toBe('0.000000000000000001')
})

test('calculates fiat values from canonical decimal inputs', () => {
  expect(calculateTokenFiatValue('1234.56789', '2.5')).toBe('3086.419725')
  expect(calculateTokenFiatValue('0', '2.5')).toBe('0')
})

test('rejects display annotations and invalid upstream values without throwing', () => {
  for (const value of ['1,234.56', '< 0.000001', '1.234…', '', ' NaN', 'NaN', Infinity]) {
    expect(parseTokenBalanceDecimal(value)).toBeNull()
    expect(calculateTokenFiatValue(value, '2.5')).toBeNull()
    expect(calculateTokenFiatValue('1', value)).toBeNull()
  }
})
