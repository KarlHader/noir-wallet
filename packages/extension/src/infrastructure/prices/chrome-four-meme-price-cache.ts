import {
  parseAssetPriceCacheSnapshot,
  type AssetPriceCacheRepository,
  type AssetPriceCacheSnapshot
} from './one-click-asset-price-service'

export const FOUR_MEME_PRICE_CACHE_STORAGE_KEY = 'four_meme_price_cache_v1'
const QUOTE_PRICE_CACHE_STORAGE_KEY = 'four_meme_quote_price_cache_v1'

export class ChromeFourMemePriceCacheRepository implements AssetPriceCacheRepository {
  private readonly storageKey: string

  constructor(kind: 'tokens' | 'quotes' = 'tokens') {
    this.storageKey =
      kind === 'tokens' ? FOUR_MEME_PRICE_CACHE_STORAGE_KEY : QUOTE_PRICE_CACHE_STORAGE_KEY
  }

  async get(): Promise<AssetPriceCacheSnapshot | null> {
    const result = await chrome.storage.local.get(this.storageKey)
    return parseAssetPriceCacheSnapshot(result[this.storageKey] ?? null)
  }

  async put(snapshot: AssetPriceCacheSnapshot): Promise<void> {
    await chrome.storage.local.set({ [this.storageKey]: snapshot })
  }
}
