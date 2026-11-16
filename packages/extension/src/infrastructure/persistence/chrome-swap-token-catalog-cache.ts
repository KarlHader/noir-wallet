import {
  parseSwapTokenCatalogResponse,
  type SwapToken,
  type SwapIconRefreshState
} from '@/core/services/intents-api'
import { SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY } from './swap-token-catalog-storage'

const CACHE_VERSION = 1
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export interface SwapTokenCatalogSnapshot {
  readonly version: typeof CACHE_VERSION
  readonly fetchedAt: number
  readonly tokens: readonly SwapToken[]
  readonly iconRefreshState?: SwapIconRefreshState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parseSwapTokenCatalogSnapshot(
  value: unknown,
  now = Date.now()
): SwapTokenCatalogSnapshot | null {
  if (value === null || value === undefined) return null
  if (
    !isRecord(value) ||
    value.version !== CACHE_VERSION ||
    !Number.isSafeInteger(value.fetchedAt) ||
    (value.fetchedAt as number) < 0 ||
    (value.fetchedAt as number) > now + MAX_CLOCK_SKEW_MS ||
    !Array.isArray(value.tokens)
  ) {
    throw new Error('Invalid cached Swap token catalog')
  }
  const tokens = parseSwapTokenCatalogResponse(value.tokens, now)
  const iconRefreshState: Record<string, { nextAttemptAt: number; failures: number }> = {}
  if (isRecord(value.iconRefreshState)) {
    for (const [key, state] of Object.entries(value.iconRefreshState).slice(0, 10_000)) {
      if (
        !isRecord(state) ||
        !Number.isSafeInteger(state.nextAttemptAt) ||
        !Number.isSafeInteger(state.failures) ||
        (state.failures as number) < 0 ||
        (state.failures as number) > 5 ||
        (state.nextAttemptAt as number) < 0 ||
        (state.nextAttemptAt as number) > now + MAX_CACHE_AGE_MS + MAX_CLOCK_SKEW_MS
      )
        continue
      iconRefreshState[key] = {
        nextAttemptAt: state.nextAttemptAt as number,
        failures: state.failures as number
      }
    }
  }
  return Object.freeze({
    version: CACHE_VERSION,
    fetchedAt: value.fetchedAt as number,
    tokens: Object.freeze(tokens),
    iconRefreshState: Object.freeze(iconRefreshState)
  })
}

export class ChromeSwapTokenCatalogCacheRepository {
  async readFresh(now = Date.now()): Promise<SwapTokenCatalogSnapshot | null> {
    try {
      const stored = await chrome.storage.local.get(SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY)
      const snapshot = parseSwapTokenCatalogSnapshot(
        stored[SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY],
        now
      )
      if (!snapshot || now - snapshot.fetchedAt > MAX_CACHE_AGE_MS) return null
      return snapshot
    } catch (error) {
      console.warn('[Swap token cache] Ignoring invalid persisted catalog', error)
      await chrome.storage.local.remove(SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY).catch(() => {})
      return null
    }
  }

  async put(
    tokens: readonly SwapToken[],
    now = Date.now(),
    iconRefreshState?: SwapIconRefreshState
  ): Promise<void> {
    const snapshot = parseSwapTokenCatalogSnapshot({
      version: CACHE_VERSION,
      fetchedAt: now,
      tokens,
      iconRefreshState
    })
    if (!snapshot) return
    await chrome.storage.local.set({ [SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY]: snapshot })
  }
}
