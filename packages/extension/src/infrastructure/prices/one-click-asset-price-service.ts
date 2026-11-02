import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import Big from 'big.js'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import { parseAssetId } from '@/core/chains/registry'
import {
  ASSET_PRICE_EXPIRES_MS,
  ASSET_PRICE_FRESH_MS,
  ASSET_PRICE_QUOTE_SOURCES,
  ASSET_PRICE_SOURCE,
  MAXIMUM_ASSET_PRICE_ITEMS,
  createMarketAssetId,
  type AssetPriceQuote,
  type AssetPriceReadModel
} from '@/core/prices'
import type { AssetPriceSourceMapping } from '@/core/prices/asset-market-mappings'
import type { OneClickContractAssetPriceSourceMapping } from '@/core/prices/user-asset-price-mappings'
import { DedupPromise } from '@/lib/async-utils'

export const ONE_CLICK_ASSET_PRICE_URL = 'https://1click.chaindefuser.com/v0/tokens'
const PRICE_CACHE_VERSION = 1
const NETWORK_REFRESH_INTERVAL_MS = 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024
const MAXIMUM_TOKEN_COUNT = 4_096

export interface AssetPriceCacheQuote {
  readonly assetId: string
  readonly priceUsd: string
  readonly sourceUpdatedAt: number
}

export interface AssetPriceCacheSnapshot {
  readonly version: typeof PRICE_CACHE_VERSION
  readonly fetchedAt: number
  readonly quotes: readonly AssetPriceCacheQuote[]
}

export interface AssetPriceCacheRepository {
  readonly get: () => Promise<AssetPriceCacheSnapshot | null>
  readonly put: (snapshot: AssetPriceCacheSnapshot) => Promise<void>
}

export interface OneClickAssetPriceServiceOptions {
  readonly mappings: readonly OneClickAssetPriceSourceMapping[]
  readonly cache: AssetPriceCacheRepository
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

export type { OneClickContractAssetPriceSourceMapping } from '@/core/prices/user-asset-price-mappings'

export type OneClickAssetPriceSourceMapping =
  | AssetPriceSourceMapping
  | OneClickContractAssetPriceSourceMapping

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every(key => keys.has(key))
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function canonicalPrice(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid asset USD price')
  }
  const price = new Big(value).round(18, Big.roundHalfUp).toFixed()
  if (price === '0') return null
  if (!/^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/.test(price)) {
    throw new Error('Asset USD price exceeds the supported precision')
  }
  return price
}

function parseSourceTimestamp(value: unknown, now: number): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new Error('Invalid asset price source timestamp')
  }
  const timestamp = Date.parse(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > now + MAX_CLOCK_SKEW_MS) {
    throw new Error('Invalid asset price source timestamp')
  }
  return timestamp
}

function parseCacheSnapshot(value: unknown): AssetPriceCacheSnapshot | null {
  if (value === null) return null
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.version !== PRICE_CACHE_VERSION ||
    !Array.isArray(value.quotes) ||
    value.quotes.length > MAXIMUM_ASSET_PRICE_ITEMS
  ) {
    throw new Error('Invalid asset price cache')
  }
  const quotes = value.quotes.map(item => {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== 3 ||
      typeof item.assetId !== 'string' ||
      typeof item.priceUsd !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/.test(item.priceUsd)
    ) {
      throw new Error('Invalid cached asset price quote')
    }
    return Object.freeze({
      assetId: parseAssetId(item.assetId).id,
      priceUsd: item.priceUsd,
      sourceUpdatedAt: readTimestamp(item.sourceUpdatedAt, 'cached price timestamp')
    })
  })
  if (new Set(quotes.map(quote => quote.assetId)).size !== quotes.length) {
    throw new Error('Duplicate cached asset price quote')
  }
  return Object.freeze({
    version: PRICE_CACHE_VERSION,
    fetchedAt: readTimestamp(value.fetchedAt, 'asset price cache timestamp'),
    quotes: Object.freeze(quotes)
  })
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new Error('Asset price response exceeds the allowed size')
  )
}

