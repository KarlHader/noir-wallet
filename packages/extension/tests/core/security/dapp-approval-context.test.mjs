import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalContextMatches } from '../../../src/background/approval-context-policy.ts'
import { signApprovedDAppMessage } from '../../../src/background/dapp-message-signing.ts'

function approval(overrides = {}) {
  return {
    action: 'sendTransaction',
    requestNetwork: 'mainnet',
    currentNetwork: 'mainnet',
    requestWalletId: 'wallet-1',
    requestAccountId: 'account-1',
    currentWalletId: 'wallet-1',
    currentAccountId: 'account-1',
    accountExists: true,
    locked: false,
    authorizationRevision: 4,
    currentAuthorizationRevision: 4,
    accountAuthorized: true,
    requestStillPending: true,
    ...overrides
  }
}

test('approval context expires on account, network, authorization, lock or request changes', () => {
  assert.equal(approvalContextMatches(approval()), true)
  for (const changed of [
    { currentWalletId: 'wallet-2' },
    { currentAccountId: 'account-2' },
    { currentNetwork: 'testnet' },
    { accountExists: false },
    { locked: true },
    { currentAuthorizationRevision: 5 },
    { accountAuthorized: false },
    { requestStillPending: false }
  ]) {
    assert.equal(approvalContextMatches(approval(changed)), false)
  }
  assert.equal(
    approvalContextMatches(approval({ action: 'connect', accountAuthorized: false })),
    true
  )
  assert.equal(
    approvalContextMatches(
      approval({ action: 'connect', accountAuthorized: false, currentAuthorizationRevision: 5 })
    ),
    false
  )
})

test('all message signing modes bind their primary signature to the reviewed HD account', async () => {
  const calls = []
  const core = {
    async signMessage(message, accountIndex, addressIndex) {
      calls.push({ message, accountIndex, addressIndex })
      return { signature: `signature-${accountIndex}`, address: `address-${accountIndex}` }
    }
  }

  const current = await signApprovedDAppMessage(core, 'reviewed', 3, 'current', 99)
  assert.equal(current.signingMode, 'current')
  assert.deepEqual(calls.splice(0), [
    { message: 'reviewed', accountIndex: 3, addressIndex: undefined }
  ])

  const legacy = await signApprovedDAppMessage(core, 'reviewed', 3, 'legacy_index0', 99)
  assert.equal(legacy.signingMode, 'legacy_index0')
  assert.deepEqual(calls.splice(0), [{ message: 'reviewed', accountIndex: 3, addressIndex: 0 }])

  const derived = await signApprovedDAppMessage(core, 'reviewed', 3, 'derived', 99)
  assert.equal(derived.signingMode, 'derived')
  assert.equal(derived.originAddress, 'address-3')
  assert.deepEqual(calls, [
    { message: 'reviewed', accountIndex: 99, addressIndex: undefined },
    { message: 'reviewed', accountIndex: 3, addressIndex: undefined }
  ])
})
