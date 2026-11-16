import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { attestZcashLightwalletdEndpoint } from '@/infrastructure/chains/zcash/zcash-network-attestation'
import {
  readZeroIndexerEnabled,
  ZERO_INDEXER_NODES_STORAGE_KEY,
  ZERO_INDEXER_REGISTRY_CACHE_KEY,
  ZERO_INDEXER_RUNTIME_STORAGE_KEY
} from '@/infrastructure/chains/zero-indexer-preferences'
import { DEFAULT_ZERO_INDEXER_REGISTRY, ZERO_INDEXER_REGISTRY_URL } from '@/config/zero-indexer'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import {
  createCustomZeroIndexerEndpoint,
  normalizeZeroIndexerUrl,
  parseZeroIndexerNodePreferences,
  parseZeroIndexerNodeStatus,
  parseZeroIndexerRegistryDocument,
  type ZeroIndexerOptions,
  type ZeroIndexerNetwork,
  type ZeroIndexerNodePreferences,
  type ZeroIndexerNodeStatus,
  type ZeroIndexerRegistryDocument
} from '@/core/zcash/zero-indexer'

const REGISTRY_TIMEOUT_MS = 3_000
const PROBE_CACHE_MAX_AGE_MS = 5 * 60_000
const mutationQueue = new SerialTaskQueue()
const refreshDedup = new DedupPromise<ZeroIndexerNodeStatus>()
let registrySuccessAt = 0
let registryAttemptAt = 0

async function verifyZcashRpcEndpoint(
  endpoint: { url: string },
  network: ZeroIndexerNetwork
): Promise<number> {
  const started = performance.now()
  await attestZcashLightwalletdEndpoint({ baseUrl: endpoint.url, network })
  return Math.max(0, Math.round(performance.now() - started))
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  return mutationQueue.run(operation)
}

async function readPreferences(): Promise<ZeroIndexerNodePreferences> {
  const stored = await chrome.storage.local.get(ZERO_INDEXER_NODES_STORAGE_KEY)
  return parseZeroIndexerNodePreferences(stored[ZERO_INDEXER_NODES_STORAGE_KEY])
}

async function readRegistry(): Promise<ZeroIndexerRegistryDocument> {
  const stored = await chrome.storage.local.get(ZERO_INDEXER_REGISTRY_CACHE_KEY)
  return (
    parseZeroIndexerRegistryDocument(stored[ZERO_INDEXER_REGISTRY_CACHE_KEY]) ??
    DEFAULT_ZERO_INDEXER_REGISTRY
  )
}

async function fetchRegistry(): Promise<ZeroIndexerRegistryDocument> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
  try {
    const response = await fetch(ZERO_INDEXER_REGISTRY_URL, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`ZeroIndexer registry returned HTTP ${response.status}`)
    const parsed = parseZeroIndexerRegistryDocument(await response.json())
    if (!parsed) throw new Error('ZeroIndexer registry returned an invalid document')
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

function buildStatus(
  network: ZeroIndexerNetwork,
  enabled: boolean,
  preferences: ZeroIndexerNodePreferences,
  registry: ZeroIndexerRegistryDocument,
  previous?: ZeroIndexerNodeStatus
): ZeroIndexerNodeStatus {
  const managedEndpoints = registry.networks[network]
  const customEndpoints = preferences.networks[network].customEndpoints
  const selectedEndpointId = preferences.networks[network].selectedEndpointId
  const selectedExists = [...managedEndpoints, ...customEndpoints].some(
    endpoint => endpoint.id === selectedEndpointId
  )
  const mode = preferences.networks[network].mode === 'fixed' && selectedExists ? 'fixed' : 'auto'
  const previousUrls = new Map(
    previous?.network === network
      ? [...previous.managedEndpoints, ...previous.customEndpoints].map(endpoint => [
          endpoint.id,
          endpoint.url
        ])
      : []
  )
  const probes: ZeroIndexerNodeStatus['probes'] = {}
  for (const endpoint of [...managedEndpoints, ...customEndpoints]) {
    const probe = previous?.probes[endpoint.id]
    if (probe && previousUrls.get(endpoint.id) === endpoint.url) probes[endpoint.id] = probe
  }
  const orderedEndpointIds =
    previous?.network === network
      ? previous.orderedEndpointIds.filter(id =>
          managedEndpoints.some(
            endpoint => endpoint.id === id && previousUrls.get(id) === endpoint.url
          )
        )
      : []
  for (const endpoint of managedEndpoints) {
    if (!orderedEndpointIds.includes(endpoint.id)) orderedEndpointIds.push(endpoint.id)
  }
  return parseZeroIndexerNodeStatus({
    network,
    enabled,
    mode,
    selectedEndpointId: mode === 'fixed' ? selectedEndpointId : null,
    managedEndpoints,
    customEndpoints,
    orderedEndpointIds,
    probes
  })
}

async function statusFromLocal(network: ZeroIndexerNetwork): Promise<ZeroIndexerNodeStatus> {
  const [preferences, registry, enabled, runtime] = await Promise.all([
    readPreferences(),
    readRegistry(),
    readZeroIndexerEnabled(),
    chrome.storage.local
      .get(ZERO_INDEXER_RUNTIME_STORAGE_KEY)
      .catch((): Record<string, unknown> => ({}))
  ])
  const previous = parseFreshRuntimeStatus(runtime[ZERO_INDEXER_RUNTIME_STORAGE_KEY])
  return buildStatus(network, enabled, preferences, registry, previous)
}

function parseFreshRuntimeStatus(value: unknown): ZeroIndexerNodeStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const checkedAt = (value as { checkedAt?: unknown }).checkedAt
  if (
    typeof checkedAt !== 'number' ||
    !Number.isFinite(checkedAt) ||
    checkedAt > Date.now() ||
    Date.now() - checkedAt > PROBE_CACHE_MAX_AGE_MS
  )
    return undefined
  try {
    return parseZeroIndexerNodeStatus(value)
  } catch {
    return undefined
  }
}

