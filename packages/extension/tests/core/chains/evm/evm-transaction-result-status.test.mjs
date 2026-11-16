import { test } from 'node:test'
import { expect } from '@playwright/test'

import { shouldApplyEvmTransactionStatus } from '../../../../src/popup/services/evm-transaction-result-status.ts'

function status(status, updatedAt = 1_100) {
  return { status, updatedAt }
}

test.describe('EVM transaction Result status reconciliation', () => {
  test('accepts normal progress and newer evidence for the same status', () => {
    expect(shouldApplyEvmTransactionStatus(status('broadcast'), status('confirming', 1_200))).toBe(
      true
    )
    expect(shouldApplyEvmTransactionStatus(status('confirming'), status('confirming', 1_200))).toBe(
      true
    )
  })

  test('shows a persisted pre-finality reorg without allowing other regressions', () => {
    expect(shouldApplyEvmTransactionStatus(status('confirming'), status('broadcast', 1_200))).toBe(
      true
    )
    expect(shouldApplyEvmTransactionStatus(status('broadcast'), status('signed', 1_200))).toBe(
      false
    )
  })

  test('rejects stale observations and never reopens terminal status', () => {
    expect(
      shouldApplyEvmTransactionStatus(status('broadcast', 1_200), status('confirming', 1_100))
    ).toBe(false)
    expect(shouldApplyEvmTransactionStatus(status('final'), status('broadcast', 1_200))).toBe(false)
    expect(shouldApplyEvmTransactionStatus(status('failed'), status('confirming', 1_200))).toBe(
      false
    )
  })

  test('accepts a newer failure unless finality already succeeded', () => {
    expect(shouldApplyEvmTransactionStatus(status('confirming'), status('failed', 1_200))).toBe(
      true
    )
    expect(shouldApplyEvmTransactionStatus(status('final'), status('failed', 1_200))).toBe(false)
  })
})
