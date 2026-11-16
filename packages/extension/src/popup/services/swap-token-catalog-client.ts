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
import { DedupPromise } from '@/lib/async-utils'

const cache = new ChromeSwapTokenCatalogCacheRepository()
const requests = new DedupPromise<readonly SwapToken[]>()
const iconListeners = new Set<() => void>()
let catalogIcons = new Map<string, string>()

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
  if (area !== 'local' || !(SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY in changes)) return
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
  getIcon: (assetId?: string): string | undefined =>
    assetId ? catalogIcons.get(assetId) : undefined,
  subscribeIcons: (notify: () => void): (() => void) => {
    if (iconListeners.size === 0) {
      chrome.storage.onChanged.addListener(onCatalogChanged)
      void cache
        .readFresh()
        .then(snapshot => {
          if (snapshot) rememberIcons(snapshot.tokens)
        })
        .catch(() => {})
    }
    iconListeners.add(notify)
    return () => {
      iconListeners.delete(notify)
      if (iconListeners.size === 0) chrome.storage.onChanged.removeListener(onCatalogChanged)
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
