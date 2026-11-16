export type ZeroIndexerNetwork = 'mainnet' | 'testnet'

export interface ZeroIndexerOptions {
  urls: string[]
  sendTimeoutMs?: number
}

export interface ZeroIndexerEndpoint {
  id: string
  label: string
  url: string
}

export interface ZeroIndexerNodeStatus {
  network: ZeroIndexerNetwork
  enabled: boolean
  mode: 'auto' | 'fixed'
  selectedEndpointId: string | null
  managedEndpoints: ZeroIndexerEndpoint[]
  customEndpoints: ZeroIndexerEndpoint[]
  orderedEndpointIds: string[]
  probes: Record<string, { status: 'ok' | 'unreachable'; latencyMs?: number }>
}

export interface ZeroIndexerRegistryDocument {
  version: 1
  updatedAt: string
  networks: Record<ZeroIndexerNetwork, ZeroIndexerEndpoint[]>
}

export interface ZeroIndexerNodePreferences {
  version: 1
  networks: Record<
    ZeroIndexerNetwork,
    {
      mode: 'auto' | 'fixed'
      selectedEndpointId: string | null
      customEndpoints: ZeroIndexerEndpoint[]
    }
  >
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/

export function normalizeZeroIndexerUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length > 2_048) {
    throw new Error('Invalid ZeroIndexer URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid ZeroIndexer URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error('ZeroIndexer URL must use HTTPS without credentials, query, or fragment')
  }
  return url.toString().replace(/\/+$/, '')
}

export function parseZeroIndexerRuntimeOptions(value: unknown): ZeroIndexerOptions | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid privacy broadcast configuration')
  }
  const options = value as Record<string, unknown>
  if (
    Object.keys(options).some(key => key !== 'urls' && key !== 'sendTimeoutMs') ||
    !Array.isArray(options.urls) ||
    options.urls.length === 0
  ) {
    throw new Error('Invalid privacy broadcast configuration')
  }
  const urls = options.urls.map(url => normalizeZeroIndexerUrl(url))
  const timeout = options.sendTimeoutMs
  const uniqueUrls = [...new Set(urls)]
  if (timeout === undefined) return { urls: uniqueUrls }
  if (
    typeof timeout !== 'number' ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > 0xffffffff
  ) {
    throw new Error('Invalid privacy broadcast timeout')
  }
  return { urls: uniqueUrls, sendTimeoutMs: timeout }
}

export function createCustomZeroIndexerEndpoint(
  label: unknown,
  url: unknown,
  id = `custom:${crypto.randomUUID()}`
): ZeroIndexerEndpoint {
  const normalizedUrl = normalizeZeroIndexerUrl(url)
  if (typeof id !== 'string' || !/^custom:[a-zA-Z0-9-]{1,120}$/.test(id)) {
    throw new Error('Invalid custom ZeroIndexer ID')
  }
  const normalizedLabel = label == null || label === '' ? new URL(normalizedUrl).host : label
  if (typeof normalizedLabel !== 'string') throw new Error('Invalid ZeroIndexer name')
  const name = normalizedLabel.normalize('NFC').trim()
  if (!name || [...name].length > 64 || CONTROL_CHARACTERS.test(name)) {
    throw new Error('ZeroIndexer name must be between 1 and 64 characters')
  }
  return { id, label: name, url: normalizedUrl }
}

function parseEndpoints(value: unknown, custom: boolean): ZeroIndexerEndpoint[] | null {
  if (!Array.isArray(value) || value.length > 100) return null
  const ids = new Set<string>()
  const urls = new Set<string>()
  const endpoints: ZeroIndexerEndpoint[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const endpoint = item as Partial<ZeroIndexerEndpoint>
    if (typeof endpoint.id !== 'string' || typeof endpoint.label !== 'string') return null
    try {
      const parsed = custom
        ? createCustomZeroIndexerEndpoint(endpoint.label, endpoint.url, endpoint.id)
        : {
            id: endpoint.id,
            label: endpoint.label.normalize('NFC').trim(),
            url: normalizeZeroIndexerUrl(endpoint.url)
          }
      if (
        !parsed.label ||
        [...parsed.label].length > 64 ||
        CONTROL_CHARACTERS.test(parsed.label) ||
        (!custom &&
          (!/^[a-zA-Z0-9-]{1,128}$/.test(parsed.id) || parsed.id.startsWith('custom:'))) ||
        ids.has(parsed.id) ||
        urls.has(parsed.url)
      )
        return null
      ids.add(parsed.id)
      urls.add(parsed.url)
      endpoints.push(parsed)
    } catch {
      return null
    }
  }
  return endpoints
}

