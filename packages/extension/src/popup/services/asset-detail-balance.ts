import Big from '@/lib/big'
import { excludeDeprecatedConfidentialAssets } from '@/core/services/confidential-funding/confidential-funding-portfolio'
import type { PortfolioAssetView, PortfolioBalanceView, PortfolioReadModel } from '@/core/portfolio'
import {
  getBundledInitialProductAssetDefinitions,
  getZcashChainId,
  parseAssetId
} from '@/core/chains/registry'
import { formatBaseUnitDecimalAmount, parseDisplayUnitAmount } from '@/lib/number-format'
import type { Network, ZcashBalance } from '@/types'
import { formatDisplayTokenAmount } from '@/popup/services/portfolio-format'
import {
  domainBalanceFamily,
  selectAssetDetailDomainRaw,
  selectAssetDetailDomains
} from '@/core/portfolio/domain-balance-policy'
import { type AssetDomain } from '@/popup/services/asset-domains'

export function getNativeZcashDetailFallback(
  network: Network,
  assetId: string,
  cachedBalance: ZcashBalance | null
): PortfolioAssetView | null {
  if (assetId !== `${getZcashChainId(network)}/slip44:133`) return null
  const definition = getBundledInitialProductAssetDefinitions(network).find(
    item => item.chainId === getZcashChainId(network) && item.kind === 'native'
  )
  if (!definition) return null
  const raw = (value: string | undefined) => parseDisplayUnitAmount(value ?? '0', 8)
  return {
    asset: { ...parseAssetId(assetId), kind: definition.kind },
    metadata: definition.metadata,
    source: definition.source,
    chainAccountIds: [],
    freshness: 'stale',
    updatedAt: 0,
    balance: {
      totalRaw: raw(cachedBalance?.total),
      availableRaw: raw(
        cachedBalance?.available ?? cachedBalance?.spendable ?? cachedBalance?.shielded
      ),
      spendableRaw: raw(cachedBalance?.spendable ?? cachedBalance?.shielded),
      pendingRaw: raw(cachedBalance?.pending?.total),
      shieldedRaw: raw(cachedBalance?.shielded),
      transparentRaw: raw(cachedBalance?.transparent),
      shieldedPendingRaw: raw(cachedBalance?.pending?.shielded),
      transparentPendingRaw: raw(cachedBalance?.pending?.transparent)
    }
  }
}

export function sumZcashDetailBalanceRaw(
  nativeRaw: string | null,
  confidentialRaw: string | null
): string | null {
  return nativeRaw === null || confidentialRaw === null
    ? null
    : (BigInt(nativeRaw) + BigInt(confidentialRaw)).toString()
}

export function getAssetDetailBalanceFiat(
  amountRaw: string | null,
  decimals: number,
  priceUsd?: string
): string | null {
  if (amountRaw === '0') return '0'
  if (amountRaw === null || priceUsd === undefined) return null
  return new Big(formatBaseUnitDecimalAmount(amountRaw, decimals)).times(priceUsd).toFixed()
}

export function getAssetDetailCategories(
  asset: PortfolioAssetView,
  model: PortfolioReadModel | null,
  privateEligible: boolean,
  priceUsd?: string
): {
  domains: readonly AssetDomain[]
  raw: Record<AssetDomain, string | null>
  fiat: Record<AssetDomain, string | null>
} {
  const visibleModel = model ? excludeDeprecatedConfidentialAssets(model) : null
  if (visibleModel !== model) {
    model = visibleModel
    asset = model?.assets.find(candidate => candidate.asset.id === asset.asset.id) ?? asset
  }
  const family = domainBalanceFamily(asset)
  const evm = family === 'evm'
  const near = family === 'near'
  const raw: Record<AssetDomain, string | null> = { ...selectAssetDetailDomainRaw(asset) }
  let shieldPriceUsd: string | undefined

  const confidential =
    (evm || (near && asset.balance.mainRaw !== undefined)) &&
    model?.confidential?.status === 'ready'
      ? model.confidential
      : null

  if (confidential) {
    const candidates = confidential.assets.filter(entry => entry.assetId === asset.asset.id)
    if (
      candidates.length === 1 &&
      candidates[0]!.chainId === asset.asset.chainId &&
      candidates[0]!.decimals === asset.metadata.decimals
    ) {
      raw.shield = candidates[0]!.availableRaw
      const candidatePrice = candidates[0]!.priceUsd
      if (
        candidatePrice &&
        candidatePrice.length <= 128 &&
        /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(candidatePrice) &&
        new Big(candidatePrice).gt(0)
      ) {
        shieldPriceUsd = candidatePrice
      }
    } else if (candidates.length === 0 && asset.balance.confidentialRaw === '0') {
      raw.shield = '0'
    }
  }

  const domains = selectAssetDetailDomains(family, raw, privateEligible)

  const fiat = Object.fromEntries(
    (['all', 'public', 'shield', 'private'] as const).map(domain => {
      const amount = raw[domain]
      const quote = domain === 'shield' ? (priceUsd ?? shieldPriceUsd) : priceUsd
      return [domain, getAssetDetailBalanceFiat(amount, asset.metadata.decimals, quote)]
    })
  ) as Record<AssetDomain, string | null>
  return { domains, raw, fiat }
}

export function getZcashPrivacyBalanceDisplay(balance: PortfolioBalanceView, decimals: number) {
  const formatPending = (raw: string | undefined) =>
    raw && BigInt(raw) > 0n ? formatDisplayTokenAmount(raw, decimals) : null

  return {
    shielded: formatDisplayTokenAmount(balance.shieldedRaw ?? '0', decimals),
    transparent: formatDisplayTokenAmount(balance.transparentRaw ?? '0', decimals),
    shieldedPending: formatPending(balance.shieldedPendingRaw),
    transparentPending: formatPending(balance.transparentPendingRaw)
  }
}
