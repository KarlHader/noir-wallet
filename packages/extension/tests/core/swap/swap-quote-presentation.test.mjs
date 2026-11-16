import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  getSwapQuoteFeeUsd,
  isSwapQuoteFresh,
  LIVE_QUOTE_MAX_AGE_MS
} from '../../../src/popup/pages/swap/swap-quote-presentation.ts'

test('derives the displayed quote cost from provider USD input and output values', () => {
  expect(getSwapQuoteFeeUsd({ amountInUsd: '25', amountOutUsd: '24.12' })).toBe('0.88')
  expect(getSwapQuoteFeeUsd({ amountInUsd: '25', amountOutUsd: '25.01' })).toBeNull()
  expect(getSwapQuoteFeeUsd({ amountInUsd: undefined, amountOutUsd: '24' })).toBeNull()
  expect(getSwapQuoteFeeUsd({ amountInUsd: 'invalid', amountOutUsd: '24' })).toBeNull()
})

test('accepts a quote through 30 seconds and rejects older or nearly expired quotes', () => {
  const receivedAt = Date.parse('2026-08-26T08:00:00.000Z')
  const quote = { deadline: '2026-08-26T08:05:00.000Z' }
  expect(isSwapQuoteFresh(quote, receivedAt, receivedAt + LIVE_QUOTE_MAX_AGE_MS)).toBe(true)
  expect(isSwapQuoteFresh(quote, receivedAt, receivedAt + LIVE_QUOTE_MAX_AGE_MS + 1)).toBe(false)
  expect(
    isSwapQuoteFresh(
      { deadline: '2026-08-26T08:00:34.999Z' },
      receivedAt,
      receivedAt + LIVE_QUOTE_MAX_AGE_MS
    )
  ).toBe(false)
})
