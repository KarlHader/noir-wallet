import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { findAssetPrice } from '@/core/prices'
import type { PortfolioReadModel } from '@/core/portfolio'
import { calculateSuggestedPrivateGasFundingRaw } from '@/core/transactions/private-funding'
import { assetPriceClient } from './asset-price-client'
import { evmWalletClient } from './evm-wallet-client'

export interface EvmGasFundingDetails {
  readonly chainId: string
  readonly nativeAssetId: string
  readonly symbol: string
  readonly decimals: number
  readonly privateAddress: string
  readonly availableRaw: string
  readonly shortfallRaw: string
  readonly maximumGasCostRaw: string
}

export interface EvmGasFundingPreview {
  readonly publicBalanceRaw: string | null
  readonly suggestedOutputRaw: string | null
  readonly error: string | null
}

const RAW_AMOUNT = /^[0-9]{1,78}$/

export function parseEvmGasFundingDetails(value: unknown): EvmGasFundingDetails | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const native = data.nativeCurrency
  if (typeof native !== 'object' || native === null || Array.isArray(native)) return null
  const currency = native as Record<string, unknown>
  const chain = data.chainId
  const decimals = currency.decimals
  const symbol = currency.symbol
  const reference = currency.slip44Reference
  if (
    typeof chain !== 'number' ||
    !Number.isSafeInteger(chain) ||
    chain <= 0 ||
    typeof decimals !== 'number' ||
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    typeof symbol !== 'string' ||
    !symbol.trim() ||
    symbol.length > 32 ||
    typeof reference !== 'string' ||
    !/^[0-9]{1,10}$/.test(reference) ||
    typeof data.privateAddress !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(data.privateAddress)
  )
    return null
  for (const key of [
    'shortfallRaw',
    'requiredNativeBalanceRaw',
    'availableNativeBalanceRaw',
    'maximumGasCostRaw'
  ]) {
    if (typeof data[key] !== 'string' || !RAW_AMOUNT.test(data[key])) return null
  }
  const shortfallRaw = data.shortfallRaw as string
  const availableRaw = data.availableNativeBalanceRaw as string
  if (
    BigInt(shortfallRaw) <= 0n ||
    BigInt(data.requiredNativeBalanceRaw as string) - BigInt(availableRaw) !== BigInt(shortfallRaw)
  )
    return null
  const chainId = `eip155:${chain}`
  return Object.freeze({
    chainId,
    nativeAssetId: `${chainId}/slip44:${reference}`,
    symbol,
    decimals,
    privateAddress: data.privateAddress,
    availableRaw,
    shortfallRaw,
    maximumGasCostRaw: data.maximumGasCostRaw as string
  })
}

export function formatEvmGasFundingAmount(raw: string | null, decimals: number): string | null {
  return raw === null ? null : formatBaseUnitDecimalAmount(BigInt(raw), decimals)
}

export function resolveEvmGasFundingPreview(input: {
  readonly details: EvmGasFundingDetails
  readonly walletId: string
  readonly accountId: string
  readonly portfolio: PortfolioReadModel | null
  readonly nativePriceUsd: string | null
}): EvmGasFundingPreview {
  const { details, portfolio } = input
  const asset =
    portfolio?.scope.keyDomainId === input.walletId && portfolio.scope.accountId === input.accountId
      ? portfolio.assets.find(item => item.asset.id === details.nativeAssetId)
      : undefined
  const publicBalanceRaw =
    asset?.freshness === 'fresh' &&
    typeof asset.balance.mainRaw === 'string' &&
    RAW_AMOUNT.test(asset.balance.mainRaw)
      ? asset.balance.mainRaw
      : null
  const suggestedOutputRaw = calculateSuggestedPrivateGasFundingRaw(
    details.shortfallRaw,
    details.maximumGasCostRaw,
    { decimals: details.decimals, nativePriceUsd: input.nativePriceUsd }
  )
  // This rejects an already unaffordable default. The route review still checks
  // its actual source value and maximum fee before any funding transaction.
  const error =
    publicBalanceRaw === null
      ? 'Unable to check the Public balance. Try again.'
      : BigInt(publicBalanceRaw) === 0n ||
          (suggestedOutputRaw !== null && BigInt(publicBalanceRaw) <= BigInt(suggestedOutputRaw))
        ? `Insufficient ${details.symbol} balance in Public account.`
        : suggestedOutputRaw === null
          ? 'Unable to load a gas funding amount. Try again.'
          : null
  return Object.freeze({ publicBalanceRaw, suggestedOutputRaw, error })
}

export async function loadEvmGasFundingPreview(
  details: EvmGasFundingDetails,
  scope: { readonly walletId: string; readonly accountId: string }
): Promise<EvmGasFundingPreview> {
  const [portfolio, price] = await Promise.allSettled([
    evmWalletClient.getPortfolio('refresh', { chainIds: [details.chainId] }),
    (async () => {
      const cached = await assetPriceClient.getPrices('read', details.nativeAssetId)
      const quote = findAssetPrice(cached, details.nativeAssetId)
      if (quote?.freshness === 'fresh') return quote.priceUsd
      const refreshed = await assetPriceClient.getPrices('refresh', details.nativeAssetId)
      const refreshedQuote = findAssetPrice(refreshed, details.nativeAssetId)
      return refreshedQuote?.freshness === 'fresh' ? refreshedQuote.priceUsd : null
    })()
  ])
  return resolveEvmGasFundingPreview({
    details,
    ...scope,
    portfolio: portfolio.status === 'fulfilled' ? portfolio.value : null,
    nativePriceUsd: price.status === 'fulfilled' ? price.value : null
  })
}
