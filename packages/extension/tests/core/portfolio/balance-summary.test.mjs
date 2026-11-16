import test from 'node:test'
import assert from 'node:assert/strict'

import { mapWasmAccountBalanceToZcashBalance } from '../../../src/core/wallet/balance-summary.ts'

test('maps non-spendable matured gap into displayed balance without pending', () => {
  const balance = mapWasmAccountBalanceToZcashBalance({
    sapling_balance: 0,
    orchard_balance: 9_092_214,
    unshielded_balance: 52_113_500,
    sapling_pending_balance: 0,
    orchard_pending_balance: 0,
    unshielded_pending_balance: 0,
    sapling_total_balance: 0,
    orchard_total_balance: 10_000_000,
    unshielded_total_balance: 52_113_500,
    spendable_balance: 9_092_214,
    pending_balance: 0,
    total_balance: 62_113_500
  })

  assert.equal(balance.shielded, '0.1')
  assert.equal(balance.transparent, '0.521135')
  assert.equal(balance.total, '0.621135')
  assert.equal(balance.spendable, '0.09092214')
  assert.equal(balance.available, '0.09052214')
  assert.deepEqual(balance.pending, {
    shielded: '0',
    transparent: '0',
    total: '0'
  })
})

test('maps confirming balance only from pending fields', () => {
  const balance = mapWasmAccountBalanceToZcashBalance({
    sapling_balance: 0,
    orchard_balance: 0,
    unshielded_balance: 0,
    sapling_pending_balance: 3_000_000,
    orchard_pending_balance: 2_000_000,
    unshielded_pending_balance: 1_000_000,
    sapling_total_balance: 3_000_000,
    orchard_total_balance: 2_000_000,
    unshielded_total_balance: 1_000_000,
    spendable_balance: 0,
    pending_balance: 6_000_000,
    total_balance: 6_000_000
  })

  assert.equal(balance.shielded, '0.05')
  assert.equal(balance.transparent, '0.01')
  assert.equal(balance.total, '0.06')
  assert.equal(balance.spendable, '0')
  assert.equal(balance.available, '0.00000000')
  assert.deepEqual(balance.pending, {
    shielded: '0.05',
    transparent: '0.01',
    total: '0.06'
  })
})

test('includes Ironwood funds in shielded balances when provided by newer WASM', () => {
  const balance = mapWasmAccountBalanceToZcashBalance({
    sapling_balance: 1_000_000,
    orchard_balance: 2_000_000,
    ironwood_balance: 3_000_000,
    unshielded_balance: 4_000_000,
    sapling_pending_balance: 100_000,
    orchard_pending_balance: 200_000,
    ironwood_pending_balance: 300_000,
    unshielded_pending_balance: 400_000,
    sapling_total_balance: 1_100_000,
    orchard_total_balance: 2_200_000,
    ironwood_total_balance: 3_300_000,
    unshielded_total_balance: 4_400_000,
    spendable_balance: 10_000_000,
    pending_balance: 1_000_000,
    total_balance: 11_000_000
  })

  assert.equal(balance.shielded, '0.066')
  assert.equal(balance.transparent, '0.044')
  assert.equal(balance.total, '0.11')
  assert.equal(balance.spendable, '0.1')
  assert.deepEqual(balance.pending, {
    shielded: '0.006',
    transparent: '0.004',
    total: '0.01'
  })
})