async function saveStatus(
  status: ZeroIndexerNodeStatus,
  checkedAt?: number
): Promise<ZeroIndexerNodeStatus> {
  const previous = await chrome.storage.local
    .get(ZERO_INDEXER_RUNTIME_STORAGE_KEY)
    .catch((): Record<string, unknown> => ({}))
  const existing = previous[ZERO_INDEXER_RUNTIME_STORAGE_KEY]
  const existingCheckedAt =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as { checkedAt?: unknown }).checkedAt
      : undefined
  await chrome.storage.local
    .set({
      [ZERO_INDEXER_RUNTIME_STORAGE_KEY]: {
        ...status,
        checkedAt: checkedAt ?? (typeof existingCheckedAt === 'number' ? existingCheckedAt : 0)
      }
    })
    .catch(() => {})
  return status
}

export function getZeroIndexerNodeStatus(refresh = false): Promise<ZeroIndexerNodeStatus> {
  if (!refresh) return statusFromLocal(DEFAULT_NETWORK)
  return refreshDedup.run(refreshZeroIndexerNodeStatus)
}

async function refreshZeroIndexerNodeStatus(): Promise<ZeroIndexerNodeStatus> {
  let registry = await readRegistry()
  const now = Date.now()
  if (now - registrySuccessAt >= 5 * 60_000 && now - registryAttemptAt >= 60_000) {
    registryAttemptAt = now
    try {
      registry = await fetchRegistry()
      await chrome.storage.local.set({ [ZERO_INDEXER_REGISTRY_CACHE_KEY]: registry })
      registrySuccessAt = Date.now()
    } catch {
      // The cached registry and bundled defaults keep node selection usable offline.
    }
  }

  const network = DEFAULT_NETWORK
  const preferencesAtProbeStart = await readPreferences()
  const endpoints = [
    ...registry.networks[network],
    ...preferencesAtProbeStart.networks[network].customEndpoints
  ]
  const outcomes = await Promise.all(
    endpoints.map(async (endpoint, index) => {
      try {
        const latencyMs = await verifyZcashRpcEndpoint(endpoint, network)
        return { endpoint, index, probe: { status: 'ok' as const, latencyMs } }
      } catch {
        return { endpoint, index, probe: { status: 'unreachable' as const } }
      }
    })
  )

  return enqueue(async () => {
    const [preferences, enabled] = await Promise.all([readPreferences(), readZeroIndexerEnabled()])
    const status = buildStatus(network, enabled, preferences, registry)
    const currentUrls = new Map(
      [...status.managedEndpoints, ...status.customEndpoints].map(endpoint => [
        endpoint.id,
        endpoint.url
      ])
    )
    for (const outcome of outcomes) {
      if (currentUrls.get(outcome.endpoint.id) === outcome.endpoint.url) {
        status.probes[outcome.endpoint.id] = outcome.probe
      }
    }
    status.orderedEndpointIds = outcomes
      .filter(outcome =>
        status.managedEndpoints.some(endpoint => endpoint.id === outcome.endpoint.id)
      )
      .sort((left, right) => {
        const leftReachable = left.probe.status === 'ok'
        const rightReachable = right.probe.status === 'ok'
        if (leftReachable !== rightReachable) return leftReachable ? -1 : 1
        return (
          (left.probe.latencyMs ?? Infinity) - (right.probe.latencyMs ?? Infinity) ||
          left.index - right.index
        )
      })
      .map(outcome => outcome.endpoint.id)
    return saveStatus(status, Date.now())
  })
}

