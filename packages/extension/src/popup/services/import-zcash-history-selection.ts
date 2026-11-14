import type { Dayjs } from 'dayjs'
import { getUtcDayStartTimestamp } from '@/lib/zcash-birthday'

export type ImportZcashHistorySelection =
  | Readonly<{ mode: 'new' }>
  | Readonly<{ mode: 'restore'; method: 'height' }>
  | Readonly<{ mode: 'restore'; method: 'date'; date: string }>

export function getImportZcashHistoryDefaults(
  birthdayHeight: number | undefined,
  selection: ImportZcashHistorySelection | null
): Readonly<{
  historyMode: 'new' | 'restore'
  restoreMethod: 'date' | 'height'
  syncDate: string | null
  syncHeight: string
}> {
  return Object.freeze({
    historyMode: selection?.mode ?? (birthdayHeight === undefined ? 'new' : 'restore'),
    restoreMethod:
      selection?.mode === 'restore'
        ? selection.method
        : birthdayHeight === undefined
          ? 'date'
          : 'height',
    syncDate: selection?.mode === 'restore' && selection.method === 'date' ? selection.date : null,
    syncHeight: birthdayHeight === undefined ? '' : String(birthdayHeight)
  })
}

export function parseZcashHistoryRecoveryHeight(
  value: string,
  recoveryFloor: number
): Readonly<{ error: null; height: number } | { error: 'format' | 'range'; height: null }> {
  const normalized = value.replace(/,/g, '').trim()
  if (!/^\d+$/.test(normalized)) return { error: 'format', height: null }
  const height = Number(normalized)
  if (!Number.isSafeInteger(height) || height < recoveryFloor)
    return { error: 'range', height: null }
  return { error: null, height }
}

export async function resolveZcashHistoryRecoveryDate(
  date: Dayjs,
  recoveryFloor: number,
  getBlockByTime: (timestamp: number) => Promise<number>
): Promise<number> {
  const height = await getBlockByTime(getUtcDayStartTimestamp(date))
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new Error('The Zcash network returned an invalid block height. Please try again.')
  }
  return Math.max(recoveryFloor, height)
}
