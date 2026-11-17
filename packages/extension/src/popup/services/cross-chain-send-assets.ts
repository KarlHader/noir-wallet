import { getEvmNetworkConfigs, getSolanaNetworkConfig } from '@/config/networks'
import {
  RHEA_SWAP_CHAIN_CATALOG,
  type RheaSwapCatalogResult,
  type RheaSwapToken
} from '@/core/services/rhea-swap'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  getInitialProductChainDefinitions,
  parseAssetId,
  type ChainDefinition
} from '@/core/chains/registry'
import { MARKET_ASSETS } from '@/config/asset-market-assets'
import { getAssetMarketMappings } from '@/core/prices/asset-market-mappings'
import type { MarketAssetId } from '@/core/prices/market-asset'
import { resolveRheaSwapCanonicalAssetId } from '@/core/services/rhea-swap/rhea-swap-asset-identity'
import type { Network } from '@/types'
import { getSendRouteCostFromAmounts } from './send-route-cost'
import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import { isSelectableChainFamily } from './chain-selection-availability'
import { getEnabledSwapChains } from './swap-catalog-loading'

type SendAssetIdentity = Readonly<{
  chainId: string
  namespace: string
  reference: string
}>

export type CrossChainSendAssetGroup = MarketAssetId | `protocol:${string}`
export type CrossChainSendCapabilities = Readonly<{ evm: boolean; solana: boolean }>

const mainnetAssets = createAssetRegistry(
  createInitialProductChainRegistry('mainnet'),
  getBundledInitialProductAssetDefinitions('mainnet')
)
const marketByAssetId = new Map(
  getAssetMarketMappings('mainnet', mainnetAssets).map(mapping => [
    mapping.assetId,
    mapping.marketAssetId
  ])
)

export function getCrossChainSendDestinationCandidates<
  T extends { readonly chain: ChainDefinition }
>(
  input: Readonly<{
    sourceChainId: string
    chains: readonly T[]
    enabledChainIds: readonly string[]
    capabilities: CrossChainSendCapabilities
    enabledFlags: readonly ChainFeatureFlagValue[]
  }>
) {
  const enabledChainIds = new Set(input.enabledChainIds)
  return input.chains.flatMap(chain => {
    if (
      chain.chain.id === input.sourceChainId ||
      !enabledChainIds.has(chain.chain.id) ||
      !isSelectableChainFamily(chain.chain.family, input.enabledFlags) ||
      chain.chain.capabilities.transaction.status !== 'available'
    )
      return []
    const descriptor = getEnabledSwapChains([chain.chain])[0]
    return descriptor &&
      ((descriptor.walletFamily === 'evm' && input.capabilities.evm) ||
        (descriptor.walletFamily === 'solana' && input.capabilities.solana))
      ? [{ chain, descriptor }]
      : []
  })
}

export function resolveCrossChainSendRouteAssetDisplay(
  input: Readonly<{
    network: Network
    sourceAssetId: string | null
    destinationAssetId?: string | null
    destinationChainId?: string | null
  }>
) {
  if (input.network !== 'mainnet' || !input.sourceAssetId) return null
  try {
    const source = parseAssetId(input.sourceAssetId)
    const destination = input.destinationAssetId ? parseAssetId(input.destinationAssetId) : null
    if (destination && input.destinationChainId && destination.chainId !== input.destinationChainId)
      return null
    const destinationChainId = input.destinationChainId ?? destination?.chainId
    const chains = getInitialProductChainDefinitions(input.network)
    const sourceChain = chains.find(chain => chain.id === source.chainId)
    const destinationChain = chains.find(chain => chain.id === destinationChainId)
    if (!sourceChain || !destinationChain) return null
    return {
      sourceSymbol: mainnetAssets.get(source.id)?.metadata.symbol,
      sourceNetworkName: sourceChain.displayName,
      destinationName: destinationChain.displayName
    }
  } catch {
    return null
  }
}

