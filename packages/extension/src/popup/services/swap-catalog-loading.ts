import { RHEA_SWAP_CHAIN_CATALOG, type RheaSwapToken } from '@/core/services/rhea-swap'
import type { ChainDefinition } from '@/core/chains/registry'
import { rheaSwapClient } from './rhea-swap-client'
import { getChainFromAssetId } from '@/lib/format'
import { createDebugRequestId, logDebugTiming, traceDebugStage } from '@/lib/debug-performance'
import { resolveEvmChainIconAlias } from '@/config/icons'

export interface SwapInitialCatalogOptions {
  readonly sourceAssetId?: string | null
  readonly destinationAssetId?: string | null
  readonly destinationApiChainId?: string | null
  readonly defaultSourceChainId?: string | null
  readonly savedSourceAssetId?: string | null
  readonly savedDestinationAssetId?: string | null
  readonly enabledChains?: readonly ChainDefinition[]
  readonly enabledChainsError?: boolean
}

export function getEnabledSwapChains(enabledChains: readonly ChainDefinition[] = []) {
  const seen = new Set<number>()
  return enabledChains.flatMap(chain => {
    if (chain.network.kind !== 'mainnet') return []
    const match = RHEA_SWAP_CHAIN_CATALOG.find(candidate =>
      chain.family === 'evm'
        ? chain.id === `eip155:${candidate.apiChainId}` && candidate.walletFamily === 'evm'
        : candidate.walletFamily === chain.family
    )
    if (!match || seen.has(match.tokenListChainId)) return []
    seen.add(match.tokenListChainId)
    return [match]
  })
}

export function getUnavailableSwapNetworks(enabledChains: readonly ChainDefinition[] = []) {
  const supportedIds = new Set(
    getEnabledSwapChains(enabledChains).map(chain => `eip155:${chain.apiChainId}`)
  )
  return enabledChains.flatMap(chain => {
    if (chain.family !== 'evm' || supportedIds.has(chain.id)) return []
    const descriptor = RHEA_SWAP_CHAIN_CATALOG.find(
      candidate => chain.id === `eip155:${candidate.apiChainId}`
    )
    return [
      {
        id: descriptor?.blockchain ?? chain.id,
        label: chain.displayName,
        iconChain: resolveEvmChainIconAlias(chain.id)
      }
    ]
  })
}

export function isSwapAssetOnEnabledChain(
  assetId: string | null | undefined,
  enabledChains: readonly ChainDefinition[] | undefined
): boolean {
  const chain = assetChain(assetId)
  return Boolean(
    chain &&
    enabledChains &&
    getEnabledSwapChains(enabledChains).some(enabled => enabled.apiChainId === chain.apiChainId)
  )
}

export function canReverseSwapPair(
  tokenIn: RheaSwapToken | null,
  tokenOut: RheaSwapToken | null,
  enabledChains: readonly ChainDefinition[] | undefined
): boolean {
  return Boolean(tokenIn && tokenOut && isSwapAssetOnEnabledChain(tokenOut.assetId, enabledChains))
}

export async function loadReversedSwapPair(input: {
  readonly tokenIn: RheaSwapToken
  readonly tokenOut: RheaSwapToken
  readonly isCancelled: () => boolean
  readonly loadSources: () => Promise<readonly RheaSwapToken[]>
  readonly loadDestinations: () => Promise<readonly RheaSwapToken[]>
}): Promise<{ tokenIn: RheaSwapToken; tokenOut: RheaSwapToken } | null> {
  const [sources, crossChainDestinations] = await Promise.all([
    input.loadSources(),
    input.tokenIn.rheaChainId === input.tokenOut.rheaChainId
      ? Promise.resolve([])
      : input.loadDestinations()
  ])
  const destinations =
    input.tokenIn.rheaChainId === input.tokenOut.rheaChainId ? sources : crossChainDestinations
  if (input.isCancelled()) return null
  const tokenIn = findSwapTokenInCatalog(sources, input.tokenOut)
  const tokenOut = findSwapTokenInCatalog(destinations, input.tokenIn)
  if (!tokenIn || !tokenOut)
    throw new Error('This pair is unavailable in the reverse direction. Try another asset.')
  return { tokenIn, tokenOut }
}

function assetChain(assetId?: string | null) {
  if (!assetId) return undefined
  const numericChain =
    /^nep245:[^:]+:([0-9]+)_/.exec(assetId)?.[1] ?? /^eip155:([0-9]+)(?:\/|$)/.exec(assetId)?.[1]
  if (numericChain) return RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.apiChainId === numericChain)
  if (assetId.startsWith('bip122:'))
    return RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.apiChainId === 'btc')
  const blockchain = getChainFromAssetId(assetId)
  const aliases: Readonly<Record<string, string>> = {
    ethereum: 'eth',
    zcash: 'zec',
    bitcoin: 'btc',
    solana: 'sol',
    polygon: 'pol',
    optimism: 'op',
    avalanche: 'avax',
    arbitrum: 'arb',
    berachain: 'bera'
  }
  return RHEA_SWAP_CHAIN_CATALOG.find(
    chain => chain.blockchain === (aliases[blockchain] ?? blockchain)
  )
}

