import {
  parseAssetPriceCacheSnapshot,
  type AssetPriceCacheRepository,
  type AssetPriceCacheSnapshot
} from './one-click-asset-price-service'

export const USER_ASSET_ONE_CLICK_PRICE_CACHE_STORAGE_KEY = 'user_asset_one_click_price_cache_v1'

export class ChromeUserAssetOneClickPriceCacheRepository implements AssetPriceCacheRepository {
  async get(): Promise<AssetPriceCacheSnapshot | null> {
    const stored = await chrome.storage.local.get(USER_ASSET_ONE_CLICK_PRICE_CACHE_STORAGE_KEY)
    return parseAssetPriceCacheSnapshot(
      stored[USER_ASSET_ONE_CLICK_PRICE_CACHE_STORAGE_KEY] ?? null
    )
  }

  async put(snapshot: AssetPriceCacheSnapshot): Promise<void> {
    await chrome.storage.local.set({ [USER_ASSET_ONE_CLICK_PRICE_CACHE_STORAGE_KEY]: snapshot })
  }
}
