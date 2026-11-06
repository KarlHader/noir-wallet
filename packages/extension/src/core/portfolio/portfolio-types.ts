import type { AccountId, ChainAccount, ChainAccountId } from '@/core/accounts/domain'
import type { Asset, AssetDisplayMetadata } from '@/core/chains/domain'
import type { AssetSource, ChainDefinition } from '@/core/chains/registry'
import type { KeyDomainId } from '@/core/keyring/domain'

export const PORTFOLIO_READ_ERROR_CODES = Object.freeze([
  'network-unavailable',
  'rate-limited',
  'unauthorized',
  'invalid-response',
  'unsupported',
  'unknown'
] as const)

export const PORTFOLIO_READ_LIMITS = Object.freeze({
  sources: 100,
  balancesPerSource: 2_048,
  balancesTotal: 10_000,
  rawAmountDigits: 128
})

export type PortfolioReadErrorCode = (typeof PORTFOLIO_READ_ERROR_CODES)[number]
export type PortfolioSourceStatus = 'loading' | 'ready' | 'error'
export type PortfolioViewStatus = 'empty' | 'loading' | 'ready' | 'partial' | 'error'

export interface PortfolioScope {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
}

export interface PortfolioBalanceSnapshot {
  readonly assetId: string
  readonly totalRaw: string
  readonly spendableRaw: string
  readonly availableRaw: string
  readonly pendingRaw: string
  readonly shieldableRaw?: string
  readonly shieldedRaw?: string
  readonly transparentRaw?: string
  readonly shieldedPendingRaw?: string
  readonly transparentPendingRaw?: string
  readonly mainRaw?: string
  readonly privateRaw?: string
  readonly privateOnchainRaw?: string
  readonly confidentialRaw?: string
  readonly updatedAt: number
}

export interface PortfolioSourceSnapshot {
  readonly chainAccount: ChainAccount
  readonly status: PortfolioSourceStatus
  readonly balances: readonly PortfolioBalanceSnapshot[]
  readonly errorCode?: PortfolioReadErrorCode
}

export interface PortfolioBalanceView {
  readonly totalRaw: string
  readonly spendableRaw: string
  readonly availableRaw: string
  readonly pendingRaw: string
  readonly shieldableRaw?: string
  readonly shieldedRaw?: string
  readonly transparentRaw?: string
  readonly shieldedPendingRaw?: string
  readonly transparentPendingRaw?: string
  readonly mainRaw?: string
  readonly privateRaw?: string
  readonly privateOnchainRaw?: string
  readonly confidentialRaw?: string
}

export interface PortfolioAssetView {
  readonly asset: Asset
  readonly metadata: AssetDisplayMetadata
  readonly source: AssetSource
  readonly balance: PortfolioBalanceView
  readonly chainAccountIds: readonly ChainAccountId[]
  readonly freshness: 'fresh' | 'stale'
  readonly updatedAt: number
}

export interface PortfolioChainView {
  readonly chain: ChainDefinition
  readonly status: Exclude<PortfolioViewStatus, 'empty'>
  readonly assets: readonly PortfolioAssetView[]
  readonly errorCodes: readonly PortfolioReadErrorCode[]
}

export interface ConfidentialPortfolioAssetView {
  readonly tokenId: string
  readonly protocolAssetId: string
  readonly availableRaw: string
  readonly assetId?: string
  readonly chainId?: string
  readonly blockchain?: string
  readonly symbol?: string
  readonly name?: string
  readonly decimals?: number
  readonly iconUrl?: string
  readonly priceUsd?: string
  readonly priceUpdatedAt?: string
}

export interface ConfidentialPortfolioView {
  readonly status: 'ready' | 'unavailable'
  readonly assets: readonly ConfidentialPortfolioAssetView[]
}

export interface PortfolioReadModel {
  readonly scope: PortfolioScope
  readonly status: PortfolioViewStatus
  readonly chains: readonly PortfolioChainView[]
  readonly assets: readonly PortfolioAssetView[]
  readonly ignoredAssetCount: number
  readonly confidential?: ConfidentialPortfolioView
}
