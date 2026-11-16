import { test } from 'node:test'
import { expect } from '@playwright/test'

import { shouldSchedulePassiveSync } from '../../../src/background/passive-sync-policy.ts'

test('schedules passive sync only for stale, idle wallet state', () => {
  const base = {
    now: 100_000,
    maxAgeMs: 30_000,
    isSchedulerRunning: false
  }

  expect(shouldSchedulePassiveSync({ ...base, lastSyncTime: null })).toBe(true)
  expect(shouldSchedulePassiveSync({ ...base, lastSyncTime: 60_000 })).toBe(true)
  expect(shouldSchedulePassiveSync({ ...base, lastSyncTime: 80_000 })).toBe(false)
  expect(
    shouldSchedulePassiveSync({ ...base, lastSyncTime: 60_000, isSchedulerRunning: true })
  ).toBe(false)
})
