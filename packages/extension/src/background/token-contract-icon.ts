import {
  CoinGeckoPlatformResolver,
  CoinGeckoCatalogUnavailable,
  COIN_GECKO_ASSET_PLATFORMS_URL
} from '@/core/prices/coingecko-platform-catalog'
import { FetchHttpError, fetchWithTimeout } from '@/lib/fetch-utils'

const MAX_REQUESTS_PER_MINUTE = 20
const MAX_PENDING_REQUESTS = 20
const MAX_CACHE_ENTRIES = 200
const REQUEST_SPACING_MS = 1_500
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000
const FAILURE_TTL_MS = 5 * 60 * 1_000
let retryAfterAt = 0

function retryDelay(value: string | null): number {
  const seconds = value === null ? NaN : Number(value)
  const date = value === null ? NaN : Date.parse(value)
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : date - Date.now()
  return Math.min(60 * 60 * 1_000, Math.max(60_000, Number.isFinite(delay) ? delay : 60_000))
}

const cache = new Map<string, Readonly<{ icon: string | null; expiresAt: number }>>()
const pending = new Map<
  string,
  Readonly<{
    promise: Promise<string | null>
    isActive: Set<() => boolean>
  }>
>()
const platformResolver = new CoinGeckoPlatformResolver(async () => {
  try {
    const response = await fetchWithTimeout(COIN_GECKO_ASSET_PLATFORMS_URL, {
      timeoutMs: 8_000,
      maxBytes: 1024 * 1024
    })
    return response.json()
  } catch (error) {
    const delay = retryDelay(error instanceof FetchHttpError ? (error.retryAfter ?? null) : null)
    if (error instanceof FetchHttpError && (error.status === 429 || error.status === 503)) {
      retryAfterAt = Date.now() + delay
    }
    throw new CoinGeckoCatalogUnavailable(delay)
  }
})
let requestWindowStart = 0
let requestsInWindow = 0
let nextRequestAt = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rememberIcon(key: string, icon: string | null): void {
  const now = Date.now()
  for (const [identity, value] of cache) {
    if (value.expiresAt <= now) cache.delete(identity)
  }
  cache.delete(key)
  cache.set(key, {
    icon,
    expiresAt: now + (icon ? SUCCESS_TTL_MS : FAILURE_TTL_MS)
  })
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
}

function parseContractIcon(
  value: unknown,
  platform: string,
  contractAddress: string
): string | null {
  if (
    !isRecord(value) ||
    !isRecord(value.platforms) ||
    typeof value.platforms[platform] !== 'string' ||
    value.platforms[platform].toLowerCase() !== contractAddress ||
    !isRecord(value.image) ||
    typeof value.image.small !== 'string'
  ) {
    return null
  }
  try {
    const url = new URL(value.image.small)
    return url.protocol === 'https:' && url.hostname === 'coin-images.coingecko.com'
      ? url.href
      : null
  } catch {
    return null
  }
}

export function lookupTokenContractIcon(
  identity: string,
  isActive: () => boolean
): Promise<string | null> {
  const match = /^(eip155:[1-9][0-9]*)\/erc20:(0x[0-9a-f]{40})$/.exec(identity)
  if (!match) return Promise.resolve(null)
  const [, chainId, address] = match
  const key = identity
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.icon)
  if (Date.now() < retryAfterAt) return Promise.resolve(null)
  const existing = pending.get(key)
  if (existing) {
    existing.isActive.add(isActive)
    return existing.promise
  }
  const now = Date.now()
  if (now - requestWindowStart >= 60_000) {
    requestWindowStart = now
    requestsInWindow = 0
  }
  if (requestsInWindow >= MAX_REQUESTS_PER_MINUTE || pending.size >= MAX_PENDING_REQUESTS) {
    return Promise.resolve(null)
  }
  requestsInWindow += 1
  const scheduledAt = Math.max(now, nextRequestAt)
  nextRequestAt = scheduledAt + REQUEST_SPACING_MS
  const activeCallbacks = new Set([isActive])
  const request = (async () => {
    try {
      const delay = scheduledAt - Date.now()
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      if (Date.now() < retryAfterAt) return null
      if (![...activeCallbacks].some(active => active())) return null
      const platform = await platformResolver.resolve(chainId)
      if (!platform || ![...activeCallbacks].some(active => active())) return null
      const response = await fetchWithTimeout(
        `https://api.coingecko.com/api/v3/coins/${platform}/contract/${address}`,
        { timeoutMs: 8_000, maxBytes: 256 * 1_024 }
      )
      const icon = parseContractIcon(await response.json(), platform, address)
      rememberIcon(key, icon)
      return icon
    } catch (error) {
      if (error instanceof FetchHttpError && (error.status === 429 || error.status === 503)) {
        retryAfterAt = Date.now() + retryDelay(error.retryAfter ?? null)
      }
      rememberIcon(key, null)
      return null
    } finally {
      pending.delete(key)
    }
  })()
  pending.set(key, { promise: request, isActive: activeCallbacks })
  return request
}
