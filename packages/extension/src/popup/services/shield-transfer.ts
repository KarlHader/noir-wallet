import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { SwapToken } from '@/core/services/intents-api'
import { isDeprecatedIntentsToken } from '@/core/services/intents-evm-assets'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { getEvmNetworkConfigs } from '@/config/networks'
import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getZcashChainId,
  getBundledInitialProductAssetDefinitions,
  parseAssetId
} from '@/core/chains/registry'
import {
  getAssetMarketMappings,
  getAssetProtocolSourceMappings
} from '@/core/prices/asset-market-mappings'
import type { FundingSource, Network } from '@/types'
import { isAddress } from 'viem'
import { parseZcashAddress } from '@/core/address-book/address-book'
import type { PrepareConfidentialFundingRequest } from './confidential-funding-client'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import type {
  ConfidentialFundingPlan,
  ConfidentialFundingReview
} from '@/core/services/confidential-funding'
import { getConfidentialAvailableForAsset } from '@/core/services/confidential-funding'
import type { TransferDomain } from './private-balance-transfer'
import { getCrossChainSendAssetGroup } from './cross-chain-send-assets'
import { formatIntentsConfirmationTime } from './confirmation-time-format'

type ShieldTransferAsset = Pick<
  IntentsManagedAsset,
  'assetId' | 'chainId' | 'protocolAssetId' | 'blockchain'
>

export type ShieldFundingAsset = Readonly<{
  asset: PortfolioAssetView
  chain: PortfolioChainView
  managed: ShieldTransferAsset
  marketAssetId?: string
}>

export interface ShieldTokenPickerItem {
  readonly key: string
  readonly assetId: string
  readonly symbol: string
  readonly name?: string
  readonly searchTerms?: readonly string[]
  readonly contractAddress?: string
  readonly iconUrl?: string
  readonly chainName: string
  readonly chainId: string
  readonly badgeBlockchain?: string
  readonly nativeIconChain?: string
  readonly zcashFundingSource?: FundingSource
  readonly sourceLabel?: string
  readonly availableRaw?: string
  readonly displayBalance?: string
  readonly decimals: number
  readonly priceUsd?: string | number | null
  readonly disabledReason?: string
  readonly subtitle?: string
  readonly title?: string
  readonly ariaLabel?: string
}

export function getZcashTokenPickerChain(network: Network) {
  return {
    chainId: getZcashChainId(network),
    chainName: network === 'testnet' ? 'Zcash Testnet' : 'Zcash',
    badgeBlockchain: 'zec'
  }
}

export function listShieldTokenPickerNetworks(
  rows: readonly Readonly<{ chainId: string; chainName: string; badgeBlockchain?: string }>[]
) {
  const networks = new Map<string, { id: string; label: string; iconChain: string }>()
  for (const { chainId, chainName, badgeBlockchain } of rows) {
    if (!networks.has(chainId)) {
      networks.set(chainId, {
        id: chainId,
        label: chainName,
        iconChain: badgeBlockchain ?? chainId
      })
    }
  }
  return [...networks.values()]
}

export function formatShieldQuoteTime(seconds: number): string {
  return formatIntentsConfirmationTime(seconds)
}

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
  const tokensByAssetId = new Map<string, SwapToken>()
  for (const token of catalogTokens) {
    if (!tokensByAssetId.has(token.assetId)) tokensByAssetId.set(token.assetId, token)
  }
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
    const token = tokensByAssetId.get(mapping.protocolAssetId)
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
    const token = tokensByAssetId.get(managed.protocolAssetId)
    if (
      (chain?.chain.family !== 'evm' && chain?.chain.id !== zcashChainId) ||
      chain.chain.capabilities.transaction.status !== 'available' ||
      !token ||
      isDeprecatedIntentsToken(token) ||
      token.decimals !== managed.decimals ||
      token.blockchain !== managed.blockchain
    )
      return []
    const holding = confidentialHolding(model, managed.protocolAssetId)
    const asset = fundingAssetView(model, managed, token.symbol, holding)
    if (!asset) return []
    seen.add(managed.protocolAssetId)
    return [{ asset, chain, managed, marketAssetId: token.coingeckoId?.trim() || undefined }]
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

