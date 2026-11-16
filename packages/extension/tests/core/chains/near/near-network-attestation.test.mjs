import { test } from 'node:test'
import { expect } from '@playwright/test'

import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import { attestNearRpcEndpoint } from '../../../../src/infrastructure/chains/near/near-network-attestation.ts'

test('attests the requested NEAR network against full static identity', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init.body)
      const result =
        body.method === 'status'
          ? {
              chain_id: 'testnet',
              sync_info: { latest_block_hash: NEAR_NETWORKS.testnet.genesisHash }
            }
          : body.method === 'genesis_config'
            ? {
                chain_id: 'testnet',
                genesis_height: NEAR_NETWORKS.testnet.genesisHeight,
                genesis_time: NEAR_NETWORKS.testnet.genesisTime
              }
            : {
                header: {
                  hash: NEAR_NETWORKS.testnet.genesisHash,
                  height: NEAR_NETWORKS.testnet.genesisHeight
                }
              }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    }
    await expect(
      attestNearRpcEndpoint({
        chainId: NEAR_NETWORKS.testnet.chainId,
        rpcUrl: 'https://near.example'
      })
    ).resolves.toBeUndefined()
    await expect(
      attestNearRpcEndpoint({
        chainId: NEAR_NETWORKS.mainnet.chainId,
        rpcUrl: 'https://near.example'
      })
    ).rejects.toMatchObject({ code: 'chain-mismatch' })
  } finally {
    globalThis.fetch = originalFetch
  }
})
