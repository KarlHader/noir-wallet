import {
  findChainEndpointOverride,
  getActiveChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import { getSolanaNetworkConfigs, type SolanaNetworkConfig } from '@/config/networks'
import { resolveSolanaRpcEndpointOptions } from '../managed-rpc-endpoints'
import { createJsonRpcFailoverFetch } from '../json-rpc-failover-fetch'
import { createSolanaRpcClient } from './solana-rpc-client'

export function createConfiguredSolanaRpcClient(
  network: Pick<SolanaNetworkConfig, 'chainId' | 'rpcUrl'>
): ReturnType<typeof createSolanaRpcClient> {
  if (findChainEndpointOverride(getActiveChainEndpointSettings(), network.chainId)?.rpc) {
    return createSolanaRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
  }
  const cluster = getSolanaNetworkConfigs().find(
    candidate => candidate.chainId === network.chainId
  )?.cluster
  if (!cluster) throw new Error('Unsupported Solana chain')
  const endpoints = resolveSolanaRpcEndpointOptions(cluster).slice(0, 5)
  const failoverFetch = createJsonRpcFailoverFetch(endpoints, async (url, signal) => {
    await createSolanaRpcClient(
      { chainId: network.chainId, rpcUrl: url },
      fetch
    ).assertExpectedChain(signal)
  })
  return createSolanaRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl }, failoverFetch)
}
