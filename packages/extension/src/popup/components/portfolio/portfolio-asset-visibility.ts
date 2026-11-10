import { getEvmNetworkConfigs } from '@/config/networks'
import type { Network } from '@/types'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'

const ETHEREUM_CHAIN_IDS = new Set<string>(
  (['mainnet', 'testnet'] as const satisfies readonly Network[])
    .flatMap(network => getEvmNetworkConfigs(network))
    .filter(network => network.displayName.startsWith('Ethereum'))
    .map(network => network.chainId)
)

export function isAssetVisibleInAssetView(
  chain: PortfolioChainView['chain'],
  asset: PortfolioAssetView,
  options: { readonly includeZeroBalanceNativeAssets?: boolean } = {}
): boolean {
  if (BigInt(asset.balance.totalRaw) !== 0n) return true
  if (asset.asset.kind !== 'native') return false
  if (options.includeZeroBalanceNativeAssets) return true

  const symbol = asset.metadata.symbol.toUpperCase()
  if (chain.family === 'zcash' && symbol === 'ZEC') return true
  if (chain.family === 'bitcoin' && symbol === 'BTC') return true
  if (chain.family === 'dash' && symbol === 'DASH') return true
  if (chain.family === 'pearl' && symbol === 'PRL') return true
  if (chain.family === 'quantus' && (symbol === 'QTC' || symbol === 'PLK')) return true
  return ETHEREUM_CHAIN_IDS.has(chain.id) && symbol === 'ETH'
}
