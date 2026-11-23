import type { PortfolioAssetView } from '@/core/portfolio'

export type EvmQuoteAssetExecutionMode = 'main' | 'private'

export interface EvmQuoteAssetExecutionSource {
  readonly asset: PortfolioAssetView
  readonly networkFeeAsset: PortfolioAssetView
  readonly refundAddress: string
}

function selectEvmBalance(
  asset: PortfolioAssetView,
  mode: EvmQuoteAssetExecutionMode,
  publicOnly: boolean
): PortfolioAssetView | null {
  const selectedRaw =
    mode === 'private'
      ? (asset.balance.privateOnchainRaw ?? asset.balance.privateRaw)
      : (asset.balance.mainRaw ?? (publicOnly ? asset.balance.availableRaw : undefined))
  if (selectedRaw === undefined) return null
  return Object.freeze({
    ...asset,
    balance: Object.freeze({
      ...asset.balance,
      totalRaw: selectedRaw,
      spendableRaw: selectedRaw,
      availableRaw: selectedRaw
    })
  })
}

export function selectEvmQuoteAssetExecution<T extends EvmQuoteAssetExecutionSource>(
  source: T,
  mode: EvmQuoteAssetExecutionMode,
  privateExecutionAddress?: string,
  publicOnly = false
): T | null {
  const asset = selectEvmBalance(source.asset, mode, publicOnly)
  const networkFeeAsset = selectEvmBalance(source.networkFeeAsset, mode, publicOnly)
  if (!asset || !networkFeeAsset) return null
  let refundAddress = source.refundAddress
  if (mode === 'private') {
    if (
      !privateExecutionAddress ||
      !/^0x[0-9a-fA-F]{40}$/.test(privateExecutionAddress) ||
      privateExecutionAddress.toLowerCase() === source.refundAddress.toLowerCase()
    ) {
      return null
    }
    refundAddress = privateExecutionAddress
  }
  return Object.freeze({
    ...source,
    asset,
    networkFeeAsset,
    refundAddress
  })
}
