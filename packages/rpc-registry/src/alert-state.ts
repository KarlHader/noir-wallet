import type { CheckName, ProbeResult } from './types'
import { resultKey } from './types'

export const FAILURE_THRESHOLD = 2
export const RECOVERY_THRESHOLD = 2
export const REMINDER_INTERVAL_MS = 60 * 60 * 1_000

export interface CheckState {
  chainId: string
  chain: string
  network: string
  targetId: string
  targetLabel: string
  check: CheckName
  consecutiveFailures: number
  consecutiveSuccesses: number
  incidentOpen: boolean
  pendingRecovery: boolean
  incidentStartedAt?: number
  recoveredAt?: number
  lastAlertAt?: number
  lastSuccessAt?: number
  lastFailureAt?: number
  lastElapsedMs?: number
  lastAttempts?: number
  lastError?: string
  lastHeight?: number
}

export interface MonitorSnapshot {
  version: 2
  checks: Record<string, CheckState>
}

export type NotificationKind = 'opened' | 'reminder' | 'recovery'

export interface NotificationItem {
  key: string
  chainId: string
  chain: string
  network: string
  targetId: string
  targetLabel: string
  check: CheckName
  elapsedMs?: number
  attempts?: number
  error?: string
  lastHeight?: number
  incidentStartedAt?: number
  recoveredAt?: number
}

export interface PlannedNotification {
  kind: NotificationKind
  items: NotificationItem[]
}

export interface StateTransition {
  snapshot: MonitorSnapshot
  notifications: PlannedNotification[]
}

export function createEmptySnapshot(): MonitorSnapshot {
  return { version: 2, checks: {} }
}

export function parseStoredSnapshot(value: unknown): MonitorSnapshot {
  if (!value || typeof value !== 'object') return createEmptySnapshot()
  const candidate = value as Partial<MonitorSnapshot>
  if (candidate.version !== 2 || !candidate.checks || typeof candidate.checks !== 'object') {
    return createEmptySnapshot()
  }
  return cloneSnapshot(candidate as MonitorSnapshot)
}

export function advanceMonitorState(
  previous: MonitorSnapshot,
  results: ProbeResult[],
  now: number
): StateTransition {
  const snapshot = cloneSnapshot(previous)

  for (const result of results) {
    if (result.outcome === 'skipped') continue

    const key = resultKey(result)
    const state = snapshot.checks[key] ?? createCheckState(result)
    state.chainId = result.chainId
    state.chain = result.chain
    state.network = result.network
    state.targetId = result.targetId
    state.targetLabel = result.targetLabel
    state.check = result.check
    state.lastElapsedMs = result.elapsedMs
    state.lastAttempts = result.attempts
    if (result.observedHeight !== undefined) state.lastHeight = result.observedHeight

    if (result.outcome === 'success') {
      state.lastSuccessAt = now
      state.consecutiveFailures = 0
      state.consecutiveSuccesses += 1

      if (state.incidentOpen && state.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
        state.incidentOpen = false
        state.pendingRecovery = true
        state.recoveredAt = now
      }
    } else {
      state.lastFailureAt = now
      state.lastError = result.error ?? 'Unknown RPC failure'
      state.consecutiveSuccesses = 0
      state.consecutiveFailures += 1

      if (state.pendingRecovery) {
        state.pendingRecovery = false
        state.recoveredAt = undefined
        state.incidentOpen = true
      } else if (!state.incidentOpen && state.consecutiveFailures >= FAILURE_THRESHOLD) {
        state.incidentOpen = true
        state.incidentStartedAt = now
        state.lastAlertAt = undefined
      }
    }

    snapshot.checks[key] = state
  }

  return {
    snapshot,
    notifications: planNotifications(snapshot, now)
  }
}

export function markNotificationSent(
  previous: MonitorSnapshot,
  notification: PlannedNotification,
  sentAt: number
): MonitorSnapshot {
  const snapshot = cloneSnapshot(previous)

  for (const item of notification.items) {
    const state = snapshot.checks[item.key]
    if (!state) continue

    if (notification.kind === 'recovery') {
      state.pendingRecovery = false
      state.incidentStartedAt = undefined
      state.recoveredAt = undefined
      state.lastAlertAt = undefined
      state.lastError = undefined
      continue
    }

    if (state.incidentOpen) state.lastAlertAt = sentAt
  }

  return snapshot
}

function planNotifications(snapshot: MonitorSnapshot, now: number): PlannedNotification[] {
  const grouped: Record<NotificationKind, NotificationItem[]> = {
    opened: [],
    reminder: [],
    recovery: []
  }

  for (const [key, state] of Object.entries(snapshot.checks)) {
    const item = toNotificationItem(key, state)
    if (state.pendingRecovery) {
      grouped.recovery.push(item)
    } else if (state.incidentOpen && state.lastAlertAt === undefined) {
      grouped.opened.push(item)
    } else if (
      state.incidentOpen &&
      state.lastAlertAt !== undefined &&
      now - state.lastAlertAt >= REMINDER_INTERVAL_MS
    ) {
      grouped.reminder.push(item)
    }
  }

  return (['opened', 'reminder', 'recovery'] as const)
    .filter(kind => grouped[kind].length > 0)
    .map(kind => ({
      kind,
      items: grouped[kind].sort(compareNotificationItems)
    }))
}

function createCheckState(result: ProbeResult): CheckState {
  return {
    chainId: result.chainId,
    chain: result.chain,
    network: result.network,
    targetId: result.targetId,
    targetLabel: result.targetLabel,
    check: result.check,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    incidentOpen: false,
    pendingRecovery: false
  }
}

function toNotificationItem(key: string, state: CheckState): NotificationItem {
  return {
    key,
    chainId: state.chainId,
    chain: state.chain,
    network: state.network,
    targetId: state.targetId,
    targetLabel: state.targetLabel,
    check: state.check,
    elapsedMs: state.lastElapsedMs,
    attempts: state.lastAttempts,
    error: state.lastError,
    lastHeight: state.lastHeight,
    incidentStartedAt: state.incidentStartedAt,
    recoveredAt: state.recoveredAt
  }
}

function compareNotificationItems(left: NotificationItem, right: NotificationItem): number {
  return left.targetLabel.localeCompare(right.targetLabel) || left.check.localeCompare(right.check)
}

function cloneSnapshot(snapshot: MonitorSnapshot): MonitorSnapshot {
  return {
    version: 2,
    checks: Object.fromEntries(
      Object.entries(snapshot.checks).map(([key, state]) => [key, { ...state }])
    )
  }
}
