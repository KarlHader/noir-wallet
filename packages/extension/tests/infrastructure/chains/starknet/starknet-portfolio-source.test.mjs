import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { getStarknetNetworkConfig } from '../../../../src/core/chains/starknet/network-config.ts'
import { readStarknetPortfolioSource } from '../../../../src/infrastructure/chains/starknet/starknet-portfolio-source.ts'

const network = 'testnet'
const chainId = getStarknetNetworkConfig(network).chainId
const assets = createAssetRegistry(
  createInitialProductChainRegistry(network),
  getBundledInitialProductAssetDefinitions(network)
)
const address = '0x6a62e3abc08f1190cf071afeec31d1693f71c9f126e820b98d7017f133e6a27'

function chainAccount(scheme) {
  return {
    id: `chain-account:starknet:${scheme}`,
    scope: { keyDomainId: 'wallet:1', accountId: 'account:1', chainId },
    derivation: { scheme, path: "m/2645'/1195502025'/1148870696'/0'/0'/0" },
    identity: { kind: 'account-identifier', value: address },
    createdAt: 1
  }
}

function rpc() {
  const calls = []
  return {
    calls,
    async call(contractAddress, selector, calldata) {
      calls.push({ contractAddress, selector, calldata })
      return ['0x2a', '0x0']
    }
  }
}

async function read(scheme) {
  const client = rpc()
  const source = await readStarknetPortfolioSource({
    chainAccount: chainAccount(scheme),
    assets,
    rpc: client,
    network,
    now: () => 5
  })
  return { source, calls: client.calls }
}

it('reads a STRK balance for Ledger eip2645 and software bip44 accounts', async () => {
  for (const scheme of ['eip2645', 'bip44']) {
    const { source, calls } = await read(scheme)
    assert.equal(source.status, 'ready')
    assert.ok(source.balances.length > 0)
    assert.ok(source.balances.every(balance => balance.totalRaw === '42'))
    assert.ok(calls.length > 0)
    assert.ok(calls.every(call => call.calldata[0] === address))
  }
})
