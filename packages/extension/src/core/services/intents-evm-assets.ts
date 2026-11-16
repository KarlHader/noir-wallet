import type { EvmNetworkConfig } from '@/config/networks'
import { resolveSwapTokenIconUrl, type SwapToken } from './intents-api'

const BLOCKCHAIN_ALIASES = new Map<string, readonly string[]>([
  ['eip155:1', ['eth', 'ethereum']],
  ['eip155:10', ['op', 'optimism']],
  ['eip155:56', ['bsc', 'bnb']],
  ['eip155:100', ['gnosis', 'xdai']],
  ['eip155:137', ['pol', 'polygon']],
  ['eip155:143', ['monad']],
  ['eip155:196', ['xlayer']],
  ['eip155:8453', ['base']],
  ['eip155:9745', ['plasma']],
  ['eip155:42161', ['arb', 'arbitrum']],
  ['eip155:43114', ['avax', 'avalanche']],
  ['eip155:80094', ['bera', 'berachain']]
])

function getNetworkAliases(network: EvmNetworkConfig): readonly string[] {
  return Object.freeze(
    [
      ...(BLOCKCHAIN_ALIASES.get(network.chainId) ?? []),
      network.iconChain,
      network.networkName,
      network.displayName.replace(/[\s_-]+/g, '')
    ].map(alias => alias.trim().toLowerCase())
  )
}

export interface IntentsEvmAsset {
  readonly protocolAssetId: string
  readonly assetId: string
  readonly chainId: string
  readonly contractAddress: `0x${string}`
  readonly blockchain: string
  readonly symbol: string
  readonly decimals: number
  readonly iconUrl?: string
}

// Retain confirmed retirements even when an older catalog has no label or the row is removed.
// Other HOT assets (including Optimism, Monad and X Layer) remain supported.
const DEPRECATED_HOT_ASSET_IDS = new Set(
  [
    '56_11111111111111111111',
    '56_2w93GqMcEmQFDru84j3HZZWt557r',
    '56_2CMMyVTGZkeyNZTSvS5sarzfir6g',
    '56_24S22V8GMmQN8t6PbCdRb3mBewAd',
    '56_SZzgw3HSudhZcTwPWUTi2RJB19t',
    '56_12zbnsg6xndDVj25QyL82YMPudb',
    '56_28V9BijGeZDBFEEtkAcnJo4tPRH4',
    '137_11111111111111111111',
    '137_qiStmoQJDQPTebaPjgx5VBxZv6L',
    '137_3hpYoaLtt8MP1Z2GH1U473DMRKgr',
    '137_2jwTGwKRX3AEe7tyzDrxtDjEFgSt',
    '43114_11111111111111111111',
    '43114_3atVJH3r5c4GqiSYmg9fECvjc47o',
    '43114_372BeH7ENZieCaabwkbWkBiTTgXp',
    '9745_11111111111111111111',
    '9745_3aL9skCy1yhPoDB8oKMmRHRN7SJW'
  ].map(id => `nep245:v2_1.omni.hot.tg:${id}`)
)

export function isDeprecatedIntentsToken(
  token: Readonly<{ assetId?: string; symbol?: string }>
): boolean {
  return (
    (token.assetId !== undefined && DEPRECATED_HOT_ASSET_IDS.has(token.assetId)) ||
    (token.symbol?.trim().toUpperCase().endsWith('(DEPRECATED)') ?? false)
  )
}

export function resolveIntentsEvmChainId(
  blockchain: string,
  networks: readonly EvmNetworkConfig[]
): string | null {
  const normalized = blockchain.trim().toLowerCase()
  return networks.find(network => getNetworkAliases(network).includes(normalized))?.chainId ?? null
}

export function resolveIntentsEvmAssets(
  tokens: readonly SwapToken[],
  networks: readonly EvmNetworkConfig[]
): readonly IntentsEvmAsset[] {
  const networkByAlias = new Map<string, EvmNetworkConfig>()
  for (const network of networks) {
    for (const alias of getNetworkAliases(network)) {
      networkByAlias.set(alias, network)
    }
  }

  const resolved = new Map<string, IntentsEvmAsset>()
  for (const token of tokens) {
    if (isDeprecatedIntentsToken(token)) continue
    const iconUrl = resolveSwapTokenIconUrl(token)
    const network = networkByAlias.get(token.blockchain.trim().toLowerCase())
    if (
      !network ||
      !token.contractAddress ||
      !/^0x[0-9a-fA-F]{40}$/.test(token.contractAddress) ||
      /^0x0{40}$/i.test(token.contractAddress)
    ) {
      continue
    }
    const contractAddress = token.contractAddress.toLowerCase() as `0x${string}`
    const assetId = `${network.chainId}/erc20:${contractAddress}`
    if (resolved.has(assetId)) continue
    resolved.set(
      assetId,
      Object.freeze({
        protocolAssetId: token.assetId,
        assetId,
        chainId: network.chainId,
        contractAddress,
        blockchain: token.blockchain,
        symbol: token.symbol,
        decimals: token.decimals,
        ...(iconUrl ? { iconUrl } : {})
      })
    )
  }
  return Object.freeze([...resolved.values()])
}

export function getDefaultIntentsEvmAssets(
  assets: readonly IntentsEvmAsset[]
): readonly IntentsEvmAsset[] {
  return Object.freeze(
    assets.filter(asset => ['USDC', 'USDT'].includes(asset.symbol.toUpperCase()))
  )
}
