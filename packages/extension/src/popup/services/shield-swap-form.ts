import type { Network } from '@/types'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { ZEC_DECIMALS } from '@/config/wallet'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { getZcashChainId } from '@/core/chains/registry'
import type { ConfidentialFundingReview } from '@/core/services/confidential-funding'
import type { SwapToken } from '@/core/services/intents-api'
import Big from '@/lib/big'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatSortAddress } from '@/lib/format'
import {
  formatBaseUnitDecimalAmount,
  formatTokenQuantity,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import type { PrepareConfidentialFundingRequest } from './confidential-funding-client'
import { sortSendAssetsByBalanceValue } from './send-asset-order'
import {
  buildExternalShieldWithdrawRequest,
  getZcashTokenPickerChain,
  matchesExternalShieldWithdrawReview,
  shieldFundingAvailableRaw,
  type ShieldFundingAsset,
  type ShieldTokenPickerItem
} from './shield-transfer'

export const nativeZecDestinationKey = (source: 'transparent' | 'shielded') =>
  `native-zec-destination:${source}`

export function shieldSwapPickerChain(asset: ShieldFundingAsset) {
  const chain = asset.chain.chain
  return {
    chainId: chain.id,
    chainName: chain.displayName,
    badgeBlockchain: resolveChainIconAlias(chain.family, chain.displayName, chain.id),
    sourceLabel: asset.managed.protocolAssetId === ZEC_ZCASH_ASSET ? 'NEAR Confidential' : undefined
  }
}

export function sortShieldSwapPickerRows<Row extends ShieldTokenPickerItem>(
  rows: readonly Row[]
): readonly Row[] {
  return sortSendAssetsByBalanceValue(
    rows.map(row => ({
      key: row.key,
      amount:
        row.availableRaw === undefined
          ? null
          : formatBaseUnitDecimalAmount(row.availableRaw, row.decimals),
      priceUsd: row.priceUsd ?? null,
      row
    }))
  ).map(({ row }) => row)
}

function isNativeZecAsset(asset: ShieldFundingAsset, network: Network): boolean {
  const chainId = getZcashChainId(network)
  const assetId = `${chainId}/slip44:133`
  return (
    asset.chain.chain.id === chainId &&
    asset.asset.asset.id === assetId &&
    asset.managed.chainId === chainId &&
    asset.managed.assetId === assetId &&
    asset.managed.protocolAssetId === ZEC_ZCASH_ASSET
  )
}

export function canMoveShieldSwapZecToUnifiedAddress(
  source: ShieldFundingAsset | null,
  address: string | undefined,
  network: Network
): boolean {
  if (!source || !address || !isNativeZecAsset(source, network)) return false
  try {
    return parseZcashAddress(address, network).scheme === 'zcash-full-unified'
  } catch {
    return false
  }
}

export function buildShieldDestinationPickerRows({
  options,
  tokens,
  balances,
  network,
  source = null,
  nativeZecDestinations = []
}: Readonly<{
  options: readonly ShieldFundingAsset[]
  tokens: readonly SwapToken[]
  balances: readonly Readonly<{ tokenId: string; available: string }>[] | null
  network: Network
  source?: ShieldFundingAsset | null
  nativeZecDestinations?: readonly Readonly<{
    fundingSource: 'transparent' | 'shielded'
    address: string
    availableRaw: string | null
  }>[]
}>): (ShieldTokenPickerItem &
  (
    | { kind: 'native-zec'; fundingSource: 'transparent' | 'shielded' }
    | { kind: 'confidential' }
  ))[] {
  const origins = shieldOriginIdentifiers(options)
  const prices = new Map(tokens.map(token => [token.assetId, token.price]))
  const nativePrice = prices.get(ZEC_ZCASH_ASSET)
  const excludedProtocolAssetId = source?.managed.protocolAssetId
  return [
    ...nativeZecDestinations
      .filter(
        ({ fundingSource, address }) =>
          excludedProtocolAssetId !== ZEC_ZCASH_ASSET ||
          (fundingSource === 'shielded' &&
            canMoveShieldSwapZecToUnifiedAddress(source, address, network))
      )
      .map(({ address, availableRaw, fundingSource }) => ({
        ...getZcashTokenPickerChain(network),
        kind: 'native-zec' as const,
        fundingSource,
        key: nativeZecDestinationKey(fundingSource),
        assetId: 'zec',
        searchTerms: [address],
        symbol: 'ZEC',
        name: 'Zcash',
        nativeIconChain: 'zcash',
        zcashFundingSource: fundingSource,
        decimals: ZEC_DECIMALS,
        availableRaw: availableRaw ?? undefined,
        displayBalance: availableRaw === null ? '—' : undefined,
        priceUsd: nativePrice,
        title: address,
        ariaLabel: `ZEC ${fundingSource} on Zcash`
      })),
    ...options
      .filter(asset => asset.managed.protocolAssetId !== excludedProtocolAssetId)
      .map(asset => {
        const chain = asset.chain.chain
        const { id, reference } = asset.asset.asset
        const { symbol, name, iconUrl, decimals } = asset.asset.metadata
        const origin = origins.get(id)
        return {
          kind: 'confidential' as const,
          key: id,
          assetId: id,
          contractAddress: reference,
          symbol,
          name,
          iconUrl,
          decimals,
          ...shieldSwapPickerChain(asset),
          availableRaw: balances ? shieldFundingAvailableRaw(asset, balances) : undefined,
          displayBalance: balances ? undefined : '—',
          priceUsd: prices.get(asset.managed.protocolAssetId),
          title: asset.managed.protocolAssetId,
          subtitle: origin ? `${chain.displayName} · ${origin}` : chain.displayName
        }
      })
  ]
}

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
    nativeZecFundingSource?: 'transparent' | 'shielded'
  }>,
  preview = false
): PrepareConfidentialFundingRequest {
  const { nativeZecRecipient } = input
  const nativeZecSwap = nativeZecRecipient !== undefined
  const sameAsset = input.from.managed.protocolAssetId === input.to.managed.protocolAssetId
  const nativeZecMove =
    sameAsset &&
    input.nativeZecFundingSource === 'shielded' &&
    canMoveShieldSwapZecToUnifiedAddress(input.from, nativeZecRecipient, input.network)
  const amountError = shieldSwapFormAmountError(input.amount, input.from, input.balances)
  if (
    (sameAsset && !nativeZecMove) ||
    (nativeZecSwap && !isNativeZecAsset(input.to, input.network)) ||
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
  const amountRaw = parseDisplayUnitAmount(input.amount, input.from.asset.metadata.decimals)
  if (nativeZecMove && nativeZecRecipient !== undefined) {
    return Object.freeze({
      ...buildExternalShieldWithdrawRequest({
        network: input.network,
        keyDomainId: input.keyDomainId,
        accountId: input.accountId,
        amountRaw,
        recipient: nativeZecRecipient,
        source: input.from,
        destination: input.to,
        slippageBps: input.slippageBps
      }),
      purpose: 'move' as const
    })
  }
  if (nativeZecSwap) {
    try {
      const parsed = parseZcashAddress(nativeZecRecipient, input.network)
      if (!parsed.scheme.startsWith('zcash-transparent-') && parsed.scheme !== 'zcash-full-unified')
        throw new Error('Invalid recipient')
    } catch {
      throw new Error('Shield swap recipient is invalid')
    }
  }
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
    ...(nativeZecSwap ? { externalRecipient: nativeZecRecipient } : {})
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
  if (request.purpose === 'move') {
    return (
      review.purpose === 'move' &&
      review.externalRecipient === request.externalRecipient &&
      review.destinationAddress === request.externalRecipient &&
      matchesExternalShieldWithdrawReview(review, request)
    )
  }
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