function materialize(
  snapshot: AssetPriceCacheSnapshot | null,
  mappings: readonly OneClickAssetPriceSourceMapping[],
  now: number
): AssetPriceReadModel {
  const cached = new Map(snapshot?.quotes.map(quote => [quote.assetId, quote]) ?? [])
  const quotes: AssetPriceQuote[] = []
  const missingAssetIds: string[] = []
  for (const mapping of mappings) {
    const quote = cached.get(mapping.assetId)
    const age = quote ? now - quote.sourceUpdatedAt : Number.POSITIVE_INFINITY
    if (!quote || age < -MAX_CLOCK_SKEW_MS || age > ASSET_PRICE_EXPIRES_MS) {
      missingAssetIds.push(mapping.assetId)
      continue
    }
    quotes.push(
      Object.freeze({
        ...quote,
        source: ASSET_PRICE_QUOTE_SOURCES.oneClick,
        fetchedAt: snapshot?.fetchedAt ?? 0,
        freshness: age <= ASSET_PRICE_FRESH_MS ? ('fresh' as const) : ('stale' as const)
      })
    )
  }
  const status =
    quotes.length === 0
      ? ('error' as const)
      : missingAssetIds.length > 0 || quotes.some(quote => quote.freshness === 'stale')
        ? ('partial' as const)
        : ('ready' as const)
  return Object.freeze({
    source: ASSET_PRICE_SOURCE,
    status,
    fetchedAt: snapshot?.fetchedAt ?? now,
    quotes: Object.freeze(quotes),
    missingAssetIds: Object.freeze(missingAssetIds)
  })
}

export class OneClickAssetPriceService {
  private readonly options: Required<
    Pick<OneClickAssetPriceServiceOptions, 'fetch' | 'now' | 'timeoutMs' | 'maximumResponseBytes'>
  > &
    Pick<OneClickAssetPriceServiceOptions, 'mappings' | 'cache'>
  private readonly refreshGates = new Map<string, DedupPromise<AssetPriceReadModel>>()

  constructor(options: OneClickAssetPriceServiceOptions) {
    if (
      !Array.isArray(options.mappings) ||
      options.mappings.length === 0 ||
      options.mappings.length > MAXIMUM_ASSET_PRICE_ITEMS
    ) {
      throw new Error('Asset price service requires bounded source mappings')
    }
    const mappings = options.mappings.map(mapping => {
      const shared = {
        assetId: parseAssetId(mapping.assetId).id,
        marketAssetId: createMarketAssetId(mapping.marketAssetId)
      }
      if ('sourceAssetId' in mapping) {
        if (!/^[-%:._a-zA-Z0-9]{1,256}$/.test(mapping.sourceAssetId)) {
          throw new Error('Invalid asset price source mapping')
        }
        return Object.freeze({ ...shared, sourceAssetId: mapping.sourceAssetId })
      }
      if (
        !/^[-a-z0-9]{1,32}$/.test(mapping.sourceBlockchain) ||
        !/^0x[0-9a-fA-F]{40}$/.test(mapping.sourceContractAddress) ||
        !Number.isSafeInteger(mapping.sourceDecimals) ||
        mapping.sourceDecimals < 0 ||
        mapping.sourceDecimals > 255
      ) {
        throw new Error('Invalid asset price contract mapping')
      }
      return Object.freeze({
        ...shared,
        sourceBlockchain: mapping.sourceBlockchain,
        sourceContractAddress: mapping.sourceContractAddress.toLowerCase() as `0x${string}`,
        sourceDecimals: mapping.sourceDecimals
      })
    })
    if (new Set(mappings.map(mapping => mapping.assetId)).size !== mappings.length) {
      throw new Error('Invalid asset price source mappings')
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error('Invalid asset price timeout')
    }
    if (
      !Number.isSafeInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1_024 ||
      maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
    ) {
      throw new Error('Invalid asset price response limit')
    }
    const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.options = {
      mappings: Object.freeze(mappings),
      cache: options.cache,
      fetch: (input, init) => fetchImplementation(input, init),
      now: options.now ?? Date.now,
      timeoutMs,
      maximumResponseBytes
    }
  }

  async readCached(): Promise<AssetPriceReadModel> {
    const now = this.readNow()
    try {
      return materialize(
        parseCacheSnapshot(await this.options.cache.get()),
        this.options.mappings,
        now
      )
    } catch {
      return materialize(null, this.options.mappings, now)
    }
  }

  refresh(assetId?: string): Promise<AssetPriceReadModel> {
    const key = assetId ?? '*'
    let gate = this.refreshGates.get(key)
    if (!gate) {
      gate = new DedupPromise<AssetPriceReadModel>()
      this.refreshGates.set(key, gate)
    }
    return gate.run(() => this.refreshOnce(assetId))
  }

  private readNow(): number {
    const now = this.options.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid asset price clock')
    return now
  }

