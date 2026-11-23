import Big from '@/lib/big'
import type {
  PortfolioAssetView,
  PortfolioReadModel,
  ConfidentialPortfolioView
} from '@/core/portfolio'
import type { AssetRegistry, AssetRegistryEntry } from '@/core/chains/registry'
import { getZcashChainId } from '@/core/chains/registry'
import { nearConfidentialPortfolioAssetId } from '@/core/chains/near/near-portfolio-assets'
import type { SwapToken } from '@/core/services/intents-api'
import { isDeprecatedIntentsToken } from '@/core/services/intents-evm-assets'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { Network } from '@/types'

export interface ConfidentialPortfolioBalance {
  readonly tokenId: string
  readonly available: string
}

export interface ConfidentialPortfolioAssetMapping {
  readonly assetId: string
  readonly protocolAssetId: string
}

export function filterConfidentialPortfolioMappings(
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  network: Network
): readonly ConfidentialPortfolioAssetMapping[] {
  const zcashAssetId = `${getZcashChainId(network)}/slip44:133`
  return mappings.filter(
    mapping => mapping.assetId.startsWith('eip155:') || mapping.assetId === zcashAssetId
  )
}

// Mainnet uses this shared treasury namespace; arbitrary IMT suffix matches are not equivalent assets.
// https://docs.near-intents.org/integration/market-makers/confidential-intents
export const CONFIDENTIAL_PRIVATE_TREASURY_ACCOUNT_ID =
  '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'

export function confidentialPrivateTokenId(protocolAssetId: string): string {
  return `imt:${CONFIDENTIAL_PRIVATE_TREASURY_ACCOUNT_ID}:${protocolAssetId}`
}

function confidentialProtocolAssetId(tokenId: string): string | null {
  const treasuryPrefix = `imt:${CONFIDENTIAL_PRIVATE_TREASURY_ACCOUNT_ID}:`
  if (!tokenId.startsWith(treasuryPrefix)) return tokenId || null
  const protocolAssetId = tokenId.slice(treasuryPrefix.length)
  return protocolAssetId || null
}

function lookupConfidentialAsset(
  assets: AssetRegistry,
  assetId: string
): AssetRegistryEntry | undefined {
  const entry = typeof assets.inspect === 'function' ? assets.inspect(assetId) : assets.get(assetId)
  return entry && entry.verification !== 'blocked' ? entry : undefined
}

function withNearConfidentialMappings(
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  protocolAssetIds: readonly string[],
  hasAsset: (assetId: string) => boolean
): readonly ConfidentialPortfolioAssetMapping[] {
  const usedProtocolIds = new Set(mappings.map(mapping => mapping.protocolAssetId))
  const usedAssetIds = new Set(mappings.map(mapping => mapping.assetId))
  const extra: ConfidentialPortfolioAssetMapping[] = []
  for (const protocolAssetId of protocolAssetIds) {
    if (usedProtocolIds.has(protocolAssetId)) continue
    const assetId = nearConfidentialPortfolioAssetId(protocolAssetId)
    if (!assetId || usedAssetIds.has(assetId) || !hasAsset(assetId)) continue
    usedProtocolIds.add(protocolAssetId)
    usedAssetIds.add(assetId)
    extra.push(Object.freeze({ assetId, protocolAssetId }))
  }
  return extra.length === 0 ? mappings : Object.freeze([...mappings, ...extra])
}

export function getConfidentialAvailableForAsset(
  balances: readonly ConfidentialPortfolioBalance[],
  protocolAssetId: string
): string | null {
  const row =
    balances.find(balance => balance.tokenId === confidentialPrivateTokenId(protocolAssetId)) ??
    balances.find(balance => balance.tokenId === protocolAssetId)
  return row && /^(0|[1-9][0-9]*)$/.test(row.available) ? row.available : null
}

