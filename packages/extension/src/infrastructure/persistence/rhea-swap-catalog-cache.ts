import {
  RHEA_SWAP_CHAIN_CATALOG,
  RHEA_SWAP_TOKEN_CATALOG_TTL_MS,
  parseRheaSwapCatalogResult,
  type RheaSwapCatalogResult
} from '@/core/services/rhea-swap'
import { DedupPromise } from '@/lib/async-utils'

const CACHE_NAME = 'noir-public-rhea-token-catalog-v2'

interface CatalogRequest {
  readonly direction: 'from' | 'cross-chain-to'
  readonly tokenListChainIds: readonly number[]
}

interface CatalogSnapshot {
  readonly fetchedAt: number
  readonly result: RheaSwapCatalogResult
}

export interface FreshRheaSwapCatalog {
  readonly result: RheaSwapCatalogResult
  readonly expiresAt: number
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
    return this.collect(input, (direction, chainId) => this.readChain(direction, chainId))
  }

  /** Reads extension-origin public metadata only; it never loads or writes a catalog. */
  async readFresh(input: CatalogRequest): Promise<FreshRheaSwapCatalog | null> {
    const chainIds = this.parseRequest(input)
    const snapshots = await Promise.all(
      chainIds.map(chainId => this.readCachedChain(input.direction, chainId))
    )
    if (snapshots.some(snapshot => !snapshot || !this.fresh(snapshot.fetchedAt))) return null
    const complete = snapshots as CatalogSnapshot[]
    return Object.freeze({
      result: Object.freeze({
        tokens: Object.freeze(complete.flatMap(snapshot => snapshot.result.tokens)),
        failedChainIds: Object.freeze([])
      }),
      expiresAt: Math.min(
        ...complete.map(snapshot => snapshot.fetchedAt + RHEA_SWAP_TOKEN_CATALOG_TTL_MS)
      )
    })
  }

  /** Restores complete public metadata for display without making a network request. */
  async readLastGood(input: CatalogRequest): Promise<RheaSwapCatalogResult> {
    return this.collect(input, async (direction, chainId) => {
      const cached = await this.readCachedChain(direction, chainId)
      return cached?.result ?? { tokens: [], failedChainIds: [chainId] }
    })
  }

  private async collect(
    input: CatalogRequest,
    readChain: (
      direction: CatalogRequest['direction'],
      chainId: number
    ) => Promise<RheaSwapCatalogResult>
  ): Promise<RheaSwapCatalogResult> {
    const chainIds = this.parseRequest(input)
    const results: RheaSwapCatalogResult[] = new Array(chainIds.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < chainIds.length) {
        const index = cursor++
        const chainId = chainIds[index]
        try {
          results[index] = await readChain(input.direction, chainId)
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

  private parseRequest(input: CatalogRequest): readonly number[] {
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
    return Object.freeze([...input.tokenListChainIds])
  }

  private complete(result: RheaSwapCatalogResult, chainId: number): boolean {
    return (
      result.failedChainIds.length === 0 &&
      result.tokens.length > 0 &&
      result.tokens.every(
        token =>
          token.tokenListChainId === chainId &&
          token.sources.length > 0 &&
          token.isDisplaySeed !== true
      )
    )
  }

  private validTimestamp(fetchedAt: number): boolean {
    return Number.isSafeInteger(fetchedAt) && fetchedAt >= 0 && fetchedAt <= this.now()
  }

  private fresh(fetchedAt: number): boolean {
    return this.validTimestamp(fetchedAt) && this.now() - fetchedAt < RHEA_SWAP_TOKEN_CATALOG_TTL_MS
  }

  private key(direction: CatalogRequest['direction'], chainId: number): string {
    return `https://api.rhea.finance/noir-public-catalog/v2/${direction}/${chainId}`
  }

  private parseSnapshot(value: unknown, chainId: number): CatalogSnapshot {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Invalid cached catalog')
    }
    const snapshot = value as Record<string, unknown>
    if (
      Object.keys(snapshot).length !== 3 ||
      snapshot.version !== 1 ||
      !this.validTimestamp(snapshot.fetchedAt as number)
    ) {
      throw new Error('Invalid cached catalog')
    }
    const result = parseRheaSwapCatalogResult(snapshot.result)
    if (!this.complete(result, chainId)) throw new Error('Incomplete cached catalog')
    return { fetchedAt: snapshot.fetchedAt as number, result }
  }

  private async readCachedChain(
    direction: CatalogRequest['direction'],
    chainId: number
  ): Promise<CatalogSnapshot | null> {
    const key = this.key(direction, chainId)
    let best: CatalogSnapshot | null = null
    const inMemory = this.memory.get(key)
    if (inMemory) {
      try {
        best = this.parseSnapshot({ version: 1, ...inMemory }, chainId)
      } catch {
        this.memory.delete(key)
      }
    }
    try {
      const cache = await this.storage?.open(CACHE_NAME)
      const response = await cache?.match(key)
      if (response) {
        const stored = this.parseSnapshot(await response.json(), chainId)
        if (!best || stored.fetchedAt > best.fetchedAt) best = stored
      }
    } catch {
      // Storage eviction, old schemas and corrupt metadata do not discard last good memory.
    }
    if (best) this.memory.set(key, best)
    return best
  }

  private async readChain(
    direction: CatalogRequest['direction'],
    chainId: number
  ): Promise<RheaSwapCatalogResult> {
    const key = this.key(direction, chainId)
    let request = this.pending.get(key)
    if (!request) {
      request = new DedupPromise<RheaSwapCatalogResult>()
      this.pending.set(key, request)
    }
    try {
      return await request.run(async () => {
        const cached = await this.readCachedChain(direction, chainId)
        if (cached && this.fresh(cached.fetchedAt)) return cached.result
        const result = await this.load({ direction, tokenListChainIds: [chainId] })
        if (this.complete(result, chainId)) {
          const fetchedAt = this.now()
          this.memory.set(key, { fetchedAt, result })
          try {
            const cache = await this.storage?.open(CACHE_NAME)
            await cache?.put(
              key,
              new Response(JSON.stringify({ version: 1, fetchedAt, result }), {
                headers: { 'content-type': 'application/json' }
              })
            )
          } catch {
            // The complete result remains available for this Background lifetime.
          }
        }
        return result
      })
    } finally {
      if (!request.isPending && this.pending.get(key) === request) this.pending.delete(key)
    }
  }
}