  private async refreshOnce(assetId?: string): Promise<AssetPriceReadModel> {
    const now = this.readNow()
    const mappings = assetId
      ? this.options.mappings.filter(mapping => mapping.assetId === assetId)
      : this.options.mappings
    if (mappings.length === 0) return this.readCached()
    let cached: AssetPriceCacheSnapshot | null = null
    try {
      cached = parseCacheSnapshot(await this.options.cache.get())
    } catch {
      cached = null
    }
    if (
      cached &&
      now - cached.fetchedAt >= 0 &&
      now - cached.fetchedAt < NETWORK_REFRESH_INTERVAL_MS &&
      (!assetId || cached.quotes.some(quote => quote.assetId === assetId))
    ) {
      return materialize(cached, this.options.mappings, now)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const response = await this.options.fetch(ONE_CLICK_ASSET_PRICE_URL, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) throw new Error('Asset price endpoint is unavailable')
      const text = await readBoundedResponse(response, this.options.maximumResponseBytes)
      const decoded: unknown = JSON.parse(text)
      if (!Array.isArray(decoded) || decoded.length > MAXIMUM_TOKEN_COUNT) {
        throw new Error('Invalid asset price response')
      }
      const wanted = new Map<string, (typeof this.options.mappings)[number][]>()
      const wantedContracts = new Map<string, (typeof this.options.mappings)[number][]>()
      for (const mapping of mappings) {
        if ('sourceAssetId' in mapping) {
          const mappings = wanted.get(mapping.sourceAssetId) ?? []
          mappings.push(mapping)
          wanted.set(mapping.sourceAssetId, mappings)
        } else {
          const key = `${mapping.sourceBlockchain}:${mapping.sourceContractAddress}`
          const mappings = wantedContracts.get(key) ?? []
          mappings.push(mapping)
          wantedContracts.set(key, mappings)
        }
      }
      const resolved = new Map<string, AssetPriceCacheQuote>()
      for (const token of decoded) {
        if (!isRecord(token) || typeof token.assetId !== 'string') continue
        const contractKey =
          typeof token.blockchain === 'string' &&
          typeof token.contractAddress === 'string' &&
          /^0x[0-9a-fA-F]{40}$/.test(token.contractAddress)
            ? `${token.blockchain}:${token.contractAddress.toLowerCase()}`
            : null
        const mappings = [
          ...(wanted.get(token.assetId) ?? []),
          ...(contractKey === null ? [] : (wantedContracts.get(contractKey) ?? []))
        ]
        if (mappings.length === 0) continue
        if (
          !hasOnlyKeys(token, [
            'assetId',
            'decimals',
            'blockchain',
            'symbol',
            'price',
            'priceUpdatedAt',
            'contractAddress',
            'coingeckoId'
          ]) ||
          !Object.prototype.hasOwnProperty.call(token, 'price') ||
          !Object.prototype.hasOwnProperty.call(token, 'priceUpdatedAt') ||
          mappings.some(mapping => resolved.has(mapping.assetId)) ||
          mappings.some(
            mapping =>
              'sourceContractAddress' in mapping && token.decimals !== mapping.sourceDecimals
          )
        ) {
          throw new Error('Invalid mapped asset price response')
        }
        if (token.price === 0) continue
        const priceUsd = canonicalPrice(token.price)
        if (priceUsd === null) continue
        const sourceUpdatedAt = parseSourceTimestamp(token.priceUpdatedAt, now)
        for (const mapping of mappings) {
          resolved.set(
            mapping.assetId,
            Object.freeze({
              assetId: mapping.assetId,
              priceUsd,
              sourceUpdatedAt
            })
          )
        }
      }
      const snapshot = Object.freeze({
        version: PRICE_CACHE_VERSION,
        fetchedAt: assetId ? (cached?.fetchedAt ?? 0) : now,
        quotes: Object.freeze([
          ...(assetId ? (cached?.quotes.filter(quote => quote.assetId !== assetId) ?? []) : []),
          ...resolved.values()
        ])
      })
      await this.options.cache.put(snapshot)
      return materialize(snapshot, this.options.mappings, now)
    } catch (error) {
      console.warn(
        '[Asset Prices] 1Click refresh failed:',
        error instanceof Error ? error.message : 'Unknown error'
      )
      return materialize(cached, this.options.mappings, now)
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function parseAssetPriceCacheSnapshot(value: unknown): AssetPriceCacheSnapshot | null {
  return parseCacheSnapshot(value)
}
