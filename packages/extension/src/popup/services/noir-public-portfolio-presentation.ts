import { ZCASH_CHAIN_FEATURE_FLAG } from '@/config/multichain-feature-flags'
import { formatNativeTokenIconUrl } from '@/config/icons'
import { defineChain, parseAssetId } from '@/core/chains/registry'
import type { PortfolioAssetView, PortfolioReadModel, PortfolioScope } from '@/core/portfolio'
import type { NoirPublicAssets } from '@/core/services/noir-protocol/public/types'
import zecIcon from '@/images/zec.svg'
import { formatSymbol } from '@/lib/format'

export function publicTokenIcon(tokenId: string): string | undefined {
  if (tokenId === 'zec.omft.near') return zecIcon
  if (tokenId === 'wrap.near') return formatNativeTokenIconUrl('near')
  return undefined
}

export function appendPublicPortfolio(
  model: PortfolioReadModel | null,
  result: NoirPublicAssets | null,
  scope: PortfolioScope | null
): PortfolioReadModel | null {
  if (!scope || result?.account.status !== 'active') return model
  const chainId = `noir:${result.account.network}`
  // This view does not advertise native send capabilities. Public actions stay
  // in their dedicated approval and execution flow.
  const chain = defineChain({
    id: chainId,
    family: 'zcash',
    network: { kind: result.account.network, name: result.account.network },
    displayName: 'Zcash',
    featureFlag: ZCASH_CHAIN_FEATURE_FLAG,
    capabilities: {
      address: {
        status: 'unsupported',
        addressSchemes: [],
        derivationSchemes: [],
        supportsRotation: false,
        supportsChange: false
      },
      signing: { status: 'unsupported', transactionFormats: [], messageFormats: [] },
      transaction: { status: 'unsupported', model: 'account', actions: [] }
    }
  })
  const assets: PortfolioAssetView[] = result.assets.flatMap(asset => {
    if (asset.balanceRaw === null) return []
    const parsed = parseAssetId(`${chainId}/nep141:${asset.tokenId}`)
    return [
      {
        asset: { ...parsed, kind: 'token' as const },
        metadata: {
          name: asset.name,
          symbol: formatSymbol(asset.symbol),
          decimals: asset.decimals,
          iconUrl: publicTokenIcon(asset.tokenId)
        },
        source: 'protocol' as const,
        balance: {
          totalRaw: asset.balanceRaw,
          availableRaw: asset.balanceRaw,
          spendableRaw: asset.balanceRaw,
          pendingRaw: '0'
        },
        chainAccountIds: [],
        freshness: asset.status === 'fresh' ? ('fresh' as const) : ('stale' as const),
        updatedAt: asset.updatedAt ?? 0
      }
    ]
  })
  const fresh = result.assets.every(asset => asset.status === 'fresh')
  const retained =
    model?.scope.keyDomainId === scope.keyDomainId && model.scope.accountId === scope.accountId
      ? model
      : null
  const chains = [
    ...(retained?.chains.filter(item => item.chain.id !== chain.id) ?? []),
    {
      chain,
      assets,
      status: fresh
        ? ('ready' as const)
        : assets.length
          ? ('partial' as const)
          : ('error' as const),
      errorCodes: fresh ? [] : ['network-unavailable' as const]
    }
  ]
  return {
    scope,
    status: chains.every(item => item.status === 'ready') ? 'ready' : 'partial',
    chains,
    assets: chains.flatMap(item => item.assets),
    ignoredAssetCount: retained?.ignoredAssetCount ?? 0
  }
}