export function parseZeroIndexerRegistryDocument(
  value: unknown
): ZeroIndexerRegistryDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const document = value as Partial<ZeroIndexerRegistryDocument>
  if (document.version !== 1 || typeof document.updatedAt !== 'string' || !document.networks) {
    return null
  }
  const mainnet = parseEndpoints(document.networks.mainnet, false)
  const testnet = parseEndpoints(document.networks.testnet, false)
  if (!mainnet?.length || !testnet?.length) return null
  return { version: 1, updatedAt: document.updatedAt, networks: { mainnet, testnet } }
}

export function parseZeroIndexerNodePreferences(value: unknown): ZeroIndexerNodePreferences {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<ZeroIndexerNodePreferences>)
      : null
  function networkPreferences(network: ZeroIndexerNetwork) {
    const candidate = raw?.version === 1 ? raw.networks?.[network] : null
    const customEndpoints = parseEndpoints(candidate?.customEndpoints, true) ?? []
    const selectedEndpointId =
      typeof candidate?.selectedEndpointId === 'string' ? candidate.selectedEndpointId : null
    return {
      mode:
        candidate?.mode === 'fixed' && selectedEndpointId ? ('fixed' as const) : ('auto' as const),
      selectedEndpointId: candidate?.mode === 'fixed' ? selectedEndpointId : null,
      customEndpoints
    }
  }
  return {
    version: 1,
    networks: { mainnet: networkPreferences('mainnet'), testnet: networkPreferences('testnet') }
  }
}

export function parseZeroIndexerNodeStatus(value: unknown): ZeroIndexerNodeStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid ZeroIndexer node status')
  }
  const candidate = value as Partial<ZeroIndexerNodeStatus>
  if (
    (candidate.network !== 'testnet' && candidate.network !== 'mainnet') ||
    typeof candidate.enabled !== 'boolean' ||
    (candidate.mode !== 'auto' && candidate.mode !== 'fixed') ||
    (candidate.selectedEndpointId !== null && typeof candidate.selectedEndpointId !== 'string') ||
    !Array.isArray(candidate.orderedEndpointIds) ||
    !candidate.probes ||
    typeof candidate.probes !== 'object' ||
    Array.isArray(candidate.probes)
  ) {
    throw new Error('Invalid ZeroIndexer node status')
  }
  const network = candidate.network
  const managedEndpoints = parseEndpoints(candidate.managedEndpoints, false)
  const customEndpoints = parseEndpoints(candidate.customEndpoints, true)
  if (!managedEndpoints?.length || !customEndpoints) {
    throw new Error('Invalid ZeroIndexer node status')
  }
  const available = new Set([...managedEndpoints, ...customEndpoints].map(endpoint => endpoint.id))
  const selectedEndpointId = candidate.selectedEndpointId
  if (
    (candidate.mode === 'fixed' && (!selectedEndpointId || !available.has(selectedEndpointId))) ||
    (candidate.mode === 'auto' && selectedEndpointId !== null)
  ) {
    throw new Error('Invalid ZeroIndexer node status')
  }
  const probes: ZeroIndexerNodeStatus['probes'] = {}
  for (const [id, probe] of Object.entries(candidate.probes)) {
    if (!available.has(id) || !probe || typeof probe !== 'object' || Array.isArray(probe)) {
      throw new Error('Invalid ZeroIndexer node status')
    }
    const result = probe as { status?: unknown; latencyMs?: unknown }
    if (result.status === 'unreachable') probes[id] = { status: 'unreachable' }
    else if (
      result.status === 'ok' &&
      typeof result.latencyMs === 'number' &&
      Number.isFinite(result.latencyMs) &&
      result.latencyMs >= 0
    )
      probes[id] = { status: 'ok', latencyMs: result.latencyMs }
    else throw new Error('Invalid ZeroIndexer node status')
  }
  const managedIds = new Set(managedEndpoints.map(endpoint => endpoint.id))
  const orderedEndpointIds = candidate.orderedEndpointIds
  if (
    orderedEndpointIds.length !== managedEndpoints.length ||
    new Set(orderedEndpointIds).size !== managedEndpoints.length ||
    orderedEndpointIds.some(id => typeof id !== 'string' || !managedIds.has(id))
  ) {
    throw new Error('Invalid ZeroIndexer node status')
  }
  return {
    network,
    enabled: candidate.enabled,
    mode: candidate.mode,
    selectedEndpointId,
    managedEndpoints,
    customEndpoints,
    orderedEndpointIds: [...orderedEndpointIds],
    probes
  }
}
