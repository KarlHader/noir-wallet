import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearHomeTransactionFocus,
  homeActivityPath,
  resolveHomeAssetDomain,
  resolveHomeDefaultTab,
  resolveWalletEntryRoute
} from '../../../src/popup/services/home-navigation.ts'

test('one-time Activity focus removes only transactionId from the current history entry', () => {
  assert.equal(clearHomeTransactionFocus('?tab=activity&transactionId=tx-1'), '/?tab=activity')
  assert.equal(clearHomeTransactionFocus('?transactionId=tx-1'), '/')
  assert.equal(clearHomeTransactionFocus('?tab=activity'), null)
})

test('opening Activity for a result keeps its balance domain after clearing focus', () => {
  const transactionId = 'quote:tx/1+2'
  for (const domain of ['public', 'private', 'shield']) {
    const path = homeActivityPath(domain, transactionId)
    const search = path.slice(1)
    assert.equal(resolveWalletEntryRoute(`#${path}`), path)
    assert.equal(resolveHomeDefaultTab(search), 'activity')
    assert.equal(resolveHomeAssetDomain(search), domain)
    assert.equal(new URLSearchParams(search).get('transactionId'), transactionId)
    assert.equal(clearHomeTransactionFocus(search), homeActivityPath(domain))
  }
})
