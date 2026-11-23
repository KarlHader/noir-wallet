import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertShieldAmount, shieldAmountToRaw } from '../src/amount.ts'
import { ShieldError } from '../src/types.ts'

test('accepts a positive decimal within asset precision', () => {
  assert.equal(assertShieldAmount('0.10', 6), '0.10')
  assert.equal(assertShieldAmount('10', 0), '10')
  assert.equal(assertShieldAmount('1.2300', 6), '1.2300')
})

test('rejects non-decimal, zero, negative, and over-precise amounts', () => {
  for (const value of ['0', '0.0', '-1', '+1', '1.', '.1', '1e2', '1,000', ' 1', '00.1', '']) {
    assert.throws(() => assertShieldAmount(value, 6), ShieldError)
  }
  assert.throws(() => assertShieldAmount('1.123', 2), /precision/)
  assert.throws(() => assertShieldAmount(1, 6), ShieldError)
})

test('converts a decimal amount into base units', () => {
  assert.equal(shieldAmountToRaw('0.10', 6), '100000')
  assert.equal(shieldAmountToRaw('1', 0), '1')
  assert.equal(shieldAmountToRaw('1.2300', 6), '1230000')
  assert.throws(() => shieldAmountToRaw('1.123', 2), /precision/)
  assert.throws(() => shieldAmountToRaw('0', 6), ShieldError)
})
