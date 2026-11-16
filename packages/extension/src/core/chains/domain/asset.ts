import type { ChainId } from './chain'

declare const assetIdBrand: unique symbol

export type AssetId = string & { readonly [assetIdBrand]: true }
export type AssetKind = 'native' | 'token'

export interface Asset {
  readonly id: AssetId
  readonly chainId: ChainId
  readonly namespace: string
  readonly reference: string
  readonly kind: AssetKind
}

export interface AssetDisplayMetadata {
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly iconUrl?: string
}
