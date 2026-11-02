import { test } from 'node:test'
import { expect } from '@playwright/test'
import { AutoLockCoordinator } from '../../../src/background/auto-lock.ts'

function setup({
  autoLockMs = 60_000,
  lastActivityTime = 1_000,
  session = true,
  now = 2_000
} = {}) {
  const calls = []
  const coordinator = new AutoLockCoordinator({
    readAutoLockMs: async () => autoLockMs,
    readLastActivityTime: async () => lastActivityTime,
    hasUnlockSession: async () => session,
    lock: async () => calls.push(['lock']),
    scheduleAlarm: async when => calls.push(['schedule', when]),
    clearAlarm: async () => calls.push(['clear']),
    now: () => now
  })
  return { coordinator, calls }
}

test.describe('Background auto-lock coordinator', () => {
  test('schedules from persisted user activity instead of process lifetime', async () => {
    const { coordinator, calls } = setup()
    await expect(coordinator.reconcile()).resolves.toBe('scheduled')
    expect(calls).toEqual([['schedule', 61_000]])
  })

  test('locks an expired session and clears the alarm', async () => {
    const { coordinator, calls } = setup({ autoLockMs: 1_000, now: 2_000 })
    await expect(coordinator.reconcile()).resolves.toBe('locked')
    expect(calls).toEqual([['lock'], ['clear']])
  })

  test('autoLockMs zero only disables inactivity locking', async () => {
    const { coordinator, calls } = setup({ autoLockMs: 0, now: 10_000 })
    await expect(coordinator.reconcile()).resolves.toBe('disabled')
    expect(calls).toEqual([['clear']])
  })

  test('does not schedule without a live unlock session', async () => {
    const { coordinator, calls } = setup({ session: false })
    await expect(coordinator.reconcile()).resolves.toBe('no-session')
    expect(calls).toEqual([['clear']])
  })

  test('shares the in-flight promise and drains a concurrent reconciliation request', async () => {
    let resolveFirstSettings
    let reads = 0
    const calls = []
    const coordinator = new AutoLockCoordinator({
      readAutoLockMs: () => {
        reads += 1
        if (reads > 1) return Promise.resolve(60_000)
        return new Promise(resolve => {
          resolveFirstSettings = resolve
        })
      },
      readLastActivityTime: async () => 1_000,
      hasUnlockSession: async () => true,
      lock: async () => calls.push(['lock']),
      scheduleAlarm: async when => calls.push(['schedule', when]),
      clearAlarm: async () => calls.push(['clear']),
      now: () => 2_000
    })
    const first = coordinator.reconcile()
    const second = coordinator.reconcile()
    expect(first).toBe(second)
    resolveFirstSettings(60_000)
    await expect(first).resolves.toBe('scheduled')
    expect(reads).toBe(2)
    expect(calls).toEqual([
      ['schedule', 61_000],
      ['schedule', 61_000]
    ])
  })
})
