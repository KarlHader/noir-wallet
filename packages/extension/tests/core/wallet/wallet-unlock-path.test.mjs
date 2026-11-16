import assert from 'node:assert/strict'
import { it } from 'node:test'
import { resolveWalletUnlockPath } from '../../../src/core/wallet/wallet-unlock-path.ts'

it('unlocks native Ledger V3 with Zcash without invoking retained V1 migration', () => {
  assert.deepEqual(resolveWalletUnlockPath('native-v2-hardware-only', false, false), {
    kind: 'native-v2',
    restoreZcashRuntime: false
  })
  assert.deepEqual(resolveWalletUnlockPath('native-v2-hardware-only', true, true), {
    kind: 'native-v2',
    restoreZcashRuntime: true
  })
  assert.deepEqual(resolveWalletUnlockPath('native-v2-mixed', true, true), {
    kind: 'native-v2',
    restoreZcashRuntime: true
  })
})

it('keeps retained V1 Zcash wallets on credential reconciliation', () => {
  assert.deepEqual(resolveWalletUnlockPath('retained-v1-backed', true, true), {
    kind: 'retained-v1'
  })
  assert.deepEqual(resolveWalletUnlockPath('inactive', null, true), {
    kind: 'retained-v1'
  })
  assert.deepEqual(resolveWalletUnlockPath('inactive', null, false), {
    kind: 'native-v2',
    restoreZcashRuntime: false
  })
})
