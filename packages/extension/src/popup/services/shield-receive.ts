import { getZcashChainId, type ChainDefinition } from '@/core/chains/registry'
import type { PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { resolveSwapTokenIconUrl, type SwapToken } from '@/core/services/intents-api'
import { ZEC_DECIMALS } from '@/config/wallet'
import Big from '@/lib/big'
import { formatChainIconUrl } from '@/lib/chain-icon'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { Network } from '@/types/wallet'
import type { AccountNetworksView } from './account-networks-client'
import { getAssetDomainRaw, type ShieldProvider } from './asset-domains'
import { comparePortfolioSymbolOrder, MAINNET_STARTER_ASSET_RANKS } from './portfolio-presentation'
import { getPrivateTransferChainIds } from './private-balance-transfer'
import { sortSendAssetsByBalanceValue } from './send-asset-order'
import { listDepositTokenChoices } from './shield-deposit-options'
import { listExternalShieldReceiveAssets } from './shield-deposit-route'
import type { ShieldTokenPickerItem } from './shield-transfer'
import { parseTokenBalanceDecimal } from './token-balance-format'
import { getConfidentialZcashTransferRecipients } from './zcash-self-transfer'

type ExternalAsset = ReturnType<typeof listExternalShieldReceiveAssets>[number]

export type ShieldReceiveRoute = Readonly<{
  id: string
  assetId: string
  chain: ChainDefinition
}> &
  (
    | Readonly<{ provider: 'zcash-shield'; address: string }>
    | Readonly<{ provider: 'near-confidential'; asset: ExternalAsset }>
  )

export interface ShieldReceiveToken {
  readonly id: string
  readonly symbol: string
  readonly name?: string
  readonly iconUrl?: string
  readonly subtitle?: string
  readonly routes: readonly ShieldReceiveRoute[]
}

export function canReceiveNearShield(network: Network, account: AccountNetworksView): boolean {
  return getPrivateTransferChainIds(account, network === 'mainnet').length > 0
}

export function listShieldReceiveTokens(
  network: Network,
  account: AccountNetworksView,
  catalog: readonly SwapToken[]
): readonly ShieldReceiveToken[] {
  const external = canReceiveNearShield(network, account)
    ? listExternalShieldReceiveAssets(network, catalog, account.networks)
    : []
  const byProtocolId = new Map(external.map(asset => [asset.token.assetId, asset]))
  const tokens = listDepositTokenChoices([...byProtocolId.values()].map(asset => asset.token)).map(
    (choice): ShieldReceiveToken => ({
      id: choice.id,
      symbol: choice.token.symbol,
      name: choice.token.name,
      iconUrl: resolveSwapTokenIconUrl(choice.token),
      subtitle: choice.distinguish
        ? [byProtocolId.get(choice.token.assetId)?.chain.displayName, choice.token.contractAddress]
            .filter(Boolean)
            .join(' · ')
        : choice.token.name,
      routes: choice.assetIds.flatMap(protocolId => {
        const asset = byProtocolId.get(protocolId)
        return asset
          ? [
              {
                id: `near-confidential:${protocolId}`,
                assetId: asset.assetId,
                chain: asset.chain,
                provider: 'near-confidential',
                asset
              }
            ]
          : []
      })
    })
  )

  const zcashChainId = getZcashChainId(network)
  const chain = account.networks.find(item => item.chain.id === zcashChainId)?.chain
  const address = getConfidentialZcashTransferRecipients(account, network).find(
    item => item.privacy === 'shielded'
  )?.address
  if (!chain || !address) return tokens

  const assetId = `${zcashChainId}/slip44:133`
  const native: ShieldReceiveRoute = {
    id: 'zcash-shield',
    assetId,
    chain,
    provider: 'zcash-shield',
    address
  }
  const zecIndex = tokens.findIndex(token => token.routes.some(route => route.assetId === assetId))
  if (zecIndex >= 0) {
    const token = tokens[zecIndex]!
    tokens.splice(zecIndex, 1)
    return [{ ...token, id: 'native-zec', routes: [native, ...token.routes] }, ...tokens]
  }
  return [{ id: 'native-zec', symbol: 'ZEC', subtitle: 'Zcash', routes: [native] }, ...tokens]
}

export function buildShieldReceivePickerRows(
  tokens: readonly ShieldReceiveToken[],
  model: PortfolioReadModel | null,
  prices: AssetPriceReadModel | null
): readonly ShieldTokenPickerItem[] {
  const nativeAssets = new Map<string, PortfolioReadModel['assets'][number]>(
    model?.assets.map(asset => [asset.asset.id, asset])
  )
  const confidential = model?.confidential?.status === 'ready' ? model.confidential.assets : null
  const nearAssets = new Map(confidential?.map(asset => [asset.protocolAssetId, asset]))
  const rows = tokens.flatMap(token => {
    const firstRoute = token.routes[0]
    if (!firstRoute) return []

    let starterRank = Infinity
    let amount: Big | null = null
    let fiat = new Big(0)
    let missingPrice = false
    let firstPrice: Big | null = null
    const searchTerms = new Set<string>()
    const seen = new Set<string>()
    for (const route of token.routes) {
      starterRank = Math.min(
        starterRank,
        MAINNET_STARTER_ASSET_RANKS.get(route.assetId) ?? Infinity
      )
      searchTerms.add(route.chain.displayName)
      const catalogAsset = route.provider === 'near-confidential' ? route.asset.token : null
      if (catalogAsset?.contractAddress) searchTerms.add(catalogAsset.contractAddress)
      const balanceKey = catalogAsset?.assetId ?? route.id
      if (seen.has(balanceKey)) continue
      seen.add(balanceKey)

      const holding = catalogAsset ? nearAssets.get(catalogAsset.assetId) : undefined
      if (holding?.decimals !== undefined && holding.decimals !== catalogAsset?.decimals) continue
      const native = catalogAsset ? undefined : nativeAssets.get(route.assetId)
      const raw = catalogAsset
        ? (holding?.availableRaw ?? (confidential ? '0' : null))
        : native
          ? getAssetDomainRaw(native, 'shield')
          : null
      const price =
        [findAssetPrice(prices, route.assetId)?.priceUsd, holding?.priceUsd, catalogAsset?.price]
          .map(parseTokenBalanceDecimal)
          .find(value => value?.gt(0)) ?? null
      firstPrice ??= price
      if (raw === null) continue
      const quantity = new Big(
        formatBaseUnitDecimalAmount(raw, catalogAsset?.decimals ?? ZEC_DECIMALS)
      )
      amount = (amount ?? new Big(0)).plus(quantity)
      if (price) fiat = fiat.plus(quantity.times(price))
      else if (quantity.gt(0)) missingPrice = true
    }

    const displayBalance = amount?.toFixed() ?? '—'
    return [
      {
        key: token.id,
        assetId: firstRoute.assetId,
        symbol: token.symbol,
        name: token.name,
        subtitle: token.subtitle,
        iconUrl:
          firstRoute.provider === 'zcash-shield' ? formatChainIconUrl('zcash') : token.iconUrl,
        chainId: firstRoute.chain.id,
        chainName: firstRoute.chain.displayName,
        searchTerms: [...searchTerms],
        decimals:
          firstRoute.provider === 'zcash-shield' ? ZEC_DECIMALS : firstRoute.asset.token.decimals,
        displayBalance,
        amount: amount?.toFixed() ?? null,
        priceUsd: amount?.gt(0)
          ? missingPrice
            ? null
            : fiat.div(amount).toFixed()
          : (firstPrice?.toFixed() ?? null),
        starterRank
      }
    ]
  })

  rows.sort(
    (left, right) =>
      (left.starterRank === right.starterRank ? 0 : left.starterRank - right.starterRank) ||
      comparePortfolioSymbolOrder(left.symbol, right.symbol)
  )
  return sortSendAssetsByBalanceValue(rows)
}

export function resolveShieldReceiveSelection(
  tokens: readonly ShieldReceiveToken[],
  selection: Readonly<{ tokenId: string | null; routeId: string | null }> | null,
  entry: Readonly<{ assetId: string | null; provider: ShieldProvider | null }>,
  autoSelect: boolean
) {
  if (!selection && !entry.assetId && !entry.provider) {
    const token =
      tokens.find(item => item.id === 'native-zec') ??
      (autoSelect && tokens.length === 1 ? tokens[0] : null)
    return { token: token ?? null, route: null }
  }
  const exact = entry.assetId
    ? tokens.find(token => token.routes.some(route => route.assetId === entry.assetId))
    : null
  const initial = exact ?? (entry.assetId || !autoSelect || tokens.length !== 1 ? null : tokens[0])
  const token = selection ? tokens.find(token => token.id === selection.tokenId) : initial
  if (!token) return { token: null, route: null }

  const candidates = selection
    ? token.routes
    : token.routes.filter(
        route =>
          (!entry.assetId || route.assetId === entry.assetId) &&
          (!entry.provider || route.provider === entry.provider)
      )
  if (selection?.routeId) {
    return { token, route: candidates.find(route => route.id === selection.routeId) ?? null }
  }
  if (new Set(candidates.map(route => route.chain.id)).size !== 1) return { token, route: null }
  const native = candidates.find(route => route.provider === 'zcash-shield')
  return {
    token,
    route: native ?? (autoSelect && candidates.length === 1 ? candidates[0] : null) ?? null
  }
}
