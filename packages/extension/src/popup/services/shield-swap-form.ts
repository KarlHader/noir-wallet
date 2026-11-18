import type { Network } from '@/types'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { getZcashChainId } from '@/core/chains/registry'
import type { ConfidentialFundingReview } from '@/core/services/confidential-funding'
import Big from '@/lib/big'
import { formatSortAddress } from '@/lib/format'
import {
  formatBaseUnitDecimalAmount,
  formatTokenQuantity,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import type { PrepareConfidentialFundingRequest } from './confidential-funding-client'
import { shieldFundingAvailableRaw, type ShieldFundingAsset } from './shield-transfer'

export function shieldOriginIdentifiers(
  options: readonly ShieldFundingAsset[]
): ReadonlyMap<string, string | null> {
  const groups = new Map<string, ShieldFundingAsset[]>()
  for (const asset of options) {
    const key = `${asset.chain.chain.id}\0${asset.asset.metadata.symbol}`
    const group = groups.get(key) ?? []
    group.push(asset)
    groups.set(key, group)
  }
  const result = new Map<string, string | null>()
  for (const group of groups.values()) {
    const references = new Map<string, number>()
    for (const asset of group) {
      const reference = asset.asset.asset.reference
      references.set(reference, (references.get(reference) ?? 0) + 1)
    }
    const identities = group.map(asset =>
      (references.get(asset.asset.asset.reference) ?? 0) > 1
        ? asset.managed.protocolAssetId
        : asset.asset.asset.reference
    )
    const unresolved = new Set(group.map((_, index) => index))
    if (group.length === 1 && group[0].asset.asset.kind === 'native') {
      result.set(group[0].asset.asset.id, null)
      continue
    }
    const assignUnique = (labels: readonly string[]) => {
      const counts = new Map<string, number>()
      for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
      for (const index of unresolved) {
        if (counts.get(labels[index]) === 1) {
          result.set(group[index].asset.asset.id, labels[index])
          unresolved.delete(index)
        }
      }
    }
    assignUnique(identities.map(identity => formatSortAddress(identity)))
    const longest = identities.reduce((max, identity) => Math.max(max, identity.length), 0)
    for (let visible = 7; unresolved.size > 0 && visible <= longest; visible += 1) {
      assignUnique(
        identities.map(identity =>
          identity.length > visible * 2
            ? `${identity.slice(0, visible)}...${identity.slice(-visible)}`
            : identity
        )
      )
    }
    for (const index of unresolved) result.set(group[index].asset.asset.id, identities[index])
  }
  return result
}

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
    balances: readonly Readonly<{ tokenId: string; available: string }>[] | null
    slippageBps: number
    nativeZecRecipient?: string
  }>,
  preview = false
): PrepareConfidentialFundingRequest {
  const nativeZecSwap = input.nativeZecRecipient !== undefined
  const amountError = shieldSwapFormAmountError(input.amount, input.from, input.balances)
  if (
    input.from.managed.protocolAssetId === input.to.managed.protocolAssetId ||
    (nativeZecSwap &&
      (input.to.managed.chainId !== getZcashChainId(input.network) ||
        input.to.managed.protocolAssetId !== ZEC_ZCASH_ASSET ||
        input.to.managed.assetId !== `${getZcashChainId(input.network)}/slip44:133`)) ||
    (amountError &&
      !(
        preview &&
        (amountError === 'Insufficient Shield balance' ||
          amountError === 'Refresh your Shield balance')
      )) ||
    !Number.isSafeInteger(input.slippageBps) ||
    input.slippageBps < 0 ||
    input.slippageBps > 10_000
  )
    throw new Error('Shield swap is unavailable')
  if (nativeZecSwap) {
    try {
      const parsed = parseZcashAddress(input.nativeZecRecipient!, input.network)
      if (
        parsed.address !== input.nativeZecRecipient ||
        (!parsed.scheme.startsWith('zcash-transparent-') &&
          !input.nativeZecRecipient!.startsWith(input.network === 'mainnet' ? 'u1' : 'utest1'))
      )
        throw new Error('Invalid recipient')
    } catch {
      throw new Error('Shield swap recipient is invalid')
    }
  }
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
    ...(nativeZecSwap ? { purpose: 'native-zec-swap' as const } : {}),
    operation: nativeZecSwap ? 'withdraw' : 'swap',
    sourceDomain: 'shield',
    destinationDomain: nativeZecSwap ? 'public' : 'shield',
    source,
    destination,
    slippageBps: input.slippageBps,
    ...(nativeZecSwap ? { externalRecipient: input.nativeZecRecipient } : {})
  })
}

export function buildShieldSwapPreviewRequest(
  input: Parameters<typeof buildShieldSwapRequest>[0]
): PrepareConfidentialFundingRequest {
  return buildShieldSwapRequest(input, true)
}

export function matchesShieldSwapReview(
  review: ConfidentialFundingReview,
  request: PrepareConfidentialFundingRequest
): boolean {
  const nativeZecSwap = request.purpose === 'native-zec-swap'
  return (
    review.operation === (nativeZecSwap ? 'withdraw' : 'swap') &&
    review.sourceDomain === 'shield' &&
    review.destinationDomain === (nativeZecSwap ? 'public' : 'shield') &&
    review.purpose === request.purpose &&
    review.network === request.network &&
    review.keyDomainId === request.keyDomainId &&
    review.accountId === request.accountId &&
    review.sourceAmountRaw === request.source.amountRaw &&
    review.slippageBps === request.slippageBps &&
    review.withdrawCount === 1 &&
    !review.requiresDeposit &&
    (nativeZecSwap
      ? review.externalRecipient === request.externalRecipient &&
        review.destinationAddress === request.externalRecipient
      : review.sourceAddress.toLowerCase() === review.destinationAddress.toLowerCase())
  )
}
