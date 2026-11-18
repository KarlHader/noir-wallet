import {
  getCachedTokens,
  hydrateSwapTokenCatalog,
  parseSwapTokenCatalogResponse,
  type SwapToken
} from '@/core/services/intents-api'
import {
  ChromeSwapTokenCatalogCacheRepository,
  parseSwapTokenCatalogSnapshot
} from '@/infrastructure/persistence/chrome-swap-token-catalog-cache'
import { SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY } from '@/infrastructure/persistence/swap-token-catalog-storage'
import { getUserEvmAssetCatalogStorageKey } from '@/infrastructure/chains/evm/chrome-user-evm-asset-catalog'
import { getDetectedEvmAssetCatalogStorageKey } from '@/infrastructure/chains/evm/chrome-detected-evm-asset-catalog'
import { DedupPromise } from '@/lib/async-utils'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { userEvmAssetsClient } from './user-evm-assets-client'

const cache = new ChromeSwapTokenCatalogCacheRepository()
const requests = new DedupPromise<readonly SwapToken[]>()
const iconListeners = new Set<() => void>()
let catalogIcons = new Map<string, string>()
let managedIcons = new Map<string, string>()
let managedIconsDirty = true
let managedIconsLoading: Promise<void> | null = null
const managedCatalogKeys = [
  getUserEvmAssetCatalogStorageKey(DEFAULT_NETWORK),
  getDetectedEvmAssetCatalogStorageKey(DEFAULT_NETWORK)
]

async function loadManagedIcons(): Promise<void> {
  const managed = await userEvmAssetsClient.listManaged()
  const next = new Map<string, string>()
  for (const asset of [...managed.detectedAssets, ...managed.userAssets]) {
    if (asset.metadata.iconUrl) next.set(asset.assetId, asset.metadata.iconUrl)
  }
  if (
    next.size === managedIcons.size &&
    [...next].every(([id, icon]) => managedIcons.get(id) === icon)
  )
    return
  managedIcons = next
  for (const notify of iconListeners) notify()
}

function refreshManagedIcons(): void {
  if (!managedIconsDirty || managedIconsLoading) return
  managedIconsDirty = false
  managedIconsLoading = loadManagedIcons().then(
    () => {
      managedIconsLoading = null
      if (managedIconsDirty && iconListeners.size > 0) refreshManagedIcons()
    },
    () => {
      managedIconsDirty = true
      managedIconsLoading = null
    }
  )
}

function rememberIcons(tokens: readonly SwapToken[]): void {
  const next = new Map(
    tokens.flatMap(token => {
      const icon = token.icon ?? token.coingeckoIcon
      return icon ? [[token.assetId, icon] as const] : []
    })
  )
  if (
    next.size === catalogIcons.size &&
    [...next].every(([id, icon]) => catalogIcons.get(id) === icon)
  )
    return
  catalogIcons = next
  for (const notify of iconListeners) notify()
}

function onCatalogChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string
): void {
  if (area !== 'local') return
  if (managedCatalogKeys.some(key => key in changes)) {
    managedIconsDirty = true
    if (iconListeners.size > 0) refreshManagedIcons()
  }
  if (!(SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY in changes)) return
  try {
    const snapshot = parseSwapTokenCatalogSnapshot(
      changes[SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY]?.newValue
    )
    rememberIcons(snapshot?.tokens ?? [])
  } catch {
    /* Keep usable icons when optional metadata is invalid. */
  }
}

export const swapTokenCatalogClient = Object.freeze({
  getIcon: (assetId?: string, contractIdentity?: string | null): string | undefined =>
    (contractIdentity ? managedIcons.get(contractIdentity) : undefined) ??
    (assetId ? catalogIcons.get(assetId) : undefined),
  subscribeIcons: (notify: () => void): (() => void) => {
    if (iconListeners.size === 0) {
      chrome.storage.onChanged.addListener(onCatalogChanged)
      managedIconsDirty = true
      void cache
        .readFresh()
        .then(snapshot => {
          if (snapshot) rememberIcons(snapshot.tokens)
        })
        .catch(() => {})
    }
    iconListeners.add(notify)
    refreshManagedIcons()
    return () => {
      iconListeners.delete(notify)
      if (iconListeners.size === 0) {
        chrome.storage.onChanged.removeListener(onCatalogChanged)
      }
    }
  },
  readCached: async (): Promise<readonly SwapToken[]> => {
    const memory = getCachedTokens()
    if (memory.length > 0) {
      rememberIcons(memory)
      return Object.freeze([...memory])
    }
    const snapshot = await cache.readFresh()
    if (snapshot) {
      hydrateSwapTokenCatalog(snapshot.tokens, snapshot.fetchedAt)
      rememberIcons(snapshot.tokens)
    }
    return snapshot?.tokens ?? Object.freeze([])
  },

  refresh: (): Promise<readonly SwapToken[]> =>
    requests.run(async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_SWAP_TOKEN_CATALOG' })
        if (!response || response.error) throw new Error('Token list is temporarily unavailable')
        const tokens = parseSwapTokenCatalogResponse(response.result)
        hydrateSwapTokenCatalog(tokens, Date.now())
        rememberIcons(tokens)
        return tokens
      } catch (error) {
        const cached = await swapTokenCatalogClient.readCached()
        if (cached.length > 0) return cached
        throw error
      }
    })
})
