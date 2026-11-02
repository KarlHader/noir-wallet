import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearHomeTransactionFocus } from '../../../src/popup/services/home-navigation.ts'

test('one-time Activity focus removes only transactionId from the current history entry', () => {
  assert.equal(clearHomeTransactionFocus('?tab=activity&transactionId=tx-1'), '/?tab=activity')
  assert.equal(clearHomeTransactionFocus('?transactionId=tx-1'), '/')
  assert.equal(clearHomeTransactionFocus('?tab=activity'), null)
})
