import {
  parseMarketChangeCacheSnapshot,
  type MarketChangeCacheRepository,
  type MarketChangeCacheSnapshot
} from './dex-screener-market-change-service'

const STORAGE_KEY = 'asset_market_change_cache_v1'

export class ChromeMarketChangeCacheRepository implements MarketChangeCacheRepository {
  async get(): Promise<MarketChangeCacheSnapshot | null> {
    const result = await chrome.storage.local.get(STORAGE_KEY)
    return parseMarketChangeCacheSnapshot(result[STORAGE_KEY] ?? null)
  }

  async put(snapshot: MarketChangeCacheSnapshot): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: snapshot })
  }
}
