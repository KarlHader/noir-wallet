import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { SwapToken } from '@/core/services/intents-api'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getZcashChainId,
  getBundledInitialProductAssetDefinitions,
  parseAssetId
} from '@/core/chains/registry'
import { getAssetProtocolSourceMappings } from '@/core/prices/asset-market-mappings'
import type { Network } from '@/types'
import { isAddress } from 'viem'
import type { PrepareConfidentialFundingRequest } from './confidential-funding-client'
import type {
  ConfidentialFundingPlan,
  ConfidentialFundingReview
} from '@/core/services/confidential-funding'
import { getConfidentialAvailableForAsset } from '@/core/services/confidential-funding'
import type { TransferDomain } from './private-balance-transfer'

export type ShieldTransferAsset = Pick<
  IntentsManagedAsset,
  'assetId' | 'chainId' | 'protocolAssetId' | 'blockchain'
>

export type ShieldFundingAsset = Readonly<{
  asset: PortfolioAssetView
  chain: PortfolioChainView
  managed: ShieldTransferAsset
}>

function confidentialHolding(
  model: PortfolioReadModel,
  protocolAssetId: string
): NonNullable<PortfolioReadModel['confidential']>['assets'][number] | undefined {
  return model.confidential?.status === 'ready'
    ? model.confidential.assets.find(asset => asset.protocolAssetId === protocolAssetId)
    : undefined
}

export function shieldPortfolioBalances(
  model: PortfolioReadModel | null
): readonly Readonly<{ tokenId: string; available: string }>[] | null {
  return model?.confidential?.status === 'ready'
    ? model.confidential.assets.map(asset => ({
        tokenId: asset.tokenId,
        available: asset.availableRaw
      }))
    : null
}

function fundingAssetView(
  model: PortfolioReadModel,
  managed: ShieldTransferAsset & Readonly<{ symbol: string; decimals: number; iconUrl?: string }>,
  name: string,
  holding: ReturnType<typeof confidentialHolding>
): PortfolioAssetView | null {
  let parsed: ReturnType<typeof parseAssetId>
  try {
    parsed = parseAssetId(managed.assetId)
  } catch {
    return null
  }
  if (parsed.chainId !== managed.chainId) return null
  if (
    holding &&
    ((holding.assetId !== undefined && holding.assetId !== managed.assetId) ||
      (holding.chainId !== undefined && holding.chainId !== managed.chainId) ||
      (holding.decimals !== undefined && holding.decimals !== managed.decimals))
  )
    return null
  const publicAsset = model.assets.find(asset => asset.asset.id === managed.assetId)
  if (publicAsset) {
    return publicAsset.metadata.decimals === managed.decimals ? publicAsset : null
  }
  const zero = '0'
  const confidentialRaw = holding?.availableRaw ?? zero
  return Object.freeze({
    asset: Object.freeze({
      id: parsed.id,
      chainId: parsed.chainId,
      namespace: parsed.namespace,
      reference: parsed.reference,
      kind: parsed.namespace === 'slip44' ? ('native' as const) : ('token' as const)
    }),
    metadata: Object.freeze({
      name,
      symbol: managed.symbol,
      decimals: managed.decimals,
      ...(managed.iconUrl ? { iconUrl: managed.iconUrl } : {})
    }),
    source: 'protocol' as const,
    balance: Object.freeze({
      totalRaw: confidentialRaw,
      spendableRaw: zero,
      availableRaw: zero,
      pendingRaw: zero,
      mainRaw: zero,
      privateRaw: confidentialRaw,
      privateOnchainRaw: zero,
      confidentialRaw
    }),
    chainAccountIds: Object.freeze([]),
    freshness: 'fresh' as const,
    updatedAt: 0
  })
}

export function listShieldFundingAssets(
  model: PortfolioReadModel | null,
  managedAssets: readonly IntentsManagedAsset[],
  catalogTokens: readonly SwapToken[],
  network: Network
): readonly ShieldFundingAsset[] {
  if (!model) return []
  const chains = new Map<string, PortfolioChainView>(
    model.chains.map(chain => [chain.chain.id, chain])
  )
  const productChains = createInitialProductChainRegistry(network)
  const bundled = createAssetRegistry(
    productChains,
    getBundledInitialProductAssetDefinitions(network)
  )
  const zcashChainId = getZcashChainId(network)
  // A Confidential ZEC holding can be spent by an EVM-only account.
  const zcashRouteChain: PortfolioChainView = Object.freeze({
    chain: productChains.resolve(zcashChainId),
    status: 'ready',
    assets: Object.freeze([]),
    errorCodes: Object.freeze([])
  })
  const native = getAssetProtocolSourceMappings(network, bundled).flatMap(mapping => {
    const entry = bundled.get(mapping.assetId)
    const token = catalogTokens.find(candidate => candidate.assetId === mapping.protocolAssetId)
    return entry?.asset.kind === 'native' &&
      (entry.asset.chainId.startsWith('eip155:') || entry.asset.chainId === zcashChainId) &&
      token?.decimals === entry.metadata.decimals
      ? [
          {
            assetId: mapping.assetId,
            chainId: entry.asset.chainId,
            protocolAssetId: mapping.protocolAssetId,
            blockchain: token.blockchain,
            symbol: token.symbol,
            decimals: token.decimals,
            ...(entry.metadata.iconUrl ? { iconUrl: entry.metadata.iconUrl } : {})
          }
        ]
      : []
  })
  const catalog = [...managedAssets.filter(asset => asset.management === 'evm'), ...native]
  const seen = new Set<string>()
  return catalog.flatMap(managed => {
    if (seen.has(managed.protocolAssetId)) return []
    const chain =
      chains.get(managed.chainId) ??
      (managed.chainId === zcashChainId ? zcashRouteChain : undefined)
    const token = catalogTokens.find(candidate => candidate.assetId === managed.protocolAssetId)
    if (
      (chain?.chain.family !== 'evm' && chain?.chain.id !== zcashChainId) ||
      chain.chain.capabilities.transaction.status !== 'available' ||
      !token ||
      token.decimals !== managed.decimals ||
      token.blockchain !== managed.blockchain
    )
      return []
    const holding = confidentialHolding(model, managed.protocolAssetId)
    const asset = fundingAssetView(model, managed, token.symbol, holding)
    if (!asset) return []
    seen.add(managed.protocolAssetId)
    return [{ asset, chain, managed }]
  })
}

