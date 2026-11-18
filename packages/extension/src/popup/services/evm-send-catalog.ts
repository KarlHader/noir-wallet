import { parseAssetId, type ChainDefinition } from '@/core/chains/registry'
import { RHEA_SWAP_CHAIN_CATALOG } from '@/core/services/rhea-swap'
import { getSolanaNetworkConfig } from '@/config/networks'
import { getConfidentialEvmChain } from '@/core/services/rhea-swap/rhea-confidential-support'
import { resolveCrossChainSendDestinationSupport } from './cross-chain-send-assets'
import { getEnabledSwapChains } from './swap-catalog-loading'
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

/** Reads already available single-chain catalogs without starting network requests. */
export function readEvmSendDestinationSupport(
  input: Parameters<typeof resolveCrossChainSendDestinationSupport>[0],
  client: Pick<typeof rheaSwapClient, 'readCachedTokens'> = rheaSwapClient
) {
  const local = resolveCrossChainSendDestinationSupport(input)
  if (local.status !== 'unknown' || !input.sourceAssetId) return local
  let sourceChainId: string
  try {
    sourceChainId = parseAssetId(input.sourceAssetId).chainId
  } catch {
    return local
  }
  const descriptorFor = (chainId: string) =>
    RHEA_SWAP_CHAIN_CATALOG.find(chain =>
      chain.walletFamily === 'evm'
        ? chainId === `eip155:${chain.apiChainId}`
        : chain.walletFamily === 'solana' && chainId === getSolanaNetworkConfig('mainnet').chainId
    )
  const source = descriptorFor(sourceChainId)
  const destination = descriptorFor(input.destinationChainId)
  if (!source || !destination) return local
  return resolveCrossChainSendDestinationSupport({
    ...input,
    sourceCatalog:
      input.sourceCatalog ??
      client.readCachedTokens({
        direction: 'from',
        tokenListChainIds: [source.tokenListChainId]
      }),
    destinationCatalog:
      input.destinationCatalog ??
      client.readCachedTokens({
        direction: 'cross-chain-to',
        tokenListChainIds: [destination.tokenListChainId]
      })
  })
}

/** Hydrates shared disk caches in the background; this never fetches catalogs. */
export async function hydrateEvmSendDestinationCatalogs(
  input: Readonly<{
    sourceChain: ChainDefinition
    destinationChains: readonly ChainDefinition[]
  }>,
  client: Pick<typeof rheaSwapClient, 'hydrateCachedTokens'> = rheaSwapClient
): Promise<void> {
  const source = getEnabledSwapChains([input.sourceChain])[0]
  if (!source) return
  await Promise.allSettled([
    client.hydrateCachedTokens({ direction: 'from', tokenListChainIds: [source.tokenListChainId] }),
    ...getEnabledSwapChains(input.destinationChains).map(destination =>
      client.hydrateCachedTokens({
        direction: 'cross-chain-to',
        tokenListChainIds: [destination.tokenListChainId]
      })
    )
  ])
}
