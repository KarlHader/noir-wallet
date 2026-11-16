import type { PortfolioAssetView } from '@/core/portfolio'
import { findBundledWalletMarketAssetId } from '@/popup/components/tokens/token-display-policy'
import type { NearConfidentialHolding } from './near-confidential-holdings'

export interface ShieldVaultNearIconEntry {
  readonly key: string
  readonly assetId?: string
  readonly symbol: string
  readonly icon?: string
}

export interface ShieldVaultZcashIconEntry {
  readonly key: string
  readonly assetId: string
  readonly symbol: string
  readonly icon?: string
}

function normalizeIconUrl(iconUrl: string | undefined): string | null {
  const trimmed = iconUrl?.trim()
  if (!trimmed) return null
  return trimmed.toLowerCase()
}

/** Deduplicate icons by provider market identity before URL and asset fallbacks. */
export function nearConfidentialVaultIconKey(entry: NearConfidentialHolding): string {
  const coingeckoId = entry.asset.coingeckoId?.toLowerCase()
  if (coingeckoId && !coingeckoId.startsWith('custom:')) return `coingecko:${coingeckoId}`
  const assetId = entry.asset.assetId ?? entry.asset.protocolAssetId
  const marketAssetId = assetId ? findBundledWalletMarketAssetId(assetId) : null
  if (marketAssetId) return `market:${marketAssetId}`
  const icon = normalizeIconUrl(entry.asset.iconUrl)
  if (icon) return `icon:${icon}`
  if (assetId) return `asset:${assetId}`
  return `token:${entry.asset.tokenId}`
}

export function zcashShieldVaultIconKey(asset: PortfolioAssetView): string {
  const icon = normalizeIconUrl(asset.metadata.iconUrl)
  if (icon?.startsWith('https://')) return `icon:${icon}`
  return `asset:${asset.asset.id}`
}

export function dedupeStableFirst<T>(
  entries: readonly T[],
  keyOf: (entry: T) => string,
  limit = 4
): readonly T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const entry of entries) {
    const key = keyOf(entry)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(entry)
    if (kept.length >= limit) break
  }
  return Object.freeze(kept)
}

export function nearConfidentialVaultIcons(
  entries: readonly NearConfidentialHolding[],
  limit = 4
): readonly ShieldVaultNearIconEntry[] {
  return dedupeStableFirst(entries, nearConfidentialVaultIconKey, limit).map(entry =>
    Object.freeze({
      key: nearConfidentialVaultIconKey(entry),
      assetId: entry.asset.assetId ?? entry.asset.protocolAssetId,
      symbol: entry.asset.symbol ?? '?',
      icon: entry.asset.iconUrl
    })
  )
}

export function zcashShieldVaultIcons(
  assets: readonly PortfolioAssetView[],
  limit = 4
): readonly ShieldVaultZcashIconEntry[] {
  return dedupeStableFirst(assets, zcashShieldVaultIconKey, limit).map(asset =>
    Object.freeze({
      key: zcashShieldVaultIconKey(asset),
      assetId: asset.asset.id,
      symbol: asset.metadata.symbol,
      icon: asset.metadata.iconUrl
    })
  )
}
