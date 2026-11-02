import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  RPC_RECOVERY_COOLDOWN_MS,
  RPC_RECOVERY_PROBE_INTERVAL_MS,
  createRpcFailoverState,
  registerPreferredRpcProbe,
  registerRpcFailure,
  registerRpcSuccess
} from '../../../../src/infrastructure/chains/rpc-failover'
import { isRpcEndpointError } from '../../../../src/lib/errors'
import {
  getActiveRpcEndpointOption,
  getNextRpcEndpointOption,
  getPreferredRpcEndpointOption,
  getRpcEndpointOptions,
  refreshRpcEndpointRegistry,
  setActiveRpcEndpointOverride,
  setActiveRpcEndpointPreferences,
  syncActiveRpcEndpointPreferencesFromStorage
} from '../../../../src/infrastructure/chains/rpc-endpoints'
import {
  getManagedRpcEndpointOptions,
  parseRpcRegistryDocument,
  probeRpcEndpoint,
  selectPreferredRpcEndpoint,
  setActiveRpcRegistryDocument
} from '../../../../src/infrastructure/chains/rpc-registry-client'
import {
  getEvmRpcEndpointOptions,
  resolveBitcoinRpcEndpointOptions,
  resolveNearRpcEndpointOptions,
  resolveSolanaRpcEndpointOptions
} from '../../../../src/infrastructure/chains/managed-rpc-endpoints'
import { getBitcoinChainId } from '../../../../src/core/chains/registry'
import { SOLANA_NETWORKS } from '../../../../src/config/networks'

test('bundles one local Zcash endpoint before the registry is loaded', () => {
  expect(getRpcEndpointOptions('zcash').map(option => option.id)).toEqual(['deltarpc'])
  expect(getNextRpcEndpointOption('zcash', 'deltarpc', 'deltarpc')).toBeUndefined()
})

test('uses the fastest RPC only when no valid persisted preference exists', async () => {
  const endpoints = [
    { id: 'primary', label: 'Primary', url: 'https://primary.example.com' },
    { id: 'fast', label: 'Fast', url: 'https://fast.example.com' },
    { id: 'slow', label: 'Slow', url: 'https://slow.example.com' }
  ]
  const latencies = new Map([
    [endpoints[0].id, 300],
    [endpoints[1].id, 80],
    [endpoints[2].id, 140]
  ])
  const probe = async (endpoint: (typeof endpoints)[number]) =>
    latencies.get(endpoint.id) ?? Number.MAX_SAFE_INTEGER

  await expect(selectPreferredRpcEndpoint(endpoints, undefined, probe)).resolves.toBe(endpoints[1])
  await expect(selectPreferredRpcEndpoint(endpoints, endpoints[2].id, probe)).resolves.toBe(
    endpoints[2]
  )
  await expect(selectPreferredRpcEndpoint(endpoints, 'removed-endpoint', probe)).resolves.toBe(
    endpoints[1]
  )
})

test('validates the versioned multi-chain RPC registry at the extension boundary', () => {
  const registry = parseRpcRegistryDocument({
    version: 1,
    updatedAt: '2026-09-07T00:00:00.000Z',
    chains: [
      {
        id: 'zcash-mainnet',
        chain: 'zcash',
        network: 'mainnet',
        label: 'Zcash',
        iconChain: 'zec',
        probe: 'zcash-lightwalletd-grpc-web',
        endpoints: [{ id: 'primary', label: 'Primary', url: 'https://rpc.example.com/' }]
      },
      {
        id: 'bip122:000000000019d6689c085ae165831e93',
        chain: 'bitcoin',
        network: 'mainnet',
        label: 'Bitcoin',
        iconChain: 'btc',
        probe: 'bitcoin-esplora',
        endpoints: [
          { id: 'btc-primary', label: 'BTC Primary', url: 'https://btc.example.com/api/' }
        ]
      }
    ]
  })

  expect(registry?.chains).toHaveLength(2)
  expect(registry?.chains[0].endpoints[0].url).toBe('https://rpc.example.com')
  expect(registry?.chains[1].endpoints[0].url).toBe('https://btc.example.com/api/')
  expect(
    parseRpcRegistryDocument({
      version: 1,
      updatedAt: '2026-09-07T00:00:00.000Z',
      chains: [
        {
          id: 'zcash-mainnet',
          chain: 'zcash',
          network: 'mainnet',
          label: 'Zcash',
          iconChain: 'zec',
          probe: 'zcash-lightwalletd-grpc-web',
          endpoints: [{ id: 'unsafe', label: 'Unsafe', url: 'http://rpc.example.com' }]
        }
      ]
    })
  ).toBeNull()
})

