import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertNewPassword,
  getNewPasswordValidationError,
  isNewPasswordValid
} from '../../../src/core/wallet/password-policy.ts'

test('new passwords reject whitespace-only values without changing other passwords', () => {
  for (const password of ['        ', '\t'.repeat(8), '\u00a0'.repeat(8)]) {
    assert.equal(getNewPasswordValidationError(password), 'Password cannot contain only whitespace')
    assert.equal(isNewPasswordValid(password), false)
    assert.throws(() => assertNewPassword(password), /cannot contain only whitespace/)
  }
  for (const password of ['aaaaaaa ', '  password  ', 'aaaaaaaa']) {
    assert.equal(getNewPasswordValidationError(password), null)
    assert.equal(isNewPasswordValid(password), true)
    assert.doesNotThrow(() => assertNewPassword(password))
  }
})
