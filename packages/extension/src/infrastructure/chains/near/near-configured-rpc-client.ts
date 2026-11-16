import {
  findChainEndpointOverride,
  getActiveChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import { getNearNetworkConfigs } from '@/config/networks'
import { resolveNearRpcEndpointOptions } from '../managed-rpc-endpoints'
import { createJsonRpcFailoverFetch } from '../json-rpc-failover-fetch'
import { createNearRpcClient } from './near-rpc-client'

export function createConfiguredNearRpcClient(network: {
  readonly chainId: string
  readonly rpcUrl: string
}): ReturnType<typeof createNearRpcClient> {
  if (findChainEndpointOverride(getActiveChainEndpointSettings(), network.chainId)?.rpc) {
    return createNearRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
  }
  const nearNetwork = getNearNetworkConfigs().find(
    candidate => candidate.chainId === network.chainId
  )?.network
  if (!nearNetwork) throw new Error('Unsupported NEAR chain')
  const endpoints = resolveNearRpcEndpointOptions(nearNetwork).slice(0, 5)
  const failoverFetch = createJsonRpcFailoverFetch(endpoints, async (url, signal) => {
    await createNearRpcClient({ chainId: network.chainId, rpcUrl: url }, fetch).assertExpectedChain(
      signal
    )
  })
  return createNearRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl }, failoverFetch)
}
