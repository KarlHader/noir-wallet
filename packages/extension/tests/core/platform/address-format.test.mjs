import { test } from 'node:test'
import { expect } from '@playwright/test'

import { formatSortAddress } from '../../../src/lib/format.ts'

test('keeps missing and short addresses intact without overlapping segments', () => {
  for (const address of [undefined, '', 'a', 'alice.near', '12345678901', '123456789012']) {
    expect(formatSortAddress(address)).toBe(address ?? '')
  }
})

test('abbreviates addresses over twelve characters to six characters on each side', () => {
  expect(formatSortAddress('1234567890123')).toBe('123456...890123')
  expect(formatSortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234...345678')
  expect(formatSortAddress('long-account.near')).toBe('long-a...t.near')
})

test('preserves descriptive placeholders instead of abbreviating them as addresses', () => {
  expect(formatSortAddress('Address unavailable')).toBe('Address unavailable')
  expect(formatSortAddress('External (recipient)')).toBe('External (recipient)')
})
