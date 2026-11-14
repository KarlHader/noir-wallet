import test from 'node:test'
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import {
  getImportZcashHistoryDefaults,
  parseZcashHistoryRecoveryHeight,
  resolveZcashHistoryRecoveryDate
} from '../../../src/popup/services/import-zcash-history-selection.ts'

test('restores the selected date after its Zcash block height was resolved', () => {
  assert.deepEqual(
    getImportZcashHistoryDefaults(2_100_000, {
      mode: 'restore',
      method: 'date',
      date: '2026-10-01'
    }),
    {
      historyMode: 'restore',
      restoreMethod: 'date',
      syncDate: '2026-10-01',
      syncHeight: '2100000'
    }
  )
})

test('defaults to block height only when returning without a saved selection', () => {
  assert.deepEqual(getImportZcashHistoryDefaults(2_100_000, null), {
    historyMode: 'restore',
    restoreMethod: 'height',
    syncDate: null,
    syncHeight: '2100000'
  })
  assert.deepEqual(getImportZcashHistoryDefaults(undefined, null), {
    historyMode: 'new',
    restoreMethod: 'date',
    syncDate: null,
    syncHeight: ''
  })
})

test('validates Zcash recovery height against the supported history floor', () => {
  assert.deepEqual(parseZcashHistoryRecoveryHeight('419,200', 419_200), {
    error: null,
    height: 419_200
  })
  assert.deepEqual(parseZcashHistoryRecoveryHeight('419199', 419_200), {
    error: 'range',
    height: null
  })
  assert.deepEqual(parseZcashHistoryRecoveryHeight('abc', 419_200), {
    error: 'format',
    height: null
  })
})

test('resolves recovery date at UTC day start and rejects invalid network heights', async () => {
  let requestedTimestamp
  const height = await resolveZcashHistoryRecoveryDate(
    dayjs('2026-10-01'),
    419_200,
    async timestamp => {
      requestedTimestamp = timestamp
      return 419_199
    }
  )
  assert.equal(requestedTimestamp, Date.UTC(2026, 9, 1) / 1_000)
  assert.equal(height, 419_200)
  await assert.rejects(
    resolveZcashHistoryRecoveryDate(dayjs('2026-10-01'), 419_200, async () => 0),
    /invalid block height/
  )
})
