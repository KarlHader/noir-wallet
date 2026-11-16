import {
  RHEA_SWAP_CHAIN_CATALOG,
  RHEA_SWAP_TOKEN_CATALOG_TTL_MS,
  parseRheaSwapCatalogResult,
  type RheaSwapCatalogResult
} from '@/core/services/rhea-swap'
import { DedupPromise } from '@/lib/async-utils'

const CACHE_NAME = 'noir-public-rhea-token-catalog-v1'

interface CatalogRequest {
  readonly direction: 'from' | 'cross-chain-to'
  readonly tokenListChainIds: readonly number[]
}

interface CatalogSnapshot {
  readonly fetchedAt: number
  readonly result: RheaSwapCatalogResult
}

/** Public metadata only; quotes, balances and account preferences never enter this cache. */
export class PersistentRheaSwapCatalogCache {
  private readonly memory = new Map<string, CatalogSnapshot>()
  private readonly pending = new Map<string, DedupPromise<RheaSwapCatalogResult>>()

  constructor(
    private readonly load: (input: CatalogRequest) => Promise<RheaSwapCatalogResult>,
    private readonly storage: Pick<CacheStorage, 'open'> | undefined = globalThis.caches,
    private readonly now: () => number = Date.now
  ) {}

  async read(input: CatalogRequest): Promise<RheaSwapCatalogResult> {
    const supported = new Set(RHEA_SWAP_CHAIN_CATALOG.map(chain => chain.tokenListChainId))
    if (
      !['from', 'cross-chain-to'].includes(input.direction) ||
      !Array.isArray(input.tokenListChainIds) ||
      input.tokenListChainIds.length === 0 ||
      input.tokenListChainIds.length > supported.size ||
      new Set(input.tokenListChainIds).size !== input.tokenListChainIds.length ||
      input.tokenListChainIds.some(chainId => !supported.has(chainId))
    ) {
      throw new Error('Invalid RHEA Swap chain list')
    }
    const results: RheaSwapCatalogResult[] = new Array(input.tokenListChainIds.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < input.tokenListChainIds.length) {
        const index = cursor++
        const chainId = input.tokenListChainIds[index]
        try {
          results[index] = await this.readChain(input.direction, chainId)
        } catch {
          results[index] = { tokens: [], failedChainIds: [chainId] }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, results.length) }, worker))
    return Object.freeze({
      tokens: Object.freeze(results.flatMap(result => result.tokens)),
      failedChainIds: Object.freeze(results.flatMap(result => result.failedChainIds))
    })
  }

  private complete(result: RheaSwapCatalogResult, chainId: number): boolean {
    return (
      result.failedChainIds.length === 0 &&
      result.tokens.length > 0 &&
      result.tokens.every(token => token.tokenListChainId === chainId && token.sources.length > 0)
    )
  }

  private fresh(fetchedAt: number): boolean {
    const age = this.now() - fetchedAt
    return (
      Number.isSafeInteger(fetchedAt) &&
      fetchedAt >= 0 &&
      age >= 0 &&
      age < RHEA_SWAP_TOKEN_CATALOG_TTL_MS
    )
  }

  private async readChain(
    direction: CatalogRequest['direction'],
    chainId: number
  ): Promise<RheaSwapCatalogResult> {
    const key = `https://api.rhea.finance/noir-public-catalog/v1/${direction}/${chainId}`
    const cached = this.memory.get(key)
    if (cached && this.fresh(cached.fetchedAt)) return cached.result
    this.memory.delete(key)
    let request = this.pending.get(key)
    if (!request) {
      request = new DedupPromise<RheaSwapCatalogResult>()
      this.pending.set(key, request)
    }
    try {
      return await request.run(async () => {
        let cache: Cache | undefined
        try {
          cache = await this.storage?.open(CACHE_NAME)
          const response = await cache?.match(key)
          if (response) {
            const value: unknown = await response.json()
            if (typeof value !== 'object' || value === null || Array.isArray(value))
              throw new Error('Invalid cached catalog')
            const snapshot = value as Record<string, unknown>
            if (snapshot.version !== 1 || !this.fresh(snapshot.fetchedAt as number))
              throw new Error('Expired cached catalog')
            const result = parseRheaSwapCatalogResult(snapshot.result)
            if (!this.complete(result, chainId)) throw new Error('Incomplete cached catalog')
            this.memory.set(key, { fetchedAt: snapshot.fetchedAt as number, result })
            return result
          }
        } catch {
          // Storage eviction, old schemas and corrupt metadata must not block a live read.
        }
        const result = await this.load({ direction, tokenListChainIds: [chainId] })
        if (this.complete(result, chainId)) {
          const fetchedAt = this.now()
          this.memory.set(key, { fetchedAt, result })
          await cache
            ?.put(
              key,
              new Response(JSON.stringify({ version: 1, fetchedAt, result }), {
                headers: { 'content-type': 'application/json' }
              })
            )
            .catch(() => {})
        }
        return result
      })
    } finally {
      if (!request.isPending && this.pending.get(key) === request) this.pending.delete(key)
    }
  }
}
