import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  SHIELD_DAPP_RUNTIME_METHODS,
  shieldErrorFromProviderFailure,
  shieldErrorToProviderError,
  toShieldProviderErrorShape
} from '../src/protocol.ts'
import { ShieldError } from '../src/types.ts'

const PROTOCOL_SOURCES = [
  'protocol.ts',
  'provider-error.ts',
  'status-projection.ts',
  'amount.ts',
  'chain-id.ts',
  'operation.ts',
  'types.ts',
  'layers/near-confidential.ts'
]

test('protocol methods are the shield channel catalog', () => {
  assert.deepEqual(SHIELD_DAPP_RUNTIME_METHODS, [
    'shield_connect',
    'shield_disconnect',
    'shield_receive',
    'shield_transfer',
    'shield_getSupportedChains',
    'shield_getSupportedTokens',
    'shield_getQuote',
    'shield_getTransactionStatus',
    'shield_refreshBalances'
  ])
})

test('provider codes and shield errors share one mapping', () => {
  assert.equal(shieldErrorFromProviderFailure(4001, 'rejected').code, 'REJECTED')
  assert.equal(
    shieldErrorFromProviderFailure(4200, 'Shield transfer to another confidential account is not confirmed by the protocol.').code,
    'NOT_CONFIRMED'
  )
  assert.equal(shieldErrorFromProviderFailure(4200, 'unsupported').code, 'UNSUPPORTED')
  assert.equal(shieldErrorFromProviderFailure(4100, 'locked').code, 'UNAUTHORIZED')
  assert.equal(shieldErrorFromProviderFailure(-32602, 'bad').code, 'INVALID_PARAMS')
  const provider = shieldErrorToProviderError(new ShieldError('INVALID_PARAMS', 'Amount must be a positive decimal string.'))
  assert.deepEqual(toShieldProviderErrorShape(provider), {
    code: -32602,
    message: 'Amount must be a positive decimal string.'
  })
  assert.equal(toShieldProviderErrorShape(new Error('secret')).code, -32603)
})

test('protocol sources do not touch the injected wallet', () => {
  for (const file of PROTOCOL_SOURCES) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    assert.equal(source.includes('@noir-wallet/sdk'), false, file)
    assert.equal(source.includes('window'), false, file)
  }
})
