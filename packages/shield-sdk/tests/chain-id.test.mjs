import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ShieldError } from '../src/types.ts'
import { normalizeEvmChainId, normalizeShieldChainId } from '../src/chain-id.ts'

const available = ['eip155:56', 'eip155:1', 'bip122:00040fe8ec8471911baa1db1266ea15d']

test('normalizes safe integer, eip155, and canonical hex to eip155:N', () => {
  assert.equal(normalizeEvmChainId(56), 'eip155:56')
  assert.equal(normalizeEvmChainId('56'), 'eip155:56')
  assert.equal(normalizeEvmChainId('eip155:56'), 'eip155:56')
  assert.equal(normalizeEvmChainId('0x38'), 'eip155:56')
  assert.equal(normalizeEvmChainId('0x38'), normalizeShieldChainId('0X38'.replace('X', 'x')))
  assert.equal(normalizeShieldChainId(56, available), 'eip155:56')
  assert.equal(
    normalizeShieldChainId('bip122:00040fe8ec8471911baa1db1266ea15d', available),
    'bip122:00040fe8ec8471911baa1db1266ea15d'
  )
})

test('rejects negative, unsafe, and ambiguous chain ids', () => {
  for (const value of [
    -1,
    0,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '0x038',
    '0X38',
    'eip155:056',
    'eip155:0x38',
    'eip155:0',
    '+56',
    '56 ',
    '1e2',
    '056',
    '',
    null,
    true
  ]) {
    assert.throws(() => normalizeShieldChainId(value, available), ShieldError)
  }
  assert.throws(
    () => normalizeShieldChainId('eip155:137', available),
    /not available/
  )
  assert.throws(() => normalizeShieldChainId(56, ['bip122:00040fe8ec8471911baa1db1266ea15d']))
  assert.throws(() => normalizeShieldChainId('near:mainnet', available))
})