export function selectDefaultShieldWithdrawSource(
  options: readonly ShieldFundingAsset[],
  balances: readonly Readonly<{ tokenId: string; available: string }>[] | null,
  model: PortfolioReadModel | null,
  prices: AssetPriceReadModel | null,
  network: Network
): ShieldFundingAsset | null {
  const funded = shieldFundingSources(options, balances)
  let highestValue: Big | null = null
  let highestValueSource: ShieldFundingAsset | null = null
  for (const option of funded) {
    const holding =
      model?.confidential?.status === 'ready'
        ? model.confidential.assets.find(
            item =>
              item.protocolAssetId === option.managed.protocolAssetId &&
              (item.assetId === undefined || item.assetId === option.asset.asset.id) &&
              (item.chainId === undefined || item.chainId === option.asset.asset.chainId)
          )
        : undefined
    const priceUsd = findAssetPrice(prices, option.asset.asset.id)?.priceUsd ?? holding?.priceUsd
    if (!priceUsd) continue
    const value = new Big(
      formatBaseUnitDecimalAmount(
        shieldFundingAvailableRaw(option, balances),
        option.asset.metadata.decimals
      )
    ).times(priceUsd)
    if (!highestValue || value.gt(highestValue)) {
      highestValue = value
      highestValueSource = option
    }
  }
  if (highestValueSource) return highestValueSource
  if (funded.length > 0) return funded[0]!

  const ethereumUsdc = getEvmNetworkConfigs(network)
    .find(config => config.chainId === 'eip155:1')
    ?.usdcContract?.toLowerCase()
  return (
    options.find(
      option =>
        option.asset.asset.chainId === 'eip155:1' &&
        option.asset.asset.namespace === 'erc20' &&
        option.asset.asset.reference.toLowerCase() === ethereumUsdc
    ) ??
    options[0] ??
    null
  )
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
          !isDeprecatedIntentsToken(token) &&
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
  if (!token || isDeprecatedIntentsToken(token)) return null
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
  return (from === 'public' && to === 'private') || (from === 'private' && to === 'public')
}

function isValidShieldFundingAsset(item: ShieldFundingAsset): boolean {
  return (
    item.chain.chain.capabilities.transaction.status === 'available' &&
    item.asset.asset.chainId === item.chain.chain.id &&
    item.managed.assetId === item.asset.asset.id &&
    item.managed.chainId === item.chain.chain.id
  )
}

function isShieldMoveDestination(
  source: ShieldFundingAsset,
  destination: ShieldFundingAsset,
  network: Network
): boolean {
  if (!isValidShieldFundingAsset(source) || !isValidShieldFundingAsset(destination)) return false
  if (source.chain.chain.family !== 'evm' || destination.chain.chain.family !== 'evm') return false
  if (source.asset.asset.id === destination.asset.asset.id) {
    return source.managed.protocolAssetId === destination.managed.protocolAssetId
  }
  if (source.chain.chain.id === destination.chain.chain.id) return false

  const chains = createInitialProductChainRegistry(network)
  const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions(network))
  const marketIds = new Map(
    getAssetMarketMappings(network, assets).map(mapping => [mapping.assetId, mapping.marketAssetId])
  )
  const protocolIds = new Map(
    getAssetProtocolSourceMappings(network, assets).map(mapping => [
      mapping.assetId,
      mapping.protocolAssetId
    ])
  )
  const sourceMarketId = marketIds.get(source.asset.asset.id)
  return Boolean(
    sourceMarketId &&
    sourceMarketId === marketIds.get(destination.asset.asset.id) &&
    protocolIds.get(source.asset.asset.id) === source.managed.protocolAssetId &&
    protocolIds.get(destination.asset.asset.id) === destination.managed.protocolAssetId
  )
}

export function listShieldMoveDestinations(
  source: ShieldFundingAsset,
  options: readonly ShieldFundingAsset[],
  network: Network
): readonly ShieldFundingAsset[] {
  return options.filter(option => isShieldMoveDestination(source, option, network))
}

function isShieldSendDestination(
  source: ShieldFundingAsset,
  destination: ShieldFundingAsset,
  network: Network
): boolean {
  if (!isValidShieldFundingAsset(source) || !isValidShieldFundingAsset(destination)) return false
  const zcashChainId = getZcashChainId(network)
  if (source.chain.chain.family !== 'evm' && source.chain.chain.id !== zcashChainId) return false
  if (destination.chain.chain.id === zcashChainId) {
    return (
      source.managed.protocolAssetId === destination.managed.protocolAssetId &&
      source.asset.asset.id === destination.asset.asset.id
    )
  }
  if (destination.chain.chain.family !== 'evm') return false
  if (source.asset.asset.id === destination.asset.asset.id)
    return source.managed.protocolAssetId === destination.managed.protocolAssetId
  if (network !== 'mainnet' || source.chain.chain.id === destination.chain.chain.id) return false
  const sourceGroup = getCrossChainSendAssetGroup(source.asset.asset)
  const destinationGroup = getCrossChainSendAssetGroup(destination.asset.asset)
  if (sourceGroup && destinationGroup) return sourceGroup === destinationGroup
  return Boolean(
    source.marketAssetId &&
    source.marketAssetId === destination.marketAssetId &&
    source.asset.metadata.symbol === destination.asset.metadata.symbol
  )
}

export function listShieldSendDestinations(
  source: ShieldFundingAsset,
  options: readonly ShieldFundingAsset[],
  network: Network
): readonly ShieldFundingAsset[] {
  return options.filter(option => isShieldSendDestination(source, option, network))
}

