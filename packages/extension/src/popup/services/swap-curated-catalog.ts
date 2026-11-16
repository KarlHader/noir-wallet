import { config_near } from '@rhea-finance/cross-chain-sdk'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import type { UserEvmAssetRecord } from '@/core/chains/user-assets'
import Big from '@/lib/big'
import { fetchWithTimeout } from '@/lib/fetch-utils'

const CATALOG_TTL_MS = 10 * 60 * 1_000
const MAX_CATALOG_ROWS = 4_096
const STORAGE_KEY = 'swap-curated-catalog:v1'

export interface CuratedSwapTokenRow {
  readonly chainId: number
  readonly address: string
  readonly order: number
}

interface CatalogEntry {
  readonly loadedAt: number
  readonly rows: readonly CuratedSwapTokenRow[]
}

const cache = new Map<number, CatalogEntry>()
const inflight = new Map<number, Promise<readonly CuratedSwapTokenRow[]>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRow(value: unknown, chainId: number, index: number): CuratedSwapTokenRow | null {
  if (!isRecord(value) || value.chainId !== chainId) return null
  if (typeof value.address !== 'string' || !value.address.trim() || value.address.length > 512) {
    return null
  }
  const order = [value.order, value.sortOrder, value.sort, value.index, value.seq, value.rank]
    .map(candidate =>
      typeof candidate === 'number'
        ? candidate
        : typeof candidate === 'string' && /^\d+$/.test(candidate.trim())
          ? Number(candidate)
          : NaN
    )
    .find(candidate => Number.isSafeInteger(candidate) && candidate >= 0)
  return Object.freeze({ chainId, address: value.address.trim(), order: order ?? index })
}

function parseRows(value: unknown, chainId: number): readonly CuratedSwapTokenRow[] {
  if (!isRecord(value) || value.code !== 0 || !Array.isArray(value.data)) return []
  if (value.data.length > MAX_CATALOG_ROWS) return []
  return Object.freeze(
    value.data
      .map((row, index) => parseRow(row, chainId, index))
      .filter((row): row is CuratedSwapTokenRow => row !== null)
      .sort((left, right) => left.order - right.order)
  )
}

function readPersisted(chainId: number): CatalogEntry | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const entries: unknown = JSON.parse(raw)
    if (!isRecord(entries)) return undefined
    const entry = entries[String(chainId)]
    if (!isRecord(entry) || !Number.isSafeInteger(entry.loadedAt) || !Array.isArray(entry.rows)) {
      return undefined
    }
    const rows = entry.rows
      .map((row, index) => parseRow(row, chainId, index))
      .filter((row): row is CuratedSwapTokenRow => row !== null)
    if (rows.length === 0 || rows.length > MAX_CATALOG_ROWS) return undefined
    return { loadedAt: entry.loadedAt as number, rows: Object.freeze(rows) }
  } catch {
    return undefined
  }
}

function getEntry(chainId: number): CatalogEntry | undefined {
  const entry = cache.get(chainId) ?? readPersisted(chainId)
  if (entry) cache.set(chainId, entry)
  return entry
}

function persist(chainId: number, entry: CatalogEntry): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const prior: unknown = raw ? JSON.parse(raw) : {}
    const entries = isRecord(prior) ? prior : {}
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...entries, [chainId]: entry }))
  } catch {
    // A session memory cache is sufficient when storage is unavailable.
  }
}

export function getCuratedSwapChainIds(tokens: readonly RheaSwapToken[]): readonly number[] {
  return [...new Set(tokens.map(token => token.tokenListChainId))]
}

export function readCachedCuratedSwapTokens(
  chainIds: readonly number[]
): readonly CuratedSwapTokenRow[] {
  return chainIds.flatMap(chainId => getEntry(chainId)?.rows ?? [])
}

async function loadChain(chainId: number): Promise<readonly CuratedSwapTokenRow[]> {
  const cached = getEntry(chainId)
  if (cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) return cached.rows
  const pending = inflight.get(chainId)
  if (pending) return pending
  const request = (async () => {
    try {
      const url = new URL(`${config_near.indexUrl}/crosschain/tokens`)
      url.searchParams.set('chain', String(chainId))
      const response = await fetchWithTimeout(url, {
        headers: { Accept: 'application/json' },
        maxBytes: 2 * 1024 * 1024
      })
      if (!response.ok) return cached?.rows ?? []
      const rows = parseRows(await response.json(), chainId)
      if (rows.length === 0) return cached?.rows ?? []
      const entry = { rows, loadedAt: Date.now() }
      cache.set(chainId, entry)
      persist(chainId, entry)
      return rows
    } catch {
      return cached?.rows ?? []
    }
  })().finally(() => inflight.delete(chainId))
  inflight.set(chainId, request)
  return request
}

