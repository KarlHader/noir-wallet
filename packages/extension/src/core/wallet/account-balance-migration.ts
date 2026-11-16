import Big from 'big.js'
import { getMaxSpendableZec } from './balance-summary.ts'
import type { ZcashBalance } from '../../types/wallet.ts'

// V1 already uses version 2 with a different Available contract.
export const ACCOUNT_DATA_VERSION = 3

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function entries(value: unknown): [string, unknown][] {
  if (value instanceof Map) {
    return [...value.entries()].filter(
      (entry): entry is [string, unknown] => typeof entry[0] === 'string'
    )
  }
  return Object.entries(record(value) ?? {})
}

function amount(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '0'
  try {
    const parsed = new Big(value)
    return parsed.gt(0) ? parsed.toFixed() : '0'
  } catch {
    return '0'
  }
}

function minimum(left: string, right: string): string {
  return new Big(left).lte(right) ? left : right
}

/** Older cached totals do not establish which inputs the current WASM policy can select. */
export function migrateStoredBalance(value: unknown): ZcashBalance {
  const stored = record(value) ?? {}
  const shielded = amount(stored.shielded)
  const transparent = amount(stored.transparent)
  const total =
    stored.total == null ? new Big(shielded).plus(transparent).toFixed() : amount(stored.total)
  const spendable = amount(stored.spendable)
  const confirmedRecord = record(stored.confirmed)
  const pendingRecord = record(stored.pending)
  const pendingShielded = amount(pendingRecord?.shielded)
  const pendingTransparent = amount(pendingRecord?.transparent)

  return {
    ...stored,
    shielded,
    transparent,
    total,
    spendable,
    available: minimum(amount(stored.available), getMaxSpendableZec(spendable)),
    confirmed: {
      shielded: minimum(amount(confirmedRecord?.shielded), shielded),
      transparent: minimum(amount(confirmedRecord?.transparent), transparent)
    },
    ...(pendingRecord && {
      pending: {
        shielded: pendingShielded,
        transparent: pendingTransparent,
        total:
          pendingRecord.total == null
            ? new Big(pendingShielded).plus(pendingTransparent).toFixed()
            : amount(pendingRecord.total)
      }
    })
  } as ZcashBalance
}

export function migrateAccountDataState(persisted: unknown, version: number): unknown {
  if (version >= ACCOUNT_DATA_VERSION) return persisted
  const state = record(persisted)
  if (!state) return persisted

  return {
    ...state,
    balances: Object.fromEntries(
      entries(state.balances).map(([key, balance]) => [key, migrateStoredBalance(balance)])
    ),
    syncStates: Object.fromEntries(
      entries(state.syncStates).map(([key, syncState]) => [
        key,
        { ...(record(syncState) ?? {}), isSyncing: false, lastSyncTime: null }
      ])
    )
  }
}
