import { test } from 'node:test'
import { expect } from '@playwright/test'

import { shouldStartRoutineScan } from '../../../src/background/passive-sync-policy.ts'

test('routine scan age is measured from a successful completion, subject to cooldown', () => {
  const base = {
    now: 100_000,
    maxStaleMs: 30_000,
    minIntervalMs: 15_000,
    minBlockGap: 10,
    currentHeight: 100,
    networkHeight: 105
  }

  expect(shouldStartRoutineScan(base)).toBe(true)
  expect(shouldStartRoutineScan({ ...base, lastCompletedAt: 70_000 })).toBe(true)
  expect(shouldStartRoutineScan({ ...base, lastCompletedAt: 80_000 })).toBe(false)
  expect(shouldStartRoutineScan({ ...base, lastCompletedAt: 60_000, lastStartedAt: 85_001 })).toBe(
    false
  )
  expect(shouldStartRoutineScan({ ...base, networkHeight: 0 })).toBe(false)
})
