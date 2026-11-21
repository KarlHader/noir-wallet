import {
  RHEA_SWAP_CHAIN_CATALOG,
  getRheaSwapTokenRouteAddress,
  type RheaSwapToken
} from '@/core/services/rhea-swap'
import type { ChainDefinition } from '@/core/chains/registry'
import { rheaSwapClient } from './rhea-swap-client'
import { getChainFromAssetId } from '@/lib/format'
import { createDebugRequestId, logDebugTiming, traceDebugStage } from '@/lib/debug-performance'
import { resolveEvmChainIconAlias } from '@/config/icons'
import { BITCOIN_CHAIN_IDS, ZCASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { isDeprecatedIntentsToken } from '@/core/services/intents-evm-assets'
import {
  ASSET_PRICE_SOURCE_ASSETS,
  EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID,
  getEvmNativeProtocolAssetId
} from '@/config/asset-market-assets'
import { getEvmNetworkConfigs } from '@/config/networks'

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
  const builtIn = getEvmNetworkConfigs('mainnet').flatMap(network => {
    if (!supported.has(network.numericChainId)) return []
    const descriptor = RHEA_SWAP_CHAIN_CATALOG.find(
      chain => chain.apiChainId === String(network.numericChainId) && chain.walletFamily === 'evm'
    )
    if (!descriptor) return []
    const nativeAssetId = getEvmNativeProtocolAssetId(network.chainId)
    const usdcAssetId = EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID[network.chainId]
    return [
      ...(nativeAssetId
        ? [
            seed({
              assetId: nativeAssetId,
              blockchain: descriptor.blockchain,
              contractAddress: null,
              decimals: network.nativeCurrency.decimals,
              symbol: network.nativeCurrency.symbol,
              rheaChainId: descriptor.apiChainId,
              tokenListChainId: descriptor.tokenListChainId,
              rheaAddress: nativeAssetId,
              isNative: true
            })
          ]
        : []),
      ...(usdcAssetId && network.usdcContract
        ? [
            seed({
              assetId: usdcAssetId,
              blockchain: descriptor.blockchain,
              contractAddress: network.usdcContract.toLowerCase(),
              decimals: 6,
              symbol: 'USDC',
              rheaChainId: descriptor.apiChainId,
              tokenListChainId: descriptor.tokenListChainId,
              rheaAddress: network.usdcContract.toLowerCase(),
              isNative: false
            })
          ]
        : [])
    ]
  })
  const otherNative = [
    {
      chainId: 900010,
      apiChainId: 'zcash',
      assetId: ASSET_PRICE_SOURCE_ASSETS.zec,
      symbol: 'ZEC',
      decimals: 8
    },
    {
      chainId: 900002,
      apiChainId: 'btc',
      assetId: ASSET_PRICE_SOURCE_ASSETS.btc,
      symbol: 'BTC',
      decimals: 8
    },
    {
      chainId: 501,
      apiChainId: 'solana',
      assetId: ASSET_PRICE_SOURCE_ASSETS.sol,
      symbol: 'SOL',
      decimals: 9
    },
    {
      chainId: 900001,
      apiChainId: 'near',
      assetId: ASSET_PRICE_SOURCE_ASSETS.near,
      symbol: 'NEAR',
      decimals: 24
    }
  ].flatMap(native => {
    if (!supported.has(native.chainId)) return []
    const descriptor = RHEA_SWAP_CHAIN_CATALOG.find(
      chain => chain.tokenListChainId === native.chainId && chain.apiChainId === native.apiChainId
    )
    return descriptor
      ? [
          seed({
            assetId: native.assetId,
            blockchain: descriptor.blockchain,
            contractAddress: null,
            decimals: native.decimals,
            symbol: native.symbol,
            rheaChainId: descriptor.apiChainId,
            tokenListChainId: descriptor.tokenListChainId,
            rheaAddress: native.assetId,
            isNative: true
          })
        ]
      : []
  })
  return Object.freeze([...otherNative, ...builtIn])
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

export function isSameSwapTokenRouteIdentity(
  left: RheaSwapToken | null,
  right: RheaSwapToken | null
): boolean {
  if (!left || !right) return left === right
  return (
    left.assetId === right.assetId &&
    left.rheaChainId === right.rheaChainId &&
    getRheaSwapTokenRouteAddress(left) === getRheaSwapTokenRouteAddress(right) &&
    left.decimals === right.decimals &&
    left.isNative === right.isNative
  )
}

function findReverseCatalogToken(
  catalog: readonly RheaSwapToken[],
  token: RheaSwapToken
): RheaSwapToken | undefined {
  const matchesRoute = (candidate: RheaSwapToken) =>
    candidate.rheaChainId === token.rheaChainId &&
    getRheaSwapTokenRouteAddress(candidate) === getRheaSwapTokenRouteAddress(token) &&
    candidate.decimals === token.decimals &&
    candidate.isNative === token.isNative
  const exact = findSwapTokenInCatalog(catalog, token)
  return (exact && matchesRoute(exact) ? exact : undefined) ?? catalog.find(matchesRoute)
}

function isWalletErc20SwapToken(token: RheaSwapToken): boolean {
  if (token.isDisplaySeed || token.isNative || !/^[1-9]\d*$/.test(token.rheaChainId)) return false
  const contract = token.rheaAddress.toLowerCase()
  return (
    /^0x[0-9a-f]{40}$/.test(contract) &&
    token.contractAddress?.toLowerCase() === contract &&
    token.assetId.toLowerCase() === `eip155:${token.rheaChainId}/erc20:${contract}`
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
  const tokenIn =
    findReverseCatalogToken(sources, input.tokenOut) ??
    (isWalletErc20SwapToken(input.tokenOut) ? input.tokenOut : undefined)
  const tokenOut =
    findReverseCatalogToken(destinations, input.tokenIn) ??
    (isWalletErc20SwapToken(input.tokenIn) ? input.tokenIn : undefined)
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
      const address = /^[1-9]\d*$/.test(token.rheaChainId)
        ? token.rheaAddress.toLowerCase()
        : token.rheaAddress
      tokens.set(
        `${token.rheaChainId}:${address}:${token.assetId}:${token.decimals}:${token.isNative}`,
        token
      )
    }
  }
  const values = [...tokens.values()]
  const merged = values.filter(
    token => !token.isDisplaySeed || !findSwapTokenForDisplaySeed(values, token)
  )
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
  return catalog.find(candidate => isSameSwapTokenRouteIdentity(candidate, token))
}

