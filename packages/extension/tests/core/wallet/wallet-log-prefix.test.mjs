import { test } from 'node:test'
import { expect } from '@playwright/test'

import { formatLogError, formatWalletLogPrefix } from '../../../src/lib/log-format.ts'

test('formats wallet logs with the final four account ID characters', () => {
  expect(formatWalletLogPrefix('Wallet 4', 'account-12345678')).toBe('[Wallet 4:5678]')
  expect(formatWalletLogPrefix('Savings', 'abc')).toBe('[Savings:abc]')
})

test('keeps wallet-only logs concise when no account context exists', () => {
  expect(formatWalletLogPrefix('Wallet 2')).toBe('[Wallet 2]')
})

test('retains error identity and context for diagnostics', () => {
  expect(formatLogError(new TypeError('invalid response'))).toBe('TypeError: invalid response')
  expect(formatLogError('provider rejected')).toBe('Unknown error')
})
