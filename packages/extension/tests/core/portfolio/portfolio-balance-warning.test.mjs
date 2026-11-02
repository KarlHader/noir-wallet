import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  getPortfolioRecoveryDelayMs,
  hasPortfolioBalanceRefreshIssue
} from '../../../src/popup/components/portfolio/portfolio-recovery.ts'

function chain(displayName, status, errorCodes = []) {
  return { chain: { displayName }, status, errorCodes }
}

test.describe('Portfolio automatic recovery', () => {
  test('does not retry cached loading or ready chains', () => {
    expect(
      hasPortfolioBalanceRefreshIssue([chain('Ethereum', 'ready'), chain('Bitcoin', 'loading')])
    ).toBe(false)
  })

  test('retries a complete network failure', () => {
    expect(
      hasPortfolioBalanceRefreshIssue([
        chain('Ethereum', 'error', ['network-unavailable']),
        chain('Bitcoin', 'ready')
      ])
    ).toBe(true)
  })

  test('retries individual asset failures', () => {
    expect(
      hasPortfolioBalanceRefreshIssue([
        chain('Ethereum', 'partial', ['rate-limited']),
        chain('Base', 'partial', ['invalid-response'])
      ])
    ).toBe(true)
  })

  test('backs off retries and caps the delay', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(getPortfolioRecoveryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000
    ])
    expect(() => getPortfolioRecoveryDelayMs(-1)).toThrow(/Invalid Portfolio recovery attempt/)
  })
})
