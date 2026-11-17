import type { ChainDefinition } from '@/core/chains/registry'
import { getConfidentialEvmChain } from '@/core/services/rhea-swap/rhea-confidential-support'
import {
  getCrossChainSendTokenGroup,
  getCrossChainSendWalletAssetId,
  isCrossChainSendDestination,
  type CrossChainSendCapabilities
} from './cross-chain-send-assets'
import { getEnabledSwapChains } from './swap-catalog-loading'
import { getSwapDestinationTokens } from './swap-token-selection'
import { rheaSwapClient } from './rhea-swap-client'

export function evmSendCatalogRequest(chain: Pick<ChainDefinition, 'id' | 'family' | 'network'>) {
  const descriptor = getConfidentialEvmChain(chain)
  return descriptor
    ? { direction: 'from' as const, tokenListChainIds: [descriptor.tokenListChainId] }
    : null
}

export async function loadEvmSendCatalog(
  request: NonNullable<ReturnType<typeof evmSendCatalogRequest>>,
  isCurrent: () => boolean,
  onSettled: () => void,
  client: Pick<typeof rheaSwapClient, 'listTokens'> = rheaSwapClient
): Promise<void> {
  try {
    await client.listTokens(request)
  } catch {
    /* Unknown support remains blocked. */
  }
  if (isCurrent()) onSettled()
}

export async function loadEvmSendDestinationAsset(
  input: Readonly<{
    sourceChain: ChainDefinition
    sourceAssetId: string
    destinationChain: ChainDefinition
    capabilities: CrossChainSendCapabilities
  }>,
  client: Pick<typeof rheaSwapClient, 'listTokens'> = rheaSwapClient
): Promise<string | null> {
  const source = getEnabledSwapChains([input.sourceChain])[0]
  const destination = getEnabledSwapChains([input.destinationChain])[0]
  if (!source || !destination) return null
  const sourceCatalog = await client.listTokens({
    direction: 'from',
    tokenListChainIds: [source.tokenListChainId]
  })
  const sourceToken = sourceCatalog.tokens.find(
    token =>
      token.rheaChainId === source.apiChainId &&
      getCrossChainSendWalletAssetId(token) === input.sourceAssetId
  )
  if (!sourceToken || !getCrossChainSendTokenGroup(sourceToken)) {
    if (sourceCatalog.failedChainIds.includes(source.tokenListChainId)) {
      throw new Error(`Unable to load tokens on ${input.sourceChain.displayName}`)
    }
    return null
  }
  const targetCatalog = await client.listTokens({
    direction: 'cross-chain-to',
    tokenListChainIds: [destination.tokenListChainId]
  })
  const tokens = getSwapDestinationTokens(sourceToken, sourceCatalog.tokens, targetCatalog.tokens)
  const target = tokens.find(
    token =>
      token.rheaChainId === destination.apiChainId &&
      isCrossChainSendDestination(sourceToken, token, input.capabilities)
  )
  if (!target && targetCatalog.failedChainIds.includes(destination.tokenListChainId)) {
    throw new Error(`Unable to load tokens on ${input.destinationChain.displayName}`)
  }
  return target ? getCrossChainSendWalletAssetId(target) : null
}
