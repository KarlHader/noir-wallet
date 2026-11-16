import { getBitcoinNetworkConfig } from '@/config/networks'
import { resolveBitcoinRpcEndpointOptions } from '../managed-rpc-endpoints'
import type { Network } from '@/types'
import { createBitcoinEsploraFailoverClient } from './bitcoin-esplora-failover-client'
import { createBitcoinEsploraClient } from './bitcoin-esplora-client'
import type {
  BitcoinActivityHistoryRpc,
  BitcoinDiscoveryRpc,
  BitcoinTransactionRpc
} from './bitcoin-esplora-client'

type ConfiguredBitcoinEsploraClient = BitcoinDiscoveryRpc &
  BitcoinTransactionRpc &
  BitcoinActivityHistoryRpc

const bundledBitcoinClients = new Map<string, ConfiguredBitcoinEsploraClient>()
const customBitcoinClients = new Map<string, ConfiguredBitcoinEsploraClient>()

interface ConfiguredBitcoinEsploraEndpoint {
  readonly id: string
  readonly baseUrl: string
}

function normalizeBitcoinEsploraBaseUrl(baseUrl: string): string {
  const normalized = new URL(baseUrl)
  if (!normalized.pathname.endsWith('/')) normalized.pathname += '/'
  return normalized.toString()
}

export function resolveConfiguredBitcoinEsploraEndpoints(
  network: Network,
  customBaseUrl?: string
): readonly ConfiguredBitcoinEsploraEndpoint[] {
  const bundledEndpoints = resolveBitcoinRpcEndpointOptions(network)
  if (customBaseUrl === undefined) return bundledEndpoints

  const normalizedCustomUrl = normalizeBitcoinEsploraBaseUrl(customBaseUrl)
  const matchingBundledEndpoint = bundledEndpoints.find(
    endpoint => normalizeBitcoinEsploraBaseUrl(endpoint.baseUrl) === normalizedCustomUrl
  )
  return [matchingBundledEndpoint ?? { id: 'custom', baseUrl: normalizedCustomUrl }]
}

export function createConfiguredBitcoinEsploraClient(
  network: Network,
  customBaseUrl?: string
): ConfiguredBitcoinEsploraClient {
  const config = getBitcoinNetworkConfig(network)
  if (customBaseUrl !== undefined) {
    const normalizedCustomUrl = normalizeBitcoinEsploraBaseUrl(customBaseUrl)
    const cacheKey = `${network}:${normalizedCustomUrl}`
    const existing = customBitcoinClients.get(cacheKey)
    if (existing) return existing
    const client = createBitcoinEsploraClient({
      chainId: config.chainId,
      baseUrl: normalizedCustomUrl,
      timeoutMs: 5_000
    })
    customBitcoinClients.set(cacheKey, client)
    return client
  }
  const cacheKey = `${network}:${JSON.stringify(resolveConfiguredBitcoinEsploraEndpoints(network))}`
  const existing = bundledBitcoinClients.get(cacheKey)
  if (existing) return existing
  const endpoints = resolveConfiguredBitcoinEsploraEndpoints(network)
  const client = createBitcoinEsploraFailoverClient({
    chainId: config.chainId,
    endpoints,
    timeoutMs: 5_000
  })
  bundledBitcoinClients.set(cacheKey, client)
  return client
}