export function resolveCrossChainSendRouteDraft(
  input: Readonly<{
    network: Network
    walletId: string | null
    accountId: string | null
    currentWalletId: string | null
    currentAccountId: string | null
    routeWalletId: string | null
    routeAccountId: string | null
    navigationState: unknown
    sourceAssetId: string | null
    destinationAssetId?: string | null
    destinationChainId?: string | null
    recipient: string | null
    amount: string | null
  }>
) {
  const display = resolveCrossChainSendRouteAssetDisplay(input)
  const routeAccount =
    typeof input.navigationState === 'object' &&
    input.navigationState !== null &&
    'crossChainSendRouteAccount' in input.navigationState
      ? input.navigationState.crossChainSendRouteAccount
      : null
  const destinationChainId =
    input.destinationChainId ?? input.destinationAssetId?.split('/')[0] ?? null
  const navigationMatches =
    !input.walletId &&
    !input.accountId &&
    !input.currentWalletId &&
    !input.currentAccountId &&
    typeof routeAccount === 'object' &&
    routeAccount !== null &&
    'walletId' in routeAccount &&
    routeAccount.walletId === input.routeWalletId &&
    'accountId' in routeAccount &&
    routeAccount.accountId === input.routeAccountId &&
    'sourceAssetId' in routeAccount &&
    routeAccount.sourceAssetId === input.sourceAssetId &&
    (input.destinationAssetId
      ? 'destinationAssetId' in routeAccount &&
        routeAccount.destinationAssetId === input.destinationAssetId &&
        (!('destinationChainId' in routeAccount) ||
          routeAccount.destinationChainId === destinationChainId)
      : Boolean(destinationChainId) &&
        'destinationChainId' in routeAccount &&
        routeAccount.destinationChainId === destinationChainId &&
        (!('destinationAssetId' in routeAccount) || routeAccount.destinationAssetId == null))
  if (
    !display ||
    !input.routeWalletId ||
    !input.routeAccountId ||
    !(
      (input.walletId === input.routeWalletId && input.accountId === input.routeAccountId) ||
      navigationMatches
    )
  )
    return null
  return {
    ...display,
    walletId: input.routeWalletId,
    accountId: input.routeAccountId,
    recipient: input.recipient ?? '',
    amount: input.amount ?? ''
  }
}

const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const MAINNET_EVM_NETWORKS = getEvmNetworkConfigs('mainnet')

export function getCrossChainSendAssetGroup(
  asset: SendAssetIdentity
): CrossChainSendAssetGroup | null {
  if (
    asset.chainId.startsWith('solana:') &&
    asset.namespace === 'token' &&
    asset.reference === SOLANA_USDC_MINT
  ) {
    return MARKET_ASSETS.usdc
  }
  const reference = asset.namespace === 'erc20' ? asset.reference.toLowerCase() : asset.reference
  return marketByAssetId.get(`${asset.chainId}/${asset.namespace}:${reference}`) ?? null
}

export function getCrossChainSendDestinationAssetId(
  chainId: string,
  group: CrossChainSendAssetGroup
): string | null {
  if (group.startsWith('protocol:')) return null
  if (group === MARKET_ASSETS.usdc && chainId.startsWith('solana:'))
    return `${chainId}/token:${SOLANA_USDC_MINT}`
  return (
    [...marketByAssetId].find(
      ([assetId, marketId]) => assetId.startsWith(`${chainId}/`) && marketId === group
    )?.[0] ?? null
  )
}

export function getCrossChainSendTokenGroup(token: RheaSwapToken): CrossChainSendAssetGroup | null {
  const walletAssetId = getCrossChainSendWalletAssetId(token)
  if (!walletAssetId) return null
  const canonicalAssetId = resolveRheaSwapCanonicalAssetId(token.assetId)
  if (
    canonicalAssetId &&
    (canonicalAssetId.startsWith('eip155:') || canonicalAssetId.startsWith('solana:')) &&
    canonicalAssetId !== walletAssetId
  )
    return null
  const known = marketByAssetId.get(walletAssetId)
  if (known) return known
  if (!token.isNative && token.rheaChainId === 'solana' && token.rheaAddress === SOLANA_USDC_MINT)
    return MARKET_ASSETS.usdc
  return /^nep(?:141|245):[^\s]+$/.test(token.assetId) ? `protocol:${token.assetId}` : null
}

