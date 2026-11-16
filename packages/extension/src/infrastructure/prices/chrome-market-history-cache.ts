import {
  parseMarketHistoryCacheSnapshot,
  type MarketHistoryCacheRepository,
  type MarketHistoryCacheSnapshot
} from './asset-market-history-service'

const STORAGE_KEY = 'asset_market_history_cache_v2'

export class ChromeMarketHistoryCacheRepository implements MarketHistoryCacheRepository {
  async get(): Promise<MarketHistoryCacheSnapshot | null> {
    const result = await chrome.storage.local.get(STORAGE_KEY)
    return parseMarketHistoryCacheSnapshot(result[STORAGE_KEY] ?? null)
  }

  async put(snapshot: MarketHistoryCacheSnapshot): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: snapshot })
  }
}
