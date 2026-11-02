import { test } from 'node:test'
import { expect } from '@playwright/test'
import { parseAccountPortfolioValueSnapshot } from '../../../src/core/wallet/account-portfolio-value.ts'

test('validates persisted Account Portfolio values at the storage boundary', () => {
  expect(
    parseAccountPortfolioValueSnapshot({
      totalUsd: '12.3400',
      updatedAt: 123,
      complete: true
    })
  ).toEqual({ totalUsd: '12.34', updatedAt: 123, complete: true })

  expect(
    parseAccountPortfolioValueSnapshot({
      totalUsd: '-1',
      updatedAt: 123,
      complete: true
    })
  ).toBeNull()
  expect(
    parseAccountPortfolioValueSnapshot({
      totalUsd: '1',
      updatedAt: 123,
      complete: true,
      unexpected: true
    })
  ).toBeNull()
})