export function getCrossChainSendWalletAssetId(token: RheaSwapToken): string | null {
  const chainId =
    token.rheaChainId === 'solana'
      ? getSolanaNetworkConfig('mainnet').chainId
      : `eip155:${token.rheaChainId}`
  if (token.isNative) {
    if (token.rheaChainId === 'solana') return `${chainId}/slip44:501`
    const evm = MAINNET_EVM_NETWORKS.find(network => network.chainId === chainId)
    return evm ? `${chainId}/slip44:${evm.nativeCurrency.slip44Reference}` : null
  }
  if (token.rheaChainId === 'solana') {
    try {
      return parseSolanaPublicKey(token.rheaAddress) === token.rheaAddress
        ? `${chainId}/token:${token.rheaAddress}`
        : null
    } catch {
      return null
    }
  }
  const address = token.contractAddress ?? token.rheaAddress
  return /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/i.test(address)
    ? `${chainId}/erc20:${address.toLowerCase()}`
    : null
}

export function isCrossChainSendDestination(
  source: RheaSwapToken | null,
  destination: RheaSwapToken,
  capabilities: CrossChainSendCapabilities
): boolean {
  if (
    !source ||
    source.rheaChainId === destination.rheaChainId ||
    !isCrossChainSendChainEnabled(source, capabilities)
  )
    return false
  const group = getCrossChainSendTokenGroup(source)
  if (!group || getCrossChainSendTokenGroup(destination) !== group) return false
  return isCrossChainSendChainEnabled(destination, capabilities)
}

export interface CrossChainSendDestinationSupport {
  readonly status: 'available' | 'unavailable' | 'unknown'
  readonly destinationAssetId: string | null
  readonly disabledReason?: string
}

/** Resolves asset identity only; a quote still determines route availability. */
export function resolveCrossChainSendDestinationSupport(
  input: Readonly<{
    sourceAssetId: string | null
    sourceToken?: RheaSwapToken | null
    destinationChainId: string
    sourceCatalog?: RheaSwapCatalogResult | null
    destinationCatalog?: RheaSwapCatalogResult | null
    capabilities?: CrossChainSendCapabilities
  }>
): CrossChainSendDestinationSupport {
  const unknown: CrossChainSendDestinationSupport = {
    status: 'unknown',
    destinationAssetId: null
  }
  if (!input.sourceAssetId) return unknown
  let source: ReturnType<typeof parseAssetId>
  try {
    source = parseAssetId(input.sourceAssetId)
  } catch {
    return unknown
  }
  const sourceAssetId =
    source.namespace === 'erc20'
      ? `${source.chainId}/erc20:${source.reference.toLowerCase()}`
      : source.id
  if (source.chainId === input.destinationChainId)
    return { status: 'available', destinationAssetId: sourceAssetId }
  const unavailable: CrossChainSendDestinationSupport = {
    status: 'unavailable',
    destinationAssetId: null,
    disabledReason: 'Same asset unavailable'
  }
  const capabilities = input.capabilities ?? { evm: true, solana: true }
  const descriptorFor = (chainId: string) =>
    RHEA_SWAP_CHAIN_CATALOG.find(chain =>
      chain.walletFamily === 'evm'
        ? chainId === `eip155:${chain.apiChainId}`
        : chain.walletFamily === 'solana' && chainId === getSolanaNetworkConfig('mainnet').chainId
    )
  const sourceDescriptor = descriptorFor(source.chainId)
  const destinationDescriptor = descriptorFor(input.destinationChainId)
  const enabled = (descriptor: typeof sourceDescriptor) =>
    descriptor?.walletFamily === 'evm'
      ? capabilities.evm
      : descriptor?.walletFamily === 'solana' && capabilities.solana
  if (
    !sourceDescriptor ||
    !destinationDescriptor ||
    !enabled(sourceDescriptor) ||
    !enabled(destinationDescriptor)
  )
    return unavailable

  // Bundled canonical identities are authoritative for the supported native/USDC set.
  const canonicalGroup = getCrossChainSendAssetGroup(source)
  if (canonicalGroup) {
    const destinationAssetId = getCrossChainSendDestinationAssetId(
      input.destinationChainId,
      canonicalGroup
    )
    return destinationAssetId ? { status: 'available', destinationAssetId } : unavailable
  }

  const complete = (
    catalog: RheaSwapCatalogResult | null | undefined,
    descriptor: NonNullable<typeof sourceDescriptor>
  ): catalog is RheaSwapCatalogResult =>
    Boolean(
      catalog &&
      catalog.failedChainIds.length === 0 &&
      catalog.tokens.length > 0 &&
      catalog.tokens.every(
        token =>
          token.rheaChainId === descriptor.apiChainId &&
          token.tokenListChainId === descriptor.tokenListChainId &&
          !token.isDisplaySeed
      )
    )
  const providedSource = input.sourceToken
  const sourceToken =
    providedSource &&
    !providedSource.isDisplaySeed &&
    providedSource.rheaChainId === sourceDescriptor.apiChainId &&
    providedSource.tokenListChainId === sourceDescriptor.tokenListChainId &&
    getCrossChainSendWalletAssetId(providedSource) === sourceAssetId
      ? providedSource
      : complete(input.sourceCatalog, sourceDescriptor)
        ? input.sourceCatalog.tokens.find(
            token => getCrossChainSendWalletAssetId(token) === sourceAssetId
          )
        : null
  if (
    !sourceToken ||
    !getCrossChainSendTokenGroup(sourceToken) ||
    (input.sourceCatalog && !complete(input.sourceCatalog, sourceDescriptor)) ||
    !complete(input.destinationCatalog, destinationDescriptor)
  )
    return unknown
  const destination = input.destinationCatalog.tokens.find(
    token =>
      token.assetId === sourceToken.assetId &&
      isCrossChainSendDestination(sourceToken, token, capabilities)
  )
  return destination
    ? { status: 'available', destinationAssetId: getCrossChainSendWalletAssetId(destination) }
    : unavailable
}

