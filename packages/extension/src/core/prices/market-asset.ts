declare const marketAssetIdBrand: unique symbol

export type MarketAssetId = string & { readonly [marketAssetIdBrand]: true }

const MARKET_ASSET_ID_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,62}[a-z0-9])?$/

export function createMarketAssetId(value: string): MarketAssetId {
  if (!MARKET_ASSET_ID_PATTERN.test(value)) {
    throw new Error(`Invalid market asset ID: ${value}`)
  }
  return value as MarketAssetId
}
