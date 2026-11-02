import { parseAssetPriceReadModel, type AssetPriceReadModel } from '@/core/prices'

type AssetPriceRuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

type AssetPriceStorageChanges = Pick<
  typeof chrome.storage.onChanged,
  'addListener' | 'removeListener'
>

const ASSET_PRICE_CACHE_STORAGE_KEYS = new Set([
  'asset_price_cache_v1',
  'asset_market_change_cache_v1',
  'defi_llama_market_change_cache_v1',
  'user_asset_market_cache_v1',
  'user_asset_one_click_price_cache_v1'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function createAssetPriceClient(
  sendMessage: AssetPriceRuntimeMessenger,
  storageChanges?: AssetPriceStorageChanges
) {
  return Object.freeze({
    async getPrices(
      action: 'read' | 'refresh',
      assetId?: string
    ): Promise<AssetPriceReadModel | null> {
      const response = await sendMessage({
        type: 'GET_ASSET_PRICES',
        action,
        ...(assetId ? { assetId } : {})
      })
      if (
        !isRecord(response) ||
        Object.keys(response).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(response, 'result')
      ) {
        throw new Error('Invalid asset price response')
      }
      return response.result === null ? null : parseAssetPriceReadModel(response.result)
    },

    onCacheChanged(listener: () => void): () => void {
      const changesEvent = storageChanges ?? chrome.storage.onChanged
      const handleStorageChanged = (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string
      ) => {
        if (
          areaName === 'local' &&
          Object.keys(changes).some(key => ASSET_PRICE_CACHE_STORAGE_KEYS.has(key))
        ) {
          listener()
        }
      }
      changesEvent.addListener(handleStorageChanged)
      return () => changesEvent.removeListener(handleStorageChanged)
    }
  })
}

export const assetPriceClient = createAssetPriceClient(message =>
  chrome.runtime.sendMessage(message)
)
