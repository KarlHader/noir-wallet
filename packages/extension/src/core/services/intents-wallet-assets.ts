import { getNearNetworkConfig, getSolanaNetworkConfig } from '@/config/networks'
import { WNEAR_NEAR_ASSET } from '@/config/intents'
import type { Network } from '@/types'
import type { AssetDefinitionInput } from '@/core/chains/registry'
import { createMarketAssetId, type MarketAssetId } from '@/core/prices'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'

import { resolveSwapTokenIconUrl, type SwapToken } from './intents-api'
import { isDeprecatedIntentsToken } from './intents-evm-assets'

export interface IntentsWalletAssetDescriptor {
  readonly assetId: string
  readonly chainId: string
  readonly namespace: 'slip44' | 'token' | 'nep141'
  readonly reference: string
  readonly kind: 'native' | 'token'
}

export interface IntentsProtocolAssetPreference {
  readonly assetId: string
  readonly visibleByDefault: boolean
}

export interface IntentsProtocolAssetPriceMapping {
  readonly assetId: string
  readonly marketAssetId: MarketAssetId
  readonly sourceAssetId: string
}

export interface IntentsWalletAssetCatalogEntry extends IntentsWalletAssetDescriptor {
  readonly protocolAssetId: string
  readonly blockchain: string
  readonly symbol: string
  readonly decimals: number
  readonly iconUrl?: string
  readonly visibleByDefault: boolean
}

export interface IntentsWalletAssetCatalog {
  readonly entries: readonly IntentsWalletAssetCatalogEntry[]
  readonly definitions: readonly AssetDefinitionInput[]
  readonly preferences: readonly IntentsProtocolAssetPreference[]
  readonly priceMappings: readonly IntentsProtocolAssetPriceMapping[]
}

const ONE_CLICK_ASSET_ID_PATTERN = /^[-%:._a-zA-Z0-9]{1,256}$/
const FALLBACK_MARKET_ASSET_ID = createMarketAssetId('intents-asset')
const RHEA_LIQUID_NEAR_ASSET = Object.freeze({
  assetId: 'near:mainnet/nep141:lst.rhealab.near',
  chainId: 'near:mainnet',
  namespace: 'nep141' as const,
  reference: 'lst.rhealab.near',
  kind: 'token' as const,
  protocolAssetId: 'nep141:lst.rhealab.near',
  blockchain: 'near',
  symbol: 'rNEAR',
  decimals: 24,
  visibleByDefault: false
})

function resolveMarketAssetId(token: SwapToken): MarketAssetId {
  if (!token.coingeckoId) return FALLBACK_MARKET_ASSET_ID
  try {
    return createMarketAssetId(token.coingeckoId)
  } catch {
    return FALLBACK_MARKET_ASSET_ID
  }
}

function nearContractReference(contractId: string): string {
  return contractId.replace(/_/g, '%5F')
}

export function resolveIntentsWalletAsset(
  token: SwapToken,
  network: Network
): IntentsWalletAssetDescriptor | null {
  if (network !== 'mainnet' || isDeprecatedIntentsToken(token)) return null
  const blockchain = token.blockchain.toLowerCase()
  if (blockchain === 'sol') {
    const chainId = getSolanaNetworkConfig('mainnet').chainId
    if (token.assetId === 'nep141:sol.omft.near' && !token.contractAddress) {
      return Object.freeze({
        assetId: `${chainId}/slip44:501`,
        chainId,
        namespace: 'slip44',
        reference: '501',
        kind: 'native'
      })
    }
    if (!token.contractAddress) return null
    let reference: string
    try {
      reference = parseSolanaPublicKey(token.contractAddress)
    } catch {
      return null
    }
    return Object.freeze({
      assetId: `${chainId}/token:${reference}`,
      chainId,
      namespace: 'token',
      reference,
      kind: 'token'
    })
  }
  if (blockchain === 'near') {
    const chainId = getNearNetworkConfig('mainnet').chainId
    if (token.assetId === WNEAR_NEAR_ASSET && !token.contractAddress) {
      return Object.freeze({
        assetId: `${chainId}/slip44:397`,
        chainId,
        namespace: 'slip44',
        reference: '397',
        kind: 'native'
      })
    }
    if (!token.contractAddress) return null
    let reference: string
    try {
      reference = nearContractReference(parseNearAccountId(token.contractAddress))
    } catch {
      return null
    }
    return Object.freeze({
      assetId: `${chainId}/nep141:${reference}`,
      chainId,
      namespace: 'nep141',
      reference,
      kind: 'token'
    })
  }
  return null
}

export function createIntentsWalletAssetCatalog(
  tokens: readonly SwapToken[],
  network: Network
): IntentsWalletAssetCatalog {
  const entries = new Map<string, IntentsWalletAssetCatalogEntry>()
  const tokensByProtocolAssetId = new Map(tokens.map(token => [token.assetId, token]))
  for (const token of tokens) {
    const descriptor = resolveIntentsWalletAsset(token, network)
    if (!descriptor) continue
    const iconUrl = resolveSwapTokenIconUrl(token)
    const entry: IntentsWalletAssetCatalogEntry = Object.freeze({
      ...descriptor,
      protocolAssetId: token.assetId,
      blockchain: token.blockchain.toLowerCase(),
      symbol: token.symbol,
      decimals: token.decimals,
      ...(iconUrl ? { iconUrl } : {}),
      visibleByDefault: ['USDC', 'USDT'].includes(token.symbol.toUpperCase())
    })
    const existing = entries.get(descriptor.assetId)
    if (existing && (existing.symbol !== entry.symbol || existing.decimals !== entry.decimals)) {
      throw new Error(`Conflicting Intents token metadata: ${descriptor.assetId}`)
    }
    if (!existing) entries.set(descriptor.assetId, entry)
  }

  if (network === 'mainnet' && !entries.has(RHEA_LIQUID_NEAR_ASSET.assetId)) {
    entries.set(RHEA_LIQUID_NEAR_ASSET.assetId, RHEA_LIQUID_NEAR_ASSET)
  }

  const catalogEntries = Object.freeze([...entries.values()])
  const definitions = Object.freeze(
    catalogEntries.flatMap(entry =>
      entry.kind === 'native'
        ? []
        : [
            Object.freeze({
              chainId: entry.chainId,
              namespace: entry.namespace,
              reference: entry.reference,
              kind: entry.kind,
              metadata: Object.freeze({
                name: entry.symbol,
                symbol: entry.symbol,
                decimals: entry.decimals,
                ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {})
              }),
              source: 'protocol' as const,
              verification: 'trusted' as const
            })
          ]
    )
  )
  const preferences = Object.freeze(
    catalogEntries.flatMap(entry =>
      entry.kind === 'native'
        ? []
        : [
            Object.freeze({
              assetId: entry.assetId,
              visibleByDefault: entry.visibleByDefault
            })
          ]
    )
  )
  const priceMappings = Object.freeze(
    catalogEntries.flatMap(entry => {
      if (!ONE_CLICK_ASSET_ID_PATTERN.test(entry.protocolAssetId)) return []
      const token = tokensByProtocolAssetId.get(entry.protocolAssetId)
      if (!token) return []
      return [
        Object.freeze({
          assetId: entry.assetId,
          marketAssetId: resolveMarketAssetId(token),
          sourceAssetId: entry.protocolAssetId
        })
      ]
    })
  )

  return Object.freeze({
    entries: catalogEntries,
    definitions,
    preferences,
    priceMappings
  })
}
