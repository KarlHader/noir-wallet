import {
  BITCOIN_CHAIN_FEATURE_FLAG,
  DASH_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  PEARL_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  STARKNET_CHAIN_FEATURE_FLAG
} from '@/config/multichain-feature-flags'
import {
  getBitcoinNetworkConfig,
  getDashNetworkConfig,
  getEvmNetworkConfigs,
  getPearlNetworkConfig
} from '@/config/networks'
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
  createConfiguredPearlBlockbookClient,
  createPearlActivityHistorySource
} from '../chains/pearl'
import {
  buildTrackedErc20Assets,
  createEvmActivityHistoryBatchReader,
  createEvmActivityHistoryReader
} from '../chains/evm'
import { createDashActivityHistorySource, createConfiguredDashInsightClient } from '../chains/dash'
import { createNearActivityHistorySource } from '../chains/near'
import {
  createStarknetActivityHistorySource,
  createStarknetRpcClient,
  parseStarknetActivityCursor,
  type StarknetActivityCursorStore
} from '../chains/starknet'
import { getStarknetNetworkConfig } from '@/core/chains/starknet/network-config'
import { findChainEndpointOverride } from '@/core/chains/chain-endpoint-settings'
import {
  createConfiguredSolanaRpcClient,
  createSolanaActivityHistorySource
} from '../chains/solana'

export function createConfiguredActivityHistorySources(input: {
  readonly network: Network
  readonly enabledChainFeatureFlags: readonly string[]
  readonly bitcoinCustomRpcUrl?: string
  readonly pearlCustomRpcUrl?: string
  readonly endpointSettings?: ChainEndpointSettings
}) {
  const enabled = new Set(input.enabledChainFeatureFlags)
  const bitcoinNetwork = getBitcoinNetworkConfig(input.network)
  const pearlNetwork = getPearlNetworkConfig(input.network)
  const dashNetwork = getDashNetworkConfig(input.network)
  const evmNetworks = enabled.has(EVM_CHAIN_FEATURE_FLAG) ? getEvmNetworkConfigs(input.network) : []
  const solanaNetwork = resolveSolanaRuntimeNetworkConfig(input.network, input.endpointSettings)
  const nearNetwork = resolveNearRuntimeNetworkConfig(input.network, input.endpointSettings)
  const starknetNetwork = getStarknetNetworkConfig(input.network)
  const starknetOverride = input.endpointSettings
    ? findChainEndpointOverride(input.endpointSettings, starknetNetwork.chainId)?.rpc
    : undefined
  const starknetCursors: StarknetActivityCursorStore = {
    async get(key) {
      const stored = await chrome.storage.local.get(key)
      return parseStarknetActivityCursor(stored[key])
    },
    async set(key, cursor) {
      await chrome.storage.local.set({ [key]: cursor })
    }
  }

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
    pearlNetwork,
    pearlHistory: enabled.has(PEARL_CHAIN_FEATURE_FLAG)
      ? createPearlActivityHistorySource({
          chainId: pearlNetwork.chainId,
          assetId: `${pearlNetwork.chainId}/slip44:808276`,
          requiredConfirmations: pearlNetwork.requiredConfirmations,
          rpc: createConfiguredPearlBlockbookClient(input.network, input.pearlCustomRpcUrl)
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
        : undefined,
    dashNetwork,
    dashHistory: enabled.has(DASH_CHAIN_FEATURE_FLAG)
      ? createDashActivityHistorySource({
          chainId: dashNetwork.chainId,
          rpc: createConfiguredDashInsightClient(input.network)
        })
      : undefined,
    starknetNetwork,
    starknetHistory: enabled.has(STARKNET_CHAIN_FEATURE_FLAG)
      ? createStarknetActivityHistorySource({
          chainId: starknetNetwork.chainId,
          tokens: starknetNetwork.tokens.map(token => ({
            reference: token.reference,
            assetId: `${starknetNetwork.chainId}/snip2:${token.reference}`
          })),
          rpc: createStarknetRpcClient({
            chainId: starknetNetwork.chainId,
            rpcUrl:
              starknetOverride?.protocol === 'starknet-json-rpc'
                ? starknetOverride.url
                : starknetNetwork.rpcUrl
          }),
          cursors: starknetCursors
        })
      : undefined
  })
}
