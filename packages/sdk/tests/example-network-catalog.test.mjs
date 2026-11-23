import assert from 'node:assert/strict'
import test from 'node:test'

import { EVM_NETWORK_EXAMPLES } from '../example/src/evm-network-catalog.ts'

function getChainIds(mode) {
  return EVM_NETWORK_EXAMPLES.filter(network => network.mode === mode)
    .map(network => network.request.chainId)
    .sort()
}

test('keeps the example network catalog aligned with the released wallet networks', () => {
  assert.deepEqual(getChainIds('mainnet'), ['0x1', '0x2105', '0x38', '0x89', '0xa4b1'].sort())
  assert.deepEqual(
    getChainIds('testnet'),
    ['0x13882', '0x14a34', '0x61', '0x66eee', '0xaa36a7'].sort()
  )
})