export function findSwapTokenForDisplaySeed(
  catalog: readonly RheaSwapToken[],
  seed: RheaSwapToken
): RheaSwapToken | undefined {
  if (!seed.isDisplaySeed) return findSwapTokenInCatalog(catalog, seed)
  return catalog.find(
    candidate =>
      !candidate.isDisplaySeed &&
      candidate.tokenListChainId === seed.tokenListChainId &&
      candidate.rheaChainId === seed.rheaChainId &&
      candidate.assetId === seed.assetId &&
      candidate.decimals === seed.decimals &&
      candidate.isNative === seed.isNative &&
      (seed.isNative ||
        candidate.contractAddress?.toLowerCase() === seed.contractAddress?.toLowerCase())
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
  client: Pick<typeof rheaSwapClient, 'listTokens'> &
    Partial<Pick<typeof rheaSwapClient, 'readCachedTokens'>> = rheaSwapClient,
  options: { readonly strict?: boolean } = {}
): Promise<readonly RheaSwapToken[]> {
  const requestId = createDebugRequestId(`swap-catalog-${direction}`)
  const startedAt = performance.now()
  const uniqueChainIds = [...new Set(chainIds)]
  const completed = new Map<number, readonly RheaSwapToken[]>()
  const pendingChainIds = uniqueChainIds.filter(chainId => {
    const cached = bypassCache
      ? null
      : client.readCachedTokens?.({ direction, tokenListChainIds: [chainId] })
    if (!cached) return true
    const available = mergeTokenCatalogs(
      cached.tokens.filter(token => token.tokenListChainId === chainId)
    )
    if (cached.tokens.length > 0 && available.length === 0) return true
    completed.set(chainId, available)
    if (!isCancelled() && available.length > 0) onTokens(available)
    return false
  })
  let firstFailure: unknown = null
  let cursor = 0
  const worker = async () => {
    while (!isCancelled() && cursor < pendingChainIds.length) {
      const chainId = pendingChainIds[cursor++]
      try {
        const result = await traceDebugStage(requestId, `list-chain-${chainId}`, () =>
          client.listTokens({ direction, tokenListChainIds: [chainId] }, { bypassCache })
        )
        if (options.strict && result.failedChainIds.includes(chainId)) {
          throw new Error(`RHEA Swap token catalog is unavailable for chain ${chainId}`)
        }
        const onChain = result.tokens.filter(token => token.tokenListChainId === chainId)
        if (result.tokens.length > 0 && onChain.length === 0) {
          throw new Error(`RHEA Swap token catalog is unavailable for chain ${chainId}`)
        }
        if (result.failedChainIds.includes(chainId) && onChain.length === 0) {
          throw new Error(`RHEA Swap token catalog is unavailable for chain ${chainId}`)
        }
        const available = mergeTokenCatalogs(onChain)
        completed.set(chainId, available)
        if (!isCancelled() && available.length > 0) onTokens(available)
      } catch (error) {
        if (firstFailure === null) firstFailure = error
        // A failed chain must not discard catalogs that are already usable.
      }
    }
  }
  // Source and destination loaders run together with at most four requests total.
  await Promise.all(Array.from({ length: Math.min(2, pendingChainIds.length) }, worker))
  const tokens = mergeTokenCatalogs(...uniqueChainIds.map(chainId => completed.get(chainId) ?? []))
  logDebugTiming(requestId, `complete chains=${chainIds.length} tokens=${tokens.length}`, startedAt)
  if (options.strict && !isCancelled() && firstFailure !== null) throw firstFailure
  return tokens
}
