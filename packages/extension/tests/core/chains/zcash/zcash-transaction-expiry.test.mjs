import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveOneClickExpiryDeltaBlocks } from '../../../../src/core/zcash/transaction-expiry.ts'

test('one-click expiry covers a stale wallet tip without lengthening current transactions', () => {
  assert.equal(resolveOneClickExpiryDeltaBlocks(3_521_041, 3_521_041, 5), 5)
  assert.equal(resolveOneClickExpiryDeltaBlocks(3_521_041, 3_521_048, 5), 12)
  assert.equal(resolveOneClickExpiryDeltaBlocks(3_521_041, 3_521_076, 5), 40)
})

test('one-click send waits for sync when the wallet tip cannot support bounded expiry', () => {
  assert.throws(() => resolveOneClickExpiryDeltaBlocks(3_521_041, 3_521_077, 5), /Wait for sync/)
  assert.throws(() => resolveOneClickExpiryDeltaBlocks(0, 3_521_048, 5), /Wait for sync/)
})
