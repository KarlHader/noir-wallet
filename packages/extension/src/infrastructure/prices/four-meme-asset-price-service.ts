import { ASSET_PRICE_SOURCE_ASSETS } from '@/config/asset-market-assets'
import {
  ASSET_PRICE_EXPIRES_MS,
  ASSET_PRICE_FRESH_MS,
  ASSET_PRICE_QUOTE_SOURCES,
  ASSET_PRICE_SOURCE,
  createMarketAssetId,
  type AssetPriceReadModel
} from '@/core/prices'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import Big from '@/lib/big'
import type { FourMemeMarketClient, FourMemeToken } from './four-meme-market-client'
import {
  OneClickAssetPriceService,
  parseAssetPriceCacheSnapshot,
  type AssetPriceCacheRepository,
  type AssetPriceCacheSnapshot,
  type OneClickAssetPriceSourceMapping
} from './one-click-asset-price-service'

const BNB_ASSET_ID = 'eip155:56/slip44:714'
const TOKEN_ASSET_PATTERN = /^eip155:56\/erc20:0x[0-9a-f]{40}$/
const REFRESH_INTERVAL_MS = 60_000
const MAXIMUM_ASSETS = 512
const MAXIMUM_REFRESH_ASSETS = 12
const CONCURRENCY = 3
const MAXIMUM_CLOCK_SKEW_MS = 5 * 60_000

export interface FourMemeAssetPriceServiceOptions {
  readonly assetIds: readonly string[]
  readonly client: Pick<FourMemeMarketClient, 'getToken'>
  readonly cache: AssetPriceCacheRepository
  readonly quotePriceCache: AssetPriceCacheRepository
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

function quoteMapping(token: FourMemeToken): OneClickAssetPriceSourceMapping | null {
  const market = token.market
  if (!market) return null
  if (market.quoteAssetId === BNB_ASSET_ID) {
    return {
      assetId: BNB_ASSET_ID,
      marketAssetId: createMarketAssetId('bnb'),
      sourceAssetId: ASSET_PRICE_SOURCE_ASSETS.bnb
    }
  }
  if (!TOKEN_ASSET_PATTERN.test(market.quoteAssetId)) return null
  return {
    assetId: market.quoteAssetId,
    marketAssetId: createMarketAssetId(`fm-${market.quoteAssetId.split(':').at(-1)!.slice(2)}`),
    sourceBlockchain: 'bsc',
    sourceContractAddress: market.quoteAssetId.split(':').at(-1)! as `0x${string}`,
    sourceDecimals: market.quoteDecimals
  }
}

export class FourMemeAssetPriceService {
  private readonly assetIds: readonly string[]
  private readonly now: () => number
  private readonly queue = new SerialTaskQueue()
  private readonly gates = new Map<string, DedupPromise<AssetPriceReadModel>>()
  private readonly attempts = new Map<string, number>()

  constructor(private readonly options: FourMemeAssetPriceServiceOptions) {
    const assetIds = options.assetIds.map(assetId => assetId.toLowerCase())
    if (
      assetIds.length === 0 ||
      assetIds.length > MAXIMUM_ASSETS ||
      assetIds.some(assetId => !TOKEN_ASSET_PATTERN.test(assetId)) ||
      new Set(assetIds).size !== assetIds.length
    ) {
      throw new Error('Four.Meme prices require a bounded BNB token inventory')
    }
    this.assetIds = Object.freeze(assetIds)
    this.now = options.now ?? Date.now
  }

  hasAsset(assetId: string): boolean {
    return this.assetIds.includes(assetId.toLowerCase())
  }

  private async snapshot(): Promise<AssetPriceCacheSnapshot | null> {
    try {
      return parseAssetPriceCacheSnapshot(await this.options.cache.get())
    } catch {
      return null
    }
  }

  private readNow(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid Four.Meme price clock')
    return now
  }