export function buildConfidentialPortfolioView(
  balances: readonly ConfidentialPortfolioBalance[],
  tokens: readonly SwapToken[],
  managedAssets: readonly IntentsManagedAsset[],
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  assets: AssetRegistry
): ConfidentialPortfolioView {
  const treasuryPrefix = `imt:${CONFIDENTIAL_PRIVATE_TREASURY_ACCOUNT_ID}:`
  const byProtocolId = new Map<
    string,
    { balance: ConfidentialPortfolioBalance; priority: number }
  >()
  for (const balance of balances) {
    if (!/^(0|[1-9][0-9]*)$/.test(balance.available)) {
      throw new Error('Invalid Confidential balance')
    }
    const verifiedImt = balance.tokenId.startsWith(treasuryPrefix)
    const protocolAssetId = verifiedImt
      ? balance.tokenId.slice(treasuryPrefix.length)
      : balance.tokenId
    if (!protocolAssetId) throw new Error('Invalid Confidential token ID')
    const priority = verifiedImt ? 1 : 0
    const previous = byProtocolId.get(protocolAssetId)
    if (previous && previous.priority === priority) {
      throw new Error('Duplicate Confidential balance')
    }
    if (!previous || priority > previous.priority)
      byProtocolId.set(protocolAssetId, { balance, priority })
  }

  const tokenById = new Map(tokens.map(token => [token.assetId, token]))
  const managedById = new Map(managedAssets.map(asset => [asset.protocolAssetId, asset]))
  const portfolioMappings = withNearConfidentialMappings(
    mappings,
    [...byProtocolId.keys()],
    assetId => lookupConfidentialAsset(assets, assetId) !== undefined
  )
  const mappedById = new Map(
    portfolioMappings.map(mapping => [mapping.protocolAssetId, mapping.assetId])
  )
  const entries = [...byProtocolId].flatMap(([protocolAssetId, { balance }]) => {
    if (balance.available === '0') return []
    const token = tokenById.get(protocolAssetId)
    if (isDeprecatedIntentsToken({ assetId: protocolAssetId, symbol: token?.symbol })) return []
    const managed = managedById.get(protocolAssetId)
    const mappedAssetId = mappedById.get(protocolAssetId)
    const registered = mappedAssetId ? lookupConfidentialAsset(assets, mappedAssetId) : undefined
    const assetId = managed?.assetId ?? registered?.asset.id
    const chainId = managed?.chainId ?? registered?.asset.chainId
    const bundledMetadata =
      token &&
      registered?.source === 'bundled' &&
      assetId === registered.asset.id &&
      token.decimals === registered.metadata.decimals
        ? registered.metadata
        : null
    const iconUrl = token ? (token.icon ?? token.coingeckoIcon ?? undefined) : undefined
    const priceUsd = token && token.price > 0 ? new Big(token.price).toFixed() : undefined
    return [
      Object.freeze({
        tokenId: balance.tokenId,
        protocolAssetId,
        availableRaw: balance.available,
        ...(assetId ? { assetId } : {}),
        ...(chainId ? { chainId } : {}),
        ...(token
          ? {
              blockchain: token.blockchain,
              symbol: bundledMetadata?.symbol ?? token.symbol,
              name: bundledMetadata?.name ?? token.symbol,
              decimals: token.decimals,
              ...(iconUrl ? { iconUrl } : {}),
              ...(token.coingeckoId ? { coingeckoId: token.coingeckoId } : {}),
              ...(priceUsd && priceUsd.length <= 128
                ? {
                    priceUsd,
                    priceUpdatedAt: token.priceUpdatedAt
                  }
                : {})
            }
          : {})
      })
    ]
  })
  return Object.freeze({ status: 'ready', assets: Object.freeze(entries) })
}

function mergeAsset(
  asset: PortfolioAssetView,
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  balances: readonly ConfidentialPortfolioBalance[],
  snapshot?: Readonly<{ freshness: 'fresh' | 'stale'; updatedAt: number }>
): PortfolioAssetView {
  const mapping = mappings.find(candidate => candidate.assetId === asset.asset.id)
  if (!mapping || asset.balance.mainRaw === undefined || asset.balance.privateRaw === undefined) {
    return asset
  }
  const confidentialRaw = isDeprecatedIntentsToken({ assetId: mapping.protocolAssetId })
    ? '0'
    : (getConfidentialAvailableForAsset(balances, mapping.protocolAssetId) ?? '0')
  const previousConfidential = BigInt(asset.balance.confidentialRaw ?? '0')
  const privateOnchain = BigInt(
    asset.balance.privateOnchainRaw ??
      (BigInt(asset.balance.privateRaw) - previousConfidential).toString()
  )
  const nextConfidential = BigInt(confidentialRaw)
  const delta = nextConfidential - previousConfidential
  const addDelta = (raw: string) => (BigInt(raw) + delta).toString()
  return Object.freeze({
    ...asset,
    ...(snapshot?.freshness === 'stale'
      ? {
          freshness: 'stale' as const,
          updatedAt:
            typeof asset.updatedAt === 'number'
              ? Math.min(asset.updatedAt, snapshot.updatedAt)
              : snapshot.updatedAt
        }
      : {}),
    balance: Object.freeze({
      ...asset.balance,
      totalRaw: addDelta(asset.balance.totalRaw),
      privateRaw: (privateOnchain + nextConfidential).toString(),
      privateOnchainRaw: privateOnchain.toString(),
      confidentialRaw: nextConfidential.toString()
    })
  })
}

export function mergeConfidentialBalancesIntoPortfolio(
  model: PortfolioReadModel,
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  balances: readonly ConfidentialPortfolioBalance[],
  snapshot?: Readonly<{ freshness: 'fresh' | 'stale'; updatedAt: number }>
): PortfolioReadModel {
  const portfolioMappings = withNearConfidentialMappings(
    mappings,
    balances.flatMap(balance => {
      const protocolAssetId = confidentialProtocolAssetId(balance.tokenId)
      return protocolAssetId ? [protocolAssetId] : []
    }),
    assetId => model.assets.some(asset => asset.asset.id === assetId)
  )
  const assets = model.assets.map(asset => mergeAsset(asset, portfolioMappings, balances, snapshot))
  const byId = new Map(assets.map(asset => [asset.asset.id, asset]))
  const chains = model.chains.map(chain =>
    Object.freeze({
      ...chain,
      assets: Object.freeze(chain.assets.map(asset => byId.get(asset.asset.id) ?? asset)),
      ...(snapshot?.freshness === 'stale' &&
      chain.status === 'ready' &&
      chain.assets.some(asset => byId.get(asset.asset.id)?.freshness === 'stale')
        ? { status: 'partial' as const }
        : {})
    })
  )
  return Object.freeze({
    ...model,
    assets: Object.freeze(assets),
    chains: Object.freeze(chains),
    ...(snapshot?.freshness === 'stale' &&
    model.status === 'ready' &&
    chains.some(chain => chain.status === 'partial')
      ? { status: 'partial' as const }
      : {})
  })
}

