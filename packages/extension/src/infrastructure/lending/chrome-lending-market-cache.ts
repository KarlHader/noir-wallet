import {
  getLendingDestinationAssetId,
  type LendingMarketView
} from '@/core/services/lending-market-catalog'

export const LENDING_MARKET_CACHE_STORAGE_KEY = 'lending_market_cache_v1'

const CACHE_VERSION = 3
const MAX_ENTRIES = 100
const MAX_MARKETS_PER_ENTRY = 256
const MAX_AGE_MS = 30 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,77})(?:\.[0-9]{1,512})?$/
const SIGNED_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]{0,77})(?:\.[0-9]{1,512})?$/

interface LendingMarketCacheEntry {
  readonly cachedAt: number
  readonly markets: readonly LendingMarketView[]
}

interface LendingMarketCacheState {
  readonly version: typeof CACHE_VERSION
  readonly entries: Readonly<Record<string, LendingMarketCacheEntry>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readDecimal(value: unknown, label: string, signed = false): string {
  if (
    typeof value !== 'string' ||
    !(signed ? SIGNED_DECIMAL_PATTERN : UNSIGNED_DECIMAL_PATTERN).test(value)
  ) {
    throw new Error(`Invalid cached Lending ${label}`)
  }
  return value
}

function readString(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`Invalid cached Lending ${label}`)
  }
  return value
}

function readMarket(value: unknown): LendingMarketView {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('Invalid cached Lending market')
  }
  const id = readString(value.id, 'market ID', 512)
  const tokenId = readString(value.tokenId, 'market token ID', 512)
  if (id !== tokenId) throw new Error('Invalid cached Lending market identity')
  const destinationAssetId = readString(value.destinationAssetId, 'destination asset ID', 1_024)
  if (destinationAssetId !== getLendingDestinationAssetId(tokenId)) {
    throw new Error('Invalid cached Lending destination asset ID')
  }
  const symbol = readString(value.symbol, 'market symbol', 64)
  const displayName = readString(value.displayName, 'market display name', 256)
  const decimals = value.decimals
  if (!Number.isSafeInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255) {
    throw new Error('Invalid cached Lending market decimals')
  }
  if (
    typeof value.priceUsd !== 'number' ||
    !Number.isFinite(value.priceUsd) ||
    value.priceUsd < 0
  ) {
    throw new Error('Invalid cached Lending market price')
  }
  const icon =
    value.icon === undefined
      ? undefined
      : typeof value.icon === 'string' && value.icon.length <= 2_048
        ? value.icon
        : (() => {
            throw new Error('Invalid cached Lending market icon')
          })()
  return Object.freeze({
    id,
    tokenId,
    destinationAssetId,
    symbol,
    displayName,
    ...(icon === undefined ? {} : { icon }),
    decimals: decimals as number,
    priceUsd: value.priceUsd,
    supplyApy: readDecimal(value.supplyApy, 'market APY', true),
    totalSupplied: readDecimal(value.totalSupplied, 'total supplied'),
    totalSuppliedUsd: readDecimal(value.totalSuppliedUsd, 'total supplied USD'),
    supplied: readDecimal(value.supplied, 'Account supplied'),
    suppliedUsd: readDecimal(value.suppliedUsd, 'Account supplied USD')
  })
}

function readTimestamp(value: unknown, now: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > now + MAX_CLOCK_SKEW_MS
  ) {
    throw new Error('Invalid cached Lending timestamp')
  }
  return value as number
}

export function parseLendingMarketCacheState(
  value: unknown,
  now = Date.now()
): LendingMarketCacheState {
  if (value === undefined || value === null) {
    return Object.freeze({ version: CACHE_VERSION, entries: Object.freeze({}) })
  }
  if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.entries)) {
    throw new Error('Invalid Lending market cache')
  }
  const sourceEntries = Object.entries(value.entries)
  if (sourceEntries.length > MAX_ENTRIES) throw new Error('Lending market cache is too large')
  const entries: Record<string, LendingMarketCacheEntry> = {}
  for (const [scope, entry] of sourceEntries) {
    if (
      scope.length === 0 ||
      scope.length > 512 ||
      !isRecord(entry) ||
      !Array.isArray(entry.markets)
    ) {
      throw new Error('Invalid Lending market cache entry')
    }
    const markets = entry.markets.map(readMarket)
    if (
      markets.length > MAX_MARKETS_PER_ENTRY ||
      new Set(markets.map(market => market.id)).size !== markets.length
    ) {
      throw new Error('Invalid cached Lending markets')
    }
    entries[scope] = Object.freeze({
      cachedAt: readTimestamp(entry.cachedAt, now),
      markets: Object.freeze(markets)
    })
  }
  return Object.freeze({ version: CACHE_VERSION, entries: Object.freeze(entries) })
}

async function readState(): Promise<LendingMarketCacheState> {
  const stored = await chrome.storage.local.get(LENDING_MARKET_CACHE_STORAGE_KEY)
  return parseLendingMarketCacheState(stored[LENDING_MARKET_CACHE_STORAGE_KEY])
}

async function writeState(state: LendingMarketCacheState): Promise<void> {
  await chrome.storage.local.set({ [LENDING_MARKET_CACHE_STORAGE_KEY]: state })
}

export async function readLendingMarketCache(
  accountScope: string
): Promise<readonly LendingMarketView[]> {
  try {
    const entry = (await readState()).entries[accountScope]
    if (!entry || Date.now() - entry.cachedAt > MAX_AGE_MS) return Object.freeze([])
    return entry.markets
  } catch (error) {
    console.warn('[Lending cache] Ignoring invalid persisted market data', error)
    await chrome.storage.local.remove(LENDING_MARKET_CACHE_STORAGE_KEY).catch(() => {})
    return Object.freeze([])
  }
}

export async function writeLendingMarketCache(
  accountScope: string,
  markets: readonly LendingMarketView[]
): Promise<void> {
  if (!accountScope || markets.length === 0) return
  let state: LendingMarketCacheState
  try {
    state = await readState()
  } catch {
    state = parseLendingMarketCacheState(null)
  }
  const entries = { ...state.entries }
  entries[accountScope] = Object.freeze({
    cachedAt: Date.now(),
    markets: Object.freeze([...markets])
  })
  const sorted = Object.entries(entries).sort((left, right) => right[1].cachedAt - left[1].cachedAt)
  const boundedEntries = Object.fromEntries(sorted.slice(0, MAX_ENTRIES))
  await writeState(
    parseLendingMarketCacheState({ version: CACHE_VERSION, entries: boundedEntries })
  )
}

export async function deleteLendingMarketCache(
  walletId?: string,
  accountId?: string
): Promise<void> {
  if (!walletId) {
    await chrome.storage.local.remove(LENDING_MARKET_CACHE_STORAGE_KEY)
    return
  }
  let state: LendingMarketCacheState
  try {
    state = await readState()
  } catch {
    await chrome.storage.local.remove(LENDING_MARKET_CACHE_STORAGE_KEY)
    return
  }
  const prefix = `${walletId}:`
  const target = accountId ? `${walletId}:${accountId}` : null
  const entries = Object.fromEntries(
    Object.entries(state.entries).filter(([scope]) =>
      target === null
        ? !scope.startsWith(prefix)
        : scope !== target && !scope.startsWith(`${target}:`)
    )
  )
  await writeState(parseLendingMarketCacheState({ version: CACHE_VERSION, entries }))
}
