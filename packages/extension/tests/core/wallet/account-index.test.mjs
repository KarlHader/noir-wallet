import { test } from 'node:test'
import { expect } from '@playwright/test'

import { selectNextZcashAccountIndex } from '../../../src/core/wallet/account-index.ts'

test.describe('Zcash account index selection', () => {
  test('starts at zero for a new wallet', () => {
    expect(selectNextZcashAccountIndex([], [])).toBe(0)
  })

  test('does not reuse an index retained only in the WASM snapshot', () => {
    expect(selectNextZcashAccountIndex([0, 1], [0, 1, 4])).toBe(5)
  })

  test('uses metadata when it is ahead of the persisted WASM snapshot', () => {
    expect(selectNextZcashAccountIndex([0, 3], [0, null])).toBe(4)
  })

  test('rejects malformed or exhausted indexes', () => {
    expect(() => selectNextZcashAccountIndex([-1], [])).toThrow(/invalid/i)
    expect(() => selectNextZcashAccountIndex([], [1.5])).toThrow(/invalid/i)
    expect(() => selectNextZcashAccountIndex([0x7fffffff], [])).toThrow(/exhausted/i)
  })
})
