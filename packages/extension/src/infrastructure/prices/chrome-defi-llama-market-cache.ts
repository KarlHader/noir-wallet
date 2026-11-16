import {
  parseMarketChangeCacheSnapshot,
  type MarketChangeCacheRepository,
  type MarketChangeCacheSnapshot
} from './dex-screener-market-change-service'

export const DEFI_LLAMA_MARKET_CACHE_STORAGE_KEY = 'defi_llama_market_change_cache_v1'

export class ChromeDefiLlamaMarketCacheRepository implements MarketChangeCacheRepository {
  async get(): Promise<MarketChangeCacheSnapshot | null> {
    const stored = await chrome.storage.local.get(DEFI_LLAMA_MARKET_CACHE_STORAGE_KEY)
    return parseMarketChangeCacheSnapshot(stored[DEFI_LLAMA_MARKET_CACHE_STORAGE_KEY] ?? null)
  }

  async put(snapshot: MarketChangeCacheSnapshot): Promise<void> {
    await chrome.storage.local.set({ [DEFI_LLAMA_MARKET_CACHE_STORAGE_KEY]: snapshot })
  }
}
