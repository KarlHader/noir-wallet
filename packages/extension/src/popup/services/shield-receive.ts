import { getZcashChainId, type ChainDefinition } from '@/core/chains/registry'
import type { PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { resolveSwapTokenIconUrl, type SwapToken } from '@/core/services/intents-api'
import { ZEC_DECIMALS } from '@/config/wallet'
import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { Network } from '@/types/wallet'
import type { AccountNetworksView } from './account-networks-client'
import { getAssetDomainRaw, type ShieldProvider } from './asset-domains'
import { getShieldTransferChainIds } from './shield-transfer'
import { listDepositTokenChoices } from './shield-deposit-options'
import { listExternalShieldReceiveAssets } from './shield-deposit-route'
import { parseTokenBalanceDecimal } from './token-balance-format'
import { sortTokenPickerRows } from './token-selector-visibility'
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
  readonly contractAddress?: string
  readonly iconUrl?: string
  readonly subtitle?: string
  readonly routes: readonly ShieldReceiveRoute[]
}

export function canReceiveNearShield(network: Network, account: AccountNetworksView): boolean {
  return getShieldTransferChainIds(account, network === 'mainnet').length > 0
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
      contractAddress: choice.token.contractAddress || undefined,
      iconUrl: resolveSwapTokenIconUrl(choice.token),
      subtitle: choice.distinguish
        ? choice.token.contractAddress || choice.token.name
        : choice.token.name !== choice.token.symbol
          ? choice.token.name
          : undefined,
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
  return [{ id: 'native-zec', symbol: 'ZEC', name: 'Zcash', routes: [native] }, ...tokens]
}

export function sortShieldReceiveTokens(
  tokens: readonly ShieldReceiveToken[],
  model: PortfolioReadModel | null,
  prices: AssetPriceReadModel | null
): readonly ShieldReceiveToken[] {
  const nativeAssets = new Map<string, PortfolioReadModel['assets'][number]>(
    model?.assets.map(asset => [asset.asset.id, asset])
  )
  const confidential = model?.confidential?.status === 'ready' ? model.confidential.assets : null
  const nearAssets = new Map(confidential?.map(asset => [asset.protocolAssetId, asset]))
  const rows = tokens.map(token => {
    let amount: Big | null = null
    let fiat = new Big(0)
    let missingPrice = false
    const seen = new Set<string>()
    for (const route of token.routes) {
      const catalogAsset = route.provider === 'near-confidential' ? route.asset.token : null
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
      if (raw === null) continue
      const quantity = new Big(
        formatBaseUnitDecimalAmount(raw, catalogAsset?.decimals ?? ZEC_DECIMALS)
      )
      amount = (amount ?? new Big(0)).plus(quantity)
      if (price) fiat = fiat.plus(quantity.times(price))
      else if (quantity.gt(0)) missingPrice = true
    }

    return {
      token,
      balance: {
        symbol: token.symbol,
        pinned: token.id === 'native-zec',
        isNative: token.routes.some(route => route.assetId.startsWith(`${route.chain.id}/slip44:`)),
        amount: amount?.toFixed() ?? '—',
        decimals:
          token.routes.find(route => route.provider === 'near-confidential')?.asset.token
            .decimals ?? ZEC_DECIMALS,
        valueUsd: missingPrice ? null : fiat.toFixed()
      }
    }
  })
  return sortTokenPickerRows(rows, row => row.balance, 'grouped').map(row => row.token)
}

export function resolveShieldReceiveSelection(
  tokens: readonly ShieldReceiveToken[],
  selection: Readonly<{ tokenId: string | null; routeId: string | null }> | null,
  entry: Readonly<{ assetId: string | null; provider: ShieldProvider | null }>,
  autoSelect: boolean
) {
  if (!selection && !entry.assetId && !entry.provider) return { token: null, route: null }
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
