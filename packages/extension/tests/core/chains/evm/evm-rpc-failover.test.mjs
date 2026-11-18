import { test } from 'node:test'
import { expect } from '@playwright/test'

import { getEvmNetworkConfigs } from '../../../../src/config/networks.ts'
import { getDefaultEvmRpcEndpoint } from '../../../../src/config/rpc-endpoints.ts'
import { getEvmRpcEndpointOptions } from '../../../../src/infrastructure/chains/managed-rpc-endpoints.ts'
import { setActiveRpcRegistryDocument } from '../../../../src/infrastructure/chains/rpc-registry-client.ts'
import { EvmRpcError } from '../../../../src/infrastructure/chains/evm/evm-rpc-client.ts'
import { createEvmRpcFailoverClient } from '../../../../src/infrastructure/chains/evm/evm-rpc-failover-client.ts'

const ADDRESS = '0x1111111111111111111111111111111111111111'

function rpcResponse(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'content-type': 'application/json' }
  })
}

test.describe('EVM RPC endpoint pools', () => {
  test('provides credential-free presets for every released EVM network', () => {
    for (const networkMode of ['mainnet', 'testnet']) {
      for (const network of getEvmNetworkConfigs(networkMode)) {
        const options = getEvmRpcEndpointOptions(networkMode, network.chainId)
        expect(new URL(options[0]?.url).toString()).toBe(new URL(network.rpcUrl).toString())
        expect(new Set(options.map(option => option.id)).size).toBe(options.length)
        expect(new Set(options.map(option => option.url)).size).toBe(options.length)
        for (const option of options) {
          const url = new URL(option.url)
          expect(url.protocol).toBe('https:')
          expect(url.username).toBe('')
          expect(url.password).toBe('')
          expect(url.search).toBe('')
          expect(url.hash).toBe('')
        }
      }
    }
  })

  test('bundles one local endpoint per released chain', () => {
    for (const networkMode of ['mainnet', 'testnet']) {
      for (const network of getEvmNetworkConfigs(networkMode)) {
        const options = getEvmRpcEndpointOptions(networkMode, network.chainId)
        expect(options, network.chainId).toHaveLength(1)
      }
    }
  })

  test('uses the bundled endpoint when the cached Ethereum registry contains only a retired endpoint', () => {
    setActiveRpcRegistryDocument({
      version: 1,
      updatedAt: '2026-11-02T00:00:00.000Z',
      chains: [
        {
          id: 'eip155:1',
          network: 'mainnet',
          probe: 'evm-json-rpc',
          endpoints: [{ id: 'deltarpc', label: 'Retired RPC', url: 'https://retired.example' }]
        }
      ]
    })
    try {
      expect(getEvmRpcEndpointOptions('mainnet', 'eip155:1')).toEqual([
        getDefaultEvmRpcEndpoint('mainnet', 'eip155:1')
      ])
    } finally {
      setActiveRpcRegistryDocument(null)
    }
  })
})

test.describe('EVM RPC failover', () => {
  test('restarts a failed nonce observation on one endpoint', async () => {
    const client = createEvmRpcFailoverClient(
      {
        chainId: 'eip155:1',
        endpoints: [
          { id: 'primary', label: 'Primary', url: 'https://primary.example' },
          { id: 'fallback', label: 'Fallback', url: 'https://fallback.example' }
        ]
      },
      async (url, init) => {
        const request = JSON.parse(init.body)
        if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x1')
        if (url === 'https://fallback.example/') return rpcResponse(request.id, '0xa')
        if (request.params[1] === 'pending') return rpcResponse(request.id, '0x9')
        return new Response('', { status: 429 })
      }
    )

    await expect(
      client.withNonceQueueEndpoint(async rpc => ({
        pending: await rpc.getPendingNonce(ADDRESS),
        latest: await rpc.getTransactionCount(ADDRESS, 'latest')
      }))
    ).resolves.toEqual({ pending: '10', latest: '10' })
  })

  test('falls back from a rate-limited endpoint and keeps the healthy endpoint active', async () => {
    const requests = []
    const client = createEvmRpcFailoverClient(
      {
        chainId: 'eip155:1',
        endpoints: [
          { id: 'primary', label: 'Primary', url: 'https://primary.example' },
          { id: 'fallback', label: 'Fallback', url: 'https://fallback.example' }
        ]
      },
      async (url, init) => {
        const request = JSON.parse(init.body)
        requests.push([url, request.method])
        if (url === 'https://primary.example/') return new Response('', { status: 429 })
        if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x1')
        if (request.method === 'eth_getBalance') return rpcResponse(request.id, '0x2a')
        throw new Error(`Unexpected request: ${request.method}`)
      }
    )

    await expect(client.getNativeBalance(ADDRESS)).resolves.toBe('42')
    await expect(client.getNativeBalance(ADDRESS)).resolves.toBe('42')
    expect(requests).toEqual([
      ['https://primary.example/', 'eth_chainId'],
      ['https://fallback.example/', 'eth_chainId'],
      ['https://fallback.example/', 'eth_getBalance'],
      ['https://fallback.example/', 'eth_getBalance']
    ])
  })

  test('does not retry deterministic JSON-RPC execution errors', async () => {
    const requests = []
    const client = createEvmRpcFailoverClient(
      {
        chainId: 'eip155:1',
        endpoints: [
          { id: 'primary', label: 'Primary', url: 'https://primary.example' },
          { id: 'fallback', label: 'Fallback', url: 'https://fallback.example' }
        ]
      },
      async (url, init) => {
        const request = JSON.parse(init.body)
        requests.push([url, request.method])
        if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x1')
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32_000, message: 'execution reverted' }
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      }
    )

    await expect(client.getNativeBalance(ADDRESS)).rejects.toMatchObject({
      name: EvmRpcError.name,
      code: 'rpc-error'
    })
    expect(requests).toEqual([
      ['https://primary.example/', 'eth_chainId'],
      ['https://primary.example/', 'eth_getBalance']
    ])
  })

  test('rejects the wrong chain and attests the fallback before using it', async () => {
    const requests = []
    const client = createEvmRpcFailoverClient(
      {
        chainId: 'eip155:1',
        endpoints: [
          { id: 'wrong', label: 'Wrong chain', url: 'https://wrong.example' },
          { id: 'fallback', label: 'Fallback', url: 'https://fallback.example' }
        ]
      },
      async (url, init) => {
        const request = JSON.parse(init.body)
        requests.push([url, request.method])
        if (request.method === 'eth_chainId') {
          return rpcResponse(request.id, url === 'https://wrong.example/' ? '0x38' : '0x1')
        }
        if (request.method === 'eth_getBalance') return rpcResponse(request.id, '0x7')
        throw new Error(`Unexpected request: ${request.method}`)
      }
    )

    await expect(client.assertExpectedChain()).resolves.toBeUndefined()
    await expect(client.getNativeBalance(ADDRESS)).resolves.toBe('7')
    expect(requests).toEqual([
      ['https://wrong.example/', 'eth_chainId'],
      ['https://fallback.example/', 'eth_chainId'],
      ['https://fallback.example/', 'eth_getBalance']
    ])
  })
})
