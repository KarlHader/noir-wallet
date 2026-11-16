import { test } from 'node:test'
import { expect } from '@playwright/test'

import { estimateSwapOutputFromPrices } from '../../../src/popup/components/swap/swap-estimate.ts'

test.describe('Swap provisional price estimate', () => {
  test('estimates the output from validated token catalog prices', () => {
    expect(
      estimateSwapOutputFromPrices({
        amountIn: '2.5',
        tokenInPrice: 40,
        tokenOutPrice: 1
      })
    ).toBe('100')

    expect(
      estimateSwapOutputFromPrices({
        amountIn: '1',
        tokenInPrice: 1,
        tokenOutPrice: 2_000
      })
    ).toBe('0.0005')
  })

  test('does not estimate without a positive amount and both usable prices', () => {
    for (const input of [
      { amountIn: '', tokenInPrice: 40, tokenOutPrice: 1 },
      { amountIn: '0', tokenInPrice: 40, tokenOutPrice: 1 },
      { amountIn: '-1', tokenInPrice: 40, tokenOutPrice: 1 },
      { amountIn: '1', tokenInPrice: 0, tokenOutPrice: 1 },
      { amountIn: '1', tokenInPrice: 40, tokenOutPrice: 0 },
      { amountIn: '1', tokenInPrice: Number.NaN, tokenOutPrice: 1 }
    ]) {
      expect(estimateSwapOutputFromPrices(input)).toBe('')
    }
  })
})
