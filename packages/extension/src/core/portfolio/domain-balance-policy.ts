import type { ChainFamily } from '@/core/chains/registry/capabilities'
import { ZCASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import type {
  PortfolioAssetView,
  PortfolioBalanceView,
  PortfolioReadModel
} from './portfolio-types'

const ZCASH_CHAIN_ID_SET = new Set<string>(Object.values(ZCASH_CHAIN_IDS))

export const PORTFOLIO_DOMAINS = Object.freeze(['all', 'public', 'shield', 'private'] as const)
export type PortfolioDomain = (typeof PORTFOLIO_DOMAINS)[number]
export type DomainBalanceFamily = ChainFamily | 'other'

function assertNever(value: never): never {
  throw new Error(`Unsupported domain balance family: ${JSON.stringify(value)}`)
}

function completeRawParts(totalRaw: string, parts: readonly (string | undefined)[]): boolean {
  return (
    parts.every(part => part !== undefined) &&
    parts.reduce<bigint>((sum, part) => sum + BigInt(part ?? '0'), 0n) === BigInt(totalRaw)
  )
}

export function domainBalanceFamily(asset: Pick<PortfolioAssetView, 'asset'>): DomainBalanceFamily {
  const chainId = asset.asset.chainId
  if (chainId.startsWith('eip155:')) return 'evm'
  if (ZCASH_CHAIN_ID_SET.has(chainId)) return 'zcash'
  if (chainId.startsWith('bip122:')) return 'bitcoin'
  if (chainId.startsWith('solana:')) return 'solana'
  if (chainId.startsWith('tron:')) return 'tron'
  if (chainId.startsWith('near:')) return 'near'
  return 'other'
}

function selectEvmDomainBalanceRaw(
  balance: PortfolioBalanceView,
  domain: Exclude<PortfolioDomain, 'all'>
): string | null {
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

function selectZcashDomainBalanceRaw(
  balance: PortfolioBalanceView,
  domain: Exclude<PortfolioDomain, 'all'>
): string | null {
  if (domain === 'private') return '0'
  if (!completeRawParts(balance.totalRaw, [balance.transparentRaw, balance.shieldedRaw])) {
    return null
  }
  if (domain === 'public') return balance.transparentRaw ?? null
  return balance.shieldedRaw ?? null
}

function nearDomainSplitReady(balance: PortfolioBalanceView): boolean {
  return balance.privateOnchainRaw !== undefined && balance.confidentialRaw !== undefined
}

function selectNearDomainBalanceRaw(
  balance: PortfolioBalanceView,
  domain: Exclude<PortfolioDomain, 'all'>
): string | null {
  // A row without both PEA and confidential parts is still one public balance.
  if (!nearDomainSplitReady(balance)) {
    return domain === 'public' ? balance.totalRaw : '0'
  }
  return selectEvmDomainBalanceRaw(balance, domain)
}

function selectUnsplitDomainBalanceRaw(
  balance: PortfolioBalanceView,
  domain: Exclude<PortfolioDomain, 'all'>
): string | null {
  return domain === 'public' ? balance.totalRaw : '0'
}

export function selectDomainBalanceRaw(
  asset: PortfolioAssetView,
  domain: PortfolioDomain
): string | null {
  if (domain === 'all') return asset.balance.totalRaw
  const family = domainBalanceFamily(asset)
  switch (family) {
    case 'evm':
      return selectEvmDomainBalanceRaw(asset.balance, domain)
    case 'zcash':
      return selectZcashDomainBalanceRaw(asset.balance, domain)
    case 'near':
      return selectNearDomainBalanceRaw(asset.balance, domain)
    case 'bitcoin':
    case 'solana':
    case 'tron':
    case 'other':
      return selectUnsplitDomainBalanceRaw(asset.balance, domain)
    default:
      return assertNever(family)
  }
}

export function selectAssetDetailDomainRaw(
  asset: PortfolioAssetView
): Record<PortfolioDomain, string | null> {
  const all = asset.balance.totalRaw
  const publicRaw = selectDomainBalanceRaw(asset, 'public')
  const family = domainBalanceFamily(asset)
  switch (family) {
    case 'evm':
      return {
        all,
        public: publicRaw,
        shield: null,
        private: selectDomainBalanceRaw(asset, 'private')
      }
    case 'zcash':
      return {
        all,
        public: publicRaw,
        shield: selectDomainBalanceRaw(asset, 'shield'),
        private: null
      }
    case 'near':
      return {
        all,
        public: publicRaw,
        shield: nearDomainSplitReady(asset.balance)
          ? selectDomainBalanceRaw(asset, 'shield')
          : null,
        private: nearDomainSplitReady(asset.balance)
          ? selectDomainBalanceRaw(asset, 'private')
          : null
      }
    case 'bitcoin':
    case 'solana':
    case 'tron':
    case 'other':
      return { all, public: publicRaw, shield: null, private: null }
    default:
      return assertNever(family)
  }
}

export function selectAssetDetailDomains(
  family: DomainBalanceFamily,
  raw: Readonly<Record<PortfolioDomain, string | null>>,
  privateEligible: boolean
): readonly PortfolioDomain[] {
  const domains: PortfolioDomain[] = ['all', 'public']
  switch (family) {
    case 'zcash':
      domains.push('shield')
      return domains
    case 'evm':
      if (privateEligible || (raw.shield !== null && BigInt(raw.shield) > 0n)) {
        domains.push('shield')
      }
      if (privateEligible || (raw.private !== null && BigInt(raw.private) > 0n)) {
        domains.push('private')
      }
      return domains
    case 'near':
      if (raw.shield !== null) domains.push('shield')
      if (raw.private !== null) domains.push('private')
      return domains
    case 'bitcoin':
    case 'solana':
    case 'tron':
    case 'other':
      return domains
    default:
      return assertNever(family)
  }
}

export function chainHasIndependentConfidential(
  family: ChainFamily,
  networkKind: string | undefined
): boolean {
  switch (family) {
    case 'evm':
      return networkKind === 'mainnet'
    case 'zcash':
    case 'bitcoin':
    case 'solana':
    case 'tron':
    case 'near':
      return false
    default:
      return assertNever(family)
  }
}

export function portfolioUsesIndependentConfidentialValuation(
  portfolio: Pick<PortfolioReadModel, 'confidential' | 'chains'>
): boolean {
  return (
    portfolio.confidential !== undefined ||
    portfolio.chains?.some(chain =>
      chainHasIndependentConfidential(chain.chain.family, chain.chain.network?.kind)
    ) === true
  )
}

export function embeddedConfidentialRaw(
  asset: Pick<PortfolioAssetView, 'asset' | 'balance'>,
  independentConfidential: boolean
): bigint {
  const family = domainBalanceFamily(asset)
  switch (family) {
    case 'evm':
    case 'near':
      return independentConfidential ? BigInt(asset.balance.confidentialRaw ?? '0') : 0n
    case 'zcash':
    case 'bitcoin':
    case 'solana':
    case 'tron':
    case 'other':
      return 0n
    default:
      return assertNever(family)
  }
}

export function chainIncludedInDomainProjection(
  family: ChainFamily,
  domain: Exclude<PortfolioDomain, 'all'>
): boolean {
  switch (domain) {
    case 'public':
      return true
    case 'shield':
      switch (family) {
        case 'evm':
        case 'zcash':
        case 'near':
          return true
        case 'bitcoin':
        case 'solana':
        case 'tron':
          return false
        default:
          return assertNever(family)
      }
    case 'private':
      switch (family) {
        case 'evm':
        case 'near':
          return true
        case 'zcash':
        case 'bitcoin':
        case 'solana':
        case 'tron':
          return false
        default:
          return assertNever(family)
      }
    default:
      return assertNever(domain)
  }
}

export function readyChainCountsAsDomainBalance(
  family: ChainFamily,
  domain: 'shield' | 'private'
): boolean {
  switch (domain) {
    case 'shield':
      switch (family) {
        case 'zcash':
          return true
        case 'evm':
        case 'bitcoin':
        case 'solana':
        case 'tron':
        case 'near':
          return false
        default:
          return assertNever(family)
      }
    case 'private':
      switch (family) {
        case 'evm':
        case 'near':
          return true
        case 'zcash':
        case 'bitcoin':
        case 'solana':
        case 'tron':
          return false
        default:
          return assertNever(family)
      }
    default:
      return assertNever(domain)
  }
}

export function chainSupportsPortfolioDomain(
  family: ChainFamily,
  domain: 'public' | 'private'
): boolean {
  switch (domain) {
    case 'public':
      return true
    case 'private':
      switch (family) {
        case 'evm':
          return true
        case 'zcash':
        case 'bitcoin':
        case 'solana':
        case 'tron':
        case 'near':
          return false
        default:
          return assertNever(family)
      }
    default:
      return assertNever(domain)
  }
}

export function chainSupportsPortfolioAction(
  family: ChainFamily,
  action: 'send' | 'swap'
): boolean {
  switch (action) {
    case 'send':
      return true
    case 'swap':
      switch (family) {
        case 'evm':
        case 'zcash':
        case 'bitcoin':
          return true
        case 'solana':
        case 'tron':
        case 'near':
          return false
        default:
          return assertNever(family)
      }
    default:
      return assertNever(action)
  }
}
