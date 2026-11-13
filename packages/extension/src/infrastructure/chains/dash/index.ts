import type { Network } from '@/types'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { resolveDashRpcEndpointOptions } from '../managed-rpc-endpoints'
import { createDashInsightClient } from './dash-insight-client'
import { createDashInsightFailoverClient } from './dash-insight-failover-client'

export function createConfiguredDashInsightClient(
  network: Network,
  customBaseUrl?: string
): ReturnType<typeof createDashInsightClient> | ReturnType<typeof createDashInsightFailoverClient> {
  const chainId = DASH_CHAIN_IDS[network]
  if (customBaseUrl !== undefined) {
    return createDashInsightClient({ chainId, baseUrl: customBaseUrl, timeoutMs: 5_000 })
  }
  return createDashInsightFailoverClient({
    chainId,
    endpoints: resolveDashRpcEndpointOptions(network).map(endpoint => ({
      id: endpoint.id,
      baseUrl: endpoint.baseUrl
    })),
    timeoutMs: 5_000
  })
}

export {
  attestDashInsightEndpoint,
  createDashInsightClient,
  DashRpcError,
  type DashInsightClientConfig,
  type DashInsightRpc
} from './dash-insight-client'
export { createDashInsightFailoverClient } from './dash-insight-failover-client'
export {
  DASH_COINBASE_MATURITY,
  DASH_DUFFS_PER_DASH,
  DASH_GAP_LIMIT,
  DASH_LOOKAHEAD_ADDRESSES,
  DASH_INSIGHT_MAX_ADDRESSES,
  DASH_INSIGHT_TX_PAGE_LENGTH,
  DASH_MAX_ADDRESSES_PER_CHAIN,
  DASH_LEGACY_FEE_BYTES_PER_KB,
  DASH_MAX_LEGACY_TX_BYTES,
  DASH_MAX_MONEY_DUFFS,
  DASH_MAX_RELAY_FEE_DUFFS_PER_KB,
  DASH_MIN_RELAY_FEE_DUFFS_PER_KB,
  DASH_P2PKH_DUST_RELAY_BYTES,
  dashP2pkhDustDuffs,
  estimateDashLegacyFeeDuffs,
  parseDashDecimalToDuffs,
  resolveDashInsightNetwork,
  resolveDashRelayFeeDuffsPerKb
} from './config'
export {
  dashBitcoinJsNetwork,
  dashDustDuffs,
  parseDashTransferAmount,
  DASH_REQUIRED_CONFIRMATIONS
} from './dash-transaction-model'
export { selectDashCoins } from './dash-coin-selection'
export { buildDashPsbt } from './dash-psbt-builder'
export { finalizeDashPsbt } from './dash-psbt-finalizer'
export {
  DashTransferOrchestrator,
  MemoryDashPendingTransferStore,
  createChromeSessionDashPendingTransferStore
} from './dash-transfer-orchestrator'
export { DashTransferPreparationCoordinator } from './dash-transfer-preparation-coordinator'
export { DashTransactionRecovery } from './dash-transaction-recovery'
export {
  DashTransactionMonitor,
  type DashTransactionMonitorResult
} from './dash-transaction-monitor'
export { createDashActivityHistorySource } from './dash-activity-history-source'
export {
  DASH_DISCOVERY_DATABASE,
  dashCurrentReceiveAddress,
  parseDashP2pkhAddress
} from './dash-discovery-model'
export {
  DashDiscoveryCoordinator,
  loadActiveDashDiscoveryContext
} from './dash-discovery-coordinator'
export { DashDiscoveryError, DashGapLimitScanner } from './dash-gap-limit-scanner'
export {
  IndexedDbDashDiscoveryRepository,
  MemoryDashDiscoveryRepository
} from './dash-discovery-repository'
export {
  IndexedDbDashInputReservationRepository,
  MemoryDashInputReservationRepository
} from './dash-input-reservation-repository'
export { IndexedDbDashChangeReservationRepository } from './dash-change-reservation-repository'
export {
  DashPortfolioCoordinator,
  type ActiveDashPortfolioSource
} from './dash-portfolio-coordinator'
export {
  classifyDashUtxo,
  collectDashSpendableUtxos,
  summarizeDashObservations
} from './dash-spendable-utxos'
