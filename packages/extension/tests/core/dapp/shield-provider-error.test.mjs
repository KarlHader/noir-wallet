import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isShieldUnlockRetryError,
  ShieldProviderError,
  toShieldProviderErrorShape
} from '../../../src/core/dapp/shield-provider.ts'

test('Shield provider errors keep their public code and message', () => {
  assert.deepEqual(
    toShieldProviderErrorShape(
      new ShieldProviderError(4200, 'The requested Shield method is not supported.')
    ),
    { code: 4200, message: 'The requested Shield method is not supported.' }
  )
})

test('Shield session failures stay specific without exposing secrets', () => {
  assert.deepEqual(
    toShieldProviderErrorShape(
      new Error('Confidential funding requires an active software EVM Account')
    ),
    { code: 4100, message: 'Shield requires an unlocked software EVM account.' }
  )
  assert.equal(toShieldProviderErrorShape(new Error('Wallet is locked')).code, 4100)
  assert.equal(
    toShieldProviderErrorShape(new Error('Confidential service is temporarily unavailable')).code,
    4900
  )
  const secret = new Error('session accessToken=abc signature secp256k1:secret')
  assert.equal(
    toShieldProviderErrorShape(secret).message,
    'Noir Wallet could not complete the Shield request.'
  )
  const locked = new Error('The wallet credential is locked.')
  locked.name = 'KeyringError'
  Object.assign(locked, { code: 'CREDENTIAL_LOCKED' })
  assert.equal(
    toShieldProviderErrorShape(new Error('Shield amount is invalid.')).code,
    -32602
  )
  assert.equal(
    toShieldProviderErrorShape(new Error('Shield recipient account is invalid.')).code,
    -32602
  )
  assert.equal(isShieldUnlockRetryError(locked), true)
  assert.equal(toShieldProviderErrorShape(locked).code, 4100)
})
