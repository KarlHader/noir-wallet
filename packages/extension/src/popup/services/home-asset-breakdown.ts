import type { PortfolioFiatSummary } from '@/popup/services/portfolio-prices'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import { buildAccountKey } from '@/core/wallet/account-scope'
import type { AccountPortfolioValueSnapshot } from '@/core/wallet/account-portfolio-value'
import { isPortfolioModelForScope } from './portfolio-cache'
import {
  chainHasIndependentConfidential,
  chainIncludedInDomainProjection,
  readyChainCountsAsDomainBalance
} from '@/core/portfolio/domain-balance-policy'
import { getAssetDomainRaw, summarizeAssetDomainsUsd, type AssetDomain } from './asset-domains'

export type HomePortfolioTotalStatus = 'loading' | 'ready' | 'partial' | 'unavailable'

const homePrices = new Map<'mainnet' | 'testnet', AssetPriceReadModel>()

export function readHomePrices(network: 'mainnet' | 'testnet'): AssetPriceReadModel | null {
  return homePrices.get(network) ?? null
}

export function rememberHomePrices(network: 'mainnet' | 'testnet', prices: AssetPriceReadModel) {
  if (prices.status !== 'error') homePrices.set(network, prices)
}

export function resolveHomePortfolioTotalStatus(
  model: PortfolioReadModel | null,
  loadStatus: 'loading' | 'ready' | 'error',
  priceStatus: 'loading' | 'ready' | 'error',
  walletId: string | null,
  accountId: string | null,
  fiat: PortfolioFiatSummary
): HomePortfolioTotalStatus {
  if (!isPortfolioModelForScope(model, walletId, accountId)) {
    return loadStatus === 'loading' ? 'loading' : 'unavailable'
  }
  if (hasCompletePortfolioTotal(model, priceStatus, walletId, accountId, fiat)) return 'ready'
  if (fiat.pricedAssetCount > 0) return 'partial'
  if (model.confidential?.status === 'ready' && model.confidential.assets.length === 0) {
    return 'partial'
  }
  if (model.status === 'empty' && fiat.missingAssetCount === 0) return 'ready'
  if (model.status === 'ready') {
    if (model.confidential?.status === 'unavailable') {
      return model.chains?.some(chain => chain.status === 'ready') ? 'partial' : 'unavailable'
    }
    return priceStatus === 'loading' && fiat.missingAssetCount > 0 ? 'loading' : 'ready'
  }
  if (
    model.status === 'partial' &&
    model.chains?.some(
      chain =>
        chain.status === 'ready' && chain.assets.every(asset => asset.balance.totalRaw === '0')
    )
  ) {
    return 'partial'
  }
  if (
    model.status === 'partial' &&
    priceStatus !== 'loading' &&
    model.chains?.some(chain => chain.status === 'ready' || chain.assets.length > 0)
  ) {
    return 'partial'
  }
  if (loadStatus === 'loading' || model.status === 'loading' || priceStatus === 'loading') {
    return 'loading'
  }
  return 'unavailable'
}

export interface HomeAssetBreakdown {
  readonly publicUsd: string | null
  readonly publicUsdPartial: boolean
  readonly shieldUsd: string | null
  readonly shieldUsdPartial: boolean
  readonly privateUsd: string | null
  readonly privateUsdPartial: boolean
}

export interface HomeAssetDomainDisplay {
  readonly totals: Readonly<Record<AssetDomain, string | null>>
  readonly loading: Readonly<Record<AssetDomain, boolean>>
  readonly partial: Readonly<Record<AssetDomain, boolean>>
}

export function resolveHomeCachedTotal(
  values: ReadonlyMap<string, AccountPortfolioValueSnapshot>,
  network: 'mainnet' | 'testnet',
  walletId: string | null,
  accountId: string | null,
  selectedChains: readonly string[] | null | undefined
): string | null {
  if (!walletId || !accountId || selectedChains?.length === 1) return null
  const value = values.get(buildAccountKey(network, walletId, accountId))
  return value?.valuationBasis === 'wallet-assets-v2' && value.complete ? value.totalUsd : null
}