export function selectShieldWithdrawDestinationForNetwork(
  options: readonly ShieldFundingAsset[],
  destination: ShieldFundingAsset | null,
  chainId: string
): ShieldFundingAsset | null {
  const candidates = options.filter(option => option.chain.chain.id === chainId)
  if (destination?.chain.chain.id === chainId) {
    return (
      candidates.find(option => option.asset.asset.id === destination.asset.asset.id) ??
      candidates[0] ??
      null
    )
  }
  return (
    candidates.find(
      option =>
        option.asset.metadata.symbol === destination?.asset.metadata.symbol &&
        option.asset.metadata.name === destination.asset.metadata.name
    ) ??
    candidates.find(
      option => option.asset.metadata.symbol === destination?.asset.metadata.symbol
    ) ??
    candidates[0] ??
    null
  )
}

export function shieldFundingAvailableRaw(
  asset: ShieldFundingAsset | null,
  balances: readonly Readonly<{ tokenId: string; available: string }>[] | null
): string {
  return asset && balances
    ? (getConfidentialAvailableForAsset(balances, asset.managed.protocolAssetId) ?? '0')
    : '0'
}

export function shieldFundingSources(
  assets: readonly ShieldFundingAsset[],
  balances: readonly Readonly<{ tokenId: string; available: string }>[] | null
): readonly ShieldFundingAsset[] {
  return balances
    ? assets.filter(asset => BigInt(shieldFundingAvailableRaw(asset, balances)) > 0n)
    : []
}

export function resolveShieldManagedAsset(
  asset: PortfolioAssetView,
  managed: readonly IntentsManagedAsset[],
  tokens: readonly SwapToken[],
  network: Network
): ShieldTransferAsset | null {
  const catalogAsset = managed.find(
    item =>
      item.management === 'evm' &&
      item.assetId === asset.asset.id &&
      item.chainId === asset.asset.chainId &&
      item.decimals === asset.metadata.decimals &&
      tokens.some(
        token =>
          token.assetId === item.protocolAssetId &&
          token.blockchain === item.blockchain &&
          token.decimals === item.decimals
      )
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
  if (plan.operation === 'withdraw' || plan.operation === 'cluster' || plan.operation === 'swap')
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

export function buildExternalShieldWithdrawRequest(
  input: Readonly<{
    network: Network
    keyDomainId: string
    accountId: string
    amountRaw: string
    recipient: string
    source: Readonly<{
      asset: PortfolioAssetView
      chain: PortfolioChainView
      managed: ShieldTransferAsset
    }>
    destination: Readonly<{
      asset: PortfolioAssetView
      chain: PortfolioChainView
      managed: ShieldTransferAsset
    }>
    slippageBps: number
  }>
): PrepareConfidentialFundingRequest {
  if (
    !isAddress(input.recipient) ||
    /^0x0{40}$/i.test(input.recipient) ||
    !/^[1-9]\d*$/.test(input.amountRaw) ||
    (input.source.chain.chain.family !== 'evm' &&
      input.source.chain.chain.id !== getZcashChainId(input.network)) ||
    input.destination.chain.chain.family !== 'evm' ||
    input.source.asset.asset.id !== input.source.managed.assetId ||
    input.destination.asset.asset.id !== input.destination.managed.assetId ||
    input.source.chain.chain.id !== input.source.managed.chainId ||
    input.destination.chain.chain.id !== input.destination.managed.chainId
  ) {
    throw new Error('Shield withdrawal is unavailable')
  }
  return Object.freeze({
    network: input.network,
    keyDomainId: input.keyDomainId,
    accountId: input.accountId,
    operation: 'withdraw',
    sourceDomain: 'shield',
    destinationDomain: 'public',
    source: Object.freeze({
      chainId: input.source.managed.chainId,
      chainName: input.source.managed.blockchain,
      assetId: input.source.managed.assetId,
      protocolAssetId: input.source.managed.protocolAssetId,
      amountRaw: input.amountRaw
    }),
    destination: Object.freeze({
      chainId: input.destination.managed.chainId,
      chainName: input.destination.managed.blockchain,
      assetId: input.destination.managed.assetId,
      protocolAssetId: input.destination.managed.protocolAssetId
    }),
    externalRecipient: input.recipient,
    slippageBps: input.slippageBps
  })
}

export function matchesExternalShieldWithdrawReview(
  review: ConfidentialFundingReview,
  request: PrepareConfidentialFundingRequest
): boolean {
  return (
    request.operation === 'withdraw' &&
    review.operation === 'withdraw' &&
    review.sourceDomain === 'shield' &&
    review.destinationDomain === 'public' &&
    review.network === request.network &&
    review.keyDomainId === request.keyDomainId &&
    review.accountId === request.accountId &&
    review.sourceAmountRaw === request.source.amountRaw &&
    review.externalRecipient?.toLowerCase() === request.externalRecipient?.toLowerCase() &&
    review.destinationAddress.toLowerCase() === request.externalRecipient?.toLowerCase() &&
    review.withdrawCount === 1 &&
    !review.requiresDeposit
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
