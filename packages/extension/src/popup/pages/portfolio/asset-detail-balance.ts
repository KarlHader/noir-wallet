import Big from '@/lib/big'
import { excludeDeprecatedConfidentialAssets } from '@/core/services/confidential-funding/confidential-funding-portfolio'
import type { PortfolioAssetView, PortfolioBalanceView, PortfolioReadModel } from '@/core/portfolio'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { formatDisplayTokenAmount } from '@/popup/components/portfolio/portfolio-format'
import {
  getAssetDomainRaw,
  getAssetShieldProvider,
  type AssetDomain
} from '@/popup/services/asset-domains'

export function getAssetDetailCategories(
  asset: PortfolioAssetView,
  model: PortfolioReadModel,
  privateEligible: boolean,
  priceUsd?: string
): {
  domains: readonly AssetDomain[]
  raw: Record<AssetDomain, string | null>
  fiat: Record<AssetDomain, string | null>
} {
  const visibleModel = excludeDeprecatedConfidentialAssets(model)
  if (visibleModel !== model) {
    model = visibleModel
    asset = model.assets.find(candidate => candidate.asset.id === asset.asset.id) ?? asset
  }
  const evm = asset.asset.chainId.startsWith('eip155:')
  const zcash = getAssetShieldProvider(asset) === 'zcash-shield'
  const raw: Record<AssetDomain, string | null> = {
    all: asset.balance.totalRaw,
    public: getAssetDomainRaw(asset, 'public'),
    shield: zcash ? getAssetDomainRaw(asset, 'shield') : null,
    private: evm ? getAssetDomainRaw(asset, 'private') : null
  }
  let shieldPriceUsd: string | undefined

  if (evm && model.confidential?.status === 'ready') {
    const candidates = model.confidential.assets.filter(entry => entry.assetId === asset.asset.id)
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

  const domains: AssetDomain[] = ['all', 'public']
  if (zcash) domains.push('shield')
  if (evm && (privateEligible || (raw.shield !== null && BigInt(raw.shield) > 0n))) {
    domains.push('shield')
  }
  if (evm && (privateEligible || (raw.private !== null && BigInt(raw.private) > 0n))) {
    domains.push('private')
  }

  const fiat = Object.fromEntries(
    (['all', 'public', 'shield', 'private'] as const).map(domain => {
      const amount = raw[domain]
      const quote = domain === 'shield' ? (priceUsd ?? shieldPriceUsd) : priceUsd
      return [
        domain,
        amount === null || quote === undefined
          ? null
          : new Big(formatBaseUnitDecimalAmount(amount, asset.metadata.decimals))
              .times(quote)
              .toFixed()
      ]
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
