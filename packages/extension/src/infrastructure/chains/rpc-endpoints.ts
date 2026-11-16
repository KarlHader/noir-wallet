import {
  SETTINGS_STORAGE_KEY,
  decodePersistedWalletSettings,
  resolvePersistedNetworkChainEndpointSettings,
  resolvePersistedNetworkMode,
  updatePersistedWalletSettings
} from '@/lib/wallet-settings-storage'
import type { Network } from '@/types'
import {
  fetchRpcRegistry,
  parseRpcRegistryDocument,
  selectPreferredRpcEndpoint,
  setActiveRpcRegistryDocument
} from './rpc-registry-client'
import { setActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import {
  RPC_DEFAULT_ENDPOINTS,
  RPC_ENDPOINT_GROUPS,
  type RpcEndpointChain,
  type RpcEndpointGroup,
  type RpcEndpointId,
  type RpcEndpointOption
} from '@/config/rpc-endpoints'

export type RpcEndpointPreferences = Record<RpcEndpointChain, RpcEndpointId>

export const DEFAULT_RPC_ENDPOINT_PREFERENCES: RpcEndpointPreferences = {
  zcash: RPC_DEFAULT_ENDPOINTS.zcash.mainnet.id
}

let activeRpcEndpointGroups = cloneRpcEndpointGroups(RPC_ENDPOINT_GROUPS)
let rpcEndpointOptionsByChain = buildOptionsByChain(activeRpcEndpointGroups)
const RETIRED_ZCASH_RPC_URLS = new Set([
  'https://zcash-wallet-grpc-self.deltarpc.com',
  'https://zcash-mainnet.chainsafe.dev'
])

function buildOptionsByChain(groups: RpcEndpointGroup[]) {
  return groups.reduce(
    (acc, group) => {
      acc[group.chain] = group.options
      return acc
    },
    {} as Record<RpcEndpointChain, RpcEndpointOption[]>
  )
}

function cloneRpcEndpointGroups(groups: RpcEndpointGroup[]): RpcEndpointGroup[] {
  return groups.map(group => ({ ...group, options: group.options.map(option => ({ ...option })) }))
}

function setRpcEndpointGroups(groups: RpcEndpointGroup[]): void {
  activeRpcEndpointGroups = cloneRpcEndpointGroups(groups)
  rpcEndpointOptionsByChain = buildOptionsByChain(activeRpcEndpointGroups)
}

export function getRpcEndpointGroups(): RpcEndpointGroup[] {
  return cloneRpcEndpointGroups(activeRpcEndpointGroups)
}

let activeRpcEndpointPreferences: RpcEndpointPreferences = {
  ...DEFAULT_RPC_ENDPOINT_PREFERENCES
}
let activeRpcEndpointOverrides: Partial<Record<RpcEndpointChain, RpcEndpointId>> = {}

export function setActiveRpcEndpointPreferences(preferences?: Partial<RpcEndpointPreferences>) {
  activeRpcEndpointPreferences = {
    ...DEFAULT_RPC_ENDPOINT_PREFERENCES,
    ...preferences
  }
}

export function setActiveRpcEndpointOverride(
  chain: RpcEndpointChain,
  endpointId?: RpcEndpointId
): void {
  if (endpointId) {
    activeRpcEndpointOverrides = { ...activeRpcEndpointOverrides, [chain]: endpointId }
    return
  }

  const remaining = { ...activeRpcEndpointOverrides }
  delete remaining[chain]
  activeRpcEndpointOverrides = remaining
}

export function getRpcEndpointOptions(chain: RpcEndpointChain): RpcEndpointOption[] {
  return [...(rpcEndpointOptionsByChain[chain] || [])]
}

export function getNextRpcEndpointOption(
  chain: RpcEndpointChain,
  preferredEndpointId: RpcEndpointId,
  activeEndpointId: RpcEndpointId
): RpcEndpointOption | undefined {
  const options = rpcEndpointOptionsByChain[chain] || []
  const preferred = options.find(option => option.id === preferredEndpointId)
  if (!preferred) return undefined

  const failoverOrder = [preferred, ...options.filter(option => option.id !== preferredEndpointId)]
  const activeIndex = failoverOrder.findIndex(option => option.id === activeEndpointId)
  return activeIndex >= 0 ? failoverOrder[activeIndex + 1] : undefined
}

export function getPreferredRpcEndpointOption(chain: RpcEndpointChain): RpcEndpointOption {
  const selectedId = activeRpcEndpointPreferences[chain] || DEFAULT_RPC_ENDPOINT_PREFERENCES[chain]
  const options = rpcEndpointOptionsByChain[chain] || []
  const selectedOption = options.find(option => option.id === selectedId)
  const defaultOption = options.find(
    option => option.id === DEFAULT_RPC_ENDPOINT_PREFERENCES[chain]
  )

  const resolved = selectedOption || defaultOption || options[0]
  if (!resolved) throw new Error(`No RPC endpoints configured for ${chain}`)
  return resolved
}

export function getActiveRpcEndpointOption(chain: RpcEndpointChain): RpcEndpointOption {
  const preferredOption = getPreferredRpcEndpointOption(chain)
  const selectedId = activeRpcEndpointOverrides[chain] || preferredOption.id
  const options = rpcEndpointOptionsByChain[chain] || []
  const selectedOption = options.find(option => option.id === selectedId)

  return selectedOption || preferredOption
}

export function getActiveZcashRpcUrlForNetwork(network: Network, fallbackUrl: string): string {
  return network === 'mainnet' ? getActiveRpcEndpointOption('zcash').url : fallbackUrl
}

const RPC_REGISTRY_CACHE_KEY = 'rpc_registry_cache_v1'
const RPC_REGISTRY_TIMING_KEY = 'rpc_registry_refresh_v1'

interface StoredRpcPreferences {
  raw: unknown
  persistedEndpointId?: string
}

function readPersistedEndpointId(raw: unknown): string | undefined {
  const preferences = decodePersistedWalletSettings(raw)?.rpcEndpointPreferences
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return
  const value = (preferences as { zcash?: unknown }).zcash
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
}

function syncChainSettings(raw: unknown): void {
  const network = resolvePersistedNetworkMode(
    raw,
    typeof __NETWORK_MODE__ === 'string' && __NETWORK_MODE__ === 'testnet' ? 'testnet' : 'mainnet'
  )
  setActiveChainEndpointSettings(resolvePersistedNetworkChainEndpointSettings(raw, network))
}

async function readStoredRpcPreferences(): Promise<StoredRpcPreferences> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  const raw = stored[SETTINGS_STORAGE_KEY as keyof typeof stored]
  syncChainSettings(raw)
  return { raw, persistedEndpointId: readPersistedEndpointId(raw) }
}

