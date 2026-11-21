import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { SwapToken } from '@/core/services/intents-api'
import { getConfidentialAvailableForAsset } from '@/core/services/confidential-funding'
import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { Network } from '@/types'
import { getTransferDomainBalanceRaw, type TransferDomain } from './private-balance-transfer'
import { resolveShieldManagedAsset } from './shield-transfer'
import { getCrossChainSendAssetGroup } from './cross-chain-send-assets'
import { toWalletEvmQuoteToken } from './token-address-discovery'

type BalanceTransferAsset = Readonly<{ asset: PortfolioAssetView; chain: PortfolioChainView }>
type ShieldBalance = Readonly<{ tokenId: string; available: string }>

type BalanceTransferAssetPickerRow = BalanceTransferAsset &
  Readonly<{ sourceRaw: string; valueUsd: string | null }>

export function listTransferSameChainDestinationAssets(input: {
  readonly source: BalanceTransferAsset
  readonly assets: readonly BalanceTransferAsset[]
  readonly from: TransferDomain
  readonly eligibleChainIds: readonly string[]
  readonly destinationChainIds: readonly string[]
  readonly managedAssets: readonly IntentsManagedAsset[]
  readonly catalogTokens: readonly SwapToken[]
  readonly network: Network
}): readonly BalanceTransferAsset[] {
  const sourceGroup = getCrossChainSendAssetGroup(input.source.asset.asset)
  const eligible = new Set(input.eligibleChainIds)
  const destinations = new Set(input.destinationChainIds)
  return [
    input.source,
    ...input.assets.filter(item => item.asset.asset.id !== input.source.asset.asset.id)
  ].filter(item => {
    if (
      item.chain.chain.family !== 'evm' ||
      item.chain.chain.capabilities.transaction.status !== 'available' ||
      !eligible.has(item.chain.chain.id) ||
      !destinations.has(item.chain.chain.id) ||
      getTransferDomainBalanceRaw(item.asset, input.from) === null ||
      (!toWalletEvmQuoteToken(item.asset) &&
        !resolveShieldManagedAsset(
          item.asset,
          input.managedAssets,
          input.catalogTokens,
          input.network
        ))
    )
      return false
    if (item.asset.asset.id === input.source.asset.asset.id) return true
    return (
      sourceGroup !== null &&
      sourceGroup === getCrossChainSendAssetGroup(item.asset.asset) &&
      item.asset.asset.kind === input.source.asset.asset.kind
    )
  })
}

export function listBalanceTransferAssetPickerRows(input: {
  readonly assets: readonly BalanceTransferAsset[]
  readonly includeEmpty?: boolean
  readonly from: TransferDomain
  readonly network: Network
  readonly prices: AssetPriceReadModel | null
  readonly portfolio: PortfolioReadModel | null
  readonly shieldBalances: readonly ShieldBalance[] | null
  readonly managedAssets: readonly IntentsManagedAsset[]
  readonly catalogTokens: readonly SwapToken[]
}): readonly BalanceTransferAssetPickerRow[] {
  const rows = input.assets.flatMap(item => {
    const managed =
      input.from === 'shield'
        ? resolveShieldManagedAsset(
            item.asset,
            input.managedAssets,
            input.catalogTokens,
            input.network
          )
        : null
    const sourceRaw =
      input.from === 'shield'
        ? managed && input.shieldBalances
          ? getConfidentialAvailableForAsset(input.shieldBalances, managed.protocolAssetId)
          : null
        : getTransferDomainBalanceRaw(item.asset, input.from)
    if (sourceRaw === null || (!input.includeEmpty && BigInt(sourceRaw) === 0n)) return []

    const priceUsd =
      findAssetPrice(input.prices, item.asset.asset.id)?.priceUsd ??
      (managed
        ? input.portfolio?.confidential?.assets.find(
            holding => holding.protocolAssetId === managed.protocolAssetId
          )?.priceUsd
        : undefined)
    const valueUsd = priceUsd
      ? new Big(formatBaseUnitDecimalAmount(sourceRaw, item.asset.metadata.decimals))
          .times(priceUsd)
          .toFixed()
      : null
    return [{ ...item, sourceRaw, valueUsd }]
  })
  return rows.sort((left, right) => {
    if (left.valueUsd === null) return right.valueUsd === null ? 0 : 1
    if (right.valueUsd === null) return -1
    return new Big(right.valueUsd).cmp(left.valueUsd)
  })
}
