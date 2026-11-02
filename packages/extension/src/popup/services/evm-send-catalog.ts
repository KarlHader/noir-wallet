import type { ChainDefinition } from '@/core/chains/registry'
import { getConfidentialEvmChain } from '@/core/services/rhea-swap/rhea-confidential-support'
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

export async function prefetchEvmSendCatalogs(
  chains: readonly ChainDefinition[],
  preferredChainId: string | undefined,
  isCancelled: () => boolean,
  client: Pick<typeof rheaSwapClient, 'listTokens'> = rheaSwapClient
): Promise<void> {
  const requests = [...new Map(chains.map(chain => [chain.id, chain])).values()]
    .sort(
      (left, right) => Number(right.id === preferredChainId) - Number(left.id === preferredChainId)
    )
    .flatMap(chain => {
      const request = evmSendCatalogRequest(chain)
      return request ? [request] : []
    })
  let cursor = 0
  const worker = async () => {
    while (!isCancelled() && cursor < requests.length) {
      const request = requests[cursor++]
      try {
        await client.listTokens(request)
      } catch {
        /* The selected asset exposes retry. */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, requests.length) }, worker))
}
