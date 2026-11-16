import assert from 'node:assert/strict'
import test from 'node:test'
import { getPendingBetaInviteReturnRoute } from '../../../src/popup/services/beta-invite-route-policy.ts'

test('pending invite activation preserves a normal window deep link and its query', () => {
  assert.equal(
    getPendingBetaInviteReturnRoute('/send', '?assetId=zcash%3Amainnet%2Fnative', true, false),
    '/send?assetId=zcash%3Amainnet%2Fnative'
  )
  assert.equal(getPendingBetaInviteReturnRoute('/send', '?assetId=zec', false, false), null)
  assert.equal(getPendingBetaInviteReturnRoute('/send', '?assetId=zec', true, true), null)
  assert.equal(getPendingBetaInviteReturnRoute('/onboarding', '?from=dapp', true, false), null)
  assert.equal(
    getPendingBetaInviteReturnRoute('/onboarding/congratulations', '', true, false),
    null
  )
  assert.equal(getPendingBetaInviteReturnRoute('/unlock', '?redirect=%2Fsend', true, false), null)
})
