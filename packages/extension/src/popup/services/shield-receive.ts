import { getZcashChainId, type ChainDefinition } from '@/core/chains/registry'
import { resolveSwapTokenIconUrl, type SwapToken } from '@/core/services/intents-api'
import type { Network } from '@/types/wallet'
import type { AccountNetworksView } from './account-networks-client'
import type { ShieldProvider } from './asset-domains'
import { getPrivateTransferChainIds } from './private-balance-transfer'
import { listDepositTokenChoices } from './shield-deposit-options'
import { listExternalShieldReceiveAssets } from './shield-deposit-route'
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
