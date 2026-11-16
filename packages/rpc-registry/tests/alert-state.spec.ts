import { expect, test } from '@playwright/test'
import {
  advanceMonitorState,
  createEmptySnapshot,
  markNotificationSent,
  REMINDER_INTERVAL_MS,
  type MonitorSnapshot
} from '../src/alert-state'
import type { CheckName, ProbeResult } from '../src/types'

test('opens after two failed runs, reminds after one hour, and recovers after two successes', () => {
  let snapshot = createEmptySnapshot()

  const firstFailure = advanceMonitorState(snapshot, [failure('deltarpc')], 1_000)
  expect(firstFailure.notifications).toEqual([])

  const opened = advanceMonitorState(firstFailure.snapshot, [failure('deltarpc')], 3_000)
  expect(opened.notifications).toHaveLength(1)
  expect(opened.notifications[0].kind).toBe('opened')
  snapshot = markNotificationSent(opened.snapshot, opened.notifications[0], 3_000)

  const beforeReminder = advanceMonitorState(
    snapshot,
    [failure('deltarpc')],
    3_000 + REMINDER_INTERVAL_MS - 1
  )
  expect(beforeReminder.notifications).toEqual([])

  const reminder = advanceMonitorState(
    beforeReminder.snapshot,
    [failure('deltarpc')],
    3_000 + REMINDER_INTERVAL_MS
  )
  expect(reminder.notifications[0].kind).toBe('reminder')
  snapshot = markNotificationSent(
    reminder.snapshot,
    reminder.notifications[0],
    3_000 + REMINDER_INTERVAL_MS
  )

  const firstSuccess = advanceMonitorState(snapshot, [success('deltarpc')], 2_000_000)
  expect(firstSuccess.notifications).toEqual([])
  const recovered = advanceMonitorState(firstSuccess.snapshot, [success('deltarpc')], 2_001_000)
  expect(recovered.notifications[0].kind).toBe('recovery')
})

test('retries an unsent opening notification on the next run', () => {
  const firstFailure = advanceMonitorState(createEmptySnapshot(), [failure('deltarpc')], 1)
  const snapshot = advanceMonitorState(firstFailure.snapshot, [failure('deltarpc')], 2).snapshot

  const retry = advanceMonitorState(snapshot, [failure('deltarpc')], 3)
  expect(retry.notifications).toHaveLength(1)
  expect(retry.notifications[0].kind).toBe('opened')
})

test('suppresses an isolated failed run and resets the failure streak after recovery', () => {
  const firstFailure = advanceMonitorState(createEmptySnapshot(), [failure('deltarpc')], 1)
  expect(firstFailure.notifications).toEqual([])

  const recovered = advanceMonitorState(firstFailure.snapshot, [success('deltarpc')], 2)
  expect(recovered.notifications).toEqual([])

  const nextFailure = advanceMonitorState(recovered.snapshot, [failure('deltarpc')], 3)
  expect(nextFailure.notifications).toEqual([])
  expect(nextFailure.snapshot.checks['zcash-mainnet:deltarpc:GetLatestBlock']).toMatchObject({
    consecutiveFailures: 1,
    incidentOpen: false
  })
})

test('aggregates checks from multiple providers into one notification', () => {
  const snapshot: MonitorSnapshot = createEmptySnapshot()
  const firstFailure = advanceMonitorState(
    snapshot,
    [failure('deltarpc', 'GetSubtreeRoots'), failure('chainsafe', 'GetSubtreeRoots')],
    1
  )
  const { notifications } = advanceMonitorState(
    firstFailure.snapshot,
    [failure('deltarpc', 'GetSubtreeRoots'), failure('chainsafe', 'GetSubtreeRoots')],
    2
  )

  expect(notifications).toHaveLength(1)
  expect(notifications[0].kind).toBe('opened')
  expect(notifications[0].items.map(item => item.targetId)).toEqual(['chainsafe', 'deltarpc'])
})

function failure(targetId: string, check: CheckName = 'GetLatestBlock'): ProbeResult {
  return {
    chainId: 'zcash-mainnet',
    chain: 'zcash',
    network: 'mainnet',
    targetId,
    targetLabel: targetId === 'deltarpc' ? 'DeltaRPC' : 'ChainSafe',
    check,
    outcome: 'failure',
    attempts: 3,
    elapsedMs: 8_000,
    error: 'Timed out',
    observedHeight: 3_100_000
  }
}

function success(targetId: string, check: CheckName = 'GetLatestBlock'): ProbeResult {
  return {
    chainId: 'zcash-mainnet',
    chain: 'zcash',
    network: 'mainnet',
    targetId,
    targetLabel: targetId === 'deltarpc' ? 'DeltaRPC' : 'ChainSafe',
    check,
    outcome: 'success',
    attempts: 1,
    elapsedMs: 120,
    observedHeight: 3_100_001
  }
}