test('scopes remote RPC endpoints by chain, network, and protocol', () => {
  const document = parseRpcRegistryDocument({
    version: 1,
    updatedAt: '2026-09-30T00:00:00.000Z',
    chains: [
      {
        id: 'eip155:1',
        chain: 'eip155',
        network: 'mainnet',
        label: 'Ethereum',
        iconChain: 'eth',
        probe: 'evm-json-rpc',
        endpoints: [
          { id: 'primary', label: 'Primary', url: 'https://rpc.example.com/eth' },
          { id: 'secondary', label: 'Secondary', url: 'https://backup.example.com/eth' }
        ]
      }
    ]
  })
  expect(document).not.toBeNull()
  if (!document) return
  setActiveRpcRegistryDocument(document)

  try {
    expect(getManagedRpcEndpointOptions('eip155:1', 'mainnet', 'evm-json-rpc')[0].url).toBe(
      'https://rpc.example.com/eth'
    )
    expect(getEvmRpcEndpointOptions('mainnet', 'eip155:1').map(endpoint => endpoint.id)).toEqual([
      'primary',
      'secondary'
    ])
    expect(getManagedRpcEndpointOptions('eip155:1', 'testnet', 'evm-json-rpc')).toEqual([])
    expect(getManagedRpcEndpointOptions('eip155:42161', 'mainnet', 'evm-json-rpc')).toEqual([])
    expect(getManagedRpcEndpointOptions('eip155:1', 'mainnet', 'near-json-rpc')).toEqual([])
  } finally {
    setActiveRpcRegistryDocument(null)
  }
})

test('uses managed Bitcoin, Solana, and NEAR endpoints only for their matching networks', () => {
  const document = parseRpcRegistryDocument({
    version: 1,
    updatedAt: '2026-09-30T00:00:00.000Z',
    chains: [
      {
        id: getBitcoinChainId('mainnet'),
        chain: 'bitcoin',
        network: 'mainnet',
        label: 'Bitcoin',
        iconChain: 'btc',
        probe: 'bitcoin-esplora',
        endpoints: [{ id: 'managed-btc', label: 'Managed BTC', url: 'https://btc.example.com' }]
      },
      {
        id: SOLANA_NETWORKS.mainnet.chainId,
        chain: 'solana',
        network: 'mainnet',
        label: 'Solana',
        iconChain: 'sol',
        probe: 'solana-json-rpc',
        endpoints: [{ id: 'managed-sol', label: 'Managed SOL', url: 'https://sol.example.com' }]
      },
      {
        id: 'near:mainnet',
        chain: 'near',
        network: 'mainnet',
        label: 'NEAR',
        iconChain: 'near',
        probe: 'near-json-rpc',
        endpoints: [{ id: 'managed-near', label: 'Managed NEAR', url: 'https://near.example.com' }]
      }
    ]
  })
  expect(document).not.toBeNull()
  if (!document) return
  setActiveRpcRegistryDocument(document)

  try {
    expect(resolveBitcoinRpcEndpointOptions('mainnet')[0]).toEqual({
      id: 'managed-btc',
      baseUrl: 'https://btc.example.com/'
    })
    expect(resolveSolanaRpcEndpointOptions('mainnet')[0].id).toBe('managed-sol')
    expect(resolveNearRpcEndpointOptions('mainnet')[0].id).toBe('managed-near')
    expect(resolveBitcoinRpcEndpointOptions('testnet')[0].id).not.toBe('managed-btc')
    expect(resolveSolanaRpcEndpointOptions('devnet')[0].id).not.toBe('managed-sol')
    expect(resolveNearRpcEndpointOptions('testnet')[0].id).not.toBe('managed-near')
  } finally {
    setActiveRpcRegistryDocument(null)
  }
})

test('measures only a functional gRPC-Web endpoint', async () => {
  const endpoint = { id: 'primary', label: 'Primary', url: 'https://rpc.example.com' }
  const data = Uint8Array.from([0, 0, 0, 0, 1, 1])
  const trailers = new TextEncoder().encode('grpc-status: 0\r\n')
  const body = new Uint8Array(data.length + 5 + trailers.length)
  body.set(data)
  body[data.length] = 0x80
  new DataView(body.buffer).setUint32(data.length + 1, trailers.length)
  body.set(trailers, data.length + 5)

  await expect(
    probeRpcEndpoint(
      endpoint,
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/grpc-web+proto' }
        })
    )
  ).resolves.toBeGreaterThanOrEqual(0)

  await expect(
    probeRpcEndpoint(
      endpoint,
      async () =>
        new Response('<html>proxy error</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
    )
  ).rejects.toThrow('RPC probe returned text/html')
})

