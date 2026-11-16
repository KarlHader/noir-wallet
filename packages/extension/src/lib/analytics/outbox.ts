import { ANALYTICS_EVENTS, resolveAnalyticsChain } from './constants.ts'
import type { AnalyticsEventPayload } from './types.ts'
import { sanitizeAnalyticsAmount } from './collector-metrics.ts'

export const MAX_OUTBOX_EVENTS = 200
export const MAX_OUTBOX_ATTEMPTS = 3
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const eventNames = new Set<string>(Object.values(ANALYTICS_EVENTS))

export interface OutboxEntry {
  id: string
  payload: AnalyticsEventPayload
  idempotencyKey?: string
  attempts: number
  createdAt: number
}

export interface AnalyticsOutboxState {
  version: 1
  entries: OutboxEntry[]
}

export function emptyAnalyticsOutbox(): AnalyticsOutboxState {
  return { version: 1, entries: [] }
}

function isPayload(value: unknown): value is AnalyticsEventPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<AnalyticsEventPayload>
  return (
    typeof payload.event_name === 'string' &&
    typeof payload.project_id === 'string' &&
    resolveAnalyticsChain(payload.chain) !== undefined &&
    typeof payload.page_id === 'string' &&
    typeof payload.timestamp === 'number' &&
    typeof payload.wallet_address === 'string' &&
    [payload.input_amount, payload.output_amount, payload.usd_amount].every(
      amount =>
        amount === '' || (typeof amount === 'string' && sanitizeAnalyticsAmount(amount) === amount)
    )
  )
}

export function pruneAnalyticsOutbox(
  state: AnalyticsOutboxState,
  now: number
): AnalyticsOutboxState {
  const fresh = (at: number) => Number.isFinite(at) && at <= now && now - at < OUTBOX_RETENTION_MS
  return {
    version: 1,
    entries: state.entries
      .filter(entry => eventNames.has(entry.payload.event_name) && fresh(entry.createdAt))
      .slice(0, MAX_OUTBOX_EVENTS)
  }
}

export function parseAnalyticsOutbox(value: unknown, now: number): AnalyticsOutboxState {
  if (!value || typeof value !== 'object') return emptyAnalyticsOutbox()
  const candidate = value as Partial<AnalyticsOutboxState>
  if (candidate.version !== 1) return emptyAnalyticsOutbox()
  const entries = Array.isArray(candidate.entries)
    ? candidate.entries.filter((entry): entry is OutboxEntry =>
        Boolean(
          entry &&
          typeof entry.id === 'string' &&
          entry.id.length <= 64 &&
          isPayload(entry.payload) &&
          Number.isInteger(entry.attempts) &&
          entry.attempts >= 0 &&
          entry.attempts < MAX_OUTBOX_ATTEMPTS &&
          typeof entry.createdAt === 'number' &&
          (entry.idempotencyKey === undefined ||
            (typeof entry.idempotencyKey === 'string' && entry.idempotencyKey.length <= 64))
        )
      )
    : []
  return pruneAnalyticsOutbox({ version: 1, entries }, now)
}

export function addAnalyticsOutboxEntry(
  state: AnalyticsOutboxState,
  entry: OutboxEntry,
  now: number
): { state: AnalyticsOutboxState; result: 'added' | 'duplicate' | 'full' } {
  const current = pruneAnalyticsOutbox(state, now)
  const key = entry.idempotencyKey
  if (key && current.entries.some(existing => existing.idempotencyKey === key)) {
    return { state: current, result: 'duplicate' }
  }
  if (current.entries.length >= MAX_OUTBOX_EVENTS) {
    return { state: current, result: 'full' }
  }
  return {
    state: { ...current, entries: [...current.entries, entry] },
    result: 'added'
  }
}

export function settleAnalyticsOutboxBatch(
  state: AnalyticsOutboxState,
  ids: readonly string[],
  acknowledged: boolean,
  now: number
): AnalyticsOutboxState {
  const selected = new Set(ids)
  const entries = state.entries.flatMap(entry => {
    if (!selected.has(entry.id)) return [entry]
    if (acknowledged) return []
    const attempts = entry.attempts + 1
    return attempts < MAX_OUTBOX_ATTEMPTS ? [{ ...entry, attempts }] : []
  })
  return pruneAnalyticsOutbox({ version: 1, entries }, now)
}