export function getCrossChainSendRouteCost(
  input: Readonly<{
    source: RheaSwapToken | null
    destination: RheaSwapToken | null
    amountInRaw: string
    estimatedOutRaw: string
  }>
): string | null {
  const { source, destination } = input
  if (
    !source ||
    !destination ||
    source.rheaChainId === destination.rheaChainId ||
    !getCrossChainSendTokenGroup(source) ||
    getCrossChainSendTokenGroup(source) !== getCrossChainSendTokenGroup(destination)
  )
    return null
  return getSendRouteCostFromAmounts({
    amountInRaw: input.amountInRaw,
    estimatedOutRaw: input.estimatedOutRaw,
    decimals: source.decimals,
    outputDecimals: destination.decimals,
    clampNegative: true
  })
}

export function filterCrossChainSendDestinations(
  source: RheaSwapToken | null,
  destinations: readonly RheaSwapToken[],
  capabilities: CrossChainSendCapabilities
): readonly RheaSwapToken[] {
  return destinations.filter(destination =>
    isCrossChainSendDestination(source, destination, capabilities)
  )
}

export function resolveCrossChainSendDestinationByWalletAssetId(
  source: RheaSwapToken | null,
  walletAssetId: string | null,
  destinations: readonly RheaSwapToken[],
  capabilities: CrossChainSendCapabilities
): RheaSwapToken | null {
  if (!walletAssetId) return null
  let asset: ReturnType<typeof parseAssetId>
  try {
    asset = parseAssetId(walletAssetId)
  } catch {
    return null
  }
  return (
    destinations.find(destination => {
      const chainMatches =
        asset.chainId === `eip155:${destination.rheaChainId}` ||
        (asset.chainId.startsWith('solana:') && destination.rheaChainId === 'solana')
      return (
        chainMatches &&
        getCrossChainSendWalletAssetId(destination) === asset.id &&
        isCrossChainSendDestination(source, destination, capabilities)
      )
    }) ?? null
  )
}

export function isCrossChainSendChainEnabled(
  token: RheaSwapToken,
  capabilities: CrossChainSendCapabilities
): boolean {
  const chain = RHEA_SWAP_CHAIN_CATALOG.find(
    candidate => candidate.apiChainId === token.rheaChainId
  )
  return chain?.walletFamily === 'evm'
    ? capabilities.evm
    : chain?.walletFamily === 'solana'
      ? capabilities.solana
      : false
}

export function isCrossChainSendRecipientValid(
  destination: RheaSwapToken | null,
  address: string
): boolean {
  if (!destination || !address) return false
  if (destination.rheaChainId === 'solana') {
    try {
      return parseSolanaPublicKey(address) === address
    } catch {
      return false
    }
  }
  return /^0x[0-9a-fA-F]{40}$/.test(address)
}
