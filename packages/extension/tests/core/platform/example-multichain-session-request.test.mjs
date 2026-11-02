import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildExampleMultichainSessionRequest } from '../../../../sdk/example/src/multichain-session-request.ts'

const zcash = {}
const evm = {}

test('SDK example requests only the scopes exposed by a two-chain wallet', () => {
  const request = buildExampleMultichainSessionRequest({ zcash, ethereum: evm }, 'mainnet', '0x1')

  assert.deepEqual(Object.keys(request.scopes).sort(), [
    'bip122:00040fe8ec8471911baa1db1266ea15d',
    'eip155:1'
  ])
  assert.deepEqual(request.scopes['eip155:1'].methods, [
    'eth_accounts',
    'eth_sendTransaction',
    'personal_sign',
    'eth_signTypedData_v4'
  ])
})

test('SDK example preserves all available scopes and the selected testnet EVM chain', () => {
  const request = buildExampleMultichainSessionRequest(
    { zcash, ethereum: evm, bitcoin: {}, solana: {}, near: {} },
    'testnet',
    '0xaa36a7'
  )

  assert.deepEqual(Object.keys(request.scopes).sort(), [
    'bip122:000000000933ea01ad0ee984209779ba',
    'bip122:05a60a92d99d85997cce3b87616c089f',
    'eip155:11155111',
    'near:testnet',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
  ])
})

test('SDK example does not request absent optional providers', () => {
  const request = buildExampleMultichainSessionRequest({ zcash }, 'mainnet', '0x1')

  assert.deepEqual(Object.keys(request.scopes), ['bip122:00040fe8ec8471911baa1db1266ea15d'])
})
