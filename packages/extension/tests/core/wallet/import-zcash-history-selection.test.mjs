import test from 'node:test'
import assert from 'node:assert/strict'
import { getImportZcashHistoryDefaults } from '../../../src/popup/services/import-zcash-history-selection.ts'

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
