import { test } from 'node:test'
import { expect } from '@playwright/test'
import { parseAccountPortfolioValueSnapshot } from '../../../src/core/wallet/account-portfolio-value.ts'

test('validates persisted Account Portfolio values at the storage boundary', () => {
  expect(
    parseAccountPortfolioValueSnapshot({
      valuationBasis: 'wallet-assets-v1',
      totalUsd: '12.3400',
      updatedAt: 123,
      complete: true
    })
  ).toEqual({
    valuationBasis: 'wallet-assets-v1',
    totalUsd: '12.34',
    updatedAt: 123,
    complete: false
  })

  expect(
    parseAccountPortfolioValueSnapshot({
      valuationBasis: 'wallet-assets-v2',
      totalUsd: '12.3400',
      updatedAt: 123,
      complete: true
    })
  ).toEqual({
    valuationBasis: 'wallet-assets-v2',
    totalUsd: '12.34',
    updatedAt: 123,
    complete: true
  })

  expect(
    parseAccountPortfolioValueSnapshot({ totalUsd: '3750', updatedAt: 123, complete: true })
  ).toBeNull()

  expect(
    parseAccountPortfolioValueSnapshot({
      valuationBasis: 'wallet-assets-v1',
      totalUsd: '-1',
      updatedAt: 123,
      complete: true
    })
  ).toBeNull()
  expect(
    parseAccountPortfolioValueSnapshot({
      valuationBasis: 'wallet-assets-v1',
      totalUsd: '1',
      updatedAt: 123,
      complete: true,
      unexpected: true
    })
  ).toBeNull()
})
