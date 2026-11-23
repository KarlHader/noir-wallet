import { test } from 'node:test'
import { expect } from '@playwright/test'

import { shouldApplyOnchainTransactionStatus } from '../../../src/popup/services/onchain-transaction-result-status.ts'

function status(status, updatedAt = 1_100) {
  return { status, updatedAt }
}

test.describe('On-chain transaction result status reconciliation', () => {
  test('accepts normal progress and newer evidence for the same status', () => {
    expect(
      shouldApplyOnchainTransactionStatus(status('broadcast'), status('confirming', 1_200))
    ).toBe(true)
    expect(
      shouldApplyOnchainTransactionStatus(status('confirming'), status('confirming', 1_200))
    ).toBe(true)
  })

  test('shows a persisted pre-finality reorg without allowing other regressions', () => {
    expect(
      shouldApplyOnchainTransactionStatus(status('confirming'), status('broadcast', 1_200))
    ).toBe(true)
    expect(shouldApplyOnchainTransactionStatus(status('broadcast'), status('signed', 1_200))).toBe(
      false
    )
  })

  test('rejects stale observations and never reopens terminal status', () => {
    expect(
      shouldApplyOnchainTransactionStatus(status('broadcast', 1_200), status('confirming', 1_100))
    ).toBe(false)
    expect(shouldApplyOnchainTransactionStatus(status('final'), status('broadcast', 1_200))).toBe(
      false
    )
    expect(shouldApplyOnchainTransactionStatus(status('failed'), status('confirming', 1_200))).toBe(
      false
    )
  })

  test('accepts a newer failure unless finality already succeeded', () => {
    expect(shouldApplyOnchainTransactionStatus(status('confirming'), status('failed', 1_200))).toBe(
      true
    )
    expect(shouldApplyOnchainTransactionStatus(status('final'), status('failed', 1_200))).toBe(
      false
    )
  })
})
