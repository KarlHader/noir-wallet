import {
  getEvmNetworkConfig,
  getEvmAnkrHistoryBlockchain,
  findBuiltinEvmNetworkConfig,
  type EvmNetworkConfig
} from '@/config/networks'
import type { RpcEndpointOption } from '@/config/rpc-endpoints'
import { getEvmRpcEndpointOptions } from '../managed-rpc-endpoints'
import type { Network } from '@/types'
import {
  findChainEndpointOverride,
  getActiveChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import {
  type EvmBalanceRpc,
  type EvmBroadcastRpc,
  type EvmContractRpc,
  type EvmDAppReadRpc,
  type EvmTransactionRpc
} from './evm-rpc-client'
import { createEvmRpcFailoverClient } from './evm-rpc-failover-client'
import { createEvmBlockscoutHistoryClient } from './evm-blockscout-history-client'
import type {
  EvmActivityHistorySource,
  ReadEvmAddressActivityInput,
  FindEvmConfirmedReplacementInput
} from './evm-indexed-activity'
import { createEvmAnkrHistoryClient, type EvmAnkrHistoryChain } from './evm-ankr-history-client'
import {
  createCachedEvmAnkrHistoryBatchSource,
  createCachedEvmActivityHistorySource,
  createCachedOnlyEvmActivityHistorySource
} from './evm-cached-history-source'

const evmHistoryApiOrigin =
  typeof __EVM_HISTORY_API_ORIGIN__ === 'string' ? __EVM_HISTORY_API_ORIGIN__ : ''

export function createConfiguredEvmRpcClient(
  network: Network,
  configuredNetwork: EvmNetworkConfig = getEvmNetworkConfig(network)
): EvmBalanceRpc & EvmContractRpc & EvmTransactionRpc & EvmBroadcastRpc & EvmDAppReadRpc {
  const builtin = findBuiltinEvmNetworkConfig(network, configuredNetwork.chainId)
  const bundled = builtin ? getEvmRpcEndpointOptions(network, configuredNetwork.chainId) : []
  const preferredUrl = new URL(configuredNetwork.rpcUrl).toString()
  const matching = bundled.find(option => new URL(option.url).toString() === preferredUrl)
  const preferred: RpcEndpointOption =
    matching ??
    Object.freeze({ id: 'preferred', label: 'Preferred', url: configuredNetwork.rpcUrl })
  const manuallySelected = findChainEndpointOverride(
    getActiveChainEndpointSettings(),
    configuredNetwork.chainId
  )?.rpc
  const endpoints = manuallySelected
    ? [preferred]
    : builtin
      ? () => getEvmRpcEndpointOptions(network, configuredNetwork.chainId)
      : [preferred]
  return createEvmRpcFailoverClient({ chainId: configuredNetwork.chainId, endpoints })
}

export { attestEvmRpcEndpoint, type AttestEvmRpcEndpointInput } from './evm-network-attestation'

export function buildTrackedErc20Assets(config: EvmNetworkConfig) {
  return config.usdcContract
    ? Object.freeze([
        Object.freeze({
          assetId: `${config.chainId}/erc20:${config.usdcContract.toLowerCase()}`,
          contract: config.usdcContract.toLowerCase(),
          decimals: 6
        })
      ])
    : Object.freeze([])
}

function resolveHistoryApiUrl(config: EvmNetworkConfig): string | undefined {
  return getEvmAnkrHistoryBlockchain(config.chainId) ? undefined : config.historyApiUrl
}

export function createConfiguredEvmActivityHistorySource(
  network: Network,
  configuredNetwork: EvmNetworkConfig = getEvmNetworkConfig(network)
): EvmActivityHistorySource | undefined {
  const config = configuredNetwork
  const trackedErc20Assets = buildTrackedErc20Assets(config)
  const nativeAssetId = `${config.chainId}/slip44:${config.nativeCurrency.slip44Reference}`
  if (evmHistoryApiOrigin && getEvmAnkrHistoryBlockchain(config.chainId)) {
    const ankr = createEvmAnkrHistoryClient(evmHistoryApiOrigin, [
      { chainId: config.chainId, nativeAssetId, trackedErc20Assets }
    ])
    const readAddressActivityWithMetadata = async (input: ReadEvmAddressActivityInput) => {
      const result = (
        await ankr.readAddressActivities([{ chainId: config.chainId, ...input }], input.signal)
      ).get(config.chainId)
      if (!result || 'error' in result || 'incomplete' in result) {
        throw result && 'error' in result ? result.error : new Error('Missing Ankr history result')
      }
      return { items: result.items, hasMore: result.hasMore ?? false }
    }
    return createCachedEvmActivityHistorySource({
      chainId: config.chainId,
      source: Object.freeze({
        readAddressActivity: async (input: ReadEvmAddressActivityInput) =>
          (await readAddressActivityWithMetadata(input)).items,
        readAddressActivityWithMetadata,
        findConfirmedReplacement: (input: FindEvmConfirmedReplacementInput) =>
          ankr.findConfirmedReplacement(config.chainId, input)
      })
    })
  }
  const rpc = createConfiguredEvmRpcClient(network, config)
  const readFinalizedBlockNumber = (signal?: AbortSignal) => rpc.getFinalizedBlockNumber(signal)
  const historyApiUrl = resolveHistoryApiUrl(config)

  if (historyApiUrl) {
    const source = createEvmBlockscoutHistoryClient({
      chainId: config.chainId,
      apiUrl: historyApiUrl,
      nativeAssetId,
      readFinalizedBlockNumber,
      trackedErc20Assets
    })
    return createCachedEvmActivityHistorySource({
      chainId: config.chainId,
      source
    })
  }

  return undefined
}

export function createEvmActivityHistoryBatchReader(configs: readonly EvmNetworkConfig[]) {
  if (!evmHistoryApiOrigin) return undefined
  const chains: EvmAnkrHistoryChain[] = configs
    .filter(config => getEvmAnkrHistoryBlockchain(config.chainId))
    .map(config => ({
      chainId: config.chainId,
      nativeAssetId: `${config.chainId}/slip44:${config.nativeCurrency.slip44Reference}`,
      trackedErc20Assets: buildTrackedErc20Assets(config)
    }))
  if (chains.length === 0) return undefined
  return Object.freeze({
    chainIds: new Set(chains.map(chain => chain.chainId)),
    ...createCachedEvmAnkrHistoryBatchSource({
      source: createEvmAnkrHistoryClient(evmHistoryApiOrigin, chains)
    })
  })
}

export function createEvmActivityHistoryReader(
  network: Network,
  configuredNetwork: EvmNetworkConfig = getEvmNetworkConfig(network)
): EvmActivityHistorySource {
  return (
    createConfiguredEvmActivityHistorySource(network, configuredNetwork) ??
    createCachedOnlyEvmActivityHistorySource({ chainId: configuredNetwork.chainId })
  )
}

export type {
  EvmActivityHistorySource,
  EvmConfirmedReplacement,
  FindEvmConfirmedReplacementInput,
  ReadEvmAddressActivityInput
} from './evm-indexed-activity'

export { readEvmPortfolioSource, type ReadEvmPortfolioInput } from './evm-balance-reader'
export { parseEvmAccountBinding, type EvmAccountBinding } from './evm-account'
export { readErc20Metadata } from './evm-erc20-metadata-reader'
export {
  deriveEvmFeeTierQuote,
  areEvmFeeSelectionsEqual,
  formatEvmPriorityFeeGwei,
  formatEvmWeiAsGwei,
  parseEvmFeeSelection,
  parseEvmPriorityFeeGwei,
  type EvmFeeSelection,
  type EvmFeeTierQuote
} from './evm-fee-tier'
export {
  ChromeUserEvmAssetCatalogRepository,
  getUserEvmAssetCatalogStorageKey,
  parseUserEvmAssetCatalogSnapshot,
  type UserEvmAssetCatalogRepository
} from './chrome-user-evm-asset-catalog'
export {
  ChromeDetectedEvmAssetCatalogRepository,
  getDetectedEvmAssetCatalogStorageKey,
  parseDetectedEvmAssetCatalogSnapshot
} from './chrome-detected-evm-asset-catalog'
export {
  DetectedEvmAssetCoordinator,
  type EvmTokenDiscoveryTarget
} from './detected-evm-asset-coordinator'
export {
  EvmTokenDiscoveryClient,
  type DetectedEvmTokenCandidate
} from './evm-token-discovery-client'
export {
  UserEvmAssetCoordinator,
  type UserEvmAssetCoordinatorOptions
} from './user-evm-asset-coordinator'
export {
  EvmPortfolioCoordinator,
  loadActiveEvmPortfolioContext,
  type ActiveEvmPortfolioContext,
  type ActiveEvmPortfolioSource,
  type EvmPortfolioStorageRepository,
  type EvmPortfolioCoordinatorOptions
} from './evm-portfolio-coordinator'
export {
  EVM_TRANSACTION_ERROR_CODES,
  EvmTransactionError,
  assertEvmTransferFresh,
  assertEvmSigningSummaryMatchesPrepared,
  buildEvmCancelTransaction,
  buildEvmContractCall,
  buildEvmNonceRecoveryTransaction,
  buildEvmTransfer,
  computeEvmSigningPayloadFingerprint,
  createEvmSigningSummary,
  createEvmSigningPreparePayload,
  parseEvmContractCallIntent,
  parseEvmTransferIntent,
  parsePreparedEvmTransfer,
  type BuildEvmContractCallInput,
  type BuildEvmCancelInput,
  type BuildEvmNonceRecoveryInput,
  type BuildEvmTransferInput,
  type EvmContractCallIntent,
  type EvmEip1559Transaction,
  type EvmTransactionErrorCode,
  type EvmSigningPreparePayload,
  type EvmTransferIntent,
  type PeaEvmExecutionAccount,
  type PreparedEvmTransfer
} from './evm-transaction-builder'
export {
  broadcastSignedEvmTransaction,
  observeEvmTransaction,
  type BroadcastSignedEvmTransactionInput,
  type EvmTransactionObservation
} from './evm-transaction-observer'
export {
  assertSignedEvmTransactionMatchesPrepared,
  createKeystoneSignedEvmTransaction,
  serializePreparedEvmUnsignedTransaction,
  type SignedEvmTransactionEnvelope
} from './evm-signed-transaction'
export {
  createEvmTransactionSegmentEvent,
  type CreateEvmTransactionSegmentEventInput
} from './evm-transaction-lifecycle'
export { createEvmTransferGraph, type CreateEvmTransferGraphInput } from './evm-transaction-graph'
export {
  ChromeSessionEvmPendingTransferStore,
  parsePendingEvmTransfer,
  type AwaitingApprovalEvmTransfer,
  type AwaitingExternalSignatureEvmTransfer,
  type EvmExternalSignerBinding,
  type EvmPendingTransferStore,
  type PendingEvmTransfer,
  type PendingEvmSigningTransfer,
  type SignedPendingEvmTransfer
} from './evm-pending-transfer-store'
export {
  EvmTransferOrchestrator,
  type ApproveEvmTransferInput,
  type ContinueEvmTransferInput,
  type EvmExternalSignatureRequired,
  type EvmExternalSigningRequest,
  type EvmTransferApprovalResult,
  type EvmTransferOrchestratorOptions,
  type EvmTransferSigningPort,
  type EvmTransferSubmission,
  type PreparedEvmTransferApproval,
  type PrepareEvmTransferInput,
  type PrepareEvmCancelInput,
  type EvmNonceRecoveryState,
  type SubmitEvmExternalSignatureInput
} from './evm-transfer-orchestrator'
export {
  EvmTransactionMonitor,
  type EvmTransactionMonitorOptions,
  type EvmTransactionMonitorResult
} from './evm-transaction-monitor'
export {
  EVM_RPC_ERROR_CODES,
  EvmRpcError,
  type EvmBalanceRpc,
  type EvmBroadcastRpc,
  type EvmContractRpc,
  type EvmDAppReadRpc,
  type EvmDAppRpcCall,
  type EvmLatestBlockFee,
  type EvmRpcBlockTag,
  type EvmRpcCall,
  type EvmRpcErrorCode,
  type EvmTransactionReceipt,
  type EvmTransactionLocation,
  type EvmTransactionRpc
} from './evm-rpc-client'
