/** Durable, bounded collector outbox owned by the background service worker. */
import { CUSTOM_ANALYTICS_CONFIG } from '../../config/analytics.ts'
import { encryptAnalyticsPayload } from './crypto.ts'
import {
  addAnalyticsOutboxEntry,
  parseAnalyticsOutbox,
  settleAnalyticsOutboxBatch,
  type AnalyticsOutboxState
} from './outbox.ts'
import type { AnalyticsEventPayload } from './types.ts'

export const ANALYTICS_OUTBOX_ALARM = 'analytics-collector-outbox'
const STORAGE_KEY = 'analytics_collector_outbox_v1'
const FLUSH_DELAY_MS = 2_000
const RETRY_DELAY_MS = 15_000
const FETCH_TIMEOUT_MS = 10_000
const MAX_BATCH_SIZE = 20
const MAX_RECENT_DELIVERIES = 500

let state: AnalyticsOutboxState | null = null
let loadPromise: Promise<AnalyticsOutboxState> | null = null
let operationQueue: Promise<unknown> = Promise.resolve()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushAt: number | null = null
let isFlushing = false
let activeAbortController: AbortController | null = null
const recentDeliveredKeys = new Set<string>()

function rememberDeliveredKeys(keys: readonly string[]): void {
  for (const key of keys) {
    recentDeliveredKeys.delete(key)
    recentDeliveredKeys.add(key)
    if (recentDeliveredKeys.size > MAX_RECENT_DELIVERIES) {
      const oldest = recentDeliveredKeys.values().next().value
      if (oldest) recentDeliveredKeys.delete(oldest)
    }
  }
}

function runOutboxOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation)
  operationQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function loadOutbox(): Promise<AnalyticsOutboxState> {
  if (state) return state
  if (loadPromise) return loadPromise
  loadPromise = chrome.storage.local.get(STORAGE_KEY).then(result => {
    state = parseAnalyticsOutbox(result[STORAGE_KEY], Date.now())
    return state
  })
  try {
    return await loadPromise
  } finally {
    loadPromise = null
  }
}

async function updateOutbox(
  update: (current: AnalyticsOutboxState) => AnalyticsOutboxState
): Promise<AnalyticsOutboxState> {
  return runOutboxOperation(async () => {
    const next = update(await loadOutbox())
    await chrome.storage.local.set({ [STORAGE_KEY]: next })
    state = next
    return next
  })
}

function scheduleFlush(delayMs: number): void {
  const nextAt = Date.now() + delayMs
  if (flushTimer && flushAt !== null && flushAt <= nextAt) return
  if (flushTimer) clearTimeout(flushTimer)
  flushAt = nextAt
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushAt = null
    void flushAnalyticsOutbox().catch(() => {})
  }, delayMs)
  // An alarm survives service-worker suspension; the timer handles the fast path.
  void chrome.alarms?.create(ANALYTICS_OUTBOX_ALARM, { delayInMinutes: 1 }).catch(() => {})
}

function cancelScheduledFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  flushAt = null
  void chrome.alarms?.clear(ANALYTICS_OUTBOX_ALARM).catch(() => {})
}

async function hashIdempotencyKey(name: string, key: string): Promise<string> {
  const data = new TextEncoder().encode(`${name}:${key}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Queues an event for collector delivery without exposing delivery state to callers. */
export async function enqueueAnalyticsEvent(
  payload: AnalyticsEventPayload,
  idempotencyKey?: string
): Promise<void> {
  if (!CUSTOM_ANALYTICS_CONFIG.cryptoPassword) return
  const key = idempotencyKey
    ? await hashIdempotencyKey(payload.event_name, idempotencyKey)
    : undefined
  const now = Date.now()
  const { next, result } = await runOutboxOperation(async () => {
    const current = await loadOutbox()
    if (key && recentDeliveredKeys.has(key)) {
      return { next: current, result: 'duplicate' as const }
    }
    const result = addAnalyticsOutboxEntry(
      current,
      { id: crypto.randomUUID(), payload, idempotencyKey: key, attempts: 0, createdAt: now },
      now
    )
    if (result.result !== 'added') return { next: current, result: result.result }
    await chrome.storage.local.set({ [STORAGE_KEY]: result.state })
    state = result.state
    return { next: result.state, result: result.result }
  })
  if (result === 'full') scheduleFlush(0)
  if (result === 'added') scheduleFlush(next.entries.length >= MAX_BATCH_SIZE ? 0 : FLUSH_DELAY_MS)
}

/** Rehydrate pending events after worker startup. The background should call this once. */
export async function initializeAnalyticsOutbox(): Promise<void> {
  if (!CUSTOM_ANALYTICS_CONFIG.cryptoPassword) return
  const loaded = await runOutboxOperation(loadOutbox)
  if (loaded.entries.length > 0) scheduleFlush(0)
}

/** Call from the background chrome.alarms listener for ANALYTICS_OUTBOX_ALARM. */
export async function handleAnalyticsOutboxAlarm(alarmName: string): Promise<boolean> {
  if (alarmName !== ANALYTICS_OUTBOX_ALARM) return false
  await flushAnalyticsOutbox()
  return true
}

/** Attempts one persisted batch; only a valid collector code 0 acknowledges it. */
export async function flushAnalyticsOutbox(): Promise<void> {
  if (isFlushing || !CUSTOM_ANALYTICS_CONFIG.cryptoPassword) return
  isFlushing = true
  let failed = false
  try {
    const batch = await runOutboxOperation(async () =>
      (await loadOutbox()).entries.slice(0, MAX_BATCH_SIZE)
    )
    if (batch.length === 0) {
      cancelScheduledFlush()
      return
    }

    const abortController = new AbortController()
    activeAbortController = abortController
    let acknowledged = false
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      const encryptedData = await encryptAnalyticsPayload(
        JSON.stringify(batch.map(entry => entry.payload)),
        CUSTOM_ANALYTICS_CONFIG.cryptoPassword
      )
      if (abortController.signal.aborted) return
      timeout = setTimeout(() => {
        timedOut = true
        abortController.abort()
      }, FETCH_TIMEOUT_MS)
      const response = await fetch(CUSTOM_ANALYTICS_CONFIG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: encryptedData }),
        signal: abortController.signal
      })
      const body: unknown = response.ok ? await response.json() : null
      acknowledged = Boolean(
        response.ok && body && typeof body === 'object' && (body as { code?: unknown }).code === 0
      )
      failed = !acknowledged
    } catch {
      if (abortController.signal.aborted && !timedOut) return
      failed = true
    } finally {
      if (timeout) clearTimeout(timeout)
      if (activeAbortController === abortController) activeAbortController = null
    }

    const next = await updateOutbox(current =>
      settleAnalyticsOutboxBatch(
        current,
        batch.map(entry => entry.id),
        acknowledged,
        Date.now()
      )
    )
    if (acknowledged) {
      rememberDeliveredKeys(
        batch.flatMap(entry => (entry.idempotencyKey ? [entry.idempotencyKey] : []))
      )
    }
    if (next.entries.length > 0) scheduleFlush(failed ? RETRY_DELAY_MS : FLUSH_DELAY_MS)
    else cancelScheduledFlush()
  } catch {
    scheduleFlush(RETRY_DELAY_MS)
  } finally {
    isFlushing = false
  }
}

/** Drops pending events and aborts an active upload. */
export async function clearAnalyticsQueue(): Promise<void> {
  cancelScheduledFlush()
  activeAbortController?.abort()
  activeAbortController = null
  recentDeliveredKeys.clear()
  await updateOutbox(current => ({ ...current, entries: [] }))
}
