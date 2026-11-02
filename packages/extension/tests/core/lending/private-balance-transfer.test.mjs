import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  normalizePrivateBalanceTransferInput,
  resolvePrivateBalanceTransferAmount
} from '../../../src/popup/services/private-balance-transfer.ts'

test('validates a bidirectional transfer amount against the selected source balance', () => {
  expect(
    resolvePrivateBalanceTransferAmount({
      amount: '1.25',
      decimals: 6,
      availableRaw: '2500000',
      sourceLabel: 'Public'
    })
  ).toEqual({ amountRaw: '1250000', error: null })
  expect(
    resolvePrivateBalanceTransferAmount({
      amount: '3',
      decimals: 6,
      availableRaw: '2500000',
      sourceLabel: 'Confidential'
    })
  ).toEqual({ amountRaw: null, error: 'Amount exceeds the Confidential balance' })
})

test('keeps empty and incomplete amounts non-submittable without an error', () => {
  for (const amount of ['', '.', '0', '0.', '0.00']) {
    expect(
      resolvePrivateBalanceTransferAmount({
        amount,
        decimals: 6,
        availableRaw: '2500000',
        sourceLabel: 'Public'
      })
    ).toEqual({ amountRaw: null, error: null })
  }
})

test('rejects excess precision, exponent notation, and oversized input', () => {
  expect(
    resolvePrivateBalanceTransferAmount({
      amount: '0.0000001',
      decimals: 6,
      availableRaw: '2500000',
      sourceLabel: 'Public'
    }).error
  ).toBe('Enter a valid amount')
  expect(normalizePrivateBalanceTransferInput('1e3')).toBeNull()
  expect(normalizePrivateBalanceTransferInput('1'.repeat(129))).toBeNull()
})
