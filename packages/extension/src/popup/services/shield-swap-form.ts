import type { Network } from '@/types'
import type { ConfidentialFundingReview } from '@/core/services/confidential-funding'
import Big from '@/lib/big'
import {
  formatBaseUnitDecimalAmount,
  formatTokenQuantity,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import type { PrepareConfidentialFundingRequest } from './confidential-funding-client'
import { shieldFundingAvailableRaw, type ShieldFundingAsset } from './shield-transfer'

export function shieldSwapFormBalance(
  asset: ShieldFundingAsset | null,
  balances: readonly Readonly<{ tokenId: string; available: string }>[] | null
): string | null {
  return asset && balances
    ? formatBaseUnitDecimalAmount(
        shieldFundingAvailableRaw(asset, balances),
        asset.asset.metadata.decimals
      )
    : null
}

export function formatShieldSwapPreviewRate(
  amount: string,
  amountOutRaw: string,
  outputDecimals: number
): string {
  const output = formatBaseUnitDecimalAmount(amountOutRaw, outputDecimals)
  return formatTokenQuantity(new Big(output).div(amount).toString())
}

export function shieldSwapFormAmountError(
  amount: string,
  asset: ShieldFundingAsset | null,
  balances: readonly Readonly<{ tokenId: string; available: string }>[] | null
): string | null {
  if (!amount || !asset) return null
  try {
    const raw = BigInt(parseDisplayUnitAmount(amount, asset.asset.metadata.decimals))
    if (raw <= 0n) return 'Enter an amount greater than zero'
    if (!balances) return 'Refresh your Shield balance'
    if (raw > BigInt(shieldFundingAvailableRaw(asset, balances))) {
      return 'Insufficient Shield balance'
    }
    return null
  } catch {
    return 'Enter a valid amount'
  }
}

export function buildShieldSwapRequest(
  input: Readonly<{
    network: Network
    keyDomainId: string
    accountId: string
    from: ShieldFundingAsset
    to: ShieldFundingAsset
    amount: string
    balances: readonly Readonly<{ tokenId: string; available: string }>[]
    slippageBps: number
  }>
): PrepareConfidentialFundingRequest {
  if (
    input.from.managed.protocolAssetId === input.to.managed.protocolAssetId ||
    shieldSwapFormAmountError(input.amount, input.from, input.balances) ||
    !Number.isSafeInteger(input.slippageBps) ||
    input.slippageBps < 0 ||
    input.slippageBps > 10_000
  )
    throw new Error('Shield swap is unavailable')
  const amountRaw = parseDisplayUnitAmount(input.amount, input.from.asset.metadata.decimals)
  const source = Object.freeze({
    chainId: input.from.managed.chainId,
    chainName: input.from.managed.blockchain,
    assetId: input.from.managed.assetId,
    protocolAssetId: input.from.managed.protocolAssetId,
    amountRaw
  })
  const destination = Object.freeze({
    chainId: input.to.managed.chainId,
    chainName: input.to.managed.blockchain,
    assetId: input.to.managed.assetId,
    protocolAssetId: input.to.managed.protocolAssetId
  })
  return Object.freeze({
    network: input.network,
    keyDomainId: input.keyDomainId,
    accountId: input.accountId,
    operation: 'swap',
    sourceDomain: 'shield',
    destinationDomain: 'shield',
    source,
    destination,
    slippageBps: input.slippageBps
  })
}

export function matchesShieldSwapReview(
  review: ConfidentialFundingReview,
  request: PrepareConfidentialFundingRequest
): boolean {
  return (
    review.operation === 'swap' &&
    review.sourceDomain === 'shield' &&
    review.destinationDomain === 'shield' &&
    review.network === request.network &&
    review.keyDomainId === request.keyDomainId &&
    review.accountId === request.accountId &&
    review.sourceAmountRaw === request.source.amountRaw &&
    review.slippageBps === request.slippageBps &&
    review.withdrawCount === 1 &&
    !review.requiresDeposit &&
    review.sourceAddress.toLowerCase() === review.destinationAddress.toLowerCase()
  )
}
