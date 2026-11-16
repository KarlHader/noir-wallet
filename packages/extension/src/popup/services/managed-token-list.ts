import type { DetectedEvmAssetRecord, UserEvmAssetRecord } from '@/core/chains/user-assets'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'

type ManagedTokenSource = 'bundled' | 'intents' | 'detected' | 'custom'

export interface ManagedTokenRow {
  readonly assetId: string
  readonly chainId: string
  readonly reference: string
  readonly blockchain?: string
  readonly metadata: Readonly<{
    readonly name: string
    readonly symbol: string
    readonly decimals: number
    readonly iconUrl?: string
  }>
  readonly source: ManagedTokenSource
  readonly catalogAsset?: IntentsManagedAsset
  readonly removableAsset?: UserEvmAssetRecord
  readonly registered: boolean
}

interface ManagedTokenNetwork {
  readonly chainId: string
  readonly iconChain: string
  readonly usdcContract?: string
}

const TOKEN_ORDER = ['USDC', 'USDT'] as const

export function buildManagedTokenRows(input: {
  readonly networks: readonly ManagedTokenNetwork[]
  readonly userAssets: readonly UserEvmAssetRecord[]
  readonly detectedAssets: readonly DetectedEvmAssetRecord[]
  readonly catalogAssets: readonly IntentsManagedAsset[]
  readonly protocolAssetIds: ReadonlySet<string>
}): readonly ManagedTokenRow[] {
  const networkByChainId = new Map(input.networks.map(network => [network.chainId, network]))
  const bundled: ManagedTokenRow[] = input.networks.flatMap(network =>
    network.usdcContract
      ? [
          {
            assetId: `${network.chainId}/erc20:${network.usdcContract.toLowerCase()}`,
            chainId: network.chainId,
            reference: network.usdcContract.toLowerCase(),
            blockchain: network.iconChain,
            metadata: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
            source: 'bundled' as const,
            registered: true
          }
        ]
      : []
  )
  const local: ManagedTokenRow[] = [
    ...bundled,
    ...input.userAssets.map(asset => ({
      assetId: asset.assetId,
      chainId: asset.chainId,
      reference: asset.contractAddress,
      blockchain: networkByChainId.get(asset.chainId)?.iconChain,
      metadata: asset.metadata,
      source: asset.source === 'intents-catalog' ? ('intents' as const) : ('custom' as const),
      ...(asset.source === 'user-added' ? { removableAsset: asset } : {}),
      registered: true
    })),
    ...input.detectedAssets.map(asset => ({
      assetId: asset.assetId,
      chainId: asset.chainId,
      reference: asset.contractAddress,
      blockchain: networkByChainId.get(asset.chainId)?.iconChain,
      metadata: asset.metadata,
      source: 'detected' as const,
      registered: true
    }))
  ]
  const localById = new Map(local.map(asset => [asset.assetId, asset]))
  const rows: ManagedTokenRow[] = input.catalogAssets.map(catalogAsset => {
    const existing = localById.get(catalogAsset.assetId)
    if (existing) localById.delete(catalogAsset.assetId)
    return {
      assetId: catalogAsset.assetId,
      chainId: catalogAsset.chainId,
      reference: catalogAsset.reference,
      blockchain: catalogAsset.blockchain,
      metadata: existing?.metadata ?? {
        name: catalogAsset.symbol,
        symbol: catalogAsset.symbol,
        decimals: catalogAsset.decimals,
        ...(catalogAsset.iconUrl ? { iconUrl: catalogAsset.iconUrl } : {})
      },
      source: existing?.source === 'bundled' ? 'bundled' : 'intents',
      catalogAsset,
      registered:
        (catalogAsset.management === 'protocol' &&
          input.protocolAssetIds.has(catalogAsset.assetId)) ||
        existing !== undefined
    }
  })
  rows.push(...localById.values())
  return Object.freeze(
    rows.sort((left, right) => {
      const leftIndex = TOKEN_ORDER.indexOf(
        left.metadata.symbol.toUpperCase() as (typeof TOKEN_ORDER)[number]
      )
      const rightIndex = TOKEN_ORDER.indexOf(
        right.metadata.symbol.toUpperCase() as (typeof TOKEN_ORDER)[number]
      )
      if (leftIndex !== rightIndex) {
        if (leftIndex === -1) return 1
        if (rightIndex === -1) return -1
        return leftIndex - rightIndex
      }
      const symbol = left.metadata.symbol.localeCompare(right.metadata.symbol, undefined, {
        sensitivity: 'base'
      })
      return symbol || left.chainId.localeCompare(right.chainId)
    })
  )
}

export function filterManagedTokenRows(
  rows: readonly ManagedTokenRow[],
  selectedChainId: string | null,
  searchQuery: string
): readonly ManagedTokenRow[] {
  const query = searchQuery.trim().toLowerCase()
  return rows.filter(asset => {
    if (selectedChainId && asset.chainId !== selectedChainId) return false
    if (!query) return true
    return (
      asset.metadata.symbol.toLowerCase().includes(query) ||
      asset.metadata.name.toLowerCase().includes(query) ||
      asset.reference.toLowerCase() === query
    )
  })
}
