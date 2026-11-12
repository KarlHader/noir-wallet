import {
  findChainEndpointOverride,
  getActiveChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import { getQuantusNetworkConfigs } from '@/config/networks'
import { resolveQuantusRpcEndpointOptions } from '../managed-rpc-endpoints'
import { createJsonRpcFailoverFetch } from '../json-rpc-failover-fetch'
import { createQuantusRpcClient } from './quantus-rpc-client'

/**
 * Quantus client for Background work: a saved `quantus-json-rpc` override is
 * used verbatim, otherwise the managed endpoint pool fails over between
 * genesis-attested endpoints.
 */
export function createConfiguredQuantusRpcClient(network: {
  readonly chainId: string
  readonly rpcUrl: string
}): ReturnType<typeof createQuantusRpcClient> {
  if (findChainEndpointOverride(getActiveChainEndpointSettings(), network.chainId)?.rpc) {
    return createQuantusRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
  }
  const networkMode = getQuantusNetworkConfigs().find(
    candidate => candidate.chainId === network.chainId
  )?.networkMode
  if (!networkMode) throw new Error('Unsupported Quantus chain')
  const endpoints = resolveQuantusRpcEndpointOptions(networkMode).slice(0, 5)
  const failoverFetch = createJsonRpcFailoverFetch(endpoints, async (url, signal) => {
    await createQuantusRpcClient(
      { chainId: network.chainId, rpcUrl: url },
      fetch
    ).assertExpectedChain(signal)
  })
  return createQuantusRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl }, failoverFetch)
}