async function persistRpcEndpointPreferences(
  stored: StoredRpcPreferences,
  preferences: RpcEndpointPreferences
): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_STORAGE_KEY]: updatePersistedWalletSettings(stored.raw, {
      rpcEndpointPreferences: preferences
    })
  })
}

function applyRegistryGroups(registry: ReturnType<typeof parseRpcRegistryDocument>): void {
  if (registry) setActiveRpcRegistryDocument(registry)
  const zcash = registry?.chains.find(
    chain => chain.chain === 'zcash' && chain.network === 'mainnet'
  )
  if (!zcash) return
  const endpoints = zcash.endpoints.filter(endpoint => !RETIRED_ZCASH_RPC_URLS.has(endpoint.url))
  if (endpoints.length === 0) return

  setRpcEndpointGroups([
    {
      chain: 'zcash',
      label: zcash.label,
      iconChain: zcash.iconChain,
      options: endpoints
    }
  ])
}

async function loadCachedRegistryGroups(): Promise<void> {
  const cached: Record<string, unknown> = await chrome.storage.local
    .get(RPC_REGISTRY_CACHE_KEY)
    .catch(() => ({}))
  applyRegistryGroups(parseRpcRegistryDocument(cached[RPC_REGISTRY_CACHE_KEY]))
}

async function refreshRegistryGroups(): Promise<boolean> {
  const stored = await chrome.storage.local
    .get([RPC_REGISTRY_CACHE_KEY, RPC_REGISTRY_TIMING_KEY])
    .catch(() => ({}) as Record<string, unknown>)
  const cached = parseRpcRegistryDocument(stored[RPC_REGISTRY_CACHE_KEY])
  const timing = stored[RPC_REGISTRY_TIMING_KEY] as
    | { successAt?: unknown; attemptAt?: unknown }
    | undefined
  const recent = (value: unknown, ttl: number) =>
    typeof value === 'number' && Date.now() >= value && Date.now() - value < ttl
  if (cached && recent(timing?.successAt, 5 * 60_000)) {
    applyRegistryGroups(cached)
    return cached.chains.some(chain => chain.chain === 'zcash' && chain.network === 'mainnet')
  }
  if (recent(timing?.attemptAt, 60_000)) {
    applyRegistryGroups(cached)
    return false
  }
  await chrome.storage.local
    .set({ [RPC_REGISTRY_TIMING_KEY]: { attemptAt: Date.now() } })
    .catch(() => {})
  try {
    const registry = await fetchRpcRegistry()
    await chrome.storage.local
      .set({
        [RPC_REGISTRY_CACHE_KEY]: registry,
        [RPC_REGISTRY_TIMING_KEY]: { successAt: Date.now(), attemptAt: Date.now() }
      })
      .catch(() => {})
    applyRegistryGroups(registry)
    return registry.chains.some(chain => chain.chain === 'zcash' && chain.network === 'mainnet')
  } catch {
    await loadCachedRegistryGroups()
    return false
  }
}