export function createShieldSendRoutes(options: readonly ShieldFundingAsset[], network: Network) {
  const destinationsByChain = new Map<string, ShieldFundingAsset[]>()
  for (const option of options) {
    if (!isShieldSendDestination(option, option, network)) continue
    const chainId = option.chain.chain.id
    const destinations = destinationsByChain.get(chainId)
    if (destinations) destinations.push(option)
    else destinationsByChain.set(chainId, [option])
  }

  const getDestination = (source: ShieldFundingAsset | null, chainId: string | null) => {
    if (!source || !chainId) return null
    const candidates = destinationsByChain.get(chainId)
    if (!candidates) return null
    return selectShieldWithdrawDestinationForNetwork(
      listShieldSendDestinations(source, candidates, network),
      source,
      chainId
    )
  }

  return {
    networks: Array.from(destinationsByChain.values(), ([first]) => first!.chain.chain),
    getDestination,
    getSources: (chainId: string) => options.filter(source => getDestination(source, chainId))
  }
}

export function estimateShieldSendRouteFee(
  source: ShieldFundingAsset,
  destination: ShieldFundingAsset,
  inputRaw: string,
  outputRaw: string
): Readonly<{ raw: string; decimals: number }> | null {
  const sourceGroup = getCrossChainSendAssetGroup(source.asset.asset)
  const destinationGroup = getCrossChainSendAssetGroup(destination.asset.asset)
  const sameAsset =
    source.asset.asset.id === destination.asset.asset.id ||
    (sourceGroup !== null && sourceGroup === destinationGroup) ||
    (source.marketAssetId !== undefined && source.marketAssetId === destination.marketAssetId)
  if (
    !sameAsset ||
    source.asset.metadata.symbol.toUpperCase() !==
      destination.asset.metadata.symbol.toUpperCase() ||
    !/^\d+$/.test(inputRaw) ||
    !/^\d+$/.test(outputRaw)
  )
    return null
  const decimals = Math.max(source.asset.metadata.decimals, destination.asset.metadata.decimals)
  const input = BigInt(inputRaw) * 10n ** BigInt(decimals - source.asset.metadata.decimals)
  const output = BigInt(outputRaw) * 10n ** BigInt(decimals - destination.asset.metadata.decimals)
  if (output > input) return null
  return { raw: (input - output).toString(), decimals }
}

export function isShieldWithdrawRecipient(
  recipient: string,
  destination: ShieldFundingAsset | null,
  network: Network
): boolean {
  if (!destination) return false
  if (destination.chain.chain.id === getZcashChainId(network)) {
    try {
      return parseZcashAddress(recipient, network).address === recipient
    } catch {
      return false
    }
  }
  return isAddress(recipient) && !/^0x0{40}$/i.test(recipient)
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
  return difference.toString()
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
    source: ShieldFundingAsset
    destination: ShieldFundingAsset
    slippageBps: number
  }>
): PrepareConfidentialFundingRequest {
  if (
    !isShieldWithdrawRecipient(input.recipient, input.destination, input.network) ||
    !/^[1-9]\d*$/.test(input.amountRaw) ||
    (input.source.chain.chain.family !== 'evm' &&
      input.source.chain.chain.id !== getZcashChainId(input.network)) ||
    !isShieldSendDestination(input.source, input.destination, input.network) ||
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
    destination?: ShieldFundingAsset
    feeSelection?: EvmFeeSelection
    dedupKey?: string
  }>
): PrepareConfidentialFundingRequest {
  const source: ShieldFundingAsset = {
    asset: input.asset,
    chain: input.chain,
    managed: input.managed
  }
  const destination = input.destination ?? source
  if (
    !(input.method === 'cluster'
      ? isClusterTransferRoute(input.from, input.to)
      : isShieldTransferRoute(input.from, input.to)) ||
    input.chain.chain.family !== 'evm' ||
    input.managed.assetId !== input.asset.asset.id ||
    input.managed.chainId !== input.chain.chain.id ||
    (input.destination !== undefined &&
      (input.from !== 'shield' ||
        (input.to !== 'public' && input.to !== 'private') ||
        input.method === 'cluster' ||
        !isShieldMoveDestination(source, destination, input.network))) ||
    !/^[1-9]\d*$/.test(input.amountRaw)
  ) {
    throw new Error('Shield transfer is unavailable')
  }
  const sourceRoute = Object.freeze({
    chainId: input.chain.chain.id,
    chainName: input.managed.blockchain,
    assetId: input.managed.assetId,
    protocolAssetId: input.managed.protocolAssetId
  })
  const destinationRoute = Object.freeze({
    chainId: destination.chain.chain.id,
    chainName: destination.managed.blockchain,
    assetId: destination.managed.assetId,
    protocolAssetId: destination.managed.protocolAssetId
  })
  return Object.freeze({
    network: input.network,
    keyDomainId: input.keyDomainId,
    accountId: input.accountId,
    operation:
      input.method === 'cluster' ? 'cluster' : input.to === 'shield' ? 'deposit' : 'withdraw',
    sourceDomain: input.from,
    destinationDomain: input.to,
    source: Object.freeze({ ...sourceRoute, amountRaw: input.amountRaw }),
    destination: destinationRoute,
    slippageBps: 50,
    ...(input.from === 'shield' || !input.feeSelection ? {} : { feeSelection: input.feeSelection }),
    ...(input.dedupKey ? { dedupKey: input.dedupKey } : {})
  })
}
