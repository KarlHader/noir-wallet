import type { Network } from '@/types'
import { getQuantusNetworkConfig, type QuantusNetworkConfig } from '@/config/networks'
import {
  findChainEndpointOverride,
  parseChainEndpointSettings,
  type ChainEndpointSettings
} from '../chain-endpoint-settings'

function resolveRpcUrl(settings: ChainEndpointSettings, network: QuantusNetworkConfig): string {
  const rpc = findChainEndpointOverride(settings, network.chainId)?.rpc
  if (rpc?.protocol !== 'quantus-json-rpc') return network.rpcUrl
  return rpc.url
}

function resolveExplorerUrl(
  settings: ChainEndpointSettings,
  network: QuantusNetworkConfig
): string {
  const explorer = findChainEndpointOverride(settings, network.chainId)?.explorer
  return explorer?.baseUrl ?? network.explorerUrl
}

/**
 * Resolves the Quantus endpoint set from persisted chain endpoint settings.
 *
 * A custom RPC only takes effect when it was saved with the `quantus-json-rpc`
 * protocol; the same override also carries the explorer URL.
 */
export function resolveQuantusRuntimeNetworkConfig(
  networkMode: Network,
  settingsValue?: unknown
): QuantusNetworkConfig {
  const network = getQuantusNetworkConfig(networkMode)
  const settings = parseChainEndpointSettings(settingsValue)
  return Object.freeze({
    ...network,
    rpcUrl: resolveRpcUrl(settings, network),
    explorerUrl: resolveExplorerUrl(settings, network)
  })
}
