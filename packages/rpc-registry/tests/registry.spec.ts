import { expect, test } from '@playwright/test'
import { handleRegistryRequest } from '../src/api'
import { getMonitorTargets, RPC_REGISTRY, ZCASH_RPC_REGISTRY } from '../src/registry'
import { ZERO_INDEXER_REGISTRY } from '../src/zero-indexer-registry'
import { TOKEN_REGISTRY } from '../src/token-registry'

test('serves canonical, unique token identities with CORS and preflight', async () => {
  const url = 'https://rpc.zknoir.com/v1/token-registry'
  const response = handleRegistryRequest(new Request(url))
  const preflight = handleRegistryRequest(new Request(url, { method: 'OPTIONS' }))

  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBe('*')
  expect(response.headers.get('cache-control')).toContain('max-age=300')
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
  await expect(response.json()).resolves.toEqual(TOKEN_REGISTRY)
  expect(TOKEN_REGISTRY.version).toBe(1)
  expect(Number.isNaN(Date.parse(TOKEN_REGISTRY.updatedAt))).toBe(false)
  expect(TOKEN_REGISTRY.assets.length).toBeGreaterThan(0)
  expect(new Set(TOKEN_REGISTRY.assets.map(asset => asset.assetId)).size).toBe(
    TOKEN_REGISTRY.assets.length
  )
  for (const asset of TOKEN_REGISTRY.assets) {
    expect(asset).toEqual({
      assetId: expect.any(String),
      network: expect.stringMatching(/^(mainnet|testnet)$/),
      defaultVisible: expect.any(Boolean)
    })
    expect(asset.assetId).toMatch(
      /^(?:eip155:[0-9]+\/erc20:0x[0-9a-f]{40}|solana:[1-9A-HJ-NP-Za-km-z]{32}\/token:[1-9A-HJ-NP-Za-km-z]{32,44}|near:(?:mainnet|testnet)\/nep141:[a-z0-9]+(?:[._-][a-z0-9]+)*)$/
    )
    if (asset.assetId.startsWith('near:mainnet/') || asset.assetId.startsWith('solana:')) {
      expect(asset.network).toBe('mainnet')
    }
  }
})

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
    'deltarpc-web',
    'deltarpc-web-1',
    'deltarpc-web-2',
    'deltarpc-web-sg',
    'deltarpc-web-us',
    'deltarpc-web-eu',
    'deltarpc-web-eu-2',
    'deltarpc-web-eu-3'
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
  expect(targets).toHaveLength(10)
  expect(targets.at(-1)).toMatchObject({
    chainId: 'zcash-testnet',
    chain: 'zcash',
    network: 'testnet',
    id: 'testnet-primary'
  })
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
