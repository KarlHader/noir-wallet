import { getEvmNetworkConfigs, getSolanaNetworkConfig } from '@/config/networks'
import { RHEA_SWAP_CHAIN_CATALOG, type RheaSwapToken } from '@/core/services/rhea-swap'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import { getInitialProductChainDefinitions, parseAssetId } from '@/core/chains/registry'
import type { Network } from '@/types'
import { getSendRouteCostFromAmounts } from './send-route-cost'

type SendAssetIdentity = Readonly<{
  chainId: string
  namespace: string
  reference: string
}>

export type CrossChainSendAssetGroup = 'ETH' | 'USDC'
export type CrossChainSendCapabilities = Readonly<{ evm: boolean; solana: boolean }>

export function resolveCrossChainSendRouteAssetDisplay(
  input: Readonly<{
    network: Network
    sourceAssetId: string | null
    destinationAssetId: string | null
  }>
) {
  if (input.network !== 'mainnet' || !input.sourceAssetId || !input.destinationAssetId) return null
  try {
    const source = parseAssetId(input.sourceAssetId)
    const destination = parseAssetId(input.destinationAssetId)
    const group = getCrossChainSendAssetGroup(source)
    if (!group || getCrossChainSendAssetGroup(destination) !== group) return null
    const chains = getInitialProductChainDefinitions(input.network)
    const sourceChain = chains.find(chain => chain.id === source.chainId)
    const destinationChain = chains.find(chain => chain.id === destination.chainId)
    if (!sourceChain || !destinationChain || sourceChain.id === destinationChain.id) return null
    return {
      sourceSymbol: group,
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
    destinationAssetId: string | null
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
    'destinationAssetId' in routeAccount &&
    routeAccount.destinationAssetId === input.destinationAssetId
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
  const evm = MAINNET_EVM_NETWORKS.find(network => network.chainId === asset.chainId)
  if (
    evm?.nativeCurrency.symbol === 'ETH' &&
    asset.namespace === 'slip44' &&
    asset.reference === evm.nativeCurrency.slip44Reference
  ) {
    return 'ETH'
  }
  if (
    evm?.usdcContract &&
    asset.namespace === 'erc20' &&
    asset.reference.toLowerCase() === evm.usdcContract.toLowerCase()
  ) {
    return 'USDC'
  }
  if (
    asset.chainId.startsWith('solana:') &&
    asset.namespace === 'token' &&
    asset.reference === SOLANA_USDC_MINT
  ) {
    return 'USDC'
  }
  return null
}

export function getCrossChainSendDestinationAssetId(
  chainId: string,
  group: CrossChainSendAssetGroup
): string | null {
  const evm = MAINNET_EVM_NETWORKS.find(network => network.chainId === chainId)
  if (evm) {
    if (group === 'ETH' && evm.nativeCurrency.symbol === 'ETH') {
      return `${chainId}/slip44:${evm.nativeCurrency.slip44Reference}`
    }
    if (group === 'USDC' && evm.usdcContract) {
      return `${chainId}/erc20:${evm.usdcContract}`
    }
  }
  return group === 'USDC' && chainId.startsWith('solana:')
    ? `${chainId}/token:${SOLANA_USDC_MINT}`
    : null
}

export function getCrossChainSendTokenGroup(token: RheaSwapToken): CrossChainSendAssetGroup | null {
  const evm = MAINNET_EVM_NETWORKS.find(
    network => network.chainId === `eip155:${token.rheaChainId}`
  )
  if (evm?.nativeCurrency.symbol === 'ETH' && token.isNative) return 'ETH'
  const evmContract = token.contractAddress ?? token.rheaAddress
  if (
    evm?.usdcContract &&
    !token.isNative &&
    /^0x[0-9a-fA-F]{40}$/.test(evmContract) &&
    evmContract.toLowerCase() === evm.usdcContract.toLowerCase()
  ) {
    return 'USDC'
  }
  if (token.rheaChainId === 'solana' && !token.isNative && token.rheaAddress === SOLANA_USDC_MINT) {
    return 'USDC'
  }
  return null
}

export function getCrossChainSendWalletAssetId(token: RheaSwapToken): string | null {
  const group = getCrossChainSendTokenGroup(token)
  if (!group) return null
  const chainId =
    token.rheaChainId === 'solana'
      ? getSolanaNetworkConfig('mainnet').chainId
      : `eip155:${token.rheaChainId}`
  return getCrossChainSendDestinationAssetId(chainId, group)
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
  const group = getCrossChainSendAssetGroup(asset)
  if (!group) return null
  return (
    destinations.find(destination => {
      const chainMatches =
        asset.chainId === `eip155:${destination.rheaChainId}` ||
        (asset.chainId.startsWith('solana:') && destination.rheaChainId === 'solana')
      return (
        chainMatches &&
        getCrossChainSendTokenGroup(destination) === group &&
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
