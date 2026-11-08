import { test } from 'node:test'
import { expect } from '@playwright/test'
import { AutoLockCoordinator } from '../../../src/background/auto-lock.ts'

function setup({
  autoLockMs = 60_000,
  lastActivityTime = 1_000,
  session = true,
  runtimeUnlocked = session,
  renewSessionOnCleanup = false,
  orphanLockFails = false,
  lockFails = false,
  now = 2_000
} = {}) {
  const calls = []
  const coordinator = new AutoLockCoordinator({
    readAutoLockMs: async () => autoLockMs,
    readLastActivityTime: async () => lastActivityTime,
    hasUnlockSession: async () => session,
    hasUnlockedRuntime: () => runtimeUnlocked,
    lockOrphanedRuntime: async () => {
      if (orphanLockFails) throw new Error('Wallet lock cleanup failed')
      if (renewSessionOnCleanup) {
        session = true
        return 'active'
      }
      runtimeUnlocked = false
      calls.push(['lock-orphaned'])
      return 'locked'
    },
    lock: async () => {
      if (lockFails) throw new Error('Wallet lock cleanup failed')
      runtimeUnlocked = false
      calls.push(['lock'])
      return 'locked'
    },
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

  test('reschedules when a queued unlock renews the expired session', async () => {
    let reads = 0
    const calls = []
    const coordinator = new AutoLockCoordinator({
      readAutoLockMs: async () => 1_000,
      readLastActivityTime: async () => (++reads === 1 ? 1_000 : 6_500),
      hasUnlockSession: async () => true,
      hasUnlockedRuntime: () => true,
      lockOrphanedRuntime: async () => 'locked',
      lock: async () => {
        calls.push(['lock-check'])
        return 'active'
      },
      scheduleAlarm: async when => calls.push(['schedule', when]),
      clearAlarm: async () => calls.push(['clear']),
      now: () => 7_000
    })
    await expect(coordinator.reconcile()).resolves.toBe('scheduled')
    expect(calls).toEqual([['lock-check'], ['schedule', 7_500]])
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

  test('locks an orphaned Zcash runtime even after activity is refreshed', async () => {
    const { coordinator, calls } = setup({
      session: false,
      runtimeUnlocked: true,
      lastActivityTime: 4_000,
      now: 4_001
    })
    await expect(coordinator.reconcile()).resolves.toBe('locked')
    expect(calls).toEqual([['lock-orphaned'], ['clear']])
  })

  test('rechecks a session established by an in-flight unlock', async () => {
    const { coordinator, calls } = setup({
      session: false,
      runtimeUnlocked: true,
      renewSessionOnCleanup: true
    })
    await expect(coordinator.reconcile()).resolves.toBe('scheduled')
    expect(calls).toEqual([['schedule', 61_000]])
  })

  test('keeps an active hardware-only session scheduled', async () => {
    const { coordinator, calls } = setup({ runtimeUnlocked: false })
    await expect(coordinator.reconcile()).resolves.toBe('scheduled')
    expect(calls).toEqual([['schedule', 61_000]])
  })

  test('disabled inactivity locking still clears an orphaned runtime', async () => {
    const { coordinator, calls } = setup({
      autoLockMs: 0,
      session: false,
      runtimeUnlocked: true
    })
    await expect(coordinator.reconcile()).resolves.toBe('locked')
    expect(calls).toEqual([['lock-orphaned'], ['clear']])
  })

  test('retries cleanup when an orphaned runtime cannot be locked', async () => {
    const { coordinator, calls } = setup({
      session: false,
      runtimeUnlocked: true,
      orphanLockFails: true
    })
    await expect(coordinator.reconcile()).rejects.toThrow('Wallet lock cleanup failed')
    expect(calls).toEqual([['schedule', 62_000]])
  })

  test('retries cleanup when an expired session cannot be locked', async () => {
    const { coordinator, calls } = setup({ autoLockMs: 1_000, now: 2_000, lockFails: true })
    await expect(coordinator.reconcile()).rejects.toThrow('Wallet lock cleanup failed')
    expect(calls).toEqual([['schedule', 62_000]])
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
      hasUnlockedRuntime: () => true,
      lockOrphanedRuntime: async () => 'locked',
      lock: async () => {
        calls.push(['lock'])
        return 'locked'
      },
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
