import { test } from 'node:test'
import { expect } from '@playwright/test'

import { formatSwapQuoteError } from '../../../src/popup/pages/swap/swap-quote-error.ts'
import { formatBridgeMinimumAmountError } from '../../../src/popup/services/quote-minimum-error.ts'

test.describe('Swap quote error presentation', () => {
  test('formats provider minimum amounts in display units', () => {
    expect(
      formatSwapQuoteError(
        'HTTP 400: Amount is too low for bridge, try at least 4445398762185558433',
        { symbol: 'ARB', decimals: 18 }
      )
    ).toBe('Enter at least 4.445398762185558433 ARB.')
  })

  test('removes transport jargon from other provider messages', () => {
    expect(formatSwapQuoteError('HTTP 400: Route is unavailable', null)).toBe(
      'Route is unavailable'
    )
  })

  test('formats a deposit minimum without exposing unrelated provider errors', () => {
    const zec = { symbol: 'ZEC', decimals: 8 }
    expect(
      formatBridgeMinimumAmountError('Amount is too low for bridge, try at least 132000', zec)
    ).toBe('Enter at least 0.00132 ZEC.')
    expect(formatBridgeMinimumAmountError('provider payload includes an address', zec)).toBeNull()
    expect(
      formatBridgeMinimumAmountError(
        `Amount is too low for bridge, try at least ${'9'.repeat(129)}`,
        zec
      )
    ).toBeNull()
    expect(
      formatBridgeMinimumAmountError('Amount is too low for bridge, try at least 132000', {
        symbol: 'ZEC',
        decimals: -1
      })
    ).toBeNull()
  })
})
