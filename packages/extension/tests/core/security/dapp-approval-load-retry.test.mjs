import assert from 'node:assert/strict'
import test from 'node:test'
import { canRetryPendingApprovalLoad } from '../../../src/popup/services/dapp-approval-request.ts'

test('approval read retry accepts transient failures without reviving expired authorization', () => {
  for (const error of [
    'Request timed out.',
    'Network error',
    'Unable to load this approval request.'
  ]) {
    assert.equal(canRetryPendingApprovalLoad(error), true, error)
  }
  for (const error of [
    'Request not found or expired',
    'Invalid or unsupported approval request.',
    'Unauthorized approval request',
    'Wallet account or site connection changed. Reconnect and try again.',
    'Account is no longer available',
    'Wallet is locked'
  ]) {
    assert.equal(canRetryPendingApprovalLoad(error), false, error)
  }
})
