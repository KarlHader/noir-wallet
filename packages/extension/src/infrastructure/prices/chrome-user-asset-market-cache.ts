import {
  parseMarketChangeCacheSnapshot,
  type MarketChangeCacheRepository,
  type MarketChangeCacheSnapshot
} from './dex-screener-market-change-service'

export const USER_ASSET_MARKET_CACHE_STORAGE_KEY = 'user_asset_market_cache_v1'

export class ChromeUserAssetMarketCacheRepository implements MarketChangeCacheRepository {
  async get(): Promise<MarketChangeCacheSnapshot | null> {
    const stored = await chrome.storage.local.get(USER_ASSET_MARKET_CACHE_STORAGE_KEY)
    return parseMarketChangeCacheSnapshot(stored[USER_ASSET_MARKET_CACHE_STORAGE_KEY] ?? null)
  }

  async put(snapshot: MarketChangeCacheSnapshot): Promise<void> {
    await chrome.storage.local.set({ [USER_ASSET_MARKET_CACHE_STORAGE_KEY]: snapshot })
  }
}
