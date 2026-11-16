import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { getEvmNetworkConfig } from '../../../../src/config/networks.ts'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  setActiveChainEndpointSettings,
  withChainRpcEndpoint
} from '../../../../src/core/chains/chain-endpoint-settings.ts'
import { createConfiguredEvmRpcClient } from '../../../../src/infrastructure/chains/evm/index.ts'
import { createEvmRpcFailoverClient } from '../../../../src/infrastructure/chains/evm/evm-rpc-failover-client.ts'
import { setActiveRpcRegistryDocument } from '../../../../src/infrastructure/chains/rpc-registry-client.ts'

const address = '0x1111111111111111111111111111111111111111'
const primary = { id: 'primary', label: 'Primary', url: 'https://primary.example' }
const secondary = { id: 'secondary', label: 'Secondary', url: 'https://secondary.example' }
const replacement = { id: 'replacement', label: 'Replacement', url: 'https://replacement.example' }
const originalFetch = globalThis.fetch

function rpcResponse(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'content-type': 'application/json' }
  })
}

function registry(endpoints) {
  setActiveRpcRegistryDocument({
    version: 1,
    updatedAt: '2026-10-14T00:00:00.000Z',
    chains: [
      {
        id: 'eip155:1',
        chain: 'eip155',
        network: 'mainnet',
        label: 'Ethereum',
        iconChain: 'eth',
        probe: 'evm-json-rpc',
        endpoints
      }
    ]
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  setActiveRpcRegistryDocument(null)
  setActiveChainEndpointSettings()
})

describe('EVM Auto RPC pool', () => {
  it('uses a late registry fallback from the original cold-start client', async () => {
    const requests = []
    const bundled = getEvmNetworkConfig('mainnet').rpcUrl
    globalThis.fetch = async (url, init) => {
      const request = JSON.parse(init.body)
      requests.push([url, request.method])
      if (url === new URL(bundled).toString()) return new Response('', { status: 429 })
      if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x1')
      return rpcResponse(request.id, '0x2a')
    }

    const client = createConfiguredEvmRpcClient('mainnet')
    await assert.rejects(client.getNativeBalance(address), { code: 'rate-limited' })
    registry([{ id: 'bundled', label: 'Bundled', url: bundled }, secondary])

    assert.equal(await client.getNativeBalance(address), '42')
    assert.equal(await client.getNativeBalance(address), '42')
    assert.deepEqual(requests, [
      [new URL(bundled).toString(), 'eth_chainId'],
      [new URL(bundled).toString(), 'eth_chainId'],
      [secondary.url + '/', 'eth_chainId'],
      [secondary.url + '/', 'eth_getBalance'],
      [secondary.url + '/', 'eth_getBalance']
    ])
  })

  it('keeps the healthy endpoint across reordering and attests a newly selected endpoint', async () => {
    let options = [primary, secondary]
    const requests = []
    const client = createEvmRpcFailoverClient(
      { chainId: 'eip155:1', endpoints: () => options },
      async (url, init) => {
        const request = JSON.parse(init.body)
        requests.push([url, request.method])
        if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x1')
        if (url === primary.url + '/') return new Response('', { status: 429 })
        return rpcResponse(request.id, url === secondary.url + '/' ? '0x2a' : '0x2b')
      }
    )

    assert.equal(await client.getNativeBalance(address), '42')
    options = [replacement, secondary, primary]
    assert.equal(await client.getNativeBalance(address), '42')
    options = [replacement]
    assert.equal(await client.getNativeBalance(address), '43')
    assert.deepEqual(requests, [
      [primary.url + '/', 'eth_chainId'],
      [primary.url + '/', 'eth_getBalance'],
      [secondary.url + '/', 'eth_chainId'],
      [secondary.url + '/', 'eth_getBalance'],
      [secondary.url + '/', 'eth_getBalance'],
      [replacement.url + '/', 'eth_chainId'],
      [replacement.url + '/', 'eth_getBalance']
    ])
  })

  it('finishes an in-flight request against its original pool snapshot', async () => {
    let options = [primary, secondary]
    let releasePrimary
    let notifyStarted
    const started = new Promise(resolve => {
      notifyStarted = resolve
    })
    const primaryChain = new Promise(resolve => {
      releasePrimary = resolve
    })
    const requests = []
    const client = createEvmRpcFailoverClient(
      { chainId: 'eip155:1', endpoints: () => options },
      async (url, init) => {
        const request = JSON.parse(init.body)
        requests.push([url, request.method])
        if (url === primary.url + '/' && request.method === 'eth_chainId') {
          notifyStarted()
          await primaryChain
          return rpcResponse(request.id, '0x1')
        }
        if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x1')
        if (url === primary.url + '/') return new Response('', { status: 429 })
        return rpcResponse(request.id, '0x2a')
      }
    )

    const pending = client.getNativeBalance(address)
    await started
    options = [replacement]
    releasePrimary()
    assert.equal(await pending, '42')
    assert.equal(await client.getNativeBalance(address), '42')
    assert.deepEqual(
      requests.map(([url]) => url),
      [
        primary.url + '/',
        primary.url + '/',
        secondary.url + '/',
        secondary.url + '/',
        replacement.url + '/',
        replacement.url + '/'
      ]
    )
  })

  it('keeps a manually selected RPC fixed when a managed pool exists', async () => {
    registry([primary, secondary])
    const selected = 'https://fixed.example'
    setActiveChainEndpointSettings(
      withChainRpcEndpoint(DEFAULT_CHAIN_ENDPOINT_SETTINGS, 'eip155:1', {
        protocol: 'evm-json-rpc',
        label: 'Fixed',
        url: selected
      })
    )
    const requests = []
    globalThis.fetch = async (url, init) => {
      requests.push([url, JSON.parse(init.body).method])
      return new Response('', { status: 429 })
    }
    const client = createConfiguredEvmRpcClient('mainnet', {
      ...getEvmNetworkConfig('mainnet'),
      rpcUrl: selected
    })

    await assert.rejects(client.getNativeBalance(address), { code: 'rate-limited' })
    assert.deepEqual(requests, [[selected + '/', 'eth_chainId']])
  })

  it('keeps an unbundled custom chain on its configured endpoint', async () => {
    const selected = 'https://custom.example'
    const requests = []
    globalThis.fetch = async (url, init) => {
      requests.push([url, JSON.parse(init.body).method])
      return new Response('', { status: 429 })
    }
    const client = createConfiguredEvmRpcClient('mainnet', {
      ...getEvmNetworkConfig('mainnet'),
      chainId: 'eip155:999999',
      numericChainId: 999999,
      rpcUrl: selected
    })

    await assert.rejects(client.getNativeBalance(address), { code: 'rate-limited' })
    assert.deepEqual(requests, [[selected + '/', 'eth_chainId']])
  })

  it('does not move a deterministic RPC execution error to another endpoint', async () => {
    const requests = []
    const client = createEvmRpcFailoverClient(
      { chainId: 'eip155:1', endpoints: () => [primary, secondary] },
      async (url, init) => {
        const request = JSON.parse(init.body)
        requests.push([url, request.method])
        if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x1')
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32000, message: 'execution reverted' }
          })
        )
      }
    )

    await assert.rejects(client.getNativeBalance(address), { code: 'rpc-error' })
    assert.deepEqual(requests, [
      [primary.url + '/', 'eth_chainId'],
      [primary.url + '/', 'eth_getBalance']
    ])
  })

  it('rejects wrong-chain endpoints and never retries a cancelled request', async () => {
    const requests = []
    const controller = new AbortController()
    const client = createEvmRpcFailoverClient(
      { chainId: 'eip155:1', endpoints: () => [primary, secondary] },
      async (url, init) => {
        const request = JSON.parse(init.body)
        requests.push([url, request.method])
        if (request.method === 'eth_chainId') {
          return rpcResponse(request.id, url === primary.url + '/' ? '0x38' : '0x1')
        }
        controller.abort()
        throw new DOMException('The request was aborted', 'AbortError')
      }
    )

    await assert.rejects(client.getNativeBalance(address, controller.signal), { code: 'cancelled' })
    assert.deepEqual(requests, [
      [primary.url + '/', 'eth_chainId'],
      [secondary.url + '/', 'eth_chainId'],
      [secondary.url + '/', 'eth_getBalance']
    ])
    await assert.rejects(client.getNativeBalance(address, controller.signal), { code: 'cancelled' })
    assert.equal(requests.length, 3)
  })

  it('retries the exact same signed raw transaction on a healthy endpoint', async () => {
    const rawTransaction = '0x0102'
    const hash = `0x${'a'.repeat(64)}`
    const broadcasts = []
    const client = createEvmRpcFailoverClient(
      { chainId: 'eip155:1', endpoints: () => [primary, secondary] },
      async (url, init) => {
        const request = JSON.parse(init.body)
        if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x1')
        assert.equal(request.method, 'eth_sendRawTransaction')
        broadcasts.push([url, request.params[0]])
        if (url === primary.url + '/') throw new TypeError('Network unavailable')
        return rpcResponse(request.id, hash)
      }
    )

    assert.equal(await client.broadcastRawTransaction(rawTransaction), hash)
    assert.deepEqual(broadcasts, [
      [primary.url + '/', rawTransaction],
      [secondary.url + '/', rawTransaction]
    ])
  })
})