export async function attestBitcoinEsploraEndpoint(
  chainId: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<void> {
  await createBitcoinEsploraClient({ chainId, baseUrl }).assertExpectedChain(signal)
}

export {
  BitcoinDiscoveryRefresher,
  assertBitcoinDiscoveryRefreshTransition,
  createRefreshedBitcoinDiscoveryCheckpoint,
  type BitcoinDiscoveryRefresherOptions,
  type BitcoinDiscoveryRefreshResult,
  type RefreshBitcoinDiscoveryInput
} from './bitcoin-discovery-refresh'
export {
  BITCOIN_RPC_ERROR_CODES,
  BitcoinRpcError,
  type BitcoinActivityHistoryRpc,
  type BitcoinDiscoveryRpc,
  type BitcoinEsploraClientConfig,
  type BitcoinOutputSpendStatus,
  type BitcoinRpcErrorCode,
  type BitcoinTransactionRpc
} from './bitcoin-esplora-client'
export type {
  BitcoinHistoryInput,
  BitcoinHistoryOutput,
  BitcoinHistoryTransaction
} from './bitcoin-esplora-history-model'
export {
  BITCOIN_ACTIVITY_HISTORY_LIMITS,
  createBitcoinActivityHistorySource,
  type BitcoinActivityHistorySource,
  type BitcoinActivityHistorySourceConfig,
  type ReadBitcoinAddressActivityInput
} from './bitcoin-activity-history-source'
export type {
  BitcoinAddressActivity,
  BitcoinTransactionStatus,
  BitcoinUtxo
} from '@/core/chains/bitcoin'
export {
  BITCOIN_DEFAULT_FEE_TARGET_BLOCKS,
  BITCOIN_MAXIMUM_FEE_RATE_SATS_PER_VBYTE,
  BITCOIN_MAXIMUM_FEE_TARGET_BLOCKS,
  BITCOIN_MAXIMUM_MONEY_SATS,
  BITCOIN_MAXIMUM_SELECTION_UTXOS,
  BITCOIN_TRANSACTION_BUILD_ERROR_CODES,
  BitcoinTransactionBuildError,
  type BitcoinChangeOutputPosition,
  type BitcoinCoinSelection,
  type BitcoinFeeRateQuote,
  type BitcoinSpendableUtxo,
  type BitcoinTransactionBuildErrorCode,
  type BitcoinTransferAmount,
  type BitcoinTransferIntent,
  type BuildBitcoinPsbtInput,
  type FinalizeBitcoinPsbtInput,
  type FinalizedBitcoinTransaction,
  type PreparedBitcoinPsbt,
  type SelectBitcoinCoinsInput
} from './bitcoin-transaction-model'
export {
  parseBitcoinAddress,
  parseBitcoinAddressType,
  parseBitcoinFeeRate,
  parseBitcoinPublicKey,
  parseBitcoinTransferIntent
} from './bitcoin-transaction-model'
export { selectBitcoinCoins, selectBitcoinFeeRate } from './bitcoin-coin-selection'
export { BITCOIN_FEE_TARGET_BLOCKS_BY_TIER, bitcoinFeeTargetBlocks } from './bitcoin-fee-tier'
export { buildBitcoinPsbt } from './bitcoin-psbt-builder'
export { finalizeBitcoinPsbt } from './bitcoin-psbt-finalizer'
export {
  assertBitcoinSigningSummaryMatchesPrepared,
  computeBitcoinSigningPayloadFingerprint,
  createBitcoinSigningSummary,
  createBitcoinSigningPreparePayload,
  KEYSTONE_BITCOIN_SIGNING_TTL_MS,
  type BitcoinSigningPreparePayload
} from './bitcoin-signing-summary-validator'
export {
  broadcastSignedBitcoinTransaction,
  observeBitcoinTransaction,
  parseBitcoinFinalityConfirmations,
  type BitcoinMonitorRpc,
  type BitcoinTransactionObservation,
  type BroadcastSignedBitcoinTransactionInput
} from './bitcoin-transaction-observer'
export {
  createBitcoinTransactionSegmentEvent,
  type CreateBitcoinTransactionSegmentEventInput
} from './bitcoin-transaction-lifecycle'
export {
  BitcoinTransactionMonitor,
  type BitcoinTransactionMonitorOptions,
  type BitcoinTransactionMonitorResult
} from './bitcoin-transaction-monitor'
export {
  createBitcoinTransferGraph,
  type CreateBitcoinTransferGraphInput
} from './bitcoin-transaction-graph'
export {
  ChromeSessionBitcoinPendingTransferStore,
  parsePendingBitcoinTransfer,
  type AwaitingApprovalBitcoinTransfer,
  type AwaitingExternalSignatureBitcoinTransfer,
  type BitcoinPendingTransferStore,
  type PendingBitcoinTransfer,
  type PendingBitcoinSigningTransfer,
  type SignedPendingBitcoinTransfer
} from './bitcoin-pending-transfer-store'
export {
  BitcoinTransferOrchestrator,
  type ApproveBitcoinTransferInput,
  type BitcoinTransferOrchestratorOptions,
  type BitcoinExternalSignatureRequired,
  type BitcoinExternalSigningRequest,
  type BitcoinTransferApprovalResult,
  type BitcoinTransferSigningPort,
  type BitcoinTransferSubmission,
  type ContinueBitcoinTransferInput,
  type PrepareBitcoinTransferInput,
  type PreparedBitcoinTransferApproval,
  type SubmitBitcoinExternalSignatureInput
} from './bitcoin-transfer-orchestrator'
export {
  BitcoinTransferPreparationCoordinator,
  type BitcoinTransferPreparationCoordinatorOptions,
  type BitcoinTransferPreparationRpc,
  type PrepareBitcoinTransferFromDiscoveryInput,
  type PreparedBitcoinTransferPlan
} from './bitcoin-transfer-preparation-coordinator'
export {
  collectBitcoinSpendableUtxos,
  isActiveBitcoinAddressObservation,
  isLedgerBitcoinAccountObservation
} from './bitcoin-spendable-utxos'
export {
  BitcoinDiscoveryError,
  BitcoinGapLimitScanner,
  type BitcoinDiscoveryErrorCode,
  type BitcoinDiscoveryResult,
  type BitcoinGapLimitScannerOptions,
  type ScanBitcoinAccountInput
} from './bitcoin-gap-limit-scanner'
export {
  bitcoinDiscoveryAddressTypeComplete,
  BitcoinDiscoveryCoordinator,
  loadActiveBitcoinDiscoveryContext,
  type ActiveBitcoinDiscoveryContext,
  type BitcoinDiscoveryCoordinatorOptions,
  type BitcoinDiscoveryStorageRepository
} from './bitcoin-discovery-coordinator'
export {
  BITCOIN_PORTFOLIO_STAGES,
  BitcoinPortfolioCoordinator,
  BitcoinPortfolioCoordinatorError,
  type ActiveBitcoinPortfolioSource,
  type BitcoinPortfolioCoordinatorOptions,
  type BitcoinPortfolioStage
} from './bitcoin-portfolio-coordinator'
export {
  BitcoinOwnedTransactionBalanceUpdater,
  applyBitcoinTransactionObservation,
  applyOptimisticBitcoinBroadcast,
  type BitcoinOwnedBalanceUpdateResult,
  type BitcoinOwnedBroadcastInput,
  type BitcoinOwnedTransactionBalanceUpdaterOptions
} from './bitcoin-owned-transaction-balance-updater'
export {
  BITCOIN_DISCOVERY_DATABASE,
  BITCOIN_DISCOVERY_READ_STAGES,
  BitcoinDiscoveryReadError,
  IndexedDbBitcoinDiscoveryRepository,
  deleteIndexedDbBitcoinDiscovery,
  type BitcoinDiscoveryReadStage,
  type BitcoinDiscoveryProgress,
  type BitcoinDiscoveryRepository,
  type BitcoinDiscoveryScope,
  type BitcoinDiscoveryState,
  type IndexedDbBitcoinDiscoveryRepositoryOptions
} from './bitcoin-discovery-repository'
export {
  BitcoinChangeReservationCoordinator,
  type BitcoinChangeReservationCoordinatorOptions,
  type ReserveBitcoinChangeInput
} from './bitcoin-change-reservation-coordinator'
export {
  BITCOIN_CHANGE_RESERVATION_DATABASE,
  IndexedDbBitcoinChangeReservationRepository,
  deleteIndexedDbBitcoinChangeReservations,
  type IndexedDbBitcoinChangeReservationRepositoryOptions
} from './bitcoin-change-reservation-repository'
export {
  BITCOIN_CHANGE_RESERVATION_SCHEMA_VERSION,
  BITCOIN_CHANGE_RESERVATION_STATES,
  type AllocateBitcoinChangeInput,
  type BindBitcoinChangeAddressInput,
  type BitcoinChangeReservation,
  type BitcoinChangeReservationRepository,
  type BitcoinChangeReservationScope,
  type BitcoinChangeReservationState,
  type TransitionBitcoinChangeInput
} from './bitcoin-change-reservation-model'
export {
  BITCOIN_INPUT_RESERVATION_DATABASE,
  IndexedDbBitcoinInputReservationRepository,
  deleteIndexedDbBitcoinInputReservations,
  type IndexedDbBitcoinInputReservationRepositoryOptions
} from './bitcoin-input-reservation-repository'
export {
  BITCOIN_INPUT_RESERVATION_SCHEMA_VERSION,
  BITCOIN_INPUT_RESERVATION_STATES,
  bitcoinInputOutpointKey,
  bitcoinInputReservationKey,
  parseBitcoinInputOutpoints,
  parseBitcoinInputReservation,
  type BitcoinInputOutpoint,
  type BitcoinInputReservation,
  type BitcoinInputReservationRepository,
  type BitcoinInputReservationScope,
  type BitcoinInputReservationState,
  type CommitBitcoinInputsInput,
  type ReserveBitcoinInputsInput
} from './bitcoin-input-reservation-model'
export {
  BITCOIN_DEFAULT_GAP_LIMIT,
  BITCOIN_DEFAULT_MAXIMUM_ADDRESSES_PER_TARGET,
  BITCOIN_DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
  BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS,
  BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET,
  BITCOIN_MAXIMUM_GAP_LIMIT
} from '@/core/chains/bitcoin'
export type {
  BitcoinAddressObservation,
  BitcoinDiscoveryCheckpoint,
  BitcoinDiscoveryCursor,
  BitcoinDiscoveryTarget
} from '@/core/chains/bitcoin'
