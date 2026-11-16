import { RHEA_SWAP_CHAIN_CATALOG, type RheaSwapToken } from '@/core/services/rhea-swap'
import type { ChainDefinition } from '@/core/chains/registry'
import { rheaSwapClient } from './rhea-swap-client'
import { getChainFromAssetId } from '@/lib/format'
import { createDebugRequestId, logDebugTiming, traceDebugStage } from '@/lib/debug-performance'
import { resolveEvmChainIconAlias } from '@/config/icons'
import { BITCOIN_CHAIN_IDS, ZCASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { isDeprecatedIntentsToken } from '@/core/services/intents-evm-assets'
import { ASSET_PRICE_SOURCE_ASSETS } from '@/config/asset-market-assets'
import { getEvmNetworkConfigs } from '@/config/networks'

const ETHEREUM_USDC_CONTRACT = getEvmNetworkConfigs('mainnet')
  .find(chain => chain.chainId === 'eip155:1')
  ?.usdcContract?.toLowerCase()

export function getSwapCatalogDisplaySeeds(chainIds: readonly number[]): readonly RheaSwapToken[] {
  const supported = new Set(chainIds)
  const seed = (
    input: Pick<
      RheaSwapToken,
      | 'assetId'
      | 'blockchain'
      | 'contractAddress'
      | 'decimals'
      | 'symbol'
      | 'rheaChainId'
      | 'tokenListChainId'
      | 'rheaAddress'
      | 'isNative'
    >
  ): RheaSwapToken =>
    Object.freeze({
      ...input,
      icon: null,
      price: 0,
      priceUpdatedAt: new Date(0).toISOString(),
      sources: Object.freeze([]),
      isDisplaySeed: true
    })
  return Object.freeze([
    ...(supported.has(900010)
      ? [
          seed({
            assetId: ASSET_PRICE_SOURCE_ASSETS.zec,
            blockchain: 'zec',
            contractAddress: null,
            decimals: 8,
            symbol: 'ZEC',
            rheaChainId: 'zcash',
            tokenListChainId: 900010,
            rheaAddress: 'zec',
            isNative: true
          })
        ]
      : []),
    ...(supported.has(1)
      ? [
          seed({
            assetId: ASSET_PRICE_SOURCE_ASSETS.eth,
            blockchain: 'eth',
            contractAddress: null,
            decimals: 18,
            symbol: 'ETH',
            rheaChainId: '1',
            tokenListChainId: 1,
            rheaAddress: 'eth',
            isNative: true
          })
        ]
      : []),
    ...(supported.has(1) && ETHEREUM_USDC_CONTRACT
      ? [
          seed({
            assetId: ASSET_PRICE_SOURCE_ASSETS.usdc,
            blockchain: 'eth',
            contractAddress: ETHEREUM_USDC_CONTRACT,
            decimals: 6,
            symbol: 'USDC',
            rheaChainId: '1',
            tokenListChainId: 1,
            rheaAddress: ETHEREUM_USDC_CONTRACT,
            isNative: false
          })
        ]
      : [])
  ])
}

export interface SwapInitialCatalogOptions {
  readonly catalogScope?: string | null
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
  return Boolean(
    tokenIn &&
    tokenOut &&
    getEnabledSwapChains(enabledChains).some(chain => chain.apiChainId === tokenOut.rheaChainId)
  )
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
  if (
    assetId === ASSET_PRICE_SOURCE_ASSETS.bnb ||
    /^nep141:bnb-0x[0-9a-f]{40}\.omdep\.near$/i.test(assetId)
  ) {
    return RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.apiChainId === '56')
  }
  const numericChain =
    /^nep245:[^:]+:([0-9]+)_/.exec(assetId)?.[1] ?? /^eip155:([0-9]+)(?:\/|$)/.exec(assetId)?.[1]
  if (numericChain) return RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.apiChainId === numericChain)
  if (assetId.startsWith('bip122:')) {
    const chainId = assetId.split('/')[0]
    const blockchain =
      chainId === ZCASH_CHAIN_IDS.mainnet
        ? 'zec'
        : chainId === BITCOIN_CHAIN_IDS.mainnet
          ? 'btc'
          : undefined
    return RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.blockchain === blockchain)
  }
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
    enabled.find(chain => chain.blockchain === 'zec') ??
    enabled.find(chain => chain.blockchain === 'eth') ??
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
    (source.walletFamily === 'evm'
      ? undefined
      : (enabled.find(chain => chain.blockchain === 'eth') ??
        enabled.find(chain => chain.apiChainId !== source.apiChainId)))
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
    for (const token of catalog) {
      if (isDeprecatedIntentsToken(token)) continue
      tokens.set(`${token.rheaChainId}:${token.rheaAddress}`, token)
    }
  }
  const merged = [...tokens.values()]
  const first = catalogs[0]
  if (first?.length === merged.length && merged.every((token, index) => token === first[index])) {
    return first
  }
  return Object.freeze(merged)
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

export async function prewarmInitialSwapCatalog(options: SwapInitialCatalogOptions): Promise<void> {
  const plan = buildInitialSwapCatalogPlan(options)
  const requests = [
    ...plan.sourceChainIds.map(chainId => ({ direction: 'from' as const, chainId })),
    ...plan.destinationChainIds.map(chainId => ({ direction: 'cross-chain-to' as const, chainId }))
  ]
  await Promise.all(
    requests.map(async ({ direction, chainId }) => {
      if (readCachedTokenCatalogByChain(direction, [chainId]).length > 0) return
      try {
        await rheaSwapClient.listTokens({ direction, tokenListChainIds: [chainId] })
      } catch {
        // Opening Swap can retry a failed background prewarm.
      }
    })
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
        const available = result.tokens.filter(token => !isDeprecatedIntentsToken(token))
        tokens.push(...available)
        if (!isCancelled() && available.length > 0) onTokens(available)
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
