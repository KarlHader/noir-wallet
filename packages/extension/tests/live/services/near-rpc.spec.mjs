import { expect, test } from '@playwright/test'

import { getNearNetworkConfigs, NEAR_NETWORKS } from '../../../src/config/networks.ts'
import { createNearRpcClient } from '../../../src/infrastructure/chains/near/near-rpc-client.ts'
import { resolveNearRpcEndpointOptions } from '../../../src/infrastructure/chains/managed-rpc-endpoints.ts'
import {
  fetchRpcRegistry,
  setActiveRpcRegistryDocument
} from '../../../src/infrastructure/chains/rpc-registry-client.ts'

test.describe('live trusted NEAR RPC profiles', () => {
  test.skip(process.env.LIVE_NEAR_RPC !== '1', 'Set LIVE_NEAR_RPC=1 to enable')

  for (const network of getNearNetworkConfigs()) {
    test(`attests ${network.network} and reads final chain state`, async () => {
      const client = createNearRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
      await client.assertExpectedChain()
      const [block, gasPrice] = await Promise.all([client.getFinalBlock(), client.getGasPrice()])
      expect(block.height).toBeGreaterThan(network.genesisHeight)
      expect(BigInt(block.gasPriceRaw)).toBeGreaterThan(0n)
      expect(BigInt(gasPrice)).toBeGreaterThan(0n)
    })
  }

  test('attests managed Mainnet RPCs and reads final chain state', async () => {
    setActiveRpcRegistryDocument(await fetchRpcRegistry())
    for (const endpoint of resolveNearRpcEndpointOptions('mainnet')) {
      const client = createNearRpcClient({
        chainId: NEAR_NETWORKS.mainnet.chainId,
        rpcUrl: endpoint.url
      })
      await client.assertExpectedChain()
      const [block, gasPrice] = await Promise.all([client.getFinalBlock(), client.getGasPrice()])
      expect(block.height).toBeGreaterThan(NEAR_NETWORKS.mainnet.genesisHeight)
      expect(BigInt(block.gasPriceRaw)).toBeGreaterThan(0n)
      expect(BigInt(gasPrice)).toBeGreaterThan(0n)
    }
  })

  test('reads final testnet account, access key and wrap.testnet NEP-141 balance', async () => {
    const client = createNearRpcClient({
      chainId: NEAR_NETWORKS.testnet.chainId,
      rpcUrl: NEAR_NETWORKS.testnet.rpcUrl
    })
    const [account, accessKey, wrappedBalance] = await Promise.all([
      client.getAccount('testnet'),
      client.getAccessKey('testnet', 'ed25519:1i7mP2eDAyL8kR5vDxDDdAsoAFttcAfua4ibfXN5k4u'),
      client.getFungibleTokenBalance('wrap.testnet', 'testnet')
    ])
    expect(account?.accountId).toBe('testnet')
    expect(accessKey?.publicKey).toBe('ed25519:1i7mP2eDAyL8kR5vDxDDdAsoAFttcAfua4ibfXN5k4u')
    expect(BigInt(wrappedBalance.amountRaw)).toBeGreaterThanOrEqual(0n)
    await expect(client.getAccount('missing-noir-account-123456.testnet')).resolves.toBeNull()
    await expect(client.getAccessKey('testnet', `ed25519:${'1'.repeat(32)}`)).resolves.toBeNull()
  })
})