export function projectConfidentialOnlyEvmAssets(
  model: PortfolioReadModel,
  confidential: ConfidentialPortfolioView,
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  assets: AssetRegistry
): PortfolioReadModel {
  if (confidential.status !== 'ready') return model
  const existing = new Set<string>(model.assets.map(asset => asset.asset.id))
  const mappedByProtocolId = new Map(
    mappings.map(mapping => [mapping.protocolAssetId, mapping.assetId])
  )
  const holdingCountByAssetId = new Map<string, number>()
  for (const holding of confidential.assets) {
    if (holding.assetId) {
      holdingCountByAssetId.set(
        holding.assetId,
        (holdingCountByAssetId.get(holding.assetId) ?? 0) + 1
      )
    }
  }
  const projected = confidential.assets.flatMap(holding => {
    const assetId = holding.assetId
    if (
      !assetId ||
      existing.has(assetId) ||
      mappedByProtocolId.get(holding.protocolAssetId) !== assetId ||
      holdingCountByAssetId.get(assetId) !== 1 ||
      !assetId.startsWith('eip155:')
    )
      return []
    const entry = assets.get(assetId)
    const chain = model.chains.find(item => item.chain.id === holding.chainId)
    const chainAccountIds = chain?.assets.find(
      asset => asset.chainAccountIds.length > 0
    )?.chainAccountIds
    if (
      !entry ||
      entry.asset.kind !== 'token' ||
      entry.asset.chainId !== holding.chainId ||
      entry.metadata.decimals !== holding.decimals ||
      !chain ||
      chain.chain.family !== 'evm' ||
      (chain.status !== 'ready' && chain.status !== 'partial') ||
      !chainAccountIds
    )
      return []
    existing.add(assetId)
    return [
      Object.freeze({
        asset: entry.asset,
        metadata: entry.metadata,
        source: entry.source,
        balance: Object.freeze({
          totalRaw: holding.availableRaw,
          spendableRaw: '0',
          availableRaw: '0',
          pendingRaw: '0',
          mainRaw: '0',
          privateRaw: holding.availableRaw,
          privateOnchainRaw: '0',
          confidentialRaw: holding.availableRaw
        }),
        chainAccountIds,
        freshness: confidential.freshness === 'stale' ? ('stale' as const) : ('fresh' as const),
        updatedAt: confidential.updatedAt ?? Date.now()
      }) satisfies PortfolioAssetView
    ]
  })
  if (projected.length === 0) return model
  const chains = model.chains.map(chain =>
    Object.freeze({
      ...chain,
      ...(confidential.freshness === 'stale' &&
      chain.status === 'ready' &&
      projected.some(asset => asset.asset.chainId === chain.chain.id)
        ? { status: 'partial' as const }
        : {}),
      assets: Object.freeze([
        ...chain.assets,
        ...projected.filter(asset => asset.asset.chainId === chain.chain.id)
      ])
    })
  )
  return Object.freeze({
    ...model,
    ...(confidential.freshness === 'stale' && model.status === 'ready'
      ? { status: 'partial' as const }
      : {}),
    chains: Object.freeze(chains),
    assets: Object.freeze(chains.flatMap(chain => chain.assets))
  })
}

export function excludeDeprecatedConfidentialAssets(model: PortfolioReadModel): PortfolioReadModel {
  const confidential = model.confidential
  if (!confidential) return model
  const hidden = confidential.assets.filter(asset =>
    isDeprecatedIntentsToken({ assetId: asset.protocolAssetId, symbol: asset.symbol })
  )
  if (hidden.length === 0) return model
  const visible = confidential.assets.filter(asset => !hidden.includes(asset))
  const hiddenMappings = new Map(
    hidden.flatMap(asset =>
      asset.assetId
        ? [
            [
              asset.assetId,
              {
                assetId: asset.assetId,
                protocolAssetId:
                  visible.find(current => current.assetId === asset.assetId)?.protocolAssetId ??
                  asset.protocolAssetId
              }
            ] as const
          ]
        : []
    )
  )
  // Replace only the projected Shield portion; public and private on-chain balances stay intact.
  const projected = mergeConfidentialBalancesIntoPortfolio(
    model,
    [...hiddenMappings.values()],
    visible.map(asset => ({ tokenId: asset.tokenId, available: asset.availableRaw }))
  )
  return Object.freeze({
    ...projected,
    confidential: Object.freeze({ ...confidential, assets: Object.freeze(visible) })
  })
}
