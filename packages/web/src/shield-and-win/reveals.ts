/**
 * Draw reveals. The server draws every eligible shield as soon as it is credited; the campaign
 * page keeps each result hidden until the visitor reveals it (Reveal, then the result dialog).
 * Revealed entry ids are kept in this browser only. Entry ids are unique across wallets, so one
 * list serves every account. Wins whose claim has started never need a reveal.
 */
import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../lib/storage'
import type { ShieldWinEntry } from './api'

const STORAGE_KEY = 'shield-win.reveals.v1'
/** The most recent reveals kept; older ids fall off the list */
export const MAX_REVEALS = 500

function parseReveals(value: unknown): number[] | null {
  if (typeof value !== 'object' || value === null) return null
  const ids = (value as { ids?: unknown }).ids
  if (!Array.isArray(ids)) return null
  return ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0)
}

export function readReveals(
  storage: KeyValueStorage | null = browserStorage()
): ReadonlySet<number> {
  return new Set(readStored(STORAGE_KEY, parseReveals, storage) ?? [])
}

/** Records a reveal and returns the updated set, keeping the newest MAX_REVEALS ids */
export function saveReveal(
  id: number,
  revealed: ReadonlySet<number>,
  storage: KeyValueStorage | null = browserStorage()
): ReadonlySet<number> {
  const ids = [...revealed].filter(other => other !== id)
  ids.push(id)
  const kept = ids.slice(-MAX_REVEALS)
  writeStored(STORAGE_KEY, { ids: kept }, storage)
  return new Set(kept)
}

/** A result the visitor has not seen yet: no win, or a win not yet claimed, and not revealed */
export function needsReveal(entry: ShieldWinEntry, revealed: ReadonlySet<number>): boolean {
  if (revealed.has(entry.id)) return false
  return entry.draw_result === 'NOT_WON' || entry.reward_status === 'UNCLAIMED'
}