export async function loadCuratedSwapTokens(
  chainIds: readonly number[],
  onRows?: (rows: readonly CuratedSwapTokenRow[]) => void
): Promise<readonly CuratedSwapTokenRow[]> {
  const unique = [
    ...new Set(chainIds.filter(chainId => Number.isSafeInteger(chainId) && chainId > 0))
  ]
  const completed = new Map<number, readonly CuratedSwapTokenRow[]>()
  await Promise.all(
    unique.map(async chainId => {
      const rows = await loadChain(chainId)
      completed.set(chainId, rows)
      if (rows.length > 0) onRows?.(unique.flatMap(id => completed.get(id) ?? []))
    })
  )
  return unique.flatMap(id => completed.get(id) ?? [])
}

function normalizedAddress(address: string, token: RheaSwapToken): string {
  const trimmed = address.trim().replace(/^nep141:/i, '')
  return /^[0-9]+$/.test(token.rheaChainId) || token.rheaChainId === 'near'
    ? trimmed.toLowerCase()
    : trimmed
}

function isNativeRow(address: string, token: RheaSwapToken): boolean {
  const normalized = normalizedAddress(address, token)
  if (normalized === normalizedAddress(token.rheaAddress, token)) return true
  if (normalized === 'native' || normalized.endsWith(':native')) return true
  if (!/^[0-9]+$/.test(token.rheaChainId)) return false
  return (
    normalized === '0x0000000000000000000000000000000000000000' ||
    normalized === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
    (token.rheaChainId === '137' && normalized === '0x0000000000000000000000000000000000001010')
  )
}

function curatedRanks(
  tokens: readonly RheaSwapToken[],
  rows: readonly CuratedSwapTokenRow[]
): {
  readonly addresses: ReadonlyMap<string, number>
  readonly native: ReadonlyMap<number, number>
} {
  const chainExamples = new Map(tokens.map(token => [token.tokenListChainId, token]))
  const nativeTokens = new Map(
    tokens.filter(token => token.isNative).map(token => [token.tokenListChainId, token])
  )
  const addresses = new Map<string, number>()
  const native = new Map<number, number>()
  for (const [index, row] of rows.entries()) {
    const example = chainExamples.get(row.chainId)
    if (!example) continue
    const nativeToken = nativeTokens.get(row.chainId)
    if (nativeToken && isNativeRow(row.address, nativeToken)) {
      if (!native.has(row.chainId)) native.set(row.chainId, index)
      continue
    }
    const address = normalizedAddress(row.address, example)
    const key = `${row.chainId}:${address}`
    if (!addresses.has(key)) addresses.set(key, index)
  }
  return { addresses, native }
}

function hasBalance(balance: string | undefined): boolean {
  if (balance === undefined) return false
  try {
    return new Big(balance).gt(0)
  } catch {
    return false
  }
}

export function selectDefaultSwapTokens(
  tokens: readonly RheaSwapToken[],
  curatedRows: readonly CuratedSwapTokenRow[],
  options: {
    readonly balances?: ReadonlyMap<string, string>
    readonly customAssets?: readonly Pick<
      UserEvmAssetRecord,
      'chainId' | 'contractAddress' | 'source'
    >[]
  } = {}
): readonly RheaSwapToken[] {
  const ranks = curatedRanks(tokens, curatedRows)
  const custom = new Set(
    (options.customAssets ?? []).map(
      asset => `${asset.chainId.toLowerCase()}:${asset.contractAddress.toLowerCase()}`
    )
  )
  const ranked = tokens.flatMap((token, index) => {
    const curated = token.isNative
      ? (ranks.native.get(token.tokenListChainId) ?? Infinity)
      : [token.rheaAddress, token.contractAddress, token.assetId].reduce((best, candidate) => {
          if (typeof candidate !== 'string') return best
          const rank = ranks.addresses.get(
            `${token.tokenListChainId}:${normalizedAddress(candidate, token)}`
          )
          return rank === undefined ? best : Math.min(best, rank)
        }, Infinity)
    const held = hasBalance(options.balances?.get(token.assetId))
    const customKey = `eip155:${token.rheaChainId}:${token.contractAddress?.toLowerCase() ?? ''}`
    const userAdded = !token.isNative && custom.has(customKey)
    if (!Number.isFinite(curated) && !token.isNative && !held && !userAdded) return []
    return [{ token, index, rank: Number.isFinite(curated) ? 0 : token.isNative ? 1 : 2, curated }]
  })
  ranked.sort(
    (left, right) =>
      left.rank - right.rank ||
      (left.rank === 0 ? left.curated - right.curated : left.index - right.index)
  )
  return ranked.map(item => item.token)
}
