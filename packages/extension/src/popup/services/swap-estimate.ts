import Big, { safeBig } from '@/lib/big'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { resolveRheaSwapCanonicalAssetId } from '@/core/services/rhea-swap/rhea-swap-asset-identity'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import type { Network } from '@/types'

interface SwapAmountValuesInput {
  readonly amountIn: string
  readonly amountOut: string
  readonly tokenInPrice: number | null | undefined
  readonly tokenOutPrice: number | null | undefined
}

export function formatSwapReviewFiat(amount: string, price: number | string | undefined): string {
  const marketPrice = safeBig(price ?? 0)
  return amount && marketPrice.gt(0) ? safeBig(amount).times(marketPrice).toFixed() : ''
}

export function resolveSwapMarketPrice(
  token: Pick<RheaSwapToken, 'assetId' | 'price'> | null,
  prices: AssetPriceReadModel | null,
  network: Network
): number | undefined {
  if (!token) return undefined
  const assetId = prices && resolveRheaSwapCanonicalAssetId(token.assetId, network)
  const marketPrice = assetId ? Number(findAssetPrice(prices, assetId)?.priceUsd) : NaN
  if (Number.isFinite(marketPrice) && marketPrice > 0) return marketPrice
  return Number.isFinite(token.price) && token.price > 0 ? token.price : undefined
}

export function getSwapAmountValues(input: SwapAmountValuesInput) {
  return {
    rate:
      input.amountIn && input.amountOut && safeBig(input.amountIn).gt(0)
        ? safeBig(input.amountOut).div(input.amountIn).toFixed()
        : '...',
    fromFiat: formatSwapReviewFiat(input.amountIn, input.tokenInPrice ?? undefined),
    toFiat: formatSwapReviewFiat(input.amountOut, input.tokenOutPrice ?? undefined)
  }
}

export function calculateSwapPriceImpact(input: SwapAmountValuesInput): number {
  const inputValue = safeBig(input.amountIn || '0').times(input.tokenInPrice || 0)
  const outputValue = safeBig(input.amountOut || '0').times(input.tokenOutPrice || 0)
  if (inputValue.lte(0) || outputValue.lte(0)) return 0
  const impact = new Big(1).minus(outputValue.div(inputValue)).times(100)
  return impact.gt(0) ? impact.toNumber() : 0
}

export function estimateSwapOutputFromPrices({
  amountIn,
  tokenInPrice,
  tokenOutPrice
}: {
  readonly amountIn: string
  readonly tokenInPrice: number | null | undefined
  readonly tokenOutPrice: number | null | undefined
}): string {
  if (
    typeof tokenInPrice !== 'number' ||
    typeof tokenOutPrice !== 'number' ||
    !Number.isFinite(tokenInPrice) ||
    !Number.isFinite(tokenOutPrice) ||
    tokenInPrice <= 0 ||
    tokenOutPrice <= 0
  ) {
    return ''
  }

  try {
    const amount = new Big(amountIn)
    if (amount.lte(0)) return ''
    return amount.mul(tokenInPrice).div(tokenOutPrice).toFixed()
  } catch {
    return ''
  }
}
