import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import Big from '../../../src/lib/big.ts'
import {
  formatAmount,
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount,
  formatDecimalAmount,
  formatFeeAmount,
  formatFiatAmount,
  formatPercentage,
  formatReviewAmount,
  formatTokenPrice,
  formatTokenQuantity
} from '../../../src/lib/number-format.ts'

test('quantity summaries preserve every integer and never exceed the held magnitude', () => {
  const cases = [
    ['4404.099793', '4,404.09'],
    ['12.3456789', '12.3456'],
    ['999.999999', '999.9999'],
    ['0.00507328123456789', '0.005073'],
    ['0.0000123456789', '0.00001234'],
    ['123456789012345678901234567890.129', '123,456,789,012,345,678,901,234,567,890.12']
  ]
  for (const [value, expected] of cases) {
    assert.equal(formatTokenQuantity(value), expected)
    assert.equal(formatTokenQuantity(`-${value}`), `-${expected}`)
    assert.ok(new Big(expected.replace(/,/g, '')).lte(value))
  }
})

test('dust, unknown values and observed zero remain distinguishable', () => {
  assert.equal(formatTokenQuantity('1e-18'), '<0.00000001')
  assert.equal(formatTokenQuantity('-1e-18'), '-<0.00000001')
  assert.equal(formatTokenQuantity('0.00000001'), '0.00000001')
  assert.equal(formatTokenQuantity('0'), '0')
  assert.equal(formatTokenQuantity('-0'), '0')
  for (const value of [
    null,
    undefined,
    '',
    'invalid',
    '1,2',
    '1…',
    '<0.01',
    ' 1',
    NaN,
    Infinity,
    '1e99999999'
  ]) {
    assert.equal(formatTokenQuantity(value), '—')
    assert.equal(formatFiatAmount(value), '—')
    assert.equal(formatTokenPrice(value), '—')
    assert.equal(formatFeeAmount(value), '—')
    assert.equal(formatPercentage(value), '—')
    assert.equal(formatReviewAmount(value).exact, null)
  }
})

test('shortened review values retain full precision for expansion and copying', () => {
  assert.deepEqual(formatReviewAmount('1,234.123456789012345678'), {
    display: '1,234.12345678…',
    full: '1,234.123456789012345678',
    exact: '1234.123456789012345678',
    isRounded: true
  })
  assert.deepEqual(formatReviewAmount('4404.099793'), {
    display: '4,404.099793',
    full: '4,404.099793',
    exact: '4404.099793',
    isRounded: false
  })
  const dust = formatReviewAmount('0.000000000000000001')
  assert.equal(dust.display, '<0.00000001')
  assert.equal(dust.exact, '0.000000000000000001')
  assert.equal(dust.isRounded, true)
  assert.equal(formatReviewAmount('-1.123456789').display, '-1.12345678…')
  assert.equal(formatReviewAmount('1.100000000').isRounded, false)
})

test('fiat valuations use cents while unit prices retain meaningful small digits', () => {
  assert.equal(formatFiatAmount('12345.675', { showSign: true }), '$12,345.68')
  assert.equal(formatFiatAmount('0', { showSign: true }), '$0.00')
  assert.equal(formatFiatAmount('0.00999', { showSign: true }), '<$0.01')
  assert.equal(formatFiatAmount('-0.001', { showSign: true }), '-<$0.01')
  assert.equal(formatFiatAmount('-12.345', { showSign: true }), '-$12.35')
  assert.equal(formatFiatAmount('12345678901234567890.675'), '12,345,678,901,234,567,890.68')
  assert.equal(formatTokenPrice('0.00987654', { showSign: true }), '$0.009877')
  assert.equal(formatTokenPrice('0.000000012345', { showSign: true }), '$0.0₇1235')
  assert.equal(formatTokenPrice('1.999', { showSign: true }), '$2.00')
})

test('fee display rounds up without losing whole units or rendering nonzero as zero', () => {
  assert.equal(formatFeeAmount('0.000012345678'), '0.00001235')
  assert.equal(formatFeeAmount('0.00000000312345'), '0.000000003124')
  assert.equal(formatFeeAmount('1e-18'), '<0.000000000001')
  assert.equal(formatFeeAmount('1234567.1'), '1,234,568')
  assert.equal(formatFeeAmount('0'), '0')
  for (const value of ['0.000012345678', '0.00000000312345', '999.999999', '1234567.1']) {
    assert.ok(new Big(formatFeeAmount(value).replace(/,/g, '')).gte(value))
  }
})

