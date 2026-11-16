import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  getAccountNameValidationError,
  normalizeAccountName
} from '../../../src/core/wallet/account-name.ts'

test.describe('Account name', () => {
  test('normalizes a user-entered account name at the provisioning boundary', () => {
    expect(normalizeAccountName('  Savings  ')).toBe('Savings')
    expect(normalizeAccountName('e\u0301')).toBe('é')
  })

  test('rejects blank, unsafe, and oversized names', () => {
    expect(getAccountNameValidationError('   ')).toMatch(/1-128/)
    expect(getAccountNameValidationError('bad\u202ename')).toMatch(/1-128/)
    expect(getAccountNameValidationError('a'.repeat(129))).toMatch(/1-128/)
    expect(getAccountNameValidationError('Primary')).toBeNull()
  })
})
