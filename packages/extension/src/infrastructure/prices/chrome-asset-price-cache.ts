import {
  parseAssetPriceCacheSnapshot,
  type AssetPriceCacheRepository,
  type AssetPriceCacheSnapshot
} from './one-click-asset-price-service'

const STORAGE_KEY = 'asset_price_cache_v1'

export class ChromeAssetPriceCacheRepository implements AssetPriceCacheRepository {
  async get(): Promise<AssetPriceCacheSnapshot | null> {
    const result = await chrome.storage.local.get(STORAGE_KEY)
    return parseAssetPriceCacheSnapshot(result[STORAGE_KEY] ?? null)
  }

  async put(snapshot: AssetPriceCacheSnapshot): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: snapshot })
  }
}