test('percentage thresholds preserve direction and decimal scaling without floats', () => {
  assert.equal(formatPercentage('5.284', { showPlus: true }), '+5.28%')
  assert.equal(formatPercentage('0.000001', { showPlus: true }), '+<0.01%')
  assert.equal(formatPercentage('-0.000001'), '-<0.01%')
  assert.equal(formatPercentage('0.05284', { decimals: 2 }), '5.28%')
  assert.equal(formatPercentage('0'), '0%')
  assert.equal(formatDecimalAmount('1.99999', { maximumFractionDigits: 2 }), '1.99')
})

test.describe('Base-unit amount formatting', () => {
  test('preserves every base unit across high asset precisions and transaction round trips', () => {
    const raw = ((1n << 256n) - 1n).toString()
    for (const decimals of [0, 18, 255]) {
      const amount = formatBaseUnitDecimalAmount(raw, decimals)
      assert.equal(parseDisplayUnitAmount(amount, decimals), raw)
      assert.equal(formatBaseUnitDecimalAmount(BigInt(raw), decimals), amount)
    }
    const smallest = `0.${'0'.repeat(254)}1`
    assert.equal(formatBaseUnitDecimalAmount('1', 255), smallest)
    assert.equal(formatAmount('1', 255), smallest)
    assert.equal(formatAmount('-1', 255), `-${smallest}`)
    assert.equal(parseDisplayUnitAmount(smallest, 255), '1')
    assert.equal(formatBaseUnitDecimalAmount('0', 255), '0')
  })
  test('keeps arithmetic base-unit conversion separate from grouped display output', () => {
    expect(formatBaseUnitDecimalAmount('1234567890000000000000', 18)).toBe('1234.56789')
    expect(formatBaseUnitAmount('1234567890000000000000', 18, 4)).toBe('1,234.5678…')
  })
  test('formats base units without converting through JavaScript numbers', () => {
    expect(formatBaseUnitAmount('123456789', 6)).toBe('123.456789')
    expect(formatBaseUnitAmount('123456789012345678901234567890', 0)).toBe(
      '123,456,789,012,345,678,901,234,567,890'
    )
  })

  test('truncates display precision without rounding spendable values up', () => {
    expect(formatBaseUnitAmount('123456789', 8, 6)).toBe('1.234567…')
    expect(formatBaseUnitAmount('1', 18, 6)).toBe('< 0.000001')
  })

  test('removes insignificant fractional zeroes', () => {
    expect(formatBaseUnitAmount('100000000', 8)).toBe('1')
    expect(formatBaseUnitAmount('100100000', 8)).toBe('1.001')
  })

  test('rejects invalid amounts and decimal metadata', () => {
    expect(() => formatBaseUnitAmount('-1', 8)).toThrow(/Invalid base-unit amount/)
    expect(() => formatBaseUnitAmount('01', 8)).toThrow(/Invalid base-unit amount/)
    expect(() => formatBaseUnitAmount('1', 256)).toThrow(/Invalid base-unit amount/)
    expect(() => formatBaseUnitAmount('1', 8, 0)).toThrow(/Invalid base-unit amount/)
  })
})

test.describe('Transaction amount parsing', () => {
  test('converts decimal display values without floating-point arithmetic', () => {
    expect(parseDisplayUnitAmount('1', 18)).toBe('1000000000000000000')
    expect(parseDisplayUnitAmount('0.001', 18)).toBe('1000000000000000')
    expect(parseDisplayUnitAmount('12.340001', 6)).toBe('12340001')
    expect(parseDisplayUnitAmount('0', 0)).toBe('0')
  })

  test('rejects ambiguous or over-precise values', () => {
    expect(() => parseDisplayUnitAmount('01', 18)).toThrow(/Invalid display-unit amount/)
    expect(() => parseDisplayUnitAmount('1e-3', 18)).toThrow(/Invalid display-unit amount/)
    expect(() => parseDisplayUnitAmount('1.0000001', 6)).toThrow(/asset precision/)
    expect(() => parseDisplayUnitAmount('.1', 18)).toThrow(/Invalid display-unit amount/)
  })
})
