import type { Network } from '@/types'
import {
  findChainEndpointOverride,
  parseChainEndpointSettings,
  type ChainEndpointSettings
} from './chain-endpoint-settings'
import {
  getNearNetworkConfig,
  type NearNetworkConfig,
  getSolanaNetworkConfig,
  type SolanaNetworkConfig
} from '@/config/networks'

const RETIRED_SOLANA_RPC_URLS = new Set([
  'https://solana.api.onfinality.io/public',
  'https://api.mainnet-beta.solana.com/'
])

function resolveRpcUrl(
  settings: ChainEndpointSettings,
  chainId: string,
  protocol: 'solana-json-rpc' | 'near-json-rpc',
  defaultUrl: string
): string {
  const rpc = findChainEndpointOverride(settings, chainId)?.rpc
  if (rpc?.protocol !== protocol) return defaultUrl
  if (protocol === 'solana-json-rpc' && RETIRED_SOLANA_RPC_URLS.has(rpc.url)) return defaultUrl
  return rpc.url
}

export function resolveSolanaRuntimeNetworkConfig(
  networkMode: Network,
  settingsValue?: unknown
): SolanaNetworkConfig {
  const network = getSolanaNetworkConfig(networkMode === 'mainnet' ? 'mainnet' : 'devnet')
  const settings = parseChainEndpointSettings(settingsValue)
  return Object.freeze({
    ...network,
    rpcUrl: resolveRpcUrl(settings, network.chainId, 'solana-json-rpc', network.rpcUrl)
  })
}

export function resolveNearRuntimeNetworkConfig(
  networkMode: Network,
  settingsValue?: unknown
): NearNetworkConfig {
  const network = getNearNetworkConfig(networkMode)
  const settings = parseChainEndpointSettings(settingsValue)
  return Object.freeze({
    ...network,
    rpcUrl: resolveRpcUrl(settings, network.chainId, 'near-json-rpc', network.rpcUrl)
  })
}
