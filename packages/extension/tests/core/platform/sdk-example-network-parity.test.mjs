import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BUILTIN_EVM_NETWORKS } from '../../../src/config/networks.ts'
import { EVM_NETWORK_EXAMPLES } from '../../../../sdk/example/src/evm-network-catalog.ts'

function toHexChainIds(networks) {
  return networks
    .map(network => `0x${BigInt(network.chainId.slice('eip155:'.length)).toString(16)}`)
    .sort()
}

test('keeps the SDK Example EVM networks aligned with the wallet catalog', () => {
  for (const mode of ['mainnet', 'testnet']) {
    expect(
      EVM_NETWORK_EXAMPLES.filter(network => network.mode === mode)
        .map(network => network.request.chainId)
        .sort()
    ).toEqual(toHexChainIds(BUILTIN_EVM_NETWORKS[mode]))
  }
})
