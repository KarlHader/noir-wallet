import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { SwapToken } from '@/core/services/intents-api'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '@/core/chains/registry'
import { getAssetProtocolSourceMappings } from '@/core/prices/asset-market-mappings'
import type { Network } from '@/types'
import type { PrepareConfidentialFundingRequest } from './confidential-funding-client'
import type {
  ConfidentialFundingPlan,
  ConfidentialFundingReview
} from '@/core/services/confidential-funding'
import type { TransferDomain } from './private-balance-transfer'

export type ShieldTransferAsset = Pick<
  IntentsManagedAsset,
  'assetId' | 'chainId' | 'protocolAssetId' | 'blockchain'
>

export function resolveShieldManagedAsset(
  asset: PortfolioAssetView,
  managed: readonly IntentsManagedAsset[],
  tokens: readonly SwapToken[],
  network: Network
): ShieldTransferAsset | null {
  const catalogAsset = managed.find(
    item => item.assetId === asset.asset.id && item.chainId === asset.asset.chainId
  )
  if (catalogAsset) return catalogAsset
  if (asset.asset.kind !== 'native' || !asset.asset.chainId.startsWith('eip155:')) return null
  const chains = createInitialProductChainRegistry(network)
  const registry = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions(network))
  const mapping = getAssetProtocolSourceMappings(network, registry).find(
    item => item.assetId === asset.asset.id
  )
  if (!mapping) return null
  const token = tokens.find(
    item => item.assetId === mapping.protocolAssetId && item.decimals === asset.metadata.decimals
  )
  if (!token) return null
  return Object.freeze({
    assetId: asset.asset.id,
    chainId: asset.asset.chainId,
    protocolAssetId: mapping.protocolAssetId,
    blockchain: token.blockchain
  })
}

export function isShieldTransferRoute(from: TransferDomain, to: TransferDomain): boolean {
  return (
    (from === 'shield' && (to === 'public' || to === 'private')) ||
    (to === 'shield' && (from === 'public' || from === 'private'))
  )
}

export function isClusterTransferRoute(from: TransferDomain, to: TransferDomain): boolean {
  return (
    (from === 'public' && to === 'private') ||
    (from === 'private' && to === 'public') ||
    (from === 'shield' && (to === 'public' || to === 'private'))
  )
}

export function matchesShieldReview(
  review: ConfidentialFundingReview,
  request: PrepareConfidentialFundingRequest
): boolean {
  return (
    review.operation === request.operation &&
    review.sourceDomain === request.sourceDomain &&
    review.destinationDomain === request.destinationDomain &&
    review.network === request.network &&
    review.keyDomainId === request.keyDomainId &&
    review.accountId === request.accountId &&
    review.sourceAmountRaw === request.source.amountRaw &&
    review.requiresDeposit ===
      (request.operation === 'deposit' ||
        (request.operation === 'cluster' && request.sourceDomain !== 'shield')) &&
    (request.operation !== 'cluster' || (review.withdrawCount >= 2 && review.withdrawCount <= 5))
  )
}

export function shieldQuoteFeeRaw(review: ConfidentialFundingReview): string | null {
  const difference = BigInt(review.sourceAmountRaw) - BigInt(review.expectedOutputRaw)
  return difference >= 0n ? difference.toString() : null
}

export function hasShieldTransferStarted(plan: ConfidentialFundingPlan): boolean {
  if (plan.operation === 'deposit')
    return Boolean(plan.preparedDeposit?.transactionHash || plan.preparedDeposit?.rawTransaction)
  if (plan.operation === 'withdraw' || plan.operation === 'cluster')
    return Boolean(
      plan.batchSubmissionAttemptedAt ||
      plan.orderId ||
      plan.preparedDeposit?.transactionHash ||
      plan.preparedDeposit?.rawTransaction ||
      plan.requestFingerprint ||
      plan.frozenRequest ||
      plan.withdraws.some(row => row.signedPayload || row.intentHash)
    )
  return false
}

export function isUnsignedShieldTerminal(plan: ConfidentialFundingPlan): boolean {
  return (
    (plan.phase === 'failed' || plan.phase === 'expired' || plan.phase === 'cancelled') &&
    !hasShieldTransferStarted(plan)
  )
}

export function buildShieldTransferRequest(
  input: Readonly<{
    network: Network
    keyDomainId: string
    accountId: string
    from: TransferDomain
    to: TransferDomain
    method?: 'cluster' | 'directly'
    amountRaw: string
    asset: PortfolioAssetView
    chain: PortfolioChainView
    managed: ShieldTransferAsset
  }>
): PrepareConfidentialFundingRequest {
  if (
    !(input.method === 'cluster'
      ? isClusterTransferRoute(input.from, input.to)
      : isShieldTransferRoute(input.from, input.to)) ||
    input.chain.chain.family !== 'evm' ||
    input.managed.assetId !== input.asset.asset.id ||
    input.managed.chainId !== input.chain.chain.id ||
    !/^[1-9]\d*$/.test(input.amountRaw)
  ) {
    throw new Error('Shield transfer is unavailable')
  }
  const routeAsset = Object.freeze({
    chainId: input.chain.chain.id,
    chainName: input.managed.blockchain,
    assetId: input.managed.assetId,
    protocolAssetId: input.managed.protocolAssetId
  })
  return Object.freeze({
    network: input.network,
    keyDomainId: input.keyDomainId,
    accountId: input.accountId,
    operation:
      input.method === 'cluster' ? 'cluster' : input.to === 'shield' ? 'deposit' : 'withdraw',
    sourceDomain: input.from,
    destinationDomain: input.to,
    source: Object.freeze({ ...routeAsset, amountRaw: input.amountRaw }),
    destination: routeAsset,
    slippageBps: 50
  })
}