export function resolveHomeAssetDomainDisplay(input: {
  readonly portfolio: PortfolioReadModel | null
  readonly walletId: string | null
  readonly accountId: string | null
  readonly loadStatus: 'loading' | 'ready' | 'error'
  readonly settled: boolean
  readonly priceStatus: 'loading' | 'ready' | 'error'
  readonly totalStatus: HomePortfolioTotalStatus
  readonly fiat: PortfolioFiatSummary
  readonly breakdown: HomeAssetBreakdown | null
  readonly cachedTotalUsd?: string | null
}): HomeAssetDomainDisplay {
  const model = isPortfolioModelForScope(input.portfolio, input.walletId, input.accountId)
    ? input.portfolio
    : null
  const chains = model?.chains ?? []
  const available = {
    public: chains.some(chain => chain.status === 'ready' || chain.assets.length > 0),
    shield:
      model?.confidential?.status === 'ready' ||
      chains.some(
        chain =>
          (readyChainCountsAsDomainBalance(chain.chain.family, 'shield') &&
            chain.status === 'ready') ||
          (chainIncludedInDomainProjection(chain.chain.family, 'shield') &&
            chain.assets.some(asset => {
              const raw = getAssetDomainRaw(asset, 'shield')
              return raw !== null && BigInt(raw) > 0n
            }))
      ),
    private: chains.some(
      chain =>
        chainIncludedInDomainProjection(chain.chain.family, 'private') &&
        (chain.status === 'ready' ||
          chain.assets.some(asset => {
            const raw = getAssetDomainRaw(asset, 'private')
            return raw !== null && BigInt(raw) > 0n
          }))
    )
  }
  const pending = {
    public: chains.some(chain => chain.status === 'loading' || chain.status === 'partial'),
    shield:
      chains.some(
        chain =>
          chainIncludedInDomainProjection(chain.chain.family, 'shield') &&
          (chain.status === 'loading' || chain.status === 'partial')
      ) ||
      (model?.confidential === undefined &&
        !input.settled &&
        chains.some(chain =>
          chainHasIndependentConfidential(
            chain.chain.family,
            chain.chain.family === 'evm' ? chain.chain.network.kind : undefined
          )
        )),
    private: chains.some(
      chain =>
        chainIncludedInDomainProjection(chain.chain.family, 'private') &&
        (chain.status === 'loading' || chain.status === 'partial')
    )
  }
  const totals: Record<AssetDomain, string | null> = {
    all:
      input.totalStatus === 'ready' || input.totalStatus === 'partial'
        ? input.fiat.totalUsd
        : (input.cachedTotalUsd ?? null),
    public: null,
    shield: null,
    private: null
  }
  const loading: Record<AssetDomain, boolean> = {
    all: input.totalStatus === 'loading' && totals.all === null,
    public: false,
    shield: false,
    private: false
  }
  const partial = {
    all: input.totalStatus === 'partial',
    public: false,
    shield: false,
    private: false
  }
  for (const domain of ['public', 'shield', 'private'] as const) {
    const value = model ? (input.breakdown?.[`${domain}Usd`] ?? null) : null
    loading[domain] = !model
      ? input.loadStatus === 'loading'
      : (!available[domain] && pending[domain]) ||
        (value === null && input.priceStatus === 'loading')
    totals[domain] = loading[domain] ? null : value
    partial[domain] =
      totals[domain] !== null &&
      Boolean(input.breakdown?.[`${domain}UsdPartial`] || pending[domain])
  }
  return { totals, loading, partial }
}

export function hasCompletePortfolioTotal(
  model: PortfolioReadModel | null,
  priceStatus: 'loading' | 'ready' | 'error',
  walletId: string | null,
  accountId: string | null,
  fiat: PortfolioFiatSummary
): boolean {
  return (
    isPortfolioModelForScope(model, walletId, accountId) &&
    model.status === 'ready' &&
    priceStatus === 'ready' &&
    fiat.missingAssetCount === 0 &&
    fiat.staleAssetCount === 0
  )
}

export function getHomeAssetBreakdown(input: {
  readonly livePortfolioTotal: boolean
  readonly portfolio?: PortfolioReadModel | null
  readonly prices?: AssetPriceReadModel | null
}): HomeAssetBreakdown | null {
  if (!input.livePortfolioTotal || !input.portfolio) return null
  return summarizeAssetDomainsUsd(input.portfolio, input.prices ?? null)
}