test('counts endpoint connectivity errors but ignores local worker timeouts', () => {
  expect(isRpcEndpointError('gRPC transport error: UNAVAILABLE')).toBe(true)
  expect(isRpcEndpointError('NetworkError when attempting to fetch resource.')).toBe(true)
  expect(isRpcEndpointError('Failed to resolve chain height from network and wallet summary')).toBe(
    true
  )
  expect(isRpcEndpointError('Offscreen RPC timeout: wallet.getWalletSummary')).toBe(false)
  expect(isRpcEndpointError('WALLET_DIRTY')).toBe(false)
})

test('fails over after the first RPC connectivity failure', () => {
  const now = 1_000_000
  const initial = createRpcFailoverState('deltarpc')
  const failedOver = registerRpcFailure(initial, 'deltarpc', 'deltarpc-web', now)

  expect(failedOver.transition).toEqual({
    reason: 'failover',
    fromEndpointId: 'deltarpc',
    toEndpointId: 'deltarpc-web'
  })
  expect(failedOver.state.activeEndpointId).toBe('deltarpc-web')
  expect(failedOver.state.recoverAfter).toBe(now + RPC_RECOVERY_COOLDOWN_MS)
})

test('advances from the first fallback to the next configured endpoint', () => {
  const now = 1_500_000
  const firstFallback = registerRpcFailure(
    createRpcFailoverState('deltarpc'),
    'deltarpc',
    'deltarpc-web',
    now
  ).state
  const secondFallback = registerRpcFailure(firstFallback, 'deltarpc', 'deltarpc-web-1', now + 1)

  expect(secondFallback.transition).toEqual({
    reason: 'failover',
    fromEndpointId: 'deltarpc-web',
    toEndpointId: 'deltarpc-web-1'
  })
  expect(secondFallback.state.activeEndpointId).toBe('deltarpc-web-1')
  expect(secondFallback.state.failedOverAt).toBe(now)
})

test('a successful preferred-endpoint sync keeps the preferred endpoint active', () => {
  const state = createRpcFailoverState('deltarpc')
  expect(registerRpcSuccess(state, 'deltarpc')).toBe(state)
})

test('a successful fallback sync keeps the fallback active until recovery', () => {
  const state = {
    ...createRpcFailoverState('deltarpc'),
    activeEndpointId: 'chainsafe' as const,
    failedOverAt: 100,
    recoverAfter: 200
  }

  expect(registerRpcSuccess(state, 'deltarpc')).toBe(state)
})

test('requires two successful recovery probes before restoring the preferred endpoint', () => {
  const now = 2_000_000
  const failedOver = registerRpcFailure(
    createRpcFailoverState('deltarpc'),
    'deltarpc',
    'chainsafe',
    now
  ).state

  const firstProbe = registerPreferredRpcProbe(failedOver, 'deltarpc', true, now)
  expect(firstProbe.transition).toBeUndefined()
  expect(firstProbe.state.activeEndpointId).toBe('chainsafe')
  expect(firstProbe.state.preferredProbeSuccesses).toBe(1)
  expect(firstProbe.state.recoverAfter).toBe(now + RPC_RECOVERY_PROBE_INTERVAL_MS)

  const recovered = registerPreferredRpcProbe(
    firstProbe.state,
    'deltarpc',
    true,
    now + RPC_RECOVERY_PROBE_INTERVAL_MS
  )
  expect(recovered.transition).toEqual({
    reason: 'recovery',
    fromEndpointId: 'chainsafe',
    toEndpointId: 'deltarpc'
  })
  expect(recovered.state).toEqual(createRpcFailoverState('deltarpc'))
})

test('a failed recovery probe keeps the fallback and restarts the cooldown', () => {
  const now = 3_000_000
  const failedOver = registerRpcFailure(
    createRpcFailoverState('deltarpc'),
    'deltarpc',
    'chainsafe',
    now
  ).state
  const probeFailed = registerPreferredRpcProbe(failedOver, 'deltarpc', false, now)

  expect(probeFailed.transition).toBeUndefined()
  expect(probeFailed.state.activeEndpointId).toBe('chainsafe')
  expect(probeFailed.state.preferredProbeSuccesses).toBe(0)
  expect(probeFailed.state.recoverAfter).toBe(now + RPC_RECOVERY_COOLDOWN_MS)
})

