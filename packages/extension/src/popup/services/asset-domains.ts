import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { ZCASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import {
  summarizeNearConfidentialHoldings,
  type NearConfidentialSummary
} from './near-confidential-holdings'

export type AssetDomain = 'all' | 'public' | 'shield' | 'private'
export type ShieldProvider = 'near-confidential' | 'zcash-shield'
const ZCASH_CHAIN_ID_SET = new Set<string>(Object.values(ZCASH_CHAIN_IDS))

function completeRawParts(totalRaw: string, parts: readonly (string | undefined)[]): boolean {
  return (
    parts.every(part => part !== undefined) &&
    parts.reduce<bigint>((sum, part) => sum + BigInt(part ?? '0'), 0n) === BigInt(totalRaw)
  )
}

export function getAssetShieldProvider(asset: PortfolioAssetView): ShieldProvider | null {
  if (asset.asset.chainId.startsWith('eip155:')) return 'near-confidential'
  if (ZCASH_CHAIN_ID_SET.has(asset.asset.chainId)) return 'zcash-shield'
  return null
}

export function getAssetDomainRaw(asset: PortfolioAssetView, domain: AssetDomain): string | null {
  const { balance } = asset
  if (domain === 'all') return balance.totalRaw
  if (asset.asset.chainId.startsWith('eip155:')) {
    if (!completeRawParts(balance.totalRaw, [balance.mainRaw, balance.privateRaw])) return null
    if (domain === 'public') return balance.mainRaw ?? null
    const privateOnchain = balance.privateOnchainRaw
    const shield = balance.confidentialRaw
    if (privateOnchain === undefined && shield === undefined) {
      return domain === 'shield' ? '0' : (balance.privateRaw ?? null)
    }
    if (privateOnchain === undefined || shield === undefined) return null
    if (BigInt(privateOnchain) + BigInt(shield) !== BigInt(balance.privateRaw ?? '0')) return null
    return domain === 'shield' ? shield : privateOnchain
  }
  if (ZCASH_CHAIN_ID_SET.has(asset.asset.chainId)) {
    if (!completeRawParts(balance.totalRaw, [balance.transparentRaw, balance.shieldedRaw])) {
      return null
    }
    if (domain === 'public') return balance.transparentRaw ?? null
    return domain === 'shield' ? (balance.shieldedRaw ?? null) : '0'
  }
  return domain === 'public' ? balance.totalRaw : '0'
}

export function selectNearShieldActionAssetId(
  model: PortfolioReadModel,
  from: 'public' | 'shield'
): string | null {
  const chainIds = new Set(
    model.chains
      .filter(
        chain =>
          chain.chain.family === 'evm' &&
          chain.chain.network.kind === 'mainnet' &&
          chain.chain.capabilities.transaction.status === 'available'
      )
      .map(chain => chain.chain.id)
  )
  const assets = model.assets.filter(asset => chainIds.has(asset.asset.chainId))
  return (
    assets.find(asset => BigInt(getAssetDomainRaw(asset, from) ?? '0') > 0n)?.asset.id ??
    assets[0]?.asset.id ??
    null
  )
}

function projectDisplayAsset(asset: PortfolioAssetView, totalRaw: string): PortfolioAssetView {
  return Object.freeze({
    ...asset,
    balance: Object.freeze({ ...asset.balance, totalRaw, pendingRaw: '0' })
  })
}

export function projectPortfolioForDomain(
  model: PortfolioReadModel,
  domain: AssetDomain
): PortfolioReadModel {
  // Display-only: projected totals must never be passed to transaction preparation.
  if (domain === 'all') return model
  const projected = new Map<string, PortfolioAssetView>()
  for (const asset of model.assets) {
    const raw = getAssetDomainRaw(asset, domain)
    if (raw === null || BigInt(raw) === 0n) continue
    projected.set(asset.asset.id, projectDisplayAsset(asset, raw))
  }
  return Object.freeze({
    ...model,
    assets: Object.freeze([...projected.values()]),
    chains: Object.freeze(
      model.chains.map(chain =>
        Object.freeze({
          ...chain,
          assets: Object.freeze(
            chain.assets.flatMap(asset => {
              const view = projected.get(asset.asset.id)
              return view ? [view] : []
            })
          )
        })
      )
    )
  })
}

export interface ShieldProviderGroup {
  readonly id: ShieldProvider
  readonly entries: readonly Readonly<{
    asset: PortfolioAssetView
    chain: PortfolioChainView
  }>[]
  readonly fiat: string | null
}

export function buildShieldProviderGroups(
  model: PortfolioReadModel,
  prices: AssetPriceReadModel | null
): readonly ShieldProviderGroup[] {
  return (['near-confidential', 'zcash-shield'] as const).flatMap(id => {
    const chains = model.chains.filter(chain =>
      id === 'near-confidential'
        ? chain.chain.family === 'evm' && chain.chain.network.kind === 'mainnet'
        : chain.chain.family === 'zcash'
    )
    if (chains.length === 0) return []
    const candidates = chains.flatMap(chain =>
      chain.assets.flatMap(asset =>
        getAssetShieldProvider(asset) === id ? [{ asset, chain }] : []
      )
    )
    const nearBalanceKnown =
      id !== 'near-confidential' ||
      candidates.some(entry => entry.asset.balance.confidentialRaw !== undefined)
    const unknown =
      candidates.length === 0 ||
      !nearBalanceKnown ||
      chains.some(chain => chain.status === 'error') ||
      candidates.some(entry => getAssetDomainRaw(entry.asset, 'shield') === null)
    const projectedEntries = candidates.flatMap(entry => {
      const raw = getAssetDomainRaw(entry.asset, 'shield')
      return raw === null ? [] : [{ ...entry, asset: projectDisplayAsset(entry.asset, raw) }]
    })
    const heldEntries = projectedEntries.filter(entry => BigInt(entry.asset.balance.totalRaw) > 0n)
    const entries =
      heldEntries.length > 0 ? heldEntries : unknown ? [] : projectedEntries.slice(0, 1)
    let fiat: string | null = unknown ? null : '0'
    if (fiat !== null) {
      let total = new Big(0)
      for (const entry of projectedEntries) {
        const raw = entry.asset.balance.totalRaw
        if (BigInt(raw) === 0n) continue
        const quote = findAssetPrice(prices, entry.asset.asset.id)
        if (!quote) {
          fiat = null
          break
        }
        total = total.plus(
          new Big(formatBaseUnitDecimalAmount(raw, entry.asset.metadata.decimals)).times(
            quote.priceUsd
          )
        )
      }
      if (fiat !== null) fiat = total.toFixed()
    }
    return [Object.freeze({ id, entries: Object.freeze(entries), fiat })]
  })
}

export function sumShieldProviderFiat(groups: readonly ShieldProviderGroup[]): string | null {
  if (groups.some(group => group.fiat === null)) return null
  return groups.reduce((sum, group) => sum.plus(group.fiat ?? '0'), new Big(0)).toFixed()
}

export function summarizeKnownShieldFiat(
  near: NearConfidentialSummary | null,
  assetShieldUsd: string | null | undefined
): Readonly<{ usd: string | null; partial: boolean }> {
  const partial = near?.fiat === null || assetShieldUsd === null
  const knownNearUsd =
    near?.entries.reduce(
      (sum, entry) => (entry.fiat === null ? sum : sum.plus(entry.fiat)),
      new Big(0)
    ) ?? new Big(0)
  const knownUsd = knownNearUsd.plus(assetShieldUsd ?? '0')
  return Object.freeze({
    usd: partial && knownUsd.eq(0) ? null : knownUsd.toFixed(),
    partial
  })
}

export interface AssetDomainFiatSummary {
  readonly publicUsd: string
  readonly shieldUsd: string | null
  readonly shieldUsdPartial: boolean
  readonly privateUsd: string
}

export function summarizeAssetDomainsUsd(
  model: PortfolioReadModel,
  prices: AssetPriceReadModel | null
): AssetDomainFiatSummary | null {
  const independentConfidential =
    model.confidential !== undefined ||
    model.chains?.some(
      chain => chain.chain.family === 'evm' && chain.chain.network?.kind === 'mainnet'
    ) === true
  const sums = { public: new Big(0), shield: new Big(0), private: new Big(0) }
  for (const asset of model.assets) {
    const embeddedConfidential =
      independentConfidential && asset.asset.chainId.startsWith('eip155:')
        ? BigInt(asset.balance.confidentialRaw ?? '0')
        : 0n
    if (BigInt(asset.balance.totalRaw) - embeddedConfidential === 0n) continue
    const quote = findAssetPrice(prices, asset.asset.id)
    if (!quote) return null
    for (const domain of ['public', 'shield', 'private'] as const) {
      if (independentConfidential && domain === 'shield' && embeddedConfidential > 0n) continue
      const raw = getAssetDomainRaw(asset, domain)
      if (raw === null) return null
      sums[domain] = sums[domain].plus(
        new Big(formatBaseUnitDecimalAmount(raw, asset.metadata.decimals)).times(quote.priceUsd)
      )
    }
  }
  const confidential = independentConfidential
    ? summarizeNearConfidentialHoldings(model, prices)
    : null
  const shield = summarizeKnownShieldFiat(confidential, sums.shield.toFixed())
  return Object.freeze({
    publicUsd: sums.public.toFixed(),
    shieldUsd: shield.usd,
    shieldUsdPartial: shield.partial,
    privateUsd: sums.private.toFixed()
  })
}
