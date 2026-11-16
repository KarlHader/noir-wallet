import type { ChainDefinition } from '@/core/chains/registry'
import { RHEA_SWAP_CHAIN_CATALOG, type RheaSwapToken } from './rhea-swap-model'
import type { RheaSwapCatalogResult } from './rhea-swap-service'

export type ConfidentialAssetSupport = 'supported' | 'unsupported' | 'unknown'

export function getConfidentialEvmChain(chain: Pick<ChainDefinition, 'id' | 'family' | 'network'>) {
  if (chain.family !== 'evm' || chain.network.kind !== 'mainnet') return undefined
  return RHEA_SWAP_CHAIN_CATALOG.find(
    candidate => candidate.walletFamily === 'evm' && chain.id === `eip155:${candidate.apiChainId}`
  )
}

function evmTokenAddress(token: RheaSwapToken): string | null {
  const address = token.contractAddress ?? token.rheaAddress
  return /^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : null
}

/** Same-chain destinations use the source catalog in SDK 2.0.6. */
export function resolveConfidentialEvmAssetSupport(input: {
  readonly chain: Pick<ChainDefinition, 'id' | 'family' | 'network'>
  readonly asset: { readonly chainId: string; readonly kind: string; readonly reference: string }
  readonly catalog: RheaSwapCatalogResult | null
}): ConfidentialAssetSupport {
  const chain = getConfidentialEvmChain(input.chain)
  if (!chain) return 'unsupported'
  if (input.asset.chainId !== input.chain.id) return 'unknown'
  const catalog = input.catalog
  if (!catalog || catalog.failedChainIds.length > 0 || catalog.tokens.length === 0) return 'unknown'
  // A mixed or malformed response cannot prove that an omitted asset is unsupported.
  if (
    catalog.tokens.some(
      token =>
        token.rheaChainId !== chain.apiChainId ||
        token.tokenListChainId !== chain.tokenListChainId ||
        (!token.isNative && evmTokenAddress(token) === null)
    )
  )
    return 'unknown'
  const matches = catalog.tokens.filter(token =>
    input.asset.kind === 'native'
      ? token.isNative
      : input.asset.kind === 'token' &&
        !token.isNative &&
        evmTokenAddress(token) === input.asset.reference.toLowerCase()
  )
  if (
    input.asset.kind !== 'native' &&
    (input.asset.kind !== 'token' || !/^0x[0-9a-f]{40}$/i.test(input.asset.reference))
  )
    return 'unknown'
  if (matches.length === 0) return 'unsupported'
  if (
    matches.some(token =>
      token.sources.some(source =>
        ['nearintents', 'preswap-nearintents'].includes(source.toLowerCase())
      )
    )
  )
    return 'supported'
  return matches.some(token => token.sources.length === 0) ? 'unknown' : 'unsupported'
}
