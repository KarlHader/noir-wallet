import {
  BITCOIN_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG
} from '@/config/multichain-feature-flags'
import { getBitcoinNetworkConfig, getEvmNetworkConfigs } from '@/config/networks'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import {
  resolveNearRuntimeNetworkConfig,
  resolveSolanaRuntimeNetworkConfig
} from '@/core/chains/solana-near-runtime-config'
import type { Network } from '@/types'
import {
  createBitcoinActivityHistorySource,
  createConfiguredBitcoinEsploraClient
} from '../chains/bitcoin'
import {
  buildTrackedErc20Assets,
  createEvmActivityHistoryBatchReader,
  createEvmActivityHistoryReader
} from '../chains/evm'
import { createNearActivityHistorySource } from '../chains/near'
import {
  createConfiguredSolanaRpcClient,
  createSolanaActivityHistorySource
} from '../chains/solana'

export function createConfiguredActivityHistorySources(input: {
  readonly network: Network
  readonly enabledChainFeatureFlags: readonly string[]
  readonly bitcoinCustomRpcUrl?: string
  readonly endpointSettings?: ChainEndpointSettings
}) {
  const enabled = new Set(input.enabledChainFeatureFlags)
  const bitcoinNetwork = getBitcoinNetworkConfig(input.network)
  const evmNetworks = enabled.has(EVM_CHAIN_FEATURE_FLAG) ? getEvmNetworkConfigs(input.network) : []
  const solanaNetwork = resolveSolanaRuntimeNetworkConfig(input.network, input.endpointSettings)
  const nearNetwork = resolveNearRuntimeNetworkConfig(input.network, input.endpointSettings)

  return Object.freeze({
    bitcoinNetwork,
    bitcoinHistory: enabled.has(BITCOIN_CHAIN_FEATURE_FLAG)
      ? createBitcoinActivityHistorySource({
          chainId: bitcoinNetwork.chainId,
          assetId: `${bitcoinNetwork.chainId}/slip44:0`,
          requiredConfirmations: bitcoinNetwork.requiredConfirmations,
          rpc: createConfiguredBitcoinEsploraClient(input.network, input.bitcoinCustomRpcUrl)
        })
      : undefined,
    evmHistorySources: Object.freeze(
      evmNetworks.map(network =>
        Object.freeze({
          chainId: network.chainId,
          trackedErc20AssetIds: buildTrackedErc20Assets(network).map(asset => asset.assetId),
          source: createEvmActivityHistoryReader(input.network, network)
        })
      )
    ),
    evmBatchHistory: createEvmActivityHistoryBatchReader(evmNetworks),
    solanaNetwork,
    solanaHistory: enabled.has(SOLANA_CHAIN_FEATURE_FLAG)
      ? createSolanaActivityHistorySource({
          chainId: solanaNetwork.chainId,
          rpc: createConfiguredSolanaRpcClient({
            chainId: solanaNetwork.chainId,
            rpcUrl: solanaNetwork.rpcUrl
          })
        })
      : undefined,
    nearNetwork,
    nearHistory:
      enabled.has(NEAR_CHAIN_FEATURE_FLAG) && input.network === 'mainnet'
        ? createNearActivityHistorySource({ chainId: nearNetwork.chainId })
        : undefined
  })
}
