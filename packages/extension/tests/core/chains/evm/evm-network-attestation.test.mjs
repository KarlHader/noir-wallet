import { test } from 'node:test'
import { expect } from '@playwright/test'
import { attestEvmRpcEndpoint } from '../../../../src/infrastructure/chains/evm/evm-network-attestation.ts'

test.describe('EVM network attestation', () => {
  test('accepts only the expected eth_chainId', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(init.body)
        expect(body.method).toBe('eth_chainId')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x38' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      await expect(
        attestEvmRpcEndpoint({ chainId: 'eip155:56', rpcUrl: 'https://rpc.example' })
      ).resolves.toBeUndefined()
      await expect(
        attestEvmRpcEndpoint({ chainId: 'eip155:1', rpcUrl: 'https://rpc.example' })
      ).rejects.toMatchObject({ code: 'chain-mismatch' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
