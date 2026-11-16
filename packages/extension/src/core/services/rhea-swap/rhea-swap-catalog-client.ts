import {
  SwapClient,
  normalizeCrossChainToTokenList,
  normalizeFromTokenList,
  type ApiRequestOptions,
  type SwapClientConfig,
  type SwapTokenListItem,
  type TokenListRequest
} from '@rhea-finance/cross-chain-aggregation-dex'
import { DedupPromise } from '@/lib/async-utils'
import { RHEA_SWAP_TOKEN_CATALOG_TTL_MS, toRheaSwapToken } from './rhea-swap-model'
import { createRheaSwapFetch } from './rhea-swap-fetch'

/** SDK 2.0.6 drops malformed rows and caches empty lists; neither proves exclusion. */
export class RheaSwapCatalogClient extends SwapClient {
  private readonly catalogs = new Map<string, { tokens: SwapTokenListItem[]; expiresAt: number }>()
  private readonly requests = new Map<string, DedupPromise<SwapTokenListItem[]>>()
  private readonly catalogNow: () => number

  constructor(config: SwapClientConfig) {
    super({ ...config, fetch: createRheaSwapFetch(config.fetch ?? globalThis.fetch) })
    this.catalogNow = config.now ?? Date.now
  }

  override async getFromTokens(
    request: TokenListRequest,
    options: ApiRequestOptions = {}
  ): Promise<SwapTokenListItem[]> {
    return this.getCatalog('from', request, options)
  }

  override async getCrossChainToTokens(
    request: TokenListRequest,
    options: ApiRequestOptions = {}
  ): Promise<SwapTokenListItem[]> {
    return this.getCatalog('cross-chain-to', request, options)
  }

  private async getCatalog(
    direction: 'from' | 'cross-chain-to',
    request: TokenListRequest,
    options: ApiRequestOptions
  ): Promise<SwapTokenListItem[]> {
    const key = `${direction}:${request.chainId}`
    const cached = this.catalogs.get(key)
    if (cached && cached.expiresAt > this.catalogNow()) return structuredClone(cached.tokens)
    this.catalogs.delete(key)
    const load = async () => {
      let tokens: SwapTokenListItem[]
      let rawCount: number
      if (direction === 'from') {
        const raw = await this.api.getFromTokenRows(request.chainId, options)
        tokens = normalizeFromTokenList(raw, request.chainId)
        rawCount = Object.keys(raw).length
      } else {
        const raw = await this.api.getCrossChainToTokenRows(request.chainId, options)
        tokens = normalizeCrossChainToTokenList(raw, request.chainId)
        rawCount = raw.tokens.length
      }
      if (tokens.length !== rawCount)
        throw new Error(
          direction === 'from'
            ? 'RHEA source catalog is incomplete'
            : 'RHEA destination catalog is incomplete'
        )
      // Retry must reach the service when capability metadata or executable rows are missing.
      const complete =
        tokens.length > 0 &&
        tokens.every(token => {
          try {
            return toRheaSwapToken(token).sources.length > 0
          } catch {
            return false
          }
        })
      if (complete)
        this.catalogs.set(key, {
          tokens: structuredClone(tokens),
          expiresAt: this.catalogNow() + RHEA_SWAP_TOKEN_CATALOG_TTL_MS
        })
      return tokens
    }
    if (options.signal) return load()
    let pending = this.requests.get(key)
    if (!pending) {
      pending = new DedupPromise()
      this.requests.set(key, pending)
    }
    try {
      return structuredClone(await pending.run(load))
    } finally {
      if (!pending.isPending && this.requests.get(key) === pending) this.requests.delete(key)
    }
  }
}