  async readCached(): Promise<AssetPriceReadModel> {
    const now = this.readNow()
    const snapshot = await this.snapshot()
    const inventory = new Set(this.assetIds)
    const quotes = Object.freeze(
      (snapshot?.quotes ?? []).flatMap(quote => {
        const age = now - quote.sourceUpdatedAt
        if (
          !inventory.has(quote.assetId) ||
          age < -MAXIMUM_CLOCK_SKEW_MS ||
          age > ASSET_PRICE_EXPIRES_MS ||
          new Big(quote.priceUsd).lte(0)
        )
          return []
        return [
          Object.freeze({
            ...quote,
            source: ASSET_PRICE_QUOTE_SOURCES.fourMeme,
            fetchedAt: snapshot!.fetchedAt,
            freshness: age <= ASSET_PRICE_FRESH_MS ? ('fresh' as const) : ('stale' as const)
          })
        ]
      })
    )
    const quoted = new Set(quotes.map(quote => quote.assetId))
    const missingAssetIds = Object.freeze(this.assetIds.filter(assetId => !quoted.has(assetId)))
    return Object.freeze({
      source: ASSET_PRICE_SOURCE,
      status:
        quotes.length === 0
          ? 'error'
          : missingAssetIds.length || quotes.some(quote => quote.freshness === 'stale')
            ? 'partial'
            : 'ready',
      fetchedAt: snapshot?.fetchedAt ?? now,
      quotes,
      missingAssetIds
    })
  }

  refresh(assetId?: string): Promise<AssetPriceReadModel> {
    const target = assetId?.toLowerCase()
    if (target && !this.assetIds.includes(target)) throw new Error('Unknown Four.Meme price asset')
    const key = target ?? '*'
    let gate = this.gates.get(key)
    if (!gate) {
      gate = new DedupPromise<AssetPriceReadModel>()
      this.gates.set(key, gate)
    }
    return gate.run(() => this.queue.run(() => this.refreshOnce(target)))
  }

  private async refreshOnce(target?: string): Promise<AssetPriceReadModel> {
    const now = this.readNow()
    const cached = await this.snapshot()
    const selected = (target ? [target] : this.assetIds)
      .filter(assetId => {
        const attempted = this.attempts.get(assetId)
        return attempted === undefined || now < attempted || now - attempted >= REFRESH_INTERVAL_MS
      })
      .sort((left, right) => (this.attempts.get(left) ?? -1) - (this.attempts.get(right) ?? -1))
      .slice(0, MAXIMUM_REFRESH_ASSETS)
    if (selected.length === 0) return this.readCached()
    const tokens = new Map<string, FourMemeToken | null>()
    let index = 0
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, selected.length) }, async () => {
        while (index < selected.length) {
          const assetId = selected[index++]
          this.attempts.set(assetId, now)
          tokens.set(assetId, await this.options.client.getToken(assetId).catch(() => null))
        }
      })
    )
    const mappings = new Map<string, OneClickAssetPriceSourceMapping>()
    for (const token of tokens.values()) {
      const mapping = token?.phase === 'curve' ? quoteMapping(token) : null
      if (mapping) mappings.set(mapping.assetId, mapping)
    }
    const usd =
      mappings.size === 0
        ? null
        : await new OneClickAssetPriceService({
            mappings: [...mappings.values()],
            cache: this.options.quotePriceCache,
            fetch: this.options.fetch,
            timeoutMs: 5_000,
            now: this.now
          }).refresh()
    const usdQuotes = new Map(usd?.quotes.map(quote => [quote.assetId, quote]) ?? [])
    const fetchedAt = this.readNow()
    const resolved = new Map(
      (cached?.quotes ?? [])
        .filter(quote => this.assetIds.includes(quote.assetId))
        .map(quote => [quote.assetId, quote])
    )
    for (const [assetId, token] of tokens) {
      if (!token) continue
      // A migrated token must use the existing DEX/catalog sources, never its last curve price.
      resolved.delete(assetId)
      if (token.assetId !== assetId || token.phase !== 'curve' || !token.market) continue
      const quote = usdQuotes.get(token.market.quoteAssetId)
      if (!quote) continue
      const sourceUpdatedAt = Math.min(token.market.sourceUpdatedAt, quote.sourceUpdatedAt)
      if (
        sourceUpdatedAt > fetchedAt + MAXIMUM_CLOCK_SKEW_MS ||
        fetchedAt - sourceUpdatedAt > ASSET_PRICE_EXPIRES_MS
      )
        continue
      const priceUsd = new Big(token.market.price)
        .times(quote.priceUsd)
        .toFixed(18, Big.roundDown)
        .replace(/\.?0+$/, '')
      if (
        !priceUsd ||
        new Big(priceUsd).lte(0) ||
        !/^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/.test(priceUsd)
      )
        continue
      resolved.set(assetId, Object.freeze({ assetId, priceUsd, sourceUpdatedAt }))
    }
    try {
      await this.options.cache.put(
        Object.freeze({ version: 1, fetchedAt, quotes: Object.freeze([...resolved.values()]) })
      )
    } catch {
      // Market-data storage failure must not interrupt wallet operations.
    }
    return this.readCached()
  }
}
