import {
  getFarmDetailsOfAsset,
  type Asset,
  type IAssetsView,
  type Portfolio
} from '@rhea-finance/cross-chain-sdk'
import { ZEC_NEAR_ASSET, ZEC_NEAR_TOKEN_ID } from '@/config/intents'
import { safeBig } from '@/lib/big'
import { formatAmount } from '@/lib/number-format'

export type LendingMarketId = string

export interface LendingMarketDefinition {
  readonly id: LendingMarketId
  readonly tokenId: string
  readonly destinationAssetId: string
  readonly symbol: string
  readonly displayName: string
}

export interface LendingMarketView extends LendingMarketDefinition {
  readonly icon?: string
  readonly decimals: number
  readonly priceUsd: number
  readonly supplyApy: string
  readonly totalSupplied: string
  readonly totalSuppliedUsd: string
  readonly supplied: string
  readonly suppliedUsd: string
}

export function getLendingDestinationAssetId(tokenId: string): string {
  return tokenId === ZEC_NEAR_TOKEN_ID ? ZEC_NEAR_ASSET : `nep141:${tokenId}`
}

export function isZcashLendingMarket(market: LendingMarketDefinition): boolean {
  return market.tokenId === ZEC_NEAR_TOKEN_ID
}

export function getLendingMarket(
  markets: readonly LendingMarketView[],
  id: string | null | undefined
): LendingMarketView | undefined {
  return markets.find(market => market.id === id) ?? markets[0]
}

export function sortLendingMarketsBySupplyApy(
  markets: readonly LendingMarketView[]
): readonly LendingMarketView[] {
  return Object.freeze(
    markets
      .map((market, index) => ({ market, index }))
      .sort((left, right) => {
        const apyOrder = safeBig(right.market.supplyApy).cmp(left.market.supplyApy)
        return apyOrder === 0 ? left.index - right.index : apyOrder
      })
      .map(({ market }) => market)
  )
}

export function normalizeLendingMarketSymbol(symbol: string): string {
  const trimmed = symbol.trim()
  const normalized = trimmed.toUpperCase()
  if (normalized === 'NBTC') return 'BTC'
  if (normalized === 'WNEAR') return 'NEAR'
  return trimmed
}

export function getLendingBalanceDecimals(asset: Asset | null | undefined): number | null {
  const baseDecimals = asset?.metadata?.decimals
  const extraDecimals = asset?.config?.extra_decimals
  if (
    typeof baseDecimals !== 'number' ||
    typeof extraDecimals !== 'number' ||
    !Number.isInteger(baseDecimals) ||
    !Number.isInteger(extraDecimals) ||
    baseDecimals < 0 ||
    extraDecimals < 0 ||
    baseDecimals + extraDecimals > 255
  ) {
    return null
  }
  return baseDecimals + extraDecimals
}

export function getLendingMarketViews(
  assetsView: IAssetsView | null,
  portfolioView: Portfolio | null | undefined
): readonly LendingMarketView[] {
  if (!assetsView) return Object.freeze([])

  return Object.freeze(
    Object.entries(assetsView).flatMap(([tokenId, asset]) => {
      const metadata = asset?.metadata
      const totalDecimals = getLendingBalanceDecimals(asset)
      if (
        !asset ||
        !metadata ||
        totalDecimals === null ||
        typeof metadata.symbol !== 'string' ||
        metadata.symbol.length === 0 ||
        typeof metadata.name !== 'string' ||
        metadata.name.length === 0
      ) {
        return []
      }

      const totalSupplied = formatAmount(asset.supplied?.balance || '0', totalDecimals)
      const suppliedRaw = safeBig(portfolioView?.supplied?.[tokenId]?.balance || '0')
        .plus(portfolioView?.collateral?.[tokenId]?.balance || '0')
        .toFixed(0)
      const supplied = formatAmount(suppliedRaw, totalDecimals)
      const priceUsd = Number(asset.price?.usd || 0)

      let supplyApy = '0'
      try {
        supplyApy = safeBig(
          getFarmDetailsOfAsset({ assets: assetsView, assetId: tokenId }).supplyApy
        ).toFixed()
      } catch {
        // A market remains visible when farm metadata is temporarily unavailable.
      }

      const symbol = normalizeLendingMarketSymbol(metadata.symbol)
      const useCanonicalNativeIcon = tokenId === 'wrap.near' || tokenId === 'nbtc.bridge.near'
      const icon =
        !useCanonicalNativeIcon &&
        typeof metadata.icon === 'string' &&
        metadata.icon.length > 0 &&
        metadata.icon.length <= 2_048
          ? metadata.icon
          : null
      const normalizedPriceUsd = Number.isFinite(priceUsd) && priceUsd >= 0 ? priceUsd : 0
      return [
        Object.freeze({
          id: tokenId,
          tokenId,
          destinationAssetId: getLendingDestinationAssetId(tokenId),
          symbol,
          displayName: metadata.name,
          ...(icon === null ? {} : { icon }),
          decimals: metadata.decimals,
          priceUsd: normalizedPriceUsd,
          supplyApy,
          totalSupplied,
          totalSuppliedUsd: safeBig(totalSupplied).times(normalizedPriceUsd).toFixed(),
          supplied,
          suppliedUsd: safeBig(supplied).times(normalizedPriceUsd).toFixed()
        })
      ]
    })
  )
}
