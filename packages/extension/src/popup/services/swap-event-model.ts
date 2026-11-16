import type { AnalyticsChain } from '@/lib/analytics/constants'
import type { TransactionGraph } from '@/core/transactions/domain'
import type { PrivateQuotePurpose } from '@/core/services/rhea-swap'
import { ASSET_PRICE_FRESH_MS } from '@/core/prices'
import type { TrackOptions } from '@/lib/analytics'
import { sanitizeAnalyticsAmount } from '@/lib/analytics/collector-metrics'
import Big from '@/lib/big'

export function hasSubmittedRheaOrigin(graph: TransactionGraph): boolean {
  if (graph.root.intent?.protocol?.provider !== 'rhea-cross-chain-dex') return false
  return graph.segments.some(
    segment =>
      segment.role === 'origin' &&
      (segment.status === 'broadcast' ||
        segment.status === 'confirming' ||
        segment.status === 'final') &&
      (segment.target?.kind === 'onchain'
        ? Boolean(segment.evidence?.transactionHash)
        : segment.target?.kind === 'relay' && Boolean(segment.evidence?.externalReference))
  )
}

export function projectSwapCollector(input: {
  readonly amountIn: string
  readonly sourcePrice?: number
  readonly sourcePriceUpdatedAt?: string
  readonly now: number
  readonly purpose?: PrivateQuotePurpose
  readonly confidentiality?: 'basic'
  readonly isTransfer: boolean
  readonly isZecSource: boolean
  readonly isZecDestination: boolean
  readonly fundingSource?: 'shielded' | 'transparent'
  readonly zecDestinationType?: 'shielded' | 'transparent'
  readonly executionSourceMode: 'main' | 'private'
  readonly destinationMode: 'main' | 'private'
  readonly hasExternalRecipient: boolean
}): TrackOptions['collector'] {
  const inputAmount = sanitizeAnalyticsAmount(input.amountIn) || undefined
  const sourceDomain = input.isZecSource
    ? input.fundingSource === 'shielded'
      ? 'shield'
      : input.fundingSource === 'transparent'
        ? 'public'
        : undefined
    : input.purpose
      ? input.executionSourceMode === 'private'
        ? 'private'
        : 'public'
      : undefined
  const destinationDomain =
    input.purpose === 'public-private-send'
      ? 'private'
      : input.hasExternalRecipient
        ? undefined
        : input.isZecDestination
          ? input.zecDestinationType === 'shielded'
            ? 'shield'
            : input.zecDestinationType === 'transparent'
              ? 'public'
              : undefined
          : input.purpose
            ? input.destinationMode === 'private'
              ? 'private'
              : 'public'
            : undefined
  const shieldedRoute = sourceDomain === 'shield' || destinationDomain === 'shield'
  const privacyRoute = shieldedRoute
    ? 'zcash_shielded'
    : input.confidentiality === 'basic'
      ? 'confidential'
      : input.purpose && sourceDomain && destinationDomain
        ? 'direct'
        : undefined
  let usdAmount: string | undefined
  const priceTime = input.sourcePriceUpdatedAt ? Date.parse(input.sourcePriceUpdatedAt) : NaN
  if (
    inputAmount &&
    input.sourcePrice !== undefined &&
    Number.isFinite(input.sourcePrice) &&
    input.sourcePrice > 0 &&
    Number.isFinite(priceTime) &&
    input.now >= priceTime &&
    input.now - priceTime <= ASSET_PRICE_FRESH_MS
  ) {
    usdAmount =
      sanitizeAnalyticsAmount(new Big(inputAmount).times(input.sourcePrice).round(8).toFixed()) ||
      undefined
  }
  return {
    inputAmount,
    usdAmount,
    valuation: usdAmount ? 'partial' : 'unavailable',
    sourceDomain,
    destinationDomain,
    privacyRoute,
    transferType: input.hasExternalRecipient
      ? 'external'
      : input.purpose === 'wallet-swap' ||
          input.purpose === 'confidential-funding' ||
          input.purpose === 'private-transfer'
        ? 'self'
        : 'unknown',
    activityType: input.isTransfer ? 'transfer' : 'swap',
    ...(input.confidentiality === 'basic'
      ? { provider: 'near_confidential' as const }
      : shieldedRoute || input.isZecSource || input.isZecDestination
        ? { provider: 'zcash' as const }
        : {})
  }
}

type SwapAnalyticsDirection = 'zec_to_other' | 'other_to_zec' | 'same_chain' | 'cross_chain'

function sourceChainFamily(
  chainId: string | undefined,
  blockchain: string | undefined
): AnalyticsChain | undefined {
  if (blockchain === 'zec' || blockchain === 'zcash' || chainId === 'zcash') return 'zcash'
  if (blockchain === 'btc' || chainId === 'btc') return 'bitcoin'
  if (blockchain === 'sol' || chainId === 'solana') return 'solana'
  if (blockchain === 'near' || chainId === 'near') return 'near'
  if (chainId && /^\d+$/.test(chainId)) return 'evm'
  return undefined
}

export function resolveSwapAnalyticsContext(input: {
  readonly sourceFamily?: AnalyticsChain | null
  readonly sourceBlockchain?: string
  readonly destinationBlockchain?: string
  readonly sourceChainId?: string
  readonly destinationChainId?: string
  readonly isTransfer: boolean
  readonly executionSourceMode: 'main' | 'private'
}): {
  readonly chain?: AnalyticsChain
  readonly direction: SwapAnalyticsDirection
  readonly fundingSource?: 'main' | 'private'
} {
  const chain =
    sourceChainFamily(input.sourceChainId, input.sourceBlockchain) ??
    input.sourceFamily ??
    undefined
  const sourceIsZec = chain === 'zcash'
  const destinationIsZec =
    input.destinationBlockchain === 'zec' ||
    input.destinationBlockchain === 'zcash' ||
    input.destinationChainId === 'zcash'
  const sameChain =
    input.sourceChainId !== undefined && input.sourceChainId === input.destinationChainId
  const direction = sameChain
    ? 'same_chain'
    : sourceIsZec
      ? 'zec_to_other'
      : destinationIsZec
        ? 'other_to_zec'
        : 'cross_chain'

  return {
    chain,
    direction,
    ...(input.isTransfer ? { fundingSource: input.executionSourceMode } : {})
  }
}

export function resolveSwapAnalyticsAction(input: {
  readonly privateTransferRequested: boolean
  readonly privateBalanceTransferRequested: boolean
  readonly crossChainSendRequested: boolean
  readonly isPrivateFunding: boolean
}): { readonly isTransfer: boolean; readonly kind: 'private-transfer' | 'transfer' } {
  return {
    isTransfer:
      input.privateTransferRequested ||
      input.privateBalanceTransferRequested ||
      input.crossChainSendRequested ||
      input.isPrivateFunding,
    kind: input.crossChainSendRequested ? 'transfer' : 'private-transfer'
  }
}