export function selectZeroIndexerNode(endpointId: string | null): Promise<ZeroIndexerNodeStatus> {
  return enqueue(async () => {
    if (endpointId !== null && typeof endpointId !== 'string') {
      throw new Error('Invalid ZeroIndexer endpoint')
    }
    const network = DEFAULT_NETWORK
    const [preferences, registry] = await Promise.all([readPreferences(), readRegistry()])
    const endpoints = [
      ...registry.networks[network],
      ...preferences.networks[network].customEndpoints
    ]
    if (endpointId !== null && !endpoints.some(endpoint => endpoint.id === endpointId)) {
      throw new Error('ZeroIndexer endpoint is no longer available')
    }
    preferences.networks[network].mode = endpointId === null ? 'auto' : 'fixed'
    preferences.networks[network].selectedEndpointId = endpointId
    await chrome.storage.local.set({ [ZERO_INDEXER_NODES_STORAGE_KEY]: preferences })
    return saveStatus(await statusFromLocal(network))
  })
}

export async function addCustomZeroIndexerNode(
  label: unknown,
  url: unknown
): Promise<ZeroIndexerNodeStatus> {
  const endpoint = createCustomZeroIndexerEndpoint(label, url)
  const [existingPreferences, existingRegistry] = await Promise.all([
    readPreferences(),
    readRegistry()
  ])
  const existing = [
    ...existingRegistry.networks[DEFAULT_NETWORK],
    ...existingPreferences.networks[DEFAULT_NETWORK].customEndpoints
  ]
  if (existing.some(item => normalizeZeroIndexerUrl(item.url) === endpoint.url)) {
    throw new Error('This ZeroIndexer endpoint is already available')
  }
  const latencyMs = await verifyZcashRpcEndpoint(endpoint, DEFAULT_NETWORK)
  return enqueue(async () => {
    const network = DEFAULT_NETWORK
    const [preferences, registry] = await Promise.all([readPreferences(), readRegistry()])
    const configured = [
      ...registry.networks[network],
      ...preferences.networks[network].customEndpoints
    ]
    if (configured.some(item => normalizeZeroIndexerUrl(item.url) === endpoint.url)) {
      throw new Error('This ZeroIndexer endpoint is already available')
    }
    preferences.networks[network].customEndpoints.push(endpoint)
    await chrome.storage.local.set({ [ZERO_INDEXER_NODES_STORAGE_KEY]: preferences })
    const status = await statusFromLocal(network)
    status.probes[endpoint.id] = { status: 'ok', latencyMs }
    return saveStatus(status, Date.now())
  })
}

export function removeCustomZeroIndexerNode(endpointId: string): Promise<ZeroIndexerNodeStatus> {
  return enqueue(async () => {
    const network = DEFAULT_NETWORK
    const preferences = await readPreferences()
    const current = preferences.networks[network]
    if (!current.customEndpoints.some(endpoint => endpoint.id === endpointId)) {
      throw new Error('Custom ZeroIndexer endpoint was not found')
    }
    current.customEndpoints = current.customEndpoints.filter(endpoint => endpoint.id !== endpointId)
    if (current.selectedEndpointId === endpointId) {
      current.mode = 'auto'
      current.selectedEndpointId = null
    }
    await chrome.storage.local.set({ [ZERO_INDEXER_NODES_STORAGE_KEY]: preferences })
    return saveStatus(await statusFromLocal(network))
  })
}

export async function getZeroIndexerBroadcastOptions(
  network: ZeroIndexerNetwork,
  enabled: boolean
): Promise<ZeroIndexerOptions | null> {
  if (!enabled) return null
  const [preferences, registry, runtime] = await Promise.all([
    readPreferences(),
    readRegistry(),
    chrome.storage.local
      .get(ZERO_INDEXER_RUNTIME_STORAGE_KEY)
      .catch((): Record<string, unknown> => ({}))
  ])
  const status = buildStatus(
    network,
    enabled,
    preferences,
    registry,
    parseFreshRuntimeStatus(runtime[ZERO_INDEXER_RUNTIME_STORAGE_KEY])
  )
  if (status.mode === 'fixed') {
    const selected = [...status.managedEndpoints, ...status.customEndpoints].find(
      endpoint => endpoint.id === status.selectedEndpointId
    )
    return selected ? { urls: [selected.url] } : null
  }
  const managedById = new Map(status.managedEndpoints.map(endpoint => [endpoint.id, endpoint]))
  const urls = status.orderedEndpointIds
    .map(id => managedById.get(id)?.url)
    .filter((url): url is string => typeof url === 'string')
  return { urls }
}
