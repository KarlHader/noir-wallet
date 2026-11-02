import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseSupplyQuoteResult } from '../../../src/core/services/lending-supply-quote.ts'

function result(overrides = {}) {
  const quote = {
    amountIn: '100000000',
    amountOut: '99000000',
    minAmountOut: '98000000',
    amountInFormatted: '1',
    amountOutFormatted: '0.99',
    amountInUsd: '50',
    amountOutUsd: '49.5',
    depositAddress: 't1deposit',
    deadline: '2026-08-11T01:00:00.000Z',
    ...overrides
  }
  return {
    quoteStatus: 'success',
    quoteSuccessResult: { quote },
    depositAddress: quote.depositAddress
  }
}

test.describe('lending supply quote parsing', () => {
  test('reads the SDK top-level quote result and retains raw binding values', () => {
    expect(parseSupplyQuoteResult(result())).toEqual({
      depositAddress: 't1deposit',
      expectedReceived: '0.99',
      minAmountOut: '0.98',
      amountInRaw: '100000000',
      amountOutRaw: '99000000',
      minAmountOutRaw: '98000000',
      deadline: '2026-08-11T01:00:00.000Z'
    })
  })

  test('rejects the old nested shape, malformed values, and a substituted deposit address', () => {
    expect(() =>
      parseSupplyQuoteResult({
        depositAddress: 't1deposit',
        quoteResult: result()
      })
    ).toThrow(/quote response/)
    expect(() => parseSupplyQuoteResult(result({ amountOut: '-1' }))).toThrow(/output amount/)
    expect(() => parseSupplyQuoteResult({ ...result(), depositAddress: 't1substituted' })).toThrow(
      /does not match/
    )
  })

  test('formats minimum output using the destination market decimals', () => {
    expect(
      parseSupplyQuoteResult(
        result({ amountOut: '990000000000000000', minAmountOut: '980000000000000000' }),
        18
      ).minAmountOut
    ).toBe('0.98')
    expect(
      parseSupplyQuoteResult(result({ amountOut: '99', minAmountOut: '98' }), 0).minAmountOut
    ).toBe('98')
  })
})
