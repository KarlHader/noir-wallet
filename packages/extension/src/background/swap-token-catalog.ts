import {
  getCachedTokens,
  getSwapIconRefreshState,
  hydrateSwapTokenCatalog,
  INTENTS_SWAP_TOKEN_CATALOG_TTL_MS,
  refreshSwapTokenCatalog,
  refreshSwapTokenIcons,
  type SwapToken
} from '@/core/services/intents-api'
import { ChromeSwapTokenCatalogCacheRepository } from '@/infrastructure/persistence/chrome-swap-token-catalog-cache'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import { assertMainnetProtocolFeature } from '@/lib/runtime-network'

export const SWAP_CATALOG_REFRESH_ALARM = 'swap-token-catalog-refresh'
const cache = new ChromeSwapTokenCatalogCacheRepository()
const requests = new DedupPromise<readonly SwapToken[]>()
const icons = new DedupPromise<void>()
const writes = new SerialTaskQueue()
let hydration: Promise<void> | undefined
let fetchedAt = 0
let retryAt = 0

function hydrate(): Promise<void> {
  return (hydration ??= cache.readFresh().then(snapshot => {
    if (!snapshot) return
    fetchedAt = snapshot.fetchedAt
    hydrateSwapTokenCatalog(snapshot.tokens, snapshot.fetchedAt, snapshot.iconRefreshState)
  }))
}

function persist(): Promise<void> {
  return writes.run(() => cache.put(getCachedTokens(), fetchedAt, getSwapIconRefreshState()))
}

function updateIcons(): void {
  const state = getSwapIconRefreshState()
  const now = Date.now()
  if (
    !getCachedTokens().some(
      token =>
        (state[`rhea:${token.blockchain}`]?.nextAttemptAt ?? 0) <= now ||
        (token.coingeckoId &&
          !token.coingeckoId.startsWith('custom:') &&
          (state[`coingecko:${token.coingeckoId}`]?.nextAttemptAt ?? 0) <= now)
    )
  )
    return
  void icons
    .run(async () => {
      await refreshSwapTokenIcons()
      await persist()
    })
    .catch(() => {})
}

/** One Background owner for all popup, side panel and portfolio catalog requests. */
export async function refreshBackgroundSwapCatalog(force = false): Promise<readonly SwapToken[]> {
  assertMainnetProtocolFeature('Swap')
  await hydrate()
  // The five-minute alarm also retries failed icon enrichment independently of catalog freshness.
  await chrome.alarms.create(SWAP_CATALOG_REFRESH_ALARM, { periodInMinutes: 5 })
  if (
    getCachedTokens().length > 0 &&
    !force &&
    Date.now() - fetchedAt < INTENTS_SWAP_TOKEN_CATALOG_TTL_MS
  ) {
    updateIcons()
    return getCachedTokens()
  }
  if (Date.now() < retryAt) {
    if (getCachedTokens().length > 0) return getCachedTokens()
    throw new Error('Token list is temporarily unavailable. Please try again shortly.')
  }
  return requests.run(async () => {
    try {
      const tokens = await refreshSwapTokenCatalog()
      fetchedAt = Date.now()
      retryAt = 0
      await persist().catch(() => {})
      updateIcons()
      return tokens
    } catch (error) {
      retryAt = Date.now() + 60_000
      if (getCachedTokens().length > 0) return getCachedTokens()
      throw error
    }
  })
}

/** Cached data renders immediately while stale metadata refreshes independently. */
export async function readBackgroundSwapCatalog(): Promise<readonly SwapToken[]> {
  assertMainnetProtocolFeature('Swap')
  await hydrate()
  if (getCachedTokens().length > 0) {
    void refreshBackgroundSwapCatalog().catch(() => {})
    return getCachedTokens()
  }
  return refreshBackgroundSwapCatalog()
}