test('changing the preferred endpoint discards stale failover state', () => {
  const stale = {
    ...createRpcFailoverState('deltarpc'),
    activeEndpointId: 'chainsafe' as const,
    failedOverAt: 100,
    recoverAfter: 200
  }

  expect(registerRpcSuccess(stale, 'chainsafe')).toEqual(createRpcFailoverState('chainsafe'))
})

test('restores a legacy Zcash selection from cache without rewriting it on registry failure', async () => {
  const originalEndpoints = getRpcEndpointOptions('zcash')
  const cachedRegistry = parseRpcRegistryDocument({
    version: 1,
    updatedAt: '2026-09-30T00:00:00.000Z',
    chains: [
      {
        id: 'zcash-mainnet',
        chain: 'zcash',
        network: 'mainnet',
        label: 'Zcash',
        iconChain: 'zec',
        probe: 'zcash-lightwalletd-grpc-web',
        endpoints: [
          { id: 'chainsafe', label: 'ChainSafe', url: 'https://zcash-mainnet.chainsafe.dev' },
          { id: 'deltarpc', label: 'DeltaRPC', url: 'https://zcash-wallet-grpc-self.deltarpc.com' }
        ]
      }
    ]
  })
  expect(cachedRegistry).not.toBeNull()
  if (!cachedRegistry) return
  const storedSettings = {
    state: { rpcEndpointPreferences: { zcash: 'chainsafe' } },
    version: 0
  }
  const writes: unknown[] = []
  let cachedValue: unknown = cachedRegistry
  const originalChrome = globalThis.chrome
  const originalFetch = globalThis.fetch
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key: string) =>
          key === 'wallet_settings'
            ? { wallet_settings: storedSettings }
            : { rpc_registry_cache_v1: cachedValue },
        set: async (value: unknown) => {
          writes.push(value)
        }
      }
    }
  } as typeof chrome
  globalThis.fetch = async () => {
    throw new Error('Registry offline')
  }

  try {
    cachedValue = parseRpcRegistryDocument({
      ...cachedRegistry,
      chains: cachedRegistry.chains.map(chain => ({
        ...chain,
        endpoints: chain.endpoints.filter(endpoint => endpoint.id !== 'chainsafe')
      }))
    })
    await expect(syncActiveRpcEndpointPreferencesFromStorage()).resolves.toEqual({
      zcash: 'chainsafe'
    })
    expect(getPreferredRpcEndpointOption('zcash').id).toBe('deltarpc')
    expect(writes).toEqual([])

    cachedValue = cachedRegistry
    await expect(syncActiveRpcEndpointPreferencesFromStorage()).resolves.toEqual({
      zcash: 'chainsafe'
    })
    expect(getPreferredRpcEndpointOption('zcash').id).toBe('chainsafe')
    expect(getRpcEndpointOptions('zcash').map(option => option.id)).toEqual([
      'chainsafe',
      'deltarpc'
    ])
    setActiveRpcEndpointOverride('zcash', 'deltarpc')
    expect(getActiveRpcEndpointOption('zcash').id).toBe('deltarpc')
    setActiveRpcEndpointOverride('zcash')
    expect(getActiveRpcEndpointOption('zcash').id).toBe('chainsafe')
    await expect(refreshRpcEndpointRegistry()).resolves.toEqual({ zcash: 'chainsafe' })
    expect(writes).toEqual([])

    cachedValue = parseRpcRegistryDocument({
      ...cachedRegistry,
      chains: cachedRegistry.chains.map(chain => ({
        ...chain,
        endpoints: chain.endpoints.filter(endpoint => endpoint.id === 'chainsafe')
      }))
    })
    await syncActiveRpcEndpointPreferencesFromStorage()
    expect(getRpcEndpointOptions('zcash').map(option => option.id)).toEqual(['chainsafe'])
  } finally {
    // The Zcash runtime pool is separate from the shared managed registry.
    cachedValue = {
      ...cachedRegistry,
      chains: cachedRegistry.chains.map(chain => ({ ...chain, endpoints: originalEndpoints }))
    }
    await syncActiveRpcEndpointPreferencesFromStorage()
    setActiveRpcEndpointOverride('zcash')
    setActiveRpcEndpointPreferences()
    setActiveRpcRegistryDocument(null)
    globalThis.fetch = originalFetch
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
  }
})
