import {
  SwapClient,
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
  private readonly sourceCatalogs = new Map<
    number,
    { tokens: SwapTokenListItem[]; expiresAt: number }
  >()
  private readonly sourceRequests = new Map<number, DedupPromise<SwapTokenListItem[]>>()
  private readonly catalogNow: () => number

  constructor(config: SwapClientConfig) {
    super({ ...config, fetch: createRheaSwapFetch(config.fetch ?? globalThis.fetch) })
    this.catalogNow = config.now ?? Date.now
  }

  override async getFromTokens(
    request: TokenListRequest,
    options: ApiRequestOptions = {}
  ): Promise<SwapTokenListItem[]> {
    const cached = this.sourceCatalogs.get(request.chainId)
    if (cached && cached.expiresAt > this.catalogNow()) return structuredClone(cached.tokens)
    this.sourceCatalogs.delete(request.chainId)
    const load = async () => {
      const raw = await this.api.getFromTokenRows(request.chainId, options)
      const tokens = normalizeFromTokenList(raw, request.chainId)
      if (tokens.length !== Object.keys(raw).length)
        throw new Error('RHEA source catalog is incomplete')
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
        this.sourceCatalogs.set(request.chainId, {
          tokens: structuredClone(tokens),
          expiresAt: this.catalogNow() + RHEA_SWAP_TOKEN_CATALOG_TTL_MS
        })
      return tokens
    }
    if (options.signal) return load()
    let pending = this.sourceRequests.get(request.chainId)
    if (!pending) {
      pending = new DedupPromise()
      this.sourceRequests.set(request.chainId, pending)
    }
    try {
      return structuredClone(await pending.run(load))
    } finally {
      if (!pending.isPending && this.sourceRequests.get(request.chainId) === pending)
        this.sourceRequests.delete(request.chainId)
    }
  }
}
