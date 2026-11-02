import { test } from 'node:test'
import { expect } from '@playwright/test'

import { formatSwapQuoteError } from '../../../src/popup/pages/swap/swap-quote-error.ts'

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
})
