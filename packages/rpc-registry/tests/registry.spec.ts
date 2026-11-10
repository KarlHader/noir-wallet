import { expect, test } from '@playwright/test'
import { handleRegistryRequest } from '../src/api'
import { getMonitorTargets, RPC_REGISTRY, ZCASH_RPC_REGISTRY } from '../src/registry'
import { ZERO_INDEXER_REGISTRY } from '../src/zero-indexer-registry'

test('serves broadcast nodes separately from sync RPC monitoring', async () => {
  const response = handleRegistryRequest(
    new Request('https://rpc.zknoir.com/v1/zero-indexer-endpoints')
  )
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual(ZERO_INDEXER_REGISTRY)
  expect(ZERO_INDEXER_REGISTRY.networks.mainnet).toHaveLength(1)
  expect(ZERO_INDEXER_REGISTRY.networks.testnet).toHaveLength(1)
  const monitoredUrls = new Set(getMonitorTargets(RPC_REGISTRY).map(endpoint => endpoint.url))
  for (const endpoint of [
    ...ZERO_INDEXER_REGISTRY.networks.mainnet,
    ...ZERO_INDEXER_REGISTRY.networks.testnet
  ]) {
    expect(monitoredUrls.has(endpoint.url)).toBe(false)
  }
})

test('preserves the V1 response and publishes the multi-chain registry on request', async () => {
  const legacy = handleRegistryRequest(new Request('https://rpc.zknoir.com/v1/rpc-endpoints'))
  const response = handleRegistryRequest(
    new Request('https://rpc.zknoir.com/v1/rpc-endpoints?scope=multichain')
  )

  expect(legacy.status).toBe(200)
  await expect(legacy.json()).resolves.toEqual(ZCASH_RPC_REGISTRY)
  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBe('*')
  expect(response.headers.get('cache-control')).toContain('max-age=300')
  expect(response.headers.get('cloudflare-cdn-cache-control')).toContain('max-age=3600')
  await expect(response.json()).resolves.toEqual(RPC_REGISTRY)

  const zcash = RPC_REGISTRY.chains.find(chain => chain.id === 'zcash-mainnet')
  expect(zcash?.endpoints.map(endpoint => endpoint.id)).toEqual([
    'zec-rocks',
    'deltarpc',
    'deltarpc-web',
    'deltarpc-web-1',
    'deltarpc-web-2',
    'deltarpc-web-sg',
    'deltarpc-web-us',
    'deltarpc-web-eu',
    'deltarpc-web-eu-2',
    'deltarpc-web-eu-3',
    'chainsafe'
  ])
  expect(
    RPC_REGISTRY.chains.find(chain => chain.id === 'eip155:1')?.endpoints.length
  ).toBeGreaterThan(1)
  expect(
    RPC_REGISTRY.chains.find(chain => chain.id === 'eip155:9745')?.endpoints.length
  ).toBeGreaterThan(1)
  expect(
    RPC_REGISTRY.chains.find(chain => chain.id === 'near:testnet')?.endpoints.length
  ).toBeGreaterThan(1)
})

test('derives monitor targets from the same registry across chain namespaces', () => {
  const registry = {
    ...RPC_REGISTRY,
    chains: [
      ...RPC_REGISTRY.chains,
      {
        ...RPC_REGISTRY.chains[0],
        id: 'zcash-testnet',
        network: 'testnet',
        endpoints: [
          {
            id: 'testnet-primary',
            label: 'Testnet Primary',
            url: 'https://testnet.example.com'
          }
        ]
      }
    ]
  }

  const targets = getMonitorTargets(registry)
  expect(targets).toHaveLength(12)
  expect(targets.at(-1)).toMatchObject({
    chainId: 'zcash-testnet',
    chain: 'zcash',
    network: 'testnet',
    id: 'testnet-primary'
  })
})

test('publishes Dash Insight endpoints without monitoring them', () => {
  const dash = RPC_REGISTRY.chains.filter(chain => chain.probe === 'dash-insight')
  expect(dash.map(chain => [chain.id, chain.network, chain.endpoints[0]?.url])).toEqual([
    ['bip122:00000ffd590b1485b3caadc19b22e637', 'mainnet', 'https://insight.dash.org/insight-api'],
    [
      'bip122:00000bafbc94add76cb75e2ec9289483',
      'testnet',
      'https://insight.testnet.networks.dash.org/insight-api'
    ]
  ])
  const monitored = getMonitorTargets(RPC_REGISTRY)
  expect(monitored.every(target => target.probe === 'zcash-lightwalletd-grpc-web')).toBe(true)
  expect(monitored.some(target => target.url.includes('insight.dash.org'))).toBe(false)
  expect(monitored.some(target => target.chainId.startsWith('bip122:00000'))).toBe(false)
})

test('rejects unknown routes and supports CORS preflight', async () => {
  const notFound = handleRegistryRequest(new Request('https://rpc.zknoir.com/'))
  const preflight = handleRegistryRequest(
    new Request('https://rpc.zknoir.com/v1/rpc-endpoints', { method: 'OPTIONS' })
  )

  expect(notFound.status).toBe(404)
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
})
