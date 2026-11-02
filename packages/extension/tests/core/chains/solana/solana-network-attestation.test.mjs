import { test } from 'node:test'
import { expect } from '@playwright/test'

import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import { attestSolanaRpcEndpoint } from '../../../../src/infrastructure/chains/solana/solana-network-attestation.ts'

test('attests only the full genesis hash for the requested Solana cluster', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init.body)
      const result =
        body.method === 'getBlockHeight'
          ? 100
          : body.method === 'getLatestBlockhash'
            ? {
                context: { slot: 120 },
                value: {
                  blockhash: SOLANA_NETWORKS.devnet.genesisHash,
                  lastValidBlockHeight: 250
                }
              }
            : SOLANA_NETWORKS.devnet.genesisHash
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    }
    await expect(
      attestSolanaRpcEndpoint({
        chainId: SOLANA_NETWORKS.devnet.chainId,
        rpcUrl: 'https://solana.example'
      })
    ).resolves.toBeUndefined()
    await expect(
      attestSolanaRpcEndpoint({
        chainId: SOLANA_NETWORKS.mainnet.chainId,
        rpcUrl: 'https://solana.example'
      })
    ).rejects.toMatchObject({ code: 'chain-mismatch' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects endpoints that mix slot and block-height evidence', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init.body)
      const result =
        body.method === 'getBlockHeight'
          ? 442_000_000
          : body.method === 'getLatestBlockhash'
            ? {
                context: { slot: 442_000_000 },
                value: {
                  blockhash: SOLANA_NETWORKS.mainnet.genesisHash,
                  lastValidBlockHeight: 420_000_150
                }
              }
            : SOLANA_NETWORKS.mainnet.genesisHash
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    }
    await expect(
      attestSolanaRpcEndpoint({
        chainId: SOLANA_NETWORKS.mainnet.chainId,
        rpcUrl: 'https://solana.example'
      })
    ).rejects.toThrow('inconsistent block-height evidence')
  } finally {
    globalThis.fetch = originalFetch
  }
})
