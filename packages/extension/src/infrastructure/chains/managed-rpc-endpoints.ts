import type { Network } from '@/types'
import {
  findBuiltinEvmNetworkConfig,
  getSolanaNetworkConfig,
  getStarknetNetworkConfig,
  type NearNetwork,
  type SolanaCluster,
  type StarknetNetwork
} from '@/config/networks'
import {
  getDefaultEvmRpcEndpoint,
  RPC_DEFAULT_ENDPOINTS,
  type RpcEndpointOption
} from '@/config/rpc-endpoints'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { getBitcoinChainId, getPearlChainId, getQuantusChainId } from '@/core/chains/registry'
import { getManagedRpcEndpointOptions } from './rpc-registry-client'

interface BitcoinEsploraEndpointConfig {
  readonly id: string
  readonly baseUrl: string
}

interface PearlBlockbookEndpointConfig {
  readonly id: string
  readonly baseUrl: string
}

export interface DashInsightEndpointConfig {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
}

function managedOrDefault(
  managed: readonly RpcEndpointOption[],
  fallback: RpcEndpointOption
): readonly RpcEndpointOption[] {
  return managed.length > 0 ? managed : [fallback]
}

export function getEvmRpcEndpointOptions(
  network: Network,
  chainId: string
): readonly RpcEndpointOption[] {
  if (!findBuiltinEvmNetworkConfig(network, chainId)) {
    throw new Error(`No built-in EVM network configured for ${chainId}`)
  }
  const managed = getManagedRpcEndpointOptions(chainId, network, 'evm-json-rpc')
  return managedOrDefault(managed, getDefaultEvmRpcEndpoint(network, chainId))
}

export function resolveBitcoinRpcEndpointOptions(
  network: Network
): readonly BitcoinEsploraEndpointConfig[] {
  const managed = getManagedRpcEndpointOptions(
    getBitcoinChainId(network),
    network,
    'bitcoin-esplora'
  )
  return managedOrDefault(managed, RPC_DEFAULT_ENDPOINTS.bitcoin[network]).map(endpoint => ({
    id: endpoint.id,
    baseUrl: endpoint.url
  }))
}

export function resolvePearlRpcEndpointOptions(
  network: Network
): readonly PearlBlockbookEndpointConfig[] {
  const managed = getManagedRpcEndpointOptions(getPearlChainId(network), network, 'pearl-blockbook')
  return managedOrDefault(managed, RPC_DEFAULT_ENDPOINTS.pearl[network]).map(endpoint => ({
    id: endpoint.id,
    baseUrl: endpoint.url
  }))
}

export function resolveDashRpcEndpointOptions(
  network: Network
): readonly DashInsightEndpointConfig[] {
  const managed = getManagedRpcEndpointOptions(DASH_CHAIN_IDS[network], network, 'dash-insight')
  return managedOrDefault(managed, RPC_DEFAULT_ENDPOINTS.dash[network]).map(endpoint => ({
    id: endpoint.id,
    label: endpoint.label,
    baseUrl: endpoint.url
  }))
}

export function resolveSolanaRpcEndpointOptions(
  cluster: SolanaCluster
): readonly RpcEndpointOption[] {
  const managed = getManagedRpcEndpointOptions(
    getSolanaNetworkConfig(cluster).chainId,
    cluster === 'mainnet' ? 'mainnet' : 'testnet',
    'solana-json-rpc'
  )
  return managedOrDefault(managed, RPC_DEFAULT_ENDPOINTS.solana[cluster])
}

export function resolveNearRpcEndpointOptions(network: NearNetwork): readonly RpcEndpointOption[] {
  const managed = getManagedRpcEndpointOptions(`near:${network}`, network, 'near-json-rpc')
  return managedOrDefault(managed, RPC_DEFAULT_ENDPOINTS.near[network])
}

export function resolveQuantusRpcEndpointOptions(network: Network): readonly RpcEndpointOption[] {
  const managed = getManagedRpcEndpointOptions(
    getQuantusChainId(network),
    network,
    'quantus-json-rpc'
  )
  return managedOrDefault(managed, RPC_DEFAULT_ENDPOINTS.quantus[network])
}

export function resolveStarknetRpcEndpointOptions(
  network: StarknetNetwork
): readonly RpcEndpointOption[] {
  const managed = getManagedRpcEndpointOptions(
    getStarknetNetworkConfig(network).chainId,
    network,
    'starknet-json-rpc'
  )
  return managedOrDefault(managed, RPC_DEFAULT_ENDPOINTS.starknet[network])
}