export function buildInitialSwapCatalogPlan(options: SwapInitialCatalogOptions) {
  const enabled = getEnabledSwapChains(options.enabledChains)
  const explicitDestination =
    assetChain(options.destinationAssetId) ??
    RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.apiChainId === options.destinationApiChainId)
  const preferredAccountChain = options.enabledChains?.find(
    chain => chain.id === options.defaultSourceChainId
  )
  const preferredSource = preferredAccountChain
    ? getEnabledSwapChains([preferredAccountChain])[0]
    : undefined
  const source =
    (isSwapAssetOnEnabledChain(options.sourceAssetId, options.enabledChains)
      ? assetChain(options.sourceAssetId)
      : undefined) ??
    enabled.find(
      chain => chain.apiChainId === assetChain(options.savedSourceAssetId)?.apiChainId
    ) ??
    preferredSource ??
    enabled[0]
  if (!source) return { sourceChainIds: [], destinationChainIds: [] }
  const savedDestination =
    options.savedSourceAssetId &&
    assetChain(options.savedSourceAssetId)?.apiChainId === source.apiChainId
      ? assetChain(options.savedDestinationAssetId)
      : undefined
  const target =
    explicitDestination ??
    savedDestination ??
    enabled.find(chain => chain.apiChainId !== source.apiChainId)
  return {
    sourceChainIds: [source.tokenListChainId],
    destinationChainIds:
      target && target.apiChainId !== source.apiChainId ? [target.tokenListChainId] : []
  }
}

export const WALLET_SOURCE_CHAIN_IDS = Object.freeze(
  RHEA_SWAP_CHAIN_CATALOG.filter(chain => chain.walletFamily !== undefined)
    .sort((left, right) => Number(right.blockchain === 'zec') - Number(left.blockchain === 'zec'))
    .map(chain => chain.tokenListChainId)
)
export const ALL_DESTINATION_CHAIN_IDS = Object.freeze(
  [
    ...RHEA_SWAP_CHAIN_CATALOG.filter(chain =>
      ['eth', 'zec', 'sol', 'near', 'btc'].includes(chain.blockchain)
    ),
    ...RHEA_SWAP_CHAIN_CATALOG.filter(
      chain => !['eth', 'zec', 'sol', 'near', 'btc'].includes(chain.blockchain)
    )
  ].map(chain => chain.tokenListChainId)
)

export function mergeTokenCatalogs(
  ...catalogs: readonly (readonly RheaSwapToken[])[]
): readonly RheaSwapToken[] {
  const tokens = new Map<string, RheaSwapToken>()
  for (const catalog of catalogs) {
    for (const token of catalog) tokens.set(`${token.rheaChainId}:${token.rheaAddress}`, token)
  }
  return Object.freeze([...tokens.values()])
}

export function findSwapTokenInCatalog(
  catalog: readonly RheaSwapToken[],
  token: RheaSwapToken
): RheaSwapToken | undefined {
  return catalog.find(
    candidate => candidate.assetId === token.assetId && candidate.blockchain === token.blockchain
  )
}

export function pickProvisionalSwapSource(
  tokens: readonly RheaSwapToken[],
  savedAssetId?: string | null
): RheaSwapToken | null {
  return (
    tokens.find(token => token.assetId === savedAssetId) ??
    tokens.find(token => token.isNative) ??
    tokens[0] ??
    null
  )
}

export function mergeSelectedSwapSourceCatalog(
  current: readonly RheaSwapToken[],
  selectorCatalog: readonly RheaSwapToken[],
  selected: RheaSwapToken
): readonly RheaSwapToken[] {
  return mergeTokenCatalogs(
    current,
    selectorCatalog.filter(token => token.tokenListChainId === selected.tokenListChainId),
    [selected]
  )
}

export function readCachedTokenCatalogByChain(
  direction: 'from' | 'cross-chain-to',
  chainIds: readonly number[]
): readonly RheaSwapToken[] {
  return mergeTokenCatalogs(
    ...chainIds.map(
      chainId =>
        rheaSwapClient.readCachedTokens({ direction, tokenListChainIds: [chainId] })?.tokens ?? []
    )
  )
}

export async function loadTokenCatalogByChain(
  direction: 'from' | 'cross-chain-to',
  chainIds: readonly number[],
  bypassCache: boolean,
  onTokens: (tokens: readonly RheaSwapToken[]) => void,
  isCancelled: () => boolean,
  client: Pick<typeof rheaSwapClient, 'listTokens'> = rheaSwapClient
): Promise<readonly RheaSwapToken[]> {
  const requestId = createDebugRequestId(`swap-catalog-${direction}`)
  const startedAt = performance.now()
  const tokens: RheaSwapToken[] = []
  let cursor = 0
  const worker = async () => {
    while (!isCancelled() && cursor < chainIds.length) {
      const chainId = chainIds[cursor++]
      try {
        const result = await traceDebugStage(requestId, `list-chain-${chainId}`, () =>
          client.listTokens({ direction, tokenListChainIds: [chainId] }, { bypassCache })
        )
        tokens.push(...result.tokens)
        if (!isCancelled() && result.tokens.length > 0) onTokens(result.tokens)
      } catch {
        // A failed chain must not discard catalogs that are already usable.
      }
    }
  }
  // Source and destination loaders run together with at most four requests total.
  await Promise.all(Array.from({ length: Math.min(2, chainIds.length) }, worker))
  logDebugTiming(requestId, `complete chains=${chainIds.length} tokens=${tokens.length}`, startedAt)
  return mergeTokenCatalogs(tokens)
}