/**
 * Reads persisted RPC endpoint preferences directly from chrome.storage,
 * bypassing zustand rehydration timing. Safe to call before stores hydrate.
 */
export async function syncActiveRpcEndpointPreferencesFromStorage(): Promise<RpcEndpointPreferences> {
  try {
    const stored = await readStoredRpcPreferences()
    await loadCachedRegistryGroups()
    setActiveRpcEndpointPreferences({
      zcash: stored.persistedEndpointId ?? DEFAULT_RPC_ENDPOINT_PREFERENCES.zcash
    })
  } catch {
    setActiveRpcEndpointPreferences()
  }
  return { ...activeRpcEndpointPreferences }
}

let loadPromise: Promise<RpcEndpointPreferences> | null = null

/**
 * Ensures persisted preferences have been read once before resolving RPC URLs.
 * Await this before creating wallet cores so cold-started contexts (e.g.
 * background service worker) don't fall back to the default endpoint.
 */
export function ensureRpcEndpointPreferencesLoaded(): Promise<RpcEndpointPreferences> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return Promise.resolve({ ...activeRpcEndpointPreferences })
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      const stored = await readStoredRpcPreferences()
      await loadCachedRegistryGroups()
      const preferences = {
        zcash: stored.persistedEndpointId ?? DEFAULT_RPC_ENDPOINT_PREFERENCES.zcash
      }
      setActiveRpcEndpointPreferences(preferences)
      return { ...preferences }
    })().catch(() => syncActiveRpcEndpointPreferencesFromStorage())
  }
  // A selection made while initialization was pending takes precedence over its snapshot.
  return loadPromise.then(() => ({ ...activeRpcEndpointPreferences }))
}

let registryRefreshPromise: Promise<RpcEndpointPreferences> | null = null

/**
 * Refreshes the remote registry without delaying wallet startup. Persisted and
 * default preferences remain stable while present; a healthy replacement is
 * selected only when the preferred endpoint has left the registry.
 */
export function refreshRpcEndpointRegistry(): Promise<RpcEndpointPreferences> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return Promise.resolve({ ...activeRpcEndpointPreferences })
  }
  if (!registryRefreshPromise) {
    const refresh = (async () => {
      await ensureRpcEndpointPreferencesLoaded()
      const stored = await readStoredRpcPreferences()
      const hasFreshZcashRegistry = await refreshRegistryGroups()
      if (!hasFreshZcashRegistry) {
        const preferences = {
          zcash: stored.persistedEndpointId ?? DEFAULT_RPC_ENDPOINT_PREFERENCES.zcash
        }
        setActiveRpcEndpointPreferences(preferences)
        return preferences
      }

      const selected = await selectPreferredRpcEndpoint(
        getRpcEndpointOptions('zcash'),
        stored.persistedEndpointId ?? DEFAULT_RPC_ENDPOINT_PREFERENCES.zcash
      )
      const preferences = {
        ...DEFAULT_RPC_ENDPOINT_PREFERENCES,
        zcash: selected.id
      }
      setActiveRpcEndpointPreferences(preferences)

      if (stored.persistedEndpointId !== selected.id) {
        await persistRpcEndpointPreferences(stored, preferences).catch(() => {})
      }
      return { ...preferences }
    })().catch(() => syncActiveRpcEndpointPreferencesFromStorage())
    registryRefreshPromise = refresh
    const clear = () => {
      if (registryRefreshPromise === refresh) registryRefreshPromise = null
    }
    void refresh.then(clear, clear)
  }
  return registryRefreshPromise
}

// Kick off the initial read in any chrome context (popup/background/offscreen).
// Guarded because this module is also reachable from the Web Worker bundle
// where chrome APIs are unavailable.
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  syncActiveRpcEndpointPreferencesFromStorage().catch(() => {})

  // Keep every extension context in sync when the preference changes elsewhere
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    const change = changes[SETTINGS_STORAGE_KEY]
    if (!change) return
    const settings = decodePersistedWalletSettings(change.newValue)
    if (!settings) return
    try {
      syncChainSettings(change.newValue)
    } catch {
      return
    }
    setActiveRpcEndpointPreferences({
      zcash: readPersistedEndpointId(change.newValue) ?? DEFAULT_RPC_ENDPOINT_PREFERENCES.zcash
    })
  })
}
