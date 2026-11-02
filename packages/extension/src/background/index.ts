import {
  initializeAnalyticsReporting,
  handleAnalyticsAlarm,
  ANALYTICS_OUTBOX_ALARM,
  ANALYTICS_EVENTS,
  handleAnalyticsMessage,
  trackEvent
} from '@/background/analytics/reporter'
import '@/lib/buffer-polyfill'
import { betaInviteActivation } from './beta-invite'
import { getBetaInviteErrorMessage } from '@/core/wallet/beta-invite'
import { promptBetaInviteActivation } from './beta-invite-window'
import { handleEvmWalletChoiceMessage } from './evm-wallet-choice'
import {
  BETA_INVITE_REQUIRED_MESSAGE,
  resolveUnactivatedBetaDAppRequest
} from '@/core/dapp/beta-invite-policy'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import {
  saveSwapApprovalContinuation,
  readSwapApprovalContinuation,
  continueSwapAfterApproval,
  clearSwapApprovalContinuation,
  clearAllSwapApprovalContinuations
} from './swap-approval-continuation'
import { resolveWalletUnlockPath } from '@/core/wallet/wallet-unlock-path'
import { parseLedgerPcztSignatures } from '@/lib/ledger/signature'
import { safeBig } from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { LedgerSigningPayload } from '@/core/worker/types'
import '@/core/services/lending-sdk-init'

import {
  projectZcashOperationEvent,
  type ZcashOperationAnalyticsContext
} from '@/lib/analytics/operations'
import { dappHandler } from './dapp-handler'
import { evmDAppOperationStore } from './evm-dapp-operation-store'
import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { UI_CONFIG } from '@/config/extension'
import { WALLET_CONFIG, ZEC_DECIMALS, type MnemonicWordCount } from '@/config/wallet'
import {
  DEFAULT_NETWORK,
  getNetworkConfig,
  initializeRuntimeNetwork,
  isRuntimeNetworkInitialized
} from '@/lib/runtime-network'
import { inspectZcashTransparentAccountHistory } from '@/core/wallet/zcash-account-history'
import { prepareTransparentSpend } from '@/core/wallet/transparent-spend-preflight'
import { sanitizeMarginalFeeZats } from '@/core/zcash/fee-policy'
import { closeAllPopupWindows } from './window-manager'
import { pendingRequestsManager } from './pending-requests'
import { getApprovalContext, estimateApprovalFee } from './approval-context'
import { SecureStorage } from '../core/wallet/secure-storage'
import { needsUnlock } from '../lib/lock-utils'
import { transactionMonitor } from './transaction-monitor'
import { zcashTxMonitor, computeExpiryHeight } from './zcash-tx-monitor'
import { formatLogError } from '@/lib/log-format'
import { logger } from '@/lib/logger'
import { appendDiagnosticLog, exportDiagnosticLogs } from '@/lib/diagnostic-log-store'
import { parseDiagnosticLogDraft, sanitizeDiagnosticMessage } from '@/lib/diagnostic-log'
import { logDebugTiming, traceDebugStage } from '@/lib/debug-performance'
import { hasWalletDb, loadTransactions, mutateTransactions } from '@/lib/indexed-db'
import {
  useWalletStore,
  prepareWalletStoreForUse,
  rehydrateWalletStore,
  waitForHydration,
  flushWalletStore
} from '@/store/wallet-store'
import { transactionRecorder } from './transaction-recorder'
import { useAccountDataStore } from '@/store/account-data-store'
import { syncScheduler, SYNC_KEEPALIVE_ALARM } from './sync-scheduler'
import {
  catchUpAfterOnChainTx,
  markWalletNeedsCatchUp,
  refreshAfterOnChainBroadcast
} from './tx-sync'
import { getRetryableWalletRpcUserMessage } from '@/core/zcash/wallet-rpc-errors'
import {
  clearPreparedHardwareSignRequest,
  consumePreparedHardwareSignRequest,
  isHardwareSignRequestFresh,
  readHardwareSignRequest,
  writePreparedHardwareSignRequest,
  type HardwareSignKind
} from '@/lib/hardware-tab'
import { applyTransactionBroadcast } from '@/lib/transaction-replacement'
import { WalletCleanupCoordinator } from './wallet-cleanup'
import {
  getShieldableTransparentBalance,
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'
import type { TransactionStatusUpdatedMessage } from '@/types/transaction-messages'
import { initializeExtensionUpdates } from './extension-update'
import type { SendTransactionParams, TransactionType, Network } from '@/types'
import { isIntentsSettledTransaction } from '@/lib/cross-chain-transaction'
import { buildAccountKey, type AccountScope } from '@/core/wallet/account-scope'
import {
  applyZeroIndexerOptionsToActiveWorker,
  forwardKeyringRpcToOffscreen
} from '@/core/worker/client'
import {
  addCustomZeroIndexerNode,
  getZeroIndexerBroadcastOptions,
  getZeroIndexerNodeStatus,
  removeCustomZeroIndexerNode,
  selectZeroIndexerNode
} from './zero-indexer-node-settings'
import {
  readZeroIndexerEnabled,
  writeZeroIndexerEnabled
} from '@/infrastructure/chains/zero-indexer-preferences'
import {
  isTransactionSubmissionUnknown,
  requireSuccessfulTransfer
} from '@/core/zcash/transfer-result'
import { encodeWorkerRpcError } from '@/core/worker/rpc-errors'
import { CredentialAuthenticationError } from '@/infrastructure/keyring/credential-envelope-authentication'
import {
  SETTINGS_STORAGE_KEY,
  resolvePersistedAutoLockMs,
  updatePersistedWalletSettings,
  withWalletSettingsLock
} from '@/lib/wallet-settings-storage'
import {
  getChainEndpointRuntimeKey,
  type ChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import {
  resolveActiveEvmNetworkConfig,
  resolveEvmNetworkCatalog
} from '@/core/chains/evm-runtime-config'
import { AutoLockCoordinator, WALLET_AUTO_LOCK_ALARM } from './auto-lock'
import { credentialLifecycle } from './credential-lifecycle'
import { credentialSession } from './credential-session'
import { switchActiveAccountPersistently } from './account-switch'
import {
  getContentScriptSenderOrigin,
  getOwnExtensionSenderContext,
  hasExactRuntimeKeys,
  isOwnExtensionRouteSender,
  isRuntimeRecord,
  isTrustedRuntimeMessageSender,
  isTrustedExtensionSender,
  parseDAppRuntimeRequestMessage,
  parseTrustedExtensionRuntimeMessage,
  parseWorkerRpcRuntimeMessage
} from '@/lib/runtime-message-security'
import { authorizeMultichainExtensionCommand } from './multichain-rpc-policy'
import {
  BackgroundEvmTransactionMonitor,
  EVM_TRANSACTION_MONITOR_ALARM
} from './evm-transaction-monitor'
import { createBackgroundEvmPortfolioCoordinator } from './evm-portfolio'
import { createBackgroundPortfolioCoordinator } from './portfolio'
import { createBackgroundActivityCoordinator } from './activity'
import {
  createBackgroundAssetMarketHistoryService,
  createBackgroundAssetPriceService
} from './asset-prices'
import { createBackgroundRheaSwapService, readRheaZcashTransferDeadline } from './rhea-swap'
import { getSafeRheaSwapRuntimeErrorMessage } from '@/core/services/rhea-swap/rhea-swap-error'
import {
  RHEA_SWAP_TRANSACTION_MONITOR_ALARM,
  RheaSwapTransactionMonitor,
  recoverSignedRheaSwaps,
  recoverSignedRheaSwapsAndPoll,
  scheduleRheaSwapTransactionMonitorRetry
} from './rhea-swap-transaction-monitor'
import { prepareRheaSwapZcashDestinationCatchUp } from './rhea-swap-zcash-sync'
import { createBackgroundRheaSwapEvmSignatureCoordinator } from './rhea-swap-evm-signature'
import {
  createBackgroundRheaSwapSolanaCoordinator,
  type RheaSwapSolanaCoordinator
} from './rhea-swap-solana'
import {
  createBackgroundRheaSwapNearCoordinator,
  type RheaSwapNearCoordinator
} from './rhea-swap-near'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseAccountId } from '@/core/accounts/domain'
import { isAssetMarketHistoryRange } from '@/core/prices'
import { UnsupportedAssetMarketHistoryError } from '@/infrastructure/prices'
import {
  getBitcoinChainId,
  getZcashChainId,
  parseAssetId,
  parseChainId,
  type AssetDefinitionInput
} from '@/core/chains/registry'

import {
  computeEvmSigningPayloadFingerprint,
  EvmRpcError,
  EvmTransactionError,
  type EvmSigningPreparePayload,
  ChromeSessionEvmPendingTransferStore,
  type DetectedEvmAssetCoordinator,
  type UserEvmAssetCoordinator
} from '@/infrastructure/chains/evm'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import {
  createBackgroundEvmTransferRuntime,
  hasBackgroundEvmTransferCapability,
  type BackgroundEvmTransferRouter
} from './evm-transfer'

import {
  CONFIDENTIAL_FUNDING_MONITOR_ALARM,
  createBackgroundConfidentialFundingCoordinator
} from './confidential-funding'
import type { ConfidentialFundingCoordinator } from './confidential-funding-coordinator'
import { ChromeConfidentialFundingStore } from './confidential-funding-store'
import { createEvmWalletRuntimeError } from '@/core/chains/evm'
import { hidePortfolioAssets } from '@/core/portfolio'
import { mapEvmWalletRuntimeError } from './evm-wallet-runtime-error'
import {
  isNewWalletFamilyEnabled,
  resolveBitcoinFeatureRuntimePolicy,
  resolveEvmFeatureRuntimePolicy,
  resolveNearFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'
import { accountContextTransition } from './account-context-transition'
import { createBackgroundAdditionalReceiveTargetsCoordinator } from './receive-targets'
import { createBackgroundAccountNetworksCoordinator } from './account-networks'
import { WalletDAppConnectionCoordinator } from './wallet-dapp-connection'
import { createBackgroundBitcoinAddressBalancesCoordinator } from './bitcoin-address-balances'
import { createBackgroundEvmDAppHandler } from './evm-dapp'
import { handleEvmDAppNetworkSwitch } from './evm-dapp-network-switch'
import {
  type ParsedEip1193ChainRequest,
  Eip1193ProviderError,
  toEip1193ErrorShape,
  type EvmDAppRuntimeMethod
} from '@/core/dapp/eip1193'
import { createBackgroundBitcoinDAppHandler } from './bitcoin-dapp'
import { fetchCachedIdentity, type IdentitySigningMode } from '@/core/wallet/identity-cache'
import type { LendingSigningMode } from '@/core/services/lending-service'
import {
  BitcoinProviderError,
  toBitcoinProviderErrorShape,
  type BitcoinDAppRuntimeMethod
} from '@/core/dapp/bitcoin-provider'
import {
  NativeTransferProviderError,
  toNativeTransferProviderErrorShape,
  type NearDAppRuntimeMethod,
  type SolanaDAppRuntimeMethod
} from '@/core/dapp/native-transfer-provider'
import { createBackgroundSolanaDAppHandler } from './solana-dapp'
import { createBackgroundNearDAppHandler } from './near-dapp'
import {
  BackgroundMultichainSessionDAppHandler,
  toCaip25ErrorShape
} from './multichain-session-dapp-handler'
import { caip25SessionAllowsMethod, type Caip25RuntimeMethod } from '@/core/dapp/caip25'
import {
  resolveNearRuntimeNetworkConfig,
  resolveSolanaRuntimeNetworkConfig
} from '@/core/chains/solana-near-runtime-config'
import { isExplicitMultichainConnectRequest } from './dapp-unlock-policy'
import {
  addSoftwareWallet,
  generateAddWalletMnemonic,
  generatePrimaryWalletMnemonic,
  provisionPrimarySoftwareWallet,
  type SoftwareWalletProvisioningMode
} from './software-wallet-provisioning'
import { provisionKeystoneHardware, provisionLedgerHardware } from './hardware-wallet-provisioning'
import {
  exportPrivateKey,
  importPrivateKeyWallet,
  previewPrivateKeyWallet
} from './private-key-wallet'
import {
  BackgroundBitcoinTransactionMonitor,
  BITCOIN_TRANSACTION_MONITOR_ALARM
} from './bitcoin-transaction-monitor'
import {
  BackgroundNearIntentsTransactionMonitor,
  NEAR_INTENTS_TRANSACTION_MONITOR_ALARM
} from './near-intents-transaction-monitor'
import {
  createBackgroundBitcoinTransferController,
  hasBackgroundBitcoinTransferCapability,
  reloadBackgroundBitcoinRuntime
} from './bitcoin-transfer'
import { createBitcoinWalletRuntimeError } from '@/core/chains/bitcoin'
import { mapBitcoinWalletRuntimeError } from './bitcoin-wallet-runtime-error'
import { PortfolioCoordinatorError } from '@/infrastructure/portfolio'
import {
  BitcoinDiscoveryReadError,
  BitcoinPortfolioCoordinatorError,
  ChromeSessionBitcoinPendingTransferStore
} from '@/infrastructure/chains/bitcoin'
import {
  ChainEndpointSettingsCoordinator,
  resolveConfiguredBitcoinRpcUrl
} from './chain-endpoint-settings'

import { ChromeSessionSolanaPendingTransferStore } from '@/infrastructure/chains/solana'
import { ChromeSessionNearPendingTransferStore } from '@/infrastructure/chains/near'

import { validateVotingDecisions } from '@/lib/voting'

import { BitcoinMultichainDerivationClient } from '@/infrastructure/keyring/multichain/bitcoin-derivation-client'
import type { NetworkAccountMetadataInput } from '@/infrastructure/keyring/network-account-metadata-coordinator'
import {
  NEAR_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG
} from '@/config/multichain-feature-flags'
import { deriveSoftwareEd25519NetworkMetadata } from './software-ed25519-metadata'
import { dappManager } from '@/core/dapp/dapp-manager'
import {
  DAppExecutionModeConfirmationRequiredError,
  DAppExecutionModeTransitionCoordinator,
  type DAppExecutionMode,
  type DAppExecutionModeScope
} from '@/core/dapp/dapp-execution-mode'
import { dappExecutionModeCoordinator, dappExecutionModeRequestGate } from './dapp-execution-mode'
import { createSolanaWalletRuntimeError } from '@/core/chains/solana'
import { mapSolanaWalletRuntimeError } from './solana-wallet-runtime-error'
import { createBackgroundSolanaTransferController } from './solana-transfer'
import {
  BackgroundSolanaTransactionMonitor,
  SOLANA_TRANSACTION_MONITOR_ALARM
} from './solana-transaction-monitor'
import { createNearWalletRuntimeError } from '@/core/chains/near'
import { mapNearWalletRuntimeError } from './near-wallet-runtime-error'
import { createBackgroundNearTransferController } from './near-transfer'
import {
  BackgroundNearTransactionMonitor,
  NEAR_TRANSACTION_MONITOR_ALARM
} from './near-transaction-monitor'
import { hasKeystoneWalletMissingNetworkProjection } from '@/store/wallet-network-projection'
import {
  configureLedgerSigningCoordinator,
  registerLedgerSigningTabLifecycle,
  getLedgerSigningRequest,
  submitLedgerSigningResponse,
  cancelLedgerSigning,
  cancelAllLedgerSigning
} from './ledger-signing-coordinator'
import { readLedgerProvisioningCredential } from './ledger-signing-bridge'

import type { ChromeTokenVisibilityRepository } from '@/infrastructure/portfolio/chrome-token-visibility'
import type { DetectedEvmAssetRecord, UserEvmAssetRecord } from '@/core/chains/user-assets'
import { createBackgroundUserEvmAssetRuntime } from './user-evm-assets'
import {
  fetchIntentsWalletTokens,
  getCachedTokens,
  type SwapToken
} from '@/core/services/intents-api'
import {
  createIntentsWalletAssetCatalog,
  resolveIntentsWalletAsset,
  type IntentsProtocolAssetPriceMapping
} from '@/core/services/intents-wallet-assets'

import { ChromeSwapTokenCatalogCacheRepository } from '@/infrastructure/persistence/chrome-swap-token-catalog-cache'
import {
  getActionFailureNotificationCopy,
  TRANSACTION_PENDING_MESSAGE
} from '@/lib/transaction-status-copy'
import {
  applyExtensionDisplayMode,
  enqueueExtensionDisplayModeUpdate,
  getAppliedSidePanelMode,
  initializeExtensionDisplayMode,
  persistSidePanelMode
} from './extension-display-mode'
import { computePassiveSyncDelayMinutes, shouldRequestPeriodicSync } from './passive-sync-policy'
import { fetchLatestBlockHeight } from '@/infrastructure/chains/rpc-registry-client'
import { SerialTaskQueue, TimeoutError, withTimeout } from '@/lib/async-utils'

import {
  getPreferredRpcEndpointOption,
  refreshRpcEndpointRegistry
} from '@/infrastructure/chains/rpc-endpoints'

const MULTICHAIN_WORKER_RPC_METHODS = new Set(['multichain.execute', 'multichain.abort'])
if (__MULTICHAIN_CONFORMANCE_RPC_ENABLED__) {
  MULTICHAIN_WORKER_RPC_METHODS.add('multichain.conformance-execute')
  MULTICHAIN_WORKER_RPC_METHODS.add('multichain.conformance-restart')
}

const runtimeNetworkReady = initializeRuntimeNetwork()

const evmFeatureRuntimePolicy = resolveEvmFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__)
const bitcoinFeatureRuntimePolicy = resolveBitcoinFeatureRuntimePolicy(
  __ENABLED_CHAIN_FEATURE_FLAGS__
)
const solanaBetaEnabled = __ENABLED_CHAIN_FEATURE_FLAGS__.includes(SOLANA_CHAIN_FEATURE_FLAG)
const nearBetaEnabled = __ENABLED_CHAIN_FEATURE_FLAGS__.includes(NEAR_CHAIN_FEATURE_FLAG)

function areSolanaOperationsEnabled(): boolean {
  return resolveSolanaFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled
}

function areNearOperationsEnabled(): boolean {
  return resolveNearFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled
}

let evmTransactionMonitor: BackgroundEvmTransactionMonitor | null = null
let bitcoinTransactionMonitor: BackgroundBitcoinTransactionMonitor | null = null
let nearIntentsTransactionMonitor: BackgroundNearIntentsTransactionMonitor | null = null
let solanaTransactionMonitor: BackgroundSolanaTransactionMonitor | null = null
let nearTransactionMonitor: BackgroundNearTransactionMonitor | null = null

type EnabledPrivateKeyChainFamily = 'eip155' | 'bip122' | 'solana' | 'near'

function resolveEnabledPrivateKeyChainFamily(value: unknown): EnabledPrivateKeyChainFamily {
  if (
    (value === 'eip155' || value === 'bip122' || value === 'solana' || value === 'near') &&
    isNewWalletFamilyEnabled(value, __ENABLED_CHAIN_FEATURE_FLAGS__)
  )
    return value
  throw new Error('Private-key chain is not enabled in this build')
}

function resolveEnabledPrivateKeyExportChainId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Private-key export chain is invalid')
  if (value.startsWith('solana:')) resolveEnabledPrivateKeyChainFamily('solana')
  if (value.startsWith('near:')) resolveEnabledPrivateKeyChainFamily('near')
  return value
}
let evmPortfolioConformanceCoordinator: ReturnType<
  typeof createBackgroundEvmPortfolioCoordinator
> | null = null
let portfolioCoordinator: ReturnType<typeof createBackgroundPortfolioCoordinator> | null = null
let activityCoordinator!: ReturnType<typeof createBackgroundActivityCoordinator>
let assetPriceService = createBackgroundAssetPriceService()
let assetPriceRefreshTail: Promise<void> = Promise.resolve()
const assetPriceRefreshes = new Map<
  string,
  { service: typeof assetPriceService; operation: ReturnType<typeof assetPriceService.refresh> }
>()
let assetMarketHistoryService = createBackgroundAssetMarketHistoryService()
const rheaSwapService = DEFAULT_NETWORK === 'mainnet' ? createBackgroundRheaSwapService() : null
const rheaSwapTransactionMonitor = rheaSwapService
  ? new RheaSwapTransactionMonitor(rheaSwapService, {
      loadZcashAccountScopes: getZcashAccountScopes,
      prepareZcashDestinationCatchUp: scope =>
        prepareRheaSwapZcashDestinationCatchUp(scope, {
          getNetwork: () => backgroundZcashWalletRuntime.getNetwork(),
          accountExists: (walletId, accountId) =>
            Boolean(useWalletStore.getState().getAccount(walletId, accountId)),
          getActiveScope: () => {
            const state = useWalletStore.getState()
            return {
              network: state.currentNetwork,
              walletId: state.currentWalletId,
              accountId: state.currentAccountId
            }
          },
          markNeedsCatchUp: markWalletNeedsCatchUp,
          catchUp: catchUpAfterOnChainTx,
          onCatchUpError: error => {
            console.warn('[RHEA Swap Monitor] Zcash destination catch-up failed', {
              errorName: error instanceof Error ? error.name : 'UnknownError'
            })
          }
        }),
      refreshPortfolio: async ({ scope, chainIds }) => {
        const model = await portfolioCoordinator?.refreshActive(chainIds)
        if (
          !model ||
          model.scope.keyDomainId !== scope.keyDomainId ||
          model.scope.accountId !== scope.accountId
        ) {
          return
        }
        await chrome.runtime
          .sendMessage({
            type: 'PORTFOLIO_UPDATED',
            walletId: scope.keyDomainId,
            accountId: scope.accountId
          })
          .catch(() => {})
      }
    })
  : null
const rheaSwapEvmSignatureCoordinator = rheaSwapService
  ? createBackgroundRheaSwapEvmSignatureCoordinator(
      rheaSwapService,
      new EvmMultichainSigningClient({ credentials: credentialSession })
    )
  : null
let userEvmAssetCoordinator: UserEvmAssetCoordinator | null = null
let detectedEvmAssetCoordinator: DetectedEvmAssetCoordinator | null = null
let tokenVisibility: ChromeTokenVisibilityRepository | null = null
let userEvmAssetRecords: readonly UserEvmAssetRecord[] = Object.freeze([])
let detectedEvmAssetRecords: readonly DetectedEvmAssetRecord[] = Object.freeze([])
let additionalReceiveTargetsCoordinator!: ReturnType<
  typeof createBackgroundAdditionalReceiveTargetsCoordinator
>
let accountNetworksCoordinator!: ReturnType<typeof createBackgroundAccountNetworksCoordinator>
const bitcoinAddressBalancesCoordinator = createBackgroundBitcoinAddressBalancesCoordinator()
let evmTransferController: ReturnType<
  typeof createBackgroundEvmTransferRuntime
>['activeController'] = null
let evmTransferRouter: BackgroundEvmTransferRouter | null = null
let confidentialFundingCoordinator: ConfidentialFundingCoordinator | null = null
const confidentialFundingStore = new ChromeConfidentialFundingStore()
let bitcoinTransferController: ReturnType<typeof createBackgroundBitcoinTransferController> | null =
  null
let solanaTransferController: ReturnType<typeof createBackgroundSolanaTransferController> | null =
  null
let rheaSwapSolanaCoordinator: RheaSwapSolanaCoordinator | null = null
let nearTransferController: ReturnType<typeof createBackgroundNearTransferController> | null = null
let rheaSwapNearCoordinator: RheaSwapNearCoordinator | null = null
let intentsProtocolAssets: readonly AssetDefinitionInput[] = Object.freeze([])
let intentsProtocolAssetIds: readonly string[] = Object.freeze([])
let intentsProtocolPriceMappings: readonly IntentsProtocolAssetPriceMapping[] = Object.freeze([])
let intentsProtocolAssetRefresh: Promise<void> | null = null
let intentsProtocolAssetsReady = false
const swapTokenCatalogCache = new ChromeSwapTokenCatalogCacheRepository()
let evmDAppHandler!: ReturnType<typeof createBackgroundEvmDAppHandler>
let bitcoinDAppHandler!: ReturnType<typeof createBackgroundBitcoinDAppHandler>
let solanaDAppHandler: ReturnType<typeof createBackgroundSolanaDAppHandler> | null = null
let nearDAppHandler: ReturnType<typeof createBackgroundNearDAppHandler> | null = null
let multichainSessionDAppHandler: BackgroundMultichainSessionDAppHandler | null = null
const chainEndpointSettingsCoordinator = new ChainEndpointSettingsCoordinator()

function refreshAssetPrices(assetId?: string) {
  const service = assetPriceService
  const fullRefresh = assetPriceRefreshes.get('*')
  if (assetId && fullRefresh?.service === service) return fullRefresh.operation
  const key = assetId ?? '*'
  const pending = assetPriceRefreshes.get(key)
  if (pending?.service === service) return pending.operation
  const operation = assetPriceRefreshTail.then(
    () => service.refresh(assetId),
    () => service.refresh(assetId)
  )
  assetPriceRefreshes.set(key, { service, operation })
  assetPriceRefreshTail = operation.then(
    () => undefined,
    () => undefined
  )
  void assetPriceRefreshTail.then(() => {
    if (assetPriceRefreshes.get(key)?.operation === operation) assetPriceRefreshes.delete(key)
  })
  return operation
}
const networkSwitchBitcoinDerivation = new BitcoinMultichainDerivationClient({
  credentials: credentialSession
})
const accountNetworksPeaDerivation = new EvmMultichainSigningClient({
  credentials: credentialSession
})
const networkSwitchEvmPending = new ChromeSessionEvmPendingTransferStore()
const networkSwitchBitcoinPending = new ChromeSessionBitcoinPendingTransferStore()
const networkSwitchSolanaPending = new ChromeSessionSolanaPendingTransferStore()
const networkSwitchNearPending = new ChromeSessionNearPendingTransferStore()
let networkRestartRequired = false
const NETWORK_MODE_RESTART_ALARM = 'network-mode-restart'
let activeEvmNumericChainId = 0
let multichainRuntimeKey = ''
let multichainRuntimeReady: Promise<void> = runtimeNetworkReady.then(() => undefined)

const walletDAppConnection = new WalletDAppConnectionCoordinator({
  getCurrentTabDApp: () => dappManager.getCurrentTabDApp(),
  getConnection: origin => dappManager.getConnection(origin),
  loadActiveAccount: () => accountNetworksCoordinator.readActiveAccount(),
  getEvmChainId: () => evmDAppHandler.getCaip2ChainId(),
  getZcashChainId: () => getZcashChainId(DEFAULT_NETWORK),
  connectEvm: origin => evmDAppHandler.connectCurrentAccountToDApp(origin),
  connectZcash: origin => dappHandler.connectCurrentAccountToDApp(origin),
  runActiveOperation: async operation => {
    await rehydrateWalletStore()
    await multichainRuntimeReady
    return accountContextTransition.runActiveOperation(operation)
  }
})

async function requireActiveDAppExecutionModeScope(): Promise<DAppExecutionModeScope> {
  const account = await accountNetworksCoordinator.readActiveAccount()
  if (!account) throw new Error('No active wallet account')
  return Object.freeze({
    network: DEFAULT_NETWORK,
    keyDomainId: account.reference.walletId,
    accountId: account.reference.accountId
  })
}

async function notifyDAppExecutionModeChanged(scope: DAppExecutionModeScope): Promise<void> {
  dappHandler.cancelPendingApprovalsForContext(scope.keyDomainId, scope.accountId, 'evm')
  await multichainRuntimeReady
  await evmDAppHandler.notifyAccountsChanged()
}

const dappExecutionModeTransitionCoordinator = new DAppExecutionModeTransitionCoordinator(
  dappExecutionModeCoordinator,
  {
    count: async scope => {
      const inMemory = dappHandler.countPendingApprovalsForContext(
        scope.keyDomainId,
        scope.accountId,
        'evm'
      )
      const persisted = await evmDAppOperationStore.listForScope(scope.keyDomainId, scope.accountId)
      return Math.max(inMemory, persisted.length)
    },
    cancel: async scope => {
      const inMemory = dappHandler.cancelPendingApprovalsForContext(
        scope.keyDomainId,
        scope.accountId,
        'evm'
      )
      const persisted = await evmDAppOperationStore.listForScope(scope.keyDomainId, scope.accountId)
      for (const operation of persisted) {
        await evmTransferRouter?.rejectForScope(operation.transactionId, {
          keyDomainId: parseKeyDomainId(scope.keyDomainId),
          accountId: parseAccountId(scope.accountId)
        })
        await evmDAppOperationStore.delete(operation.transactionId)
      }
      return Math.max(inMemory, persisted.length)
    }
  },
  notifyDAppExecutionModeChanged,
  dappExecutionModeRequestGate
)

async function dispatchDAppChainRequest(
  chainId: 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'near',
  request: {
    readonly method: string
    readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>
  },
  origin: string,
  tabInfo: { readonly title?: string; readonly favIconUrl?: string; readonly pageUrl?: string }
): Promise<unknown> {
  await assertCaip25MethodPermission(chainId, request.method, origin)
  if (chainId === 'evm') {
    return evmDAppHandler.request(
      {
        method: request.method as EvmDAppRuntimeMethod,
        ...(request.params === undefined ? {} : { params: request.params })
      },
      origin,
      tabInfo
    )
  }
  const params = Array.isArray(request.params) ? request.params : undefined
  if (chainId === 'bitcoin') {
    return bitcoinDAppHandler.request(
      {
        method: request.method as BitcoinDAppRuntimeMethod,
        ...(params === undefined ? {} : { params })
      },
      origin,
      tabInfo
    )
  }
  if (chainId === 'solana') {
    if (!solanaDAppHandler) throw new Error('Solana dApp runtime is unavailable')
    return solanaDAppHandler.request(
      {
        method: request.method as SolanaDAppRuntimeMethod,
        ...(params === undefined ? {} : { params })
      },
      origin,
      tabInfo
    )
  }
  if (chainId === 'near') {
    if (!nearDAppHandler) throw new Error('NEAR dApp runtime is unavailable')
    return nearDAppHandler.request(
      {
        method: request.method as NearDAppRuntimeMethod,
        ...(params === undefined ? {} : { params })
      },
      origin,
      tabInfo
    )
  }
  return request.method === 'zcash_disconnect'
    ? handleDAppDisconnect(origin)
    : handleDAppRequest(request, origin, tabInfo)
}

const CAIP25_CONNECTION_METHODS = new Set([
  'zcash_requestAccounts',
  'zcash_disconnect',
  'eth_requestAccounts',
  'wallet_requestPermissions',
  'wallet_revokePermissions',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'connect',
  'requestAccounts',
  'disconnect',
  'switchNetwork',
  'switchChain'
])

async function assertCaip25MethodPermission(
  family: 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'near',
  method: string,
  origin: string
): Promise<void> {
  if (CAIP25_CONNECTION_METHODS.has(method)) return
  const chainId =
    family === 'zcash'
      ? getZcashChainId(DEFAULT_NETWORK)
      : family === 'evm'
        ? evmDAppHandler.getCaip2ChainId()
        : family === 'bitcoin'
          ? getBitcoinChainId(DEFAULT_NETWORK)
          : family === 'solana'
            ? resolveSolanaRuntimeNetworkConfig(DEFAULT_NETWORK).chainId
            : resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK).chainId
  const session = await dappManager.getCaip25Session(origin)
  const scope = session?.scopes.find(candidate => candidate.chainId === chainId)
  if (!scope || caip25SessionAllowsMethod(session, chainId, method)) return
  const message = `${method} is not authorized for CAIP-25 scope ${chainId}.`
  if (family === 'evm') throw new Eip1193ProviderError(4100, message)
  if (family === 'bitcoin') throw new BitcoinProviderError(4100, message)
  if (family === 'solana' || family === 'near') {
    throw new NativeTransferProviderError(4100, message)
  }
  throw new Error(message)
}

async function handleEvmDAppNetworkRequest(
  requested: ParsedEip1193ChainRequest,
  origin: string,
  action: 'switch' | 'add',
  tabInfo: { readonly title?: string; readonly favIconUrl?: string; readonly pageUrl?: string }
): Promise<void> {
  const runtime = evmDAppHandler
  const account = useWalletStore.getState()
  const accountIdentity = [
    account.currentWalletId,
    account.currentAccountId,
    account.currentNetwork
  ]
  const sourceChainId = runtime.getCaip2ChainId()
  const authorization = JSON.stringify(
    await dappManager.getChainAuthorization(origin, sourceChainId)
  )
  const readUnlockEpoch = async () =>
    account.currentWalletId
      ? (await credentialSession.getCredentialBinding(account.currentWalletId).catch(() => null))
          ?.globalUnlockEpoch
      : undefined
  const unlockEpoch = await readUnlockEpoch()
  const validateRequest = async (): Promise<void> => {
    const current = useWalletStore.getState()
    if (
      runtime !== evmDAppHandler ||
      JSON.stringify(accountIdentity) !==
        JSON.stringify([
          current.currentWalletId,
          current.currentAccountId,
          current.currentNetwork
        ]) ||
      authorization !==
        JSON.stringify(await dappManager.getChainAuthorization(origin, sourceChainId)) ||
      unlockEpoch !== (await readUnlockEpoch())
    ) {
      throw new Eip1193ProviderError(
        4001,
        'Wallet context changed. Review the network request again.'
      )
    }
  }
  await validateRequest()
  await handleEvmDAppNetworkSwitch(requested, origin, action, {
    readSettings: () => chainEndpointSettingsCoordinator.read(),
    validateRequest,
    commitCustomNetwork: async network => {
      await updateChainEndpointSettings(async () => {
        await validateRequest()
        return chainEndpointSettingsCoordinator.saveCustomEvmNetwork(
          network,
          undefined,
          validateRequest
        )
      })
    },
    commitActiveChain: (chainId, approvalOrigin) =>
      commitEvmDAppActiveChain(chainId, approvalOrigin, validateRequest),
    requestApproval: (approvalOrigin, approvalAction, data) =>
      dappHandler.requestExternalApproval(approvalOrigin, approvalAction, {
        ...(typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {}),
        ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
        ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
      })
  })
}

function commitEvmDAppActiveChain(
  chainId: string,
  origin: string,
  validateRequest: () => Promise<void>
): Promise<void> {
  const previousReadiness = multichainRuntimeReady
  let reconfiguring = false
  const operation = previousReadiness
    .catch(() => {})
    .then(() =>
      accountContextTransition.runActiveOperation(async () => {
        await validateRequest()
        const sourceChainId = evmDAppHandler.getCaip2ChainId()
        const saved = await chainEndpointSettingsCoordinator.selectActiveEvmChain(
          chainId,
          validateRequest
        )
        reconfiguring = true
        await dappManager.carryEvmAuthorizationToChain(origin, sourceChainId, chainId)
        await reloadMultichainRuntime(saved)
      })
    )
  multichainRuntimeReady = operation.catch(error => {
    if (reconfiguring) throw error
    return previousReadiness
  })
  void multichainRuntimeReady.catch(() => {})
  return operation
}

function applyChainEndpointSettings(
  settings: unknown,
  expectedSettings?: unknown
): Promise<ChainEndpointSettings> {
  return updateChainEndpointSettings(() =>
    chainEndpointSettingsCoordinator.apply(settings, expectedSettings)
  )
}

function updateChainEndpointSettings(
  update: () => Promise<ChainEndpointSettings>
): Promise<ChainEndpointSettings> {
  const previousReadiness = multichainRuntimeReady
  let reconfiguring = false
  const operation = previousReadiness
    .catch(() => {})
    .then(() =>
      accountContextTransition.runActiveOperation(async () => {
        const previous = await chainEndpointSettingsCoordinator.read()
        const result = await update()
        reconfiguring = true
        await reloadMultichainRuntime(result)
        const previousZcashRpc = previous.overrides.find(
          override => override.chainId === getZcashChainId(DEFAULT_NETWORK)
        )?.rpc?.url
        const nextZcashRpc = result.overrides.find(
          override => override.chainId === getZcashChainId(DEFAULT_NETWORK)
        )?.rpc?.url
        if (previousZcashRpc !== nextZcashRpc) {
          await waitForHydration()
          await backgroundZcashWalletRuntime.applyRpcEndpointChange()
          syncScheduler.onRequestSync()
        }
        return result
      })
    )
  // Validation and concurrent-edit rejections leave the existing runtime ready.
  multichainRuntimeReady = operation.then(
    () => undefined,
    error => {
      if (reconfiguring) throw error
      return previousReadiness
    }
  )
  void multichainRuntimeReady.catch(() => {})
  return operation
}

async function reloadMultichainRuntime(
  settings: ChainEndpointSettings,
  force = false,
  cancelAwaitingApprovals = true
): Promise<void> {
  const solanaOperationsEnabled = areSolanaOperationsEnabled()
  const nearOperationsEnabled = areNearOperationsEnabled()
  const nextKey = getChainEndpointRuntimeKey(settings)
  if (!force && nextKey === multichainRuntimeKey) return
  const isRuntimeReconfiguration = multichainRuntimeKey !== ''
  const endpointRuntimeChanged = isRuntimeReconfiguration && nextKey !== multichainRuntimeKey
  const shouldCancelAwaitingApprovals = isRuntimeReconfiguration && cancelAwaitingApprovals
  if (endpointRuntimeChanged || shouldCancelAwaitingApprovals) {
    evmDAppHandler?.deactivate()
  }
  const catalog = resolveEvmNetworkCatalog(DEFAULT_NETWORK, settings)
  const activeEvm = resolveActiveEvmNetworkConfig(DEFAULT_NETWORK, settings)
  const customEvmNetworks = catalog.filter(network => network.source === 'custom')
  const userAssets = await createBackgroundUserEvmAssetRuntime(catalog, customEvmNetworks)
  userEvmAssetCoordinator = userAssets.coordinator
  detectedEvmAssetCoordinator = userAssets.detectedCoordinator
  tokenVisibility = userAssets.visibility
  userEvmAssetRecords = userAssets.records
  detectedEvmAssetRecords = userAssets.detectedRecords
  if (userAssets.catalogStatus === 'error') {
    console.warn(
      '[User EVM Assets] Stored catalog failed validation; built-in assets remain active'
    )
  }
  const bitcoinRpcUrl = resolveConfiguredBitcoinRpcUrl(settings)
  const previousNumericChainId = activeEvmNumericChainId

  if (shouldCancelAwaitingApprovals) {
    await evmTransferRouter?.cancelAllAwaitingApprovals()
    await solanaTransferController?.cancelAllAwaitingApprovals()
    await nearTransferController?.cancelAllAwaitingApprovals()
  }
  await reloadBackgroundBitcoinRuntime(bitcoinRpcUrl, shouldCancelAwaitingApprovals)

  evmTransactionMonitor = evmFeatureRuntimePolicy.transactionRecoveryEnabled
    ? new BackgroundEvmTransactionMonitor(catalog)
    : null
  bitcoinTransactionMonitor = bitcoinFeatureRuntimePolicy.transactionRecoveryEnabled
    ? new BackgroundBitcoinTransactionMonitor(bitcoinRpcUrl)
    : null
  evmPortfolioConformanceCoordinator = __MULTICHAIN_CONFORMANCE_RPC_ENABLED__
    ? createBackgroundEvmPortfolioCoordinator(activeEvm)
    : null
  portfolioCoordinator =
    evmFeatureRuntimePolicy.newOperationsEnabled ||
    bitcoinFeatureRuntimePolicy.newOperationsEnabled ||
    solanaBetaEnabled ||
    nearBetaEnabled
      ? createBackgroundPortfolioCoordinator(
          catalog,
          customEvmNetworks,
          userAssets.definitions,
          intentsProtocolAssets,
          settings
        )
      : null
  activityCoordinator = createBackgroundActivityCoordinator(bitcoinRpcUrl, settings)
  additionalReceiveTargetsCoordinator =
    createBackgroundAdditionalReceiveTargetsCoordinator(customEvmNetworks)
  accountNetworksCoordinator = createBackgroundAccountNetworksCoordinator(
    customEvmNetworks,
    networkSwitchBitcoinDerivation,
    accountNetworksPeaDerivation,
    scope => {
      if (scope.chainId !== getZcashChainId(DEFAULT_NETWORK)) return null
      return (
        useWalletStore.getState().getAccount(scope.keyDomainId, scope.accountId)
          ?.networkAddresses?.[DEFAULT_NETWORK]?.shielded || null
      )
    }
  )
  const evmTransferRuntime =
    evmFeatureRuntimePolicy.newOperationsEnabled && hasBackgroundEvmTransferCapability(activeEvm)
      ? createBackgroundEvmTransferRuntime(catalog, activeEvm, userAssets.definitions)
      : null
  evmTransferController = evmTransferRuntime?.activeController ?? null
  evmTransferRouter = evmTransferRuntime?.router ?? null
  confidentialFundingCoordinator = evmFeatureRuntimePolicy.newOperationsEnabled
    ? createBackgroundConfidentialFundingCoordinator(
        catalog,
        customEvmNetworks,
        userAssets.definitions,
        intentsProtocolAssets,
        getCachedTokens(),
        settings,
        async () => {
          await portfolioCoordinator?.refreshActive()
          const { currentWalletId, currentAccountId } = useWalletStore.getState()
          if (currentWalletId && currentAccountId) {
            await chrome.runtime
              .sendMessage({
                type: 'PORTFOLIO_UPDATED',
                walletId: currentWalletId,
                accountId: currentAccountId
              })
              .catch(() => {})
          }
        },
        confidentialFundingStore
      )
    : null
  if (!isRuntimeReconfiguration) {
    void confidentialFundingCoordinator?.resumeAll().catch(error => {
      console.warn(
        '[Confidential Funding] Startup recovery failed:',
        error instanceof Error ? error.name : 'UnknownError'
      )
    })
  }
  bitcoinTransferController =
    bitcoinFeatureRuntimePolicy.newOperationsEnabled && hasBackgroundBitcoinTransferCapability()
      ? createBackgroundBitcoinTransferController()
      : null
  solanaTransferController = solanaOperationsEnabled
    ? createBackgroundSolanaTransferController(intentsProtocolAssets, settings)
    : null
  rheaSwapSolanaCoordinator =
    solanaOperationsEnabled && rheaSwapService
      ? createBackgroundRheaSwapSolanaCoordinator(rheaSwapService, settings)
      : null
  solanaTransactionMonitor = solanaTransferController
    ? new BackgroundSolanaTransactionMonitor(solanaTransferController)
    : null
  nearTransferController = nearOperationsEnabled
    ? createBackgroundNearTransferController(intentsProtocolAssets, settings)
    : null
  rheaSwapNearCoordinator =
    nearOperationsEnabled && rheaSwapService
      ? createBackgroundRheaSwapNearCoordinator(rheaSwapService, settings)
      : null
  nearTransactionMonitor = nearTransferController
    ? new BackgroundNearTransactionMonitor(nearTransferController)
    : null
  const nextEvmDAppHandler = createBackgroundEvmDAppHandler(
    evmTransferController,
    activeEvm,
    handleEvmDAppNetworkRequest,
    rheaSwapService && rheaSwapEvmSignatureCoordinator
      ? {
          service: rheaSwapService,
          signatureCoordinator: rheaSwapEvmSignatureCoordinator
        }
      : undefined
  )
  evmDAppHandler = nextEvmDAppHandler
  bitcoinDAppHandler = createBackgroundBitcoinDAppHandler(bitcoinTransferController, bitcoinRpcUrl)
  solanaDAppHandler = solanaOperationsEnabled ? createBackgroundSolanaDAppHandler(settings) : null
  nearDAppHandler = nearOperationsEnabled ? createBackgroundNearDAppHandler(settings) : null
  const solanaScope = solanaOperationsEnabled
    ? resolveSolanaRuntimeNetworkConfig(DEFAULT_NETWORK, settings)
    : undefined
  const nearScope = nearOperationsEnabled
    ? resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK, settings)
    : undefined
  multichainSessionDAppHandler = new BackgroundMultichainSessionDAppHandler({
    analytics: trackEvent,
    network: DEFAULT_NETWORK,
    evmNetworks: catalog,
    manager: dappManager,
    approval: dappHandler,
    zcash: dappHandler,
    evm: evmDAppHandler,
    bitcoin: bitcoinDAppHandler,
    bitcoinEnabled: bitcoinFeatureRuntimePolicy.newOperationsEnabled,
    solana: solanaDAppHandler,
    near: nearDAppHandler,
    ...(solanaScope === undefined
      ? {}
      : {
          solanaScope: {
            chainId: solanaScope.chainId,
            chainName: solanaScope.displayName,
            iconChain: 'solana'
          }
        }),
    ...(nearScope === undefined
      ? {}
      : {
          nearScope: {
            chainId: nearScope.chainId,
            chainName: nearScope.displayName,
            iconChain: 'near'
          }
        }),
    dispatch: dispatchDAppChainRequest
  })
  assetPriceService = createBackgroundAssetPriceService(
    userAssets.definitions,
    intentsProtocolAssets,
    intentsProtocolPriceMappings
  )
  assetMarketHistoryService = createBackgroundAssetMarketHistoryService(
    userAssets.definitions,
    intentsProtocolAssets,
    intentsProtocolPriceMappings,
    customEvmNetworks
  )
  if (DEFAULT_NETWORK === 'mainnet') {
    nearIntentsTransactionMonitor ??= new BackgroundNearIntentsTransactionMonitor()
  } else {
    nearIntentsTransactionMonitor = null
    await chrome.alarms.clear(NEAR_INTENTS_TRANSACTION_MONITOR_ALARM)
  }
  activeEvmNumericChainId = activeEvm.numericChainId
  multichainRuntimeKey = nextKey

  await Promise.all([
    evmTransactionMonitor?.init(),
    bitcoinTransactionMonitor?.init(),
    solanaTransactionMonitor?.init(),
    nearTransactionMonitor?.init(),
    portfolioCoordinator?.readCachedActive()
  ])
  if (previousNumericChainId !== 0 && previousNumericChainId !== activeEvm.numericChainId) {
    await evmDAppHandler.notifyChainChanged(activeEvm.numericChainId)
    await evmDAppHandler.notifyAccountsChanged()
    await multichainSessionDAppHandler?.notifyAllSessionsChanged()
  }
}

function scheduleMultichainRuntimeReload(
  settings?: ChainEndpointSettings,
  force = false,
  cancelAwaitingApprovals = true
): Promise<void> {
  const operation = multichainRuntimeReady
    .catch(() => {})
    .then(async () => {
      const next = settings ?? (await chainEndpointSettingsCoordinator.read())
      return accountContextTransition.runActiveOperation(() =>
        reloadMultichainRuntime(next, force, cancelAwaitingApprovals)
      )
    })
  multichainRuntimeReady = operation
  return operation
}

function refreshIntentsProtocolAssets(force = false): Promise<void> {
  if (
    DEFAULT_NETWORK !== 'mainnet' ||
    (!areSolanaOperationsEnabled() && !areNearOperationsEnabled())
  ) {
    return Promise.resolve()
  }
  if (intentsProtocolAssetsReady && !force) return Promise.resolve()
  if (intentsProtocolAssetRefresh) return intentsProtocolAssetRefresh

  const operation = (async () => {
    let tokens: readonly SwapToken[]
    try {
      tokens = await fetchIntentsWalletTokens()
      const fullCatalog = getCachedTokens()
      if (fullCatalog.length > 0) {
        await swapTokenCatalogCache.put(fullCatalog).catch(error => {
          console.warn('[Intents assets] Token catalog cache write failed', error)
        })
      }
    } catch (error) {
      const cached = await swapTokenCatalogCache.readFresh()
      if (!cached) throw error
      tokens = cached.tokens
    }
    if (!tokens.some(token => resolveIntentsWalletAsset(token, DEFAULT_NETWORK))) {
      throw new Error('Intents wallet token catalog is unavailable')
    }
    const catalog = createIntentsWalletAssetCatalog(tokens, DEFAULT_NETWORK)
    if (catalog.entries.length === 0) throw new Error('Intents wallet token catalog is unavailable')
    intentsProtocolAssets = catalog.definitions
    intentsProtocolAssetIds = Object.freeze(
      catalog.preferences.map(preference => preference.assetId)
    )
    intentsProtocolPriceMappings = catalog.priceMappings
    await tokenVisibility?.synchronizeProtocolDefaults(catalog.preferences)
    await scheduleMultichainRuntimeReload(undefined, true, false)
    void refreshAssetPrices().catch(error => {
      console.warn(
        '[Intents assets] Market data refresh after catalog change failed:',
        error instanceof Error ? error.message : 'Unknown error'
      )
    })
    intentsProtocolAssetsReady = true
  })()
  intentsProtocolAssetRefresh = operation
  void operation.then(
    () => {
      if (intentsProtocolAssetRefresh === operation) intentsProtocolAssetRefresh = null
    },
    () => {
      if (intentsProtocolAssetRefresh === operation) intentsProtocolAssetRefresh = null
    }
  )
  return operation
}

async function refreshMultichainRuntimeForUserAssets(
  cancelAwaitingApprovals = true,
  chainIds?: readonly string[]
): Promise<void> {
  await scheduleMultichainRuntimeReload(undefined, true, cancelAwaitingApprovals)
  await portfolioCoordinator?.refreshActive(chainIds).catch(error => {
    console.warn('[User EVM Assets] Portfolio refresh after catalog change failed', error)
  })
}

async function refreshDetectedEvmAssetsForActiveAccount(force = false): Promise<void> {
  const coordinator = detectedEvmAssetCoordinator
  if (!coordinator) return
  const active = await additionalReceiveTargetsCoordinator.readCurrentActive()
  if (!active) return
  const byAddress = new Map<string, Set<string>>()
  for (const target of active.targets) {
    if (target.kind !== 'evm') continue
    const key = target.address.toLowerCase()
    const chainIds = byAddress.get(key) ?? new Set<string>()
    chainIds.add(target.chainId)
    byAddress.set(key, chainIds)
  }
  const changed = await coordinator.refresh(
    [...byAddress].map(([address, chainIds]) =>
      Object.freeze({ address, chainIds: Object.freeze([...chainIds]) })
    ),
    { force }
  )
  if (changed) await refreshMultichainRuntimeForUserAssets(false)
}

async function prepareSoftwareWalletNetworkMetadata(target: Network): Promise<void> {
  await rehydrateWalletStore()
  const wallets = useWalletStore
    .getState()
    .wallets.filter(wallet => !isZcashHardwareKeySource(wallet.keySource))
  const metadata: NetworkAccountMetadataInput[] = []

  for (const wallet of wallets) {
    if (!(await credentialSession.bindZcashCredential(wallet.id))) {
      throw new Error('The Wallet credential session expired. Unlock and try again.')
    }
    const zcashAddresses = await backgroundZcashWalletRuntime.deriveSoftwareWalletAddresses(
      wallet.id,
      target
    )
    for (const account of wallet.accounts) {
      const zcash = zcashAddresses[account.id]
      if (!zcash) throw new Error('Unable to derive the target Zcash Account')
      const bitcoin = await networkSwitchBitcoinDerivation.deriveAddress(
        parseKeyDomainId(wallet.id),
        {
          chainId: parseChainId(getBitcoinChainId(target)).id,
          addressType: 'p2wpkh',
          accountIndex: account.derivationIndex,
          change: false,
          addressIndex: 0
        }
      )
      const ed25519 = await deriveSoftwareEd25519NetworkMetadata({
        keyDomainId: wallet.id,
        accountIndex: account.derivationIndex,
        network: target,
        solanaEnabled: solanaBetaEnabled,
        nearEnabled: nearBetaEnabled
      })
      metadata.push({
        keyDomainId: parseKeyDomainId(wallet.id),
        accountId: parseAccountId(account.id),
        accountIndex: account.derivationIndex,
        zcashNetwork: target,
        zcashChainId: getZcashChainId(target),
        zcashAddresses: zcash,
        bitcoin,
        ...ed25519
      })
      useWalletStore.getState().updateAccountInWallets(wallet.id, account.id, {
        networkAddresses: {
          ...account.networkAddresses,
          [target]: zcash
        },
        networkBirthdayHeights: {
          ...account.networkBirthdayHeights,
          [target]: account.networkBirthdayHeights?.[target] ?? 0
        }
      })
    }
  }
  if (metadata.length > 0) {
    await credentialLifecycle.synchronizeNetworkAccountMetadata(metadata)
  }
  useWalletStore.getState().setCurrentNetwork(target)
  await flushWalletStore()
}

async function synchronizeCurrentSoftwareWalletNetworkMetadata(): Promise<void> {
  if (!solanaBetaEnabled && !nearBetaEnabled) return
  await prepareSoftwareWalletNetworkMetadata(DEFAULT_NETWORK)
  const currentWalletId = useWalletStore.getState().currentWalletId
  const currentWallet = currentWalletId
    ? useWalletStore.getState().getWallet(currentWalletId)
    : null
  if (
    currentWalletId &&
    !isZcashHardwareKeySource(currentWallet?.keySource) &&
    !(await credentialSession.bindZcashCredential(currentWalletId))
  ) {
    throw new Error('Unable to restore the active Zcash credential binding')
  }
}

async function persistNetworkMode(target: Network): Promise<void> {
  await withWalletSettingsLock(async () => {
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
    const raw = stored[SETTINGS_STORAGE_KEY]
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: updatePersistedWalletSettings(raw, { networkMode: target })
    })
  })
}

async function switchGlobalNetworkMode(target: Network): Promise<{ restartRequired: true }> {
  if (networkRestartRequired) throw new Error('A wallet restart is already required')
  if (target === DEFAULT_NETWORK) throw new Error('The requested network mode is already active')
  if (!(await credentialSession.hasUnlockSession())) {
    throw new Error('Unlock the wallet before switching networks')
  }
  await cancelAllLedgerSigning('Network mode changed. Review this action again.')
  const hardwareMissingTargetMetadata = hasKeystoneWalletMissingNetworkProjection(
    useWalletStore.getState().wallets,
    target
  )
  if (hardwareMissingTargetMetadata) {
    throw new Error(
      'Reconnect the hardware wallet for the target network before switching networks'
    )
  }
  const [evmPending, bitcoinPending, solanaPending, nearPending] = await Promise.all([
    networkSwitchEvmPending.list(),
    networkSwitchBitcoinPending.list(),
    networkSwitchSolanaPending.list(),
    networkSwitchNearPending.list()
  ])
  if (evmPending.some(item => item.phase === 'signed')) {
    throw new Error('Broadcast or recover the signed EVM transaction before switching networks')
  }
  if (bitcoinPending.some(item => item.phase === 'signed')) {
    throw new Error('Broadcast or recover the signed Bitcoin transaction before switching networks')
  }
  if (solanaPending.some(item => item.phase === 'signed')) {
    throw new Error('Broadcast or recover the signed Solana transaction before switching networks')
  }
  if (nearPending.some(item => item.phase === 'signed')) {
    throw new Error('Broadcast or recover the signed NEAR transaction before switching networks')
  }

  return accountContextTransition.runActiveOperation(async () => {
    syncScheduler.pauseForTx()
    syncScheduler.abortSync()
    let targetProjectionPrepared = false
    let targetModePersisted = false
    try {
      const idle = await syncScheduler.waitForActiveSyncIdle(30_000)
      if (!idle) throw new Error('Wallet sync did not stop before network switch')
      await prepareSoftwareWalletNetworkMetadata(target)
      targetProjectionPrepared = true
      pendingRequestsManager.cancelAll()
      await Promise.all([
        evmTransferRouter?.cancelAllAwaitingApprovals(),
        bitcoinTransferController?.cancelAllAwaitingApprovals(),
        solanaTransferController?.cancelAllAwaitingApprovals(),
        nearTransferController?.cancelAllAwaitingApprovals()
      ])
      await dappManager.clearConnections()
      await performWalletLockState()
      networkRestartRequired = true
      await persistNetworkMode(target)
      targetModePersisted = true
      await clearAllSwapApprovalContinuations()
      await chrome.alarms.create(NETWORK_MODE_RESTART_ALARM, { when: Date.now() + 500 })
      return { restartRequired: true as const }
    } catch (error) {
      networkRestartRequired = false
      if (targetModePersisted) {
        try {
          await persistNetworkMode(DEFAULT_NETWORK)
        } catch {
          networkRestartRequired = true
          chrome.runtime.reload()
          throw new Error('Network mode recovery failed; Noir Wallet is restarting')
        }
      }
      if (
        targetProjectionPrepared ||
        useWalletStore.getState().currentNetwork !== DEFAULT_NETWORK
      ) {
        useWalletStore.getState().setCurrentNetwork(DEFAULT_NETWORK)
        await flushWalletStore()
      }
      throw error
    } finally {
      if (!networkRestartRequired) {
        syncScheduler.resumeAfterTx()
      }
    }
  })
}
accountContextTransition.registerInvalidator({
  invalidate: async request => {
    const scope = {
      keyDomainId: parseKeyDomainId(request.scope.walletId),
      accountId: parseAccountId(request.scope.accountId)
    }
    const controller = evmTransferRouter
    if (!controller) return
    await (request.mode === 'scope'
      ? controller.cancelAwaitingApprovalsForScope(scope)
      : controller.cancelAwaitingApprovalsExceptScope(scope))
  }
})
accountContextTransition.registerInvalidator({
  invalidate: async request => {
    const scope = {
      keyDomainId: parseKeyDomainId(request.scope.walletId),
      accountId: parseAccountId(request.scope.accountId)
    }
    const controller = nearTransferController
    if (!controller) return
    await (request.mode === 'scope'
      ? controller.cancelAwaitingApprovalsForScope(scope)
      : controller.cancelAwaitingApprovalsExceptScope(scope))
  }
})
accountContextTransition.registerInvalidator({
  invalidate: async request => {
    const scope = {
      keyDomainId: parseKeyDomainId(request.scope.walletId),
      accountId: parseAccountId(request.scope.accountId)
    }
    const controller = solanaTransferController
    if (!controller) return
    await (request.mode === 'scope'
      ? controller.cancelAwaitingApprovalsForScope(scope)
      : controller.cancelAwaitingApprovalsExceptScope(scope))
  }
})
accountContextTransition.registerInvalidator({
  invalidate: async request => {
    const scope = {
      keyDomainId: parseKeyDomainId(request.scope.walletId),
      accountId: parseAccountId(request.scope.accountId)
    }
    const controller = bitcoinTransferController
    if (!controller) return
    await (request.mode === 'scope'
      ? controller.cancelAwaitingApprovalsForScope(scope)
      : controller.cancelAwaitingApprovalsExceptScope(scope))
  }
})
const evmSigningConformanceClient = __MULTICHAIN_CONFORMANCE_RPC_ENABLED__
  ? new EvmMultichainSigningClient({ credentials: credentialSession })
  : null

const backgroundAutoLock = new AutoLockCoordinator({
  readLastActivityTime: () => SecureStorage.getLastActivityTime(),
  readAutoLockMs: async () => {
    const settings = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
    return resolvePersistedAutoLockMs(
      settings[SETTINGS_STORAGE_KEY],
      WALLET_CONFIG.SECURITY.AUTO_LOCK.DEFAULT_MS,
      WALLET_CONFIG.SECURITY.AUTO_LOCK.OPTIONS.map(option => option.value)
    )
  },
  hasUnlockSession: async () =>
    !backgroundZcashWalletRuntime.isLocked() || (await credentialSession.hasUnlockSession()),
  lock: () => handleWalletLock(),
  scheduleAlarm: async when => {
    await chrome.alarms.create(WALLET_AUTO_LOCK_ALARM, { when })
  },
  clearAlarm: async () => {
    await chrome.alarms.clear(WALLET_AUTO_LOCK_ALARM)
  }
})
export { zcashTxMonitor }

export const BALANCE_SYNC_ALARM = 'wallet-balance-sync'
const BALANCE_SYNC_SCHEDULE_STATE_KEY = 'wallet-balance-sync-schedule'

if (__EXTENSION_UPDATES_ENABLED__) {
  initializeExtensionUpdates()
}

const debugLogsEnabled = typeof __DEBUG_LOGS__ !== 'boolean' || __DEBUG_LOGS__
let forwardedDiagnosticSequence = 0
logger.configureDiagnostics(appendDiagnosticLog)
configureLedgerSigningCoordinator(async scope => {
  if (networkRestartRequired || !(await credentialSession.hasUnlockSession()))
    throw new Error('Wallet is locked or restarting')
  const namespace = parseChainId(scope.chainId).namespace
  const family =
    namespace === 'eip155'
      ? 'evm'
      : namespace === 'solana'
        ? 'solana'
        : namespace === 'near'
          ? 'near'
          : namespace === 'bip122'
            ? 'bitcoin'
            : null
  if (!family) throw new Error('Unsupported Ledger chain')
  await credentialLifecycle.assertActiveAccountSupportsChain(
    scope.keyDomainId,
    scope.accountId,
    family
  )
})
registerLedgerSigningTabLifecycle()

logger.info(`Background service worker started version=${__APP_VERSION__} build=${__BUILD_TIME__}`)

const trustedStorageAccessReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
])
  .then(() => true)
  .catch(error => {
    console.error('[Security] Failed to restrict extension storage access:', error)
    return false
  })

const LEGACY_EXTENSION_PERMISSIONS = [
  'clipboardRead',
  'windows',
  'tabs',
  'history',
  'webNavigation'
] as const

async function removeLegacyExtensionPermissions(): Promise<void> {
  const granted = await chrome.permissions.getAll()
  const obsolete = LEGACY_EXTENSION_PERMISSIONS.filter(permission =>
    granted.permissions?.includes(permission)
  )
  if (obsolete.length === 0) return

  const removed = await chrome.permissions.remove({ permissions: obsolete })
  if (removed) {
    console.log('[Background] Removed legacy extension permissions:', obsolete.join(', '))
  } else {
    console.warn('[Background] Unable to remove legacy extension permissions:', obsolete.join(', '))
  }
}

removeLegacyExtensionPermissions().catch(error => {
  console.warn('[Background] Failed to remove legacy extension permissions:', error)
})

enqueueExtensionDisplayModeUpdate(initializeExtensionDisplayMode).catch(error => {
  console.warn('[Background] Failed to restore extension display mode:', error)
})

// Network-bound services start only after the persisted global mode is resolved.
const multichainStartupReady = runtimeNetworkReady.then(async () => {
  await prepareWalletStoreForUse()
  await scheduleMultichainRuntimeReload()
})

function rheaSignedRecoveryJobs() {
  return [
    {
      name: 'EVM',
      recover: () => rheaSwapEvmSignatureCoordinator?.recoverSigned() ?? Promise.resolve(0)
    },
    {
      name: 'Solana',
      recover: () => rheaSwapSolanaCoordinator?.recoverSigned() ?? Promise.resolve(0)
    },
    {
      name: 'NEAR',
      recover: () => rheaSwapNearCoordinator?.recoverSigned() ?? Promise.resolve(0)
    }
  ]
}

const backgroundNetworkServicesReady = multichainStartupReady
  .then(async () => {
    await Promise.all([
      DEFAULT_NETWORK === 'mainnet'
        ? transactionMonitor.init()
        : chrome.alarms.clear('transaction-monitor-alarm').then(() => undefined),
      zcashTxMonitor.init(),
      rheaSwapTransactionMonitor?.init().catch(error => {
        console.warn('[RHEA Swap Monitor] Startup poll failed:', error)
      }) ?? Promise.resolve()
    ])
    if (await recoverSignedRheaSwaps(rheaSignedRecoveryJobs())) {
      await scheduleRheaSwapTransactionMonitorRetry().catch(error => {
        console.warn('[RHEA Swap Monitor] Could not schedule signed recovery retry:', error)
      })
    }
    void refreshIntentsProtocolAssets().catch(error => {
      console.warn('[Intents assets] Protocol token catalog is unavailable', error)
    })
    await nearIntentsTransactionMonitor?.init()
  })
  .catch(error => {
    console.warn('[Background] Network runtime initialization failed:', error)
    throw error
  })

async function scheduleNextBalanceSyncAlarm(
  probeFailed: boolean,
  preserveFailureCount = false
): Promise<void> {
  const stored = await chrome.storage.session.get(BALANCE_SYNC_SCHEDULE_STATE_KEY)
  const previous = Number(stored[BALANCE_SYNC_SCHEDULE_STATE_KEY]?.failureCount ?? 0)
  const failureCount = probeFailed ? Math.min(previous + 1, 8) : preserveFailureCount ? previous : 0
  const delayInMinutes = computePassiveSyncDelayMinutes({
    baseMinutes: WALLET_CONFIG.SYNC.BACKGROUND_POLL_MINUTES,
    jitterMinutes: WALLET_CONFIG.SYNC.BACKGROUND_POLL_JITTER_MINUTES,
    maxMinutes: WALLET_CONFIG.SYNC.BACKGROUND_POLL_MAX_BACKOFF_MINUTES,
    failureCount,
    randomUnit: Math.random()
  })
  await chrome.storage.session.set({ [BALANCE_SYNC_SCHEDULE_STATE_KEY]: { failureCount } })
  await chrome.alarms.clear(BALANCE_SYNC_ALARM)
  chrome.alarms.create(BALANCE_SYNC_ALARM, { delayInMinutes })
}

syncScheduler.onPassiveSyncOutcome = status => {
  void scheduleNextBalanceSyncAlarm(status === 'failed' || status === 'skipped').catch(error => {
    console.warn('[Background] Failed to schedule next balance sync after scan:', error)
  })
}

async function ensureBalanceSyncAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(BALANCE_SYNC_ALARM)
  if (existing && existing.periodInMinutes === undefined && existing.scheduledTime > Date.now()) {
    return
  }
  await scheduleNextBalanceSyncAlarm(false)
}

ensureBalanceSyncAlarm().catch(error => {
  console.warn('[Background] Failed to schedule balance sync alarm:', error)
})

// ============================================
// Silent WASM Initialization on Extension Start
// ============================================

/**
 * Silently initialize WASM and Worker
 * Called on Background startup to pre-warm the WASM environment
 */
let backgroundInitializationPromise: Promise<void> | null = null

function silentInitializeWasm(): Promise<void> {
  if (!backgroundInitializationPromise) {
    backgroundInitializationPromise = performSilentWasmInitialization()
  }
  return backgroundInitializationPromise
}

async function performSilentWasmInitialization(): Promise<void> {
  try {
    await runtimeNetworkReady
    await prepareWalletStoreForUse()

    restoreStuckWithdrawMonitors().catch(err => {
      console.warn('[Background] Failed to restore stuck withdraw monitors:', err)
    })

    await backgroundZcashWalletRuntime.initialize()
    await walletCleanupCoordinator.resumePendingCleanup()

    const initialRpcEndpointId = getPreferredRpcEndpointOption('zcash').id
    void refreshRpcEndpointRegistry()
      .then(async preferences => {
        if (preferences.zcash === initialRpcEndpointId) return
        await accountContextTransition.runActiveOperation(async () => {
          await backgroundZcashWalletRuntime.applyRpcEndpointChange(preferences)
          syncScheduler.onRequestSync()
        })
      })
      .catch(error => {
        console.warn('[Background] RPC registry refresh failed:', error)
      })

    syncScheduler.resumeInterrupted().catch(err => {
      console.warn('[Background] Failed to resume interrupted sync:', err)
    })
  } catch (error) {
    console.warn('[Background] Silent WASM initialization failed:', error)
    throw error
  }
}

async function restoreStuckWithdrawMonitors(): Promise<void> {
  const accountScopes = getZcashAccountScopes()
  if (accountScopes.length > 0) {
    await Promise.all([
      DEFAULT_NETWORK === 'mainnet'
        ? transactionMonitor.restorePendingWithdrawals(accountScopes)
        : Promise.resolve(),
      zcashTxMonitor.restoreStuckWithdrawals(accountScopes),
      backgroundNetworkServicesReady.then(() =>
        rheaSwapTransactionMonitor?.restorePendingZcashSwaps(accountScopes)
      )
    ])
  }
}

function getZcashAccountScopes(): AccountScope[] {
  const { wallets, currentNetwork } = useWalletStore.getState()
  return wallets.flatMap(wallet =>
    wallet.accounts.map(account => ({
      accountKey: `${currentNetwork}_${wallet.id}_${account.id}`,
      walletId: wallet.id,
      accountId: account.id
    }))
  )
}

// ============================================
// Extension Event Listeners
// ============================================

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    trackEvent(ANALYTICS_EVENTS.EXTENSION_INSTALLED)
  } else if (details.reason === 'update') {
    trackEvent(ANALYTICS_EVENTS.EXTENSION_UPDATED, {
      params: { previous_version: details.previousVersion }
    })
  }

  if (details.reason === 'install' || details.reason === 'update') {
    silentInitializeWasm().catch(console.warn)
  }
})

// Service Worker activation - ensure WASM is ready
chrome.runtime.onStartup.addListener(() => {
  silentInitializeWasm()
    .then(() => handlePeriodicBalanceSyncAlarm())
    .catch(console.warn)
})

async function checkOffscreenHealth(): Promise<void> {
  if (!chrome.offscreen?.hasDocument) return
  try {
    const alive = await chrome.offscreen.hasDocument()
    if (!alive) {
      console.warn(
        '%c[Background] Offscreen Document disappeared during sync!',
        'background: #FF4444; color: #fff; font-weight: bold; padding: 4px 8px; border-radius: 4px;'
      )
    }
  } catch (err) {
    console.warn('[Background] Offscreen health check error:', err)
  }
}

async function requestPeriodicBalanceSync(): Promise<'scheduled' | 'skipped' | 'probe-failed'> {
  if (syncScheduler.isRunning()) return 'skipped'
  await Promise.all([rehydrateWalletStore(), useAccountDataStore.persist.rehydrate()])
  const { currentWalletId, currentNetwork } = useWalletStore.getState()
  if (!currentWalletId) return 'skipped'

  const syncState = useAccountDataStore
    .getState()
    .getWalletSyncState(currentNetwork, currentWalletId)
  const hasUnlockSession = await credentialSession.hasUnlockSession()
  const [isWalletUiOpen, hasPendingCrossChainTransaction, hasPendingZcashTransaction, snapshot] =
    await Promise.all([
      isWalletUiContextOpen(),
      transactionMonitor.hasPendingTransactions(),
      zcashTxMonitor.hasPendingTransactions(),
      hasWalletDb(`${currentNetwork}_${currentWalletId}`)
    ])
  const hasPendingTransactions = hasPendingCrossChainTransaction || hasPendingZcashTransaction
  let networkHeight: number | null = null
  if (!isWalletUiOpen && !hasPendingTransactions) {
    try {
      networkHeight = await fetchLatestBlockHeight(getNetworkConfig(currentNetwork).rpcUrl)
    } catch {
      return 'probe-failed'
    }
  }
  if (
    !shouldRequestPeriodicSync({
      isSchedulerRunning: syncScheduler.isRunning(),
      isWalletUiOpen,
      hasPendingTransactions,
      isWalletLocked: backgroundZcashWalletRuntime.isLocked() && !hasUnlockSession,
      hasPersistedSnapshot: snapshot,
      currentHeight: syncState.currentHeight,
      networkHeight,
      lastSyncTime: syncState.lastSyncTime,
      now: Date.now(),
      minBlockGap: WALLET_CONFIG.SYNC.BACKGROUND_MIN_GAP_BLOCKS,
      maxStaleMs: WALLET_CONFIG.SYNC.BACKGROUND_MAX_STALE_MS
    })
  ) {
    return 'skipped'
  }

  return syncScheduler.requestPassiveSync(0) ? 'scheduled' : 'skipped'
}

async function handlePeriodicBalanceSyncAlarm(): Promise<void> {
  let probeFailed = false
  let syncScheduled = false
  try {
    const result = await requestPeriodicBalanceSync()
    probeFailed = result === 'probe-failed'
    syncScheduled = result === 'scheduled'
  } catch (error) {
    probeFailed = true
    console.warn('[Background] Periodic balance sync request failed:', error)
  } finally {
    await scheduleNextBalanceSyncAlarm(probeFailed, syncScheduled).catch(error => {
      console.warn('[Background] Failed to schedule next balance sync probe:', error)
    })
  }
}

async function isWalletUiContextOpen(): Promise<boolean> {
  if (typeof chrome.runtime.getContexts !== 'function') return false

  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [
        chrome.runtime.ContextType.TAB,
        chrome.runtime.ContextType.POPUP,
        chrome.runtime.ContextType.SIDE_PANEL
      ],
      documentOrigins: [new URL(chrome.runtime.getURL('/')).origin]
    })
    return contexts.length > 0
  } catch {
    return false
  }
}

void trustedStorageAccessReady.then(() => initializeAnalyticsReporting()).catch(() => {})

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ANALYTICS_OUTBOX_ALARM) {
    void handleAnalyticsAlarm(alarm.name).catch(() => {})
    return
  }
  if (alarm.name === NETWORK_MODE_RESTART_ALARM) {
    void chrome.alarms.clear(NETWORK_MODE_RESTART_ALARM).finally(() => chrome.runtime.reload())
    return
  }
  void runtimeNetworkReady
    .then(() => {
      if (alarm.name === WALLET_AUTO_LOCK_ALARM) {
        backgroundAutoLock.reconcile().catch(error => {
          console.warn('[Background] Auto-lock reconciliation failed:', error)
        })
      }
      if (alarm.name === 'transaction-monitor-alarm') {
        if (DEFAULT_NETWORK === 'mainnet') {
          transactionMonitor.handleAlarm().catch(console.warn)
        } else {
          chrome.alarms.clear('transaction-monitor-alarm')
        }
      }
      if (alarm.name === 'zcash-tx-monitor-alarm') {
        zcashTxMonitor.handleAlarm().catch(console.warn)
      }
      if (alarm.name === EVM_TRANSACTION_MONITOR_ALARM) {
        evmTransactionMonitor?.handleAlarm().catch(error => {
          console.warn('[EVM Transaction Monitor] Poll failed:', error)
        })
      }
      if (alarm.name === BITCOIN_TRANSACTION_MONITOR_ALARM) {
        bitcoinTransactionMonitor?.handleAlarm().catch(error => {
          const { currentWalletId, currentAccountId } = useWalletStore.getState()
          logger.warn(
            `Bitcoin transaction monitor failed: ${formatLogError(error)}`,
            currentWalletId ?? undefined,
            currentAccountId ?? undefined
          )
        })
      }
      if (alarm.name === SOLANA_TRANSACTION_MONITOR_ALARM) {
        solanaTransactionMonitor?.handleAlarm().catch(error => {
          console.warn('[Solana Transaction Monitor] Poll failed:', error)
        })
      }
      if (alarm.name === NEAR_TRANSACTION_MONITOR_ALARM) {
        nearTransactionMonitor?.handleAlarm().catch(error => {
          console.warn('[NEAR Transaction Monitor] Poll failed:', error)
        })
      }
      if (alarm.name === NEAR_INTENTS_TRANSACTION_MONITOR_ALARM) {
        nearIntentsTransactionMonitor?.handleAlarm().catch(error => {
          console.warn('[Near Intents Transaction Monitor] Poll failed:', error)
        })
      }
      if (alarm.name === RHEA_SWAP_TRANSACTION_MONITOR_ALARM) {
        void recoverSignedRheaSwapsAndPoll(
          rheaSignedRecoveryJobs(),
          rheaSwapTransactionMonitor
        ).catch(error => {
          console.warn('[RHEA Swap Monitor] Poll failed:', error)
        })
      }
      if (alarm.name === CONFIDENTIAL_FUNDING_MONITOR_ALARM) {
        confidentialFundingCoordinator?.resumeAll().catch(error => {
          console.warn('[Confidential Funding Monitor] Poll failed:', error)
        })
      }
      if (alarm.name === BALANCE_SYNC_ALARM) {
        void handlePeriodicBalanceSyncAlarm()
      }
      if (alarm.name === SYNC_KEEPALIVE_ALARM) {
        if (syncScheduler.isRunning()) {
          checkOffscreenHealth().catch(err => {
            console.warn('[Background] Offscreen health check failed:', err)
          })
        } else {
          chrome.alarms.clear(SYNC_KEEPALIVE_ALARM)
        }
      }
    })
    .catch(error => {
      console.warn('[Background] Alarm skipped because network initialization failed:', error)
    })
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'session' &&
    (changes.session_password?.newValue !== undefined ||
      changes.session_key_material?.newValue !== undefined)
  ) {
    handleWalletLock().catch(error => {
      console.warn('[Background] Failed to reject legacy session credentials:', error)
    })
    return
  }
  if (
    areaName === 'local' &&
    (Object.prototype.hasOwnProperty.call(changes, SecureStorage.LAST_ACTIVITY_KEY) ||
      Object.prototype.hasOwnProperty.call(changes, SETTINGS_STORAGE_KEY))
  ) {
    const activity = changes[SecureStorage.LAST_ACTIVITY_KEY]?.newValue
    if (typeof activity === 'number' && Number.isSafeInteger(activity) && activity >= 0) {
      credentialSession.touch(activity).catch(error => {
        console.warn('[Background] Credential session activity update failed:', error)
      })
    }
    backgroundAutoLock.reconcile().catch(error => {
      console.warn('[Background] Auto-lock scheduling failed:', error)
    })
    if (Object.prototype.hasOwnProperty.call(changes, SETTINGS_STORAGE_KEY)) {
      if (networkRestartRequired) return
      scheduleMultichainRuntimeReload().catch(error => {
        console.warn('[Multichain Runtime] Settings reload failed:', error)
      })
    }
  }
})

Promise.all([trustedStorageAccessReady, backgroundNetworkServicesReady])
  .then(([storageRestricted]) => {
    if (!storageRestricted) return
    return chrome.storage.session.get(['session_password', 'session_key_material']).then(legacy => {
      if (legacy.session_password !== undefined || legacy.session_key_material !== undefined) {
        return handleWalletLock()
      }
      return backgroundAutoLock.reconcile().then(() => undefined)
    })
  })
  .catch(error => {
    console.warn('[Background] Initial credential session reconciliation failed:', error)
  })

// Don't initialize dappHandler here - wait until wallet unlocked

const walletCleanupCoordinator = new WalletCleanupCoordinator(
  handleAccountSwitched,
  async () => {
    await evmTransferRouter?.clearPendingTransfers()
    await bitcoinTransferController?.clearPendingTransfers()
    await solanaTransferController?.clearPendingTransfers()
    await nearTransferController?.clearPendingTransfers()
    await rheaSwapTransactionMonitor?.clear()
  },
  (walletId, accountIds) =>
    rheaSwapTransactionMonitor?.removeAccounts(walletId, accountIds) ?? Promise.resolve()
)

const zeroIndexerUpdateQueue = new SerialTaskQueue()

function enqueueZeroIndexerUpdate<T>(operation: () => Promise<T>): Promise<T> {
  return zeroIndexerUpdateQueue.run(operation)
}

async function applyLatestZeroIndexerRuntime(): Promise<string | undefined> {
  try {
    const enabled = await readZeroIndexerEnabled()
    const options = await getZeroIndexerBroadcastOptions(DEFAULT_NETWORK, enabled)
    await applyZeroIndexerOptionsToActiveWorker(DEFAULT_NETWORK, options)
    return undefined
  } catch {
    return 'Saved. The active wallet will use this setting after it reconnects.'
  }
}

const handleRuntimeMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
  message,
  sender,
  sendResponse
) => {
  const runtimeMessage = isRuntimeRecord(message) ? message : null
  if (!runtimeMessage || typeof runtimeMessage.type !== 'string') {
    return false
  }

  if (networkRestartRequired && runtimeMessage.type !== 'GET_NETWORK_MODE') {
    sendResponse({ error: 'Noir Wallet is restarting to apply the network change' })
    return true
  }

  if (runtimeMessage.type === 'DAPP_REQUEST') {
    const candidateRequestId = runtimeMessage.requestId
    const requestId =
      typeof candidateRequestId === 'string' &&
      candidateRequestId.length > 0 &&
      candidateRequestId.length <= 128
        ? candidateRequestId
        : undefined
    const origin = getContentScriptSenderOrigin(sender, chrome.runtime.id)
    if (!origin) {
      sendResponse({
        ...(requestId ? { requestId } : {}),
        error: 'Unauthorized dApp request sender'
      })
      return true
    }

    let parsedMessage
    try {
      parsedMessage = parseDAppRuntimeRequestMessage(runtimeMessage)
    } catch {
      sendResponse({ ...(requestId ? { requestId } : {}), error: 'Invalid dApp request' })
      return true
    }

    const respond = (
      response:
        | { result: unknown }
        | { error: string | { readonly code: number; readonly message: string } }
    ) => {
      sendResponse({ requestId: parsedMessage.requestId, ...response })
    }

    void trustedStorageAccessReady.then(async storageRestricted => {
      if (!storageRestricted) {
        respond({ error: 'Wallet security initialization failed' })
        return
      }

      try {
        const { chainId, request } = parsedMessage
        if (!(await betaInviteActivation.isActivated())) {
          const decision = resolveUnactivatedBetaDAppRequest(chainId, request.method)
          if (decision.kind === 'silent') {
            respond({ result: decision.result })
            return
          }
          if (decision.kind === 'activate') {
            try {
              await promptBetaInviteActivation()
            } catch {
              respond({
                error:
                  chainId === 'zcash'
                    ? 'Beta activation was not completed.'
                    : { code: 4001, message: 'Beta activation was not completed.' }
              })
              return
            }
          }
          if (!(await betaInviteActivation.isActivated())) {
            respond({
              error:
                chainId === 'zcash'
                  ? BETA_INVITE_REQUIRED_MESSAGE
                  : { code: 4100, message: BETA_INVITE_REQUIRED_MESSAGE }
            })
            return
          }
        }
        if (
          chainId === 'evm' ||
          chainId === 'bitcoin' ||
          chainId === 'solana' ||
          chainId === 'near' ||
          chainId === 'multichain'
        ) {
          await multichainStartupReady
          await multichainRuntimeReady
        }
        if (chainId === 'evm' && !evmFeatureRuntimePolicy.newOperationsEnabled) {
          respond({
            error: { code: 4200, message: 'The EVM provider is unavailable in this wallet build.' }
          })
          return
        }
        if (chainId === 'bitcoin' && !bitcoinFeatureRuntimePolicy.newOperationsEnabled) {
          respond({
            error: {
              code: 4200,
              message: 'The Bitcoin provider is unavailable in this wallet build.'
            }
          })
          return
        }
        if (chainId === 'solana' && !areSolanaOperationsEnabled()) {
          respond({
            error: {
              code: 4200,
              message: 'The Solana provider is unavailable in this wallet build.'
            }
          })
          return
        }
        if (chainId === 'near' && !areNearOperationsEnabled()) {
          respond({
            error: { code: 4200, message: 'The NEAR provider is unavailable in this wallet build.' }
          })
          return
        }
        if (
          isExplicitMultichainConnectRequest(parsedMessage) ||
          (chainId === 'multichain' && request.method === 'wallet_createSession')
        ) {
          const unlockRequired = await needsUnlock({
            hasUnlockSession: () => credentialSession.hasUnlockSession()
          })
          const requestedScopes =
            chainId === 'multichain' &&
            request.params &&
            !Array.isArray(request.params) &&
            isRuntimeRecord(Reflect.get(request.params, 'scopes'))
              ? (Reflect.get(request.params, 'scopes') as Record<string, unknown>)
              : null
          const needsZcashRuntime = Boolean(
            requestedScopes &&
            Object.prototype.hasOwnProperty.call(requestedScopes, getZcashChainId(DEFAULT_NETWORK))
          )
          if (unlockRequired) await promptUnlock({ restoreZcashRuntime: needsZcashRuntime })
        }
        const declaredFaviconUrl = parsedMessage.siteMetadata?.faviconUrl
        const tabFaviconUrl = declaredFaviconUrl?.startsWith('data:image/')
          ? declaredFaviconUrl
          : typeof sender.tab?.favIconUrl === 'string' && sender.tab.favIconUrl.length > 0
            ? sender.tab.favIconUrl
            : declaredFaviconUrl
        const tabInfo = {
          ...(sender.tab?.title === undefined ? {} : { title: sender.tab.title }),
          ...(tabFaviconUrl === undefined ? {} : { favIconUrl: tabFaviconUrl }),
          ...(sender.tab?.url === undefined ? {} : { pageUrl: sender.tab.url })
        }
        let result: unknown
        if (chainId === 'multichain') {
          if (!multichainSessionDAppHandler) {
            throw new Error('Multichain session runtime is unavailable')
          }
          result = await multichainSessionDAppHandler.request(
            {
              method: request.method as Caip25RuntimeMethod,
              ...(request.params === undefined ? {} : { params: request.params })
            },
            origin,
            tabInfo
          )
        } else {
          result = await dispatchDAppChainRequest(chainId, request, origin, tabInfo)
          if (
            isExplicitMultichainConnectRequest(parsedMessage) ||
            request.method === 'zcash_requestAccounts' ||
            request.method === 'zcash_disconnect' ||
            request.method === 'disconnect' ||
            request.method === 'wallet_revokePermissions'
          ) {
            await multichainSessionDAppHandler?.notifySessionChanged(origin)
          }
        }
        respond({ result })
      } catch (error) {
        respond({
          error:
            parsedMessage.chainId === 'multichain'
              ? toCaip25ErrorShape(error)
              : parsedMessage.chainId === 'evm'
                ? toEip1193ErrorShape(error)
                : parsedMessage.chainId === 'bitcoin'
                  ? toBitcoinProviderErrorShape(error)
                  : parsedMessage.chainId === 'solana' || parsedMessage.chainId === 'near'
                    ? toNativeTransferProviderErrorShape(error)
                    : error instanceof Error
                      ? error.message
                      : 'dApp request failed'
        })
      }
    })
    return true
  }

  if (!isTrustedExtensionSender(sender, chrome.runtime.id)) {
    if (runtimeMessage.type === 'WORKER_RPC') {
      sendResponse({ error: 'Unauthorized Worker RPC sender' })
      return true
    }
    return false
  }

  if (runtimeMessage.type === 'RUN_ZCASH_VOTING') {
    const action = runtimeMessage.action
    const actions = new Set([
      'discoverRounds',
      'checkEligibility',
      'roundStatus',
      'prepareRound',
      'roundProposals',
      'submitDelegation',
      'submitBallot',
      'resumeRound',
      'clearRound'
    ])
    const roundActions = new Set([...actions].filter(value => value !== 'discoverRounds'))
    const expectedKeys =
      action === 'discoverRounds'
        ? ['type', 'action']
        : action === 'submitBallot'
          ? ['type', 'action', 'roundId', 'decisions']
          : ['type', 'action', 'roundId']
    if (
      typeof action !== 'string' ||
      !actions.has(action) ||
      !hasExactRuntimeKeys(runtimeMessage, expectedKeys) ||
      (roundActions.has(action) &&
        (typeof runtimeMessage.roundId !== 'string' ||
          runtimeMessage.roundId.length === 0 ||
          runtimeMessage.roundId.length > 256 ||
          /[\u0000-\u001f\u007f-\u009f]/.test(runtimeMessage.roundId)))
    ) {
      sendResponse({ success: false, error: 'Invalid Zcash voting request' })
      return true
    }

    void accountContextTransition
      .runActiveOperation(async () => {
        await rehydrateWalletStore()
        const state = useWalletStore.getState()
        const walletId = state.currentWalletId
        const accountId = state.currentAccountId
        if (!walletId || !accountId) throw new Error('Select an active Zcash account')
        const wallet = state.getWallet(walletId)
        if (!wallet || isZcashHardwareKeySource(wallet.keySource)) {
          throw new Error('Voting requires a software wallet')
        }
        await assertActiveBackgroundAccountScope(walletId, accountId)
        const account = wallet.accounts.find(candidate => candidate.id === accountId)
        if (!account) throw new Error('Active Zcash account is unavailable')
        const catalog = await accountNetworksCoordinator.readCatalog()
        const activeAccount = catalog?.accounts.find(
          candidate => candidate.active && candidate.accountId === accountId
        )
        if (
          !activeAccount ||
          activeAccount.walletId !== walletId ||
          activeAccount.walletSource.kind !== 'software' ||
          !activeAccount.networks.some(
            network => network.chainId === getZcashChainId(DEFAULT_NETWORK)
          )
        ) {
          throw new Error('The active account does not support Zcash voting')
        }

        const core = await prepareWalletCoreForTx(walletId, accountId)
        switch (action) {
          case 'discoverRounds':
            return core.discoverVotingRounds()
          case 'checkEligibility':
            return core.checkVotingEligibility(runtimeMessage.roundId as string)
          case 'roundStatus':
            return core.getVotingRoundStatus(runtimeMessage.roundId as string)
          case 'prepareRound':
            return core.prepareVotingRound(runtimeMessage.roundId as string)
          case 'roundProposals':
            return core.getVotingRoundProposals(runtimeMessage.roundId as string)
          case 'submitDelegation': {
            const binding = await credentialSession.getCredentialBinding(walletId)
            return core.submitVotingDelegation(runtimeMessage.roundId as string, {
              credentialGenerationId: binding.credentialGenerationId,
              globalUnlockEpoch: binding.globalUnlockEpoch
            })
          }
          case 'submitBallot':
            return core
              .getVotingRoundProposals(runtimeMessage.roundId as string)
              .then(proposals =>
                core.submitVotingBallot(
                  runtimeMessage.roundId as string,
                  validateVotingDecisions(proposals, runtimeMessage.decisions)
                )
              )
          case 'resumeRound':
            return core.resumeVotingRound(runtimeMessage.roundId as string)
          case 'clearRound':
            return core.clearVotingRound(runtimeMessage.roundId as string)
        }
      })
      .then(result => sendResponse({ success: true, result }))
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Zcash voting request failed'
        })
      )
    return true
  }

  if (
    runtimeMessage.type === 'SAVE_SWAP_APPROVAL_CONTINUATION' ||
    runtimeMessage.type === 'GET_SWAP_APPROVAL_CONTINUATION' ||
    runtimeMessage.type === 'CONTINUE_SWAP_AFTER_APPROVAL' ||
    runtimeMessage.type === 'CLEAR_SWAP_APPROVAL_CONTINUATION'
  ) {
    const type = runtimeMessage.type
    const canRead = getOwnExtensionSenderContext(sender, chrome.runtime.id) === 'extension-page'
    if (!canRead) {
      sendResponse({ error: 'Unauthorized Swap continuation sender' })
      return true
    }
    void (async () => {
      const readActive = async () => {
        await rehydrateWalletStore()
        const state = useWalletStore.getState()
        const catalog = await accountNetworksCoordinator.readCatalog()
        const account = catalog?.accounts.find(candidate => candidate.active)
        return {
          network: state.currentNetwork,
          walletId: account?.walletId ?? null,
          accountId: account?.accountId ?? null
        }
      }
      if (type === 'SAVE_SWAP_APPROVAL_CONTINUATION') {
        if (!evmTransferRouter) throw new Error('EVM transfer is unavailable')
        return saveSwapApprovalContinuation(runtimeMessage.input, evmTransferRouter, readActive)
      }
      if (typeof runtimeMessage.transactionId !== 'string')
        throw new Error('Invalid transaction ID')
      if (type === 'GET_SWAP_APPROVAL_CONTINUATION')
        return readSwapApprovalContinuation(runtimeMessage.transactionId, readActive)
      if (type === 'CONTINUE_SWAP_AFTER_APPROVAL') {
        if (!evmTransferRouter) throw new Error('EVM transfer is unavailable')
        return continueSwapAfterApproval(
          runtimeMessage.transactionId,
          evmTransferRouter,
          readActive
        )
      }
      await clearSwapApprovalContinuation(runtimeMessage.transactionId)
      return true
    })()
      .then(result => sendResponse({ result }))
      .catch(error =>
        sendResponse({ error: error instanceof Error ? error.message : 'Swap continuation failed' })
      )
    return true
  }
  if (
    [
      'GET_LEDGER_SIGNING_REQUEST',
      'SUBMIT_LEDGER_SIGNING_RESPONSE',
      'CANCEL_LEDGER_SIGNING_REQUEST',
      'GET_LEDGER_PROVISIONING_CREDENTIAL',
      'GET_HARDWARE_TRANSFER_VENDOR'
    ].includes(message.type)
  ) {
    if (!isTrustedRuntimeMessageSender(message.type, sender, chrome.runtime.id)) {
      sendResponse({ error: 'Unauthorized Ledger runtime sender' })
      return true
    }
    try {
      message = parseTrustedExtensionRuntimeMessage(runtimeMessage)
    } catch {
      sendResponse({ error: 'Invalid Ledger runtime message' })
      return true
    }
  }
  if (
    message.type === 'GET_LEDGER_SIGNING_REQUEST' ||
    message.type === 'SUBMIT_LEDGER_SIGNING_RESPONSE' ||
    message.type === 'CANCEL_LEDGER_SIGNING_REQUEST'
  ) {
    if (!isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/ledger-sign')) {
      sendResponse({ error: 'Unauthorized Ledger signing sender' })
      return true
    }
    const operation =
      message.type === 'GET_LEDGER_SIGNING_REQUEST'
        ? getLedgerSigningRequest(message.requestId, sender.tab?.id)
        : message.type === 'SUBMIT_LEDGER_SIGNING_RESPONSE'
          ? submitLedgerSigningResponse(message.requestId, message.response, sender.tab?.id)
          : getLedgerSigningRequest(message.requestId, sender.tab?.id).then(() =>
              cancelLedgerSigning(message.requestId)
            )
    void operation
      .then(result => sendResponse({ result: result ?? true }))
      .catch(error =>
        sendResponse({ error: error instanceof Error ? error.message : 'Ledger signing failed' })
      )
    return true
  }
  if (message.type === 'GET_LEDGER_PROVISIONING_CREDENTIAL') {
    if (!isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/ledger-connect')) {
      sendResponse({ error: 'Unauthorized Ledger setup sender' })
      return true
    }
    void readLedgerProvisioningCredential(message.walletId)
      .then(result => sendResponse({ result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Ledger Wallet unavailable'
        })
      )
    return true
  }
  if (message.type === 'GET_HARDWARE_TRANSFER_VENDOR') {
    const operation =
      message.family === 'evm'
        ? evmTransferRouter?.getExternalSigningRequest(message.transactionId)
        : message.family === 'bitcoin'
          ? bitcoinTransferController?.getExternalSigningRequest(message.transactionId)
          : undefined
    if (!operation) {
      sendResponse({ error: 'Hardware signing unavailable' })
      return true
    }
    void operation
      .then(result => sendResponse({ result: result?.vendor ?? 'keystone' }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Hardware signing unavailable'
        })
      )
    return true
  }
  if (message.type === 'WORKER_RPC') {
    if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'extension-page') {
      sendResponse({ error: 'Unauthorized Worker RPC sender' })
      return true
    }
    let rpcMessage
    try {
      rpcMessage = parseWorkerRpcRuntimeMessage(runtimeMessage)
    } catch {
      sendResponse({ error: 'Invalid Worker RPC message' })
      return true
    }

    if (rpcMessage.method === 'zeroIndexer.setOptions') {
      sendResponse({ error: 'Privacy broadcast settings are Background-only' })
      return true
    }

    if (rpcMessage.method.startsWith('multichain.')) {
      if (!MULTICHAIN_WORKER_RPC_METHODS.has(rpcMessage.method)) {
        sendResponse({ error: 'Unsupported Multichain Worker RPC method' })
        return true
      }
      if (rpcMessage.method === 'multichain.execute') {
        const authorization = authorizeMultichainExtensionCommand(rpcMessage.payload.command)
        if (!authorization.allowed) {
          sendResponse({
            error:
              authorization.reason === 'invalid-command'
                ? 'Invalid Multichain Worker command'
                : 'Multichain capability is Background-only'
          })
          return true
        }
      }
      let forwardedMethod = rpcMessage.method
      if (
        __MULTICHAIN_CONFORMANCE_RPC_ENABLED__ &&
        (rpcMessage.method === 'multichain.conformance-execute' ||
          rpcMessage.method === 'multichain.conformance-restart')
      ) {
        forwardedMethod =
          rpcMessage.method === 'multichain.conformance-execute'
            ? 'multichain.execute'
            : 'multichain.restart'
      }
      void forwardKeyringRpcToOffscreen(forwardedMethod, rpcMessage.payload)
        .then(result => sendResponse({ result }))
        .catch(error => {
          sendResponse({
            error: error instanceof Error ? error.message : 'Worker RPC routing failed'
          })
        })
      return true
    }

    if (
      __MULTICHAIN_CONFORMANCE_RPC_ENABLED__ &&
      rpcMessage.method.startsWith('session.conformance-')
    ) {
      const forwardedMethod =
        rpcMessage.method === 'session.conformance-unlock'
          ? 'session.unlock'
          : rpcMessage.method === 'session.conformance-attest'
            ? 'session.attest'
            : rpcMessage.method === 'session.conformance-lock'
              ? 'session.lock'
              : null
      if (!forwardedMethod) {
        sendResponse({ error: 'Unsupported credential session conformance method' })
        return true
      }
      void forwardKeyringRpcToOffscreen(forwardedMethod, rpcMessage.payload)
        .then(result => sendResponse({ result }))
        .catch(error => {
          sendResponse({
            error: error instanceof Error ? error.message : 'Credential session routing failed'
          })
        })
      return true
    }

    if (__MULTICHAIN_CONFORMANCE_RPC_ENABLED__ && rpcMessage.method === 'evm.conformance-poll') {
      if (!evmTransactionMonitor) {
        sendResponse({ error: 'EVM transaction monitor is unavailable' })
        return true
      }
      void evmTransactionMonitor
        .pollConformanceScopes(rpcMessage.payload.scopes)
        .then(result => sendResponse({ result }))
        .catch(error => {
          sendResponse({
            error: error instanceof Error ? error.message : 'EVM monitor poll failed'
          })
        })
      return true
    }

    if (__MULTICHAIN_CONFORMANCE_RPC_ENABLED__ && rpcMessage.method === 'evm.conformance-sign') {
      if (
        !evmSigningConformanceClient ||
        !hasExactRuntimeKeys(rpcMessage.payload, ['keyDomainId', 'signingPayload']) ||
        typeof rpcMessage.payload.keyDomainId !== 'string' ||
        !isRuntimeRecord(rpcMessage.payload.signingPayload)
      ) {
        sendResponse({ error: 'Invalid EVM signing conformance request' })
        return true
      }
      const keyDomainId = parseKeyDomainId(rpcMessage.payload.keyDomainId)
      const signingPayload = rpcMessage.payload
        .signingPayload as unknown as EvmSigningPreparePayload
      void Promise.all([
        evmSigningConformanceClient.prepare(keyDomainId, signingPayload),
        computeEvmSigningPayloadFingerprint(signingPayload.transaction)
      ])
        .then(async ([prepared, hostFingerprint]) => ({
          prepared,
          signed: await evmSigningConformanceClient.confirm(keyDomainId, prepared.commandId),
          hostFingerprint
        }))
        .then(result => sendResponse({ result }))
        .catch(error => {
          sendResponse({
            error: error instanceof Error ? error.message : 'EVM signing conformance failed'
          })
        })
      return true
    }

    if (rpcMessage.method.startsWith('session.') || rpcMessage.method.startsWith('credential.')) {
      sendResponse({ error: 'Credential session RPC is Background-only' })
      return true
    }

    void forwardKeyringRpcToOffscreen(rpcMessage.method, rpcMessage.payload)
      .then(result => sendResponse({ result }))
      .catch(error => {
        sendResponse(encodeWorkerRpcError(error))
      })
    return true
  }

  // Internal Background-to-Offscreen route; handled only by the Offscreen Document.
  if (message.type === 'KEYRING_WORKER_RPC') {
    return false
  }

  if (message.type === 'ZCASH_TRANSACTION_OUTCOME') {
    if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'offscreen-document') {
      sendResponse({ error: 'Unauthorized transaction outcome sender' })
      return true
    }
    void multichainStartupReady
      .then(() =>
        accountContextTransition.runActiveOperation(async () => {
          const scope = getZcashAccountScopes().find(item => item.accountKey === message.accountKey)
          if (!scope || typeof message.transactionId !== 'string') return
          const transaction = (await loadTransactions(scope.accountKey)).find(
            item => item.id === message.transactionId
          )
          if (!transaction?.txHash) return
          void chrome.runtime
            .sendMessage({
              type: 'ZCASH_TX_COMPLETED',
              accountKey: scope.accountKey,
              transactionId: transaction.id,
              txHash: transaction.txHash
            })
            .catch(() => {})
          void chrome.runtime
            .sendMessage({ type: 'TRANSACTION_UPDATED', accountKey: scope.accountKey })
            .catch(() => {})
          await zcashTxMonitor.restoreStuckWithdrawals([scope])
          if (transaction.type === 'swap') {
            await rheaSwapTransactionMonitor?.restorePendingZcashSwaps([scope])
          }
        })
      )
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ error: 'Transaction monitoring deferred' }))
    return true
  }

  // Ignore OFFSCREEN_READY messages - they are handled by client.ts
  if (message.type === 'OFFSCREEN_READY') {
    if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'offscreen-document') {
      sendResponse({ error: 'Unauthorized Offscreen ready sender' })
      return true
    }
    return false
  }

  // Background broadcasts this event to extension pages after an independent
  // Bitcoin refresh. The sender does not need a response from this listener.
  if (message.type === 'PORTFOLIO_UPDATED') {
    return false
  }

  if (
    message.type === 'DAPP_APPROVAL_RESULT' ||
    message.type === 'DAPP_NETWORK_FEE_TIER_CHANGE' ||
    message.type === 'DAPP_EVM_FEE_SELECTION_CHANGE' ||
    message.type === 'HW_SIGN_RESULT' ||
    message.type === 'UNLOCK_SUCCESS' ||
    message.type === 'CLEAR_WALLET_INIT_STATE' ||
    message.type === 'RECONCILE_WALLET_STATE' ||
    message.type === 'SYNC_ABORT_WALLET' ||
    message.type === 'SYNC_CLEAR_ABORT'
  ) {
    return false
  }

  if (!isTrustedRuntimeMessageSender(message.type, sender, chrome.runtime.id)) {
    sendResponse({ error: 'Unauthorized runtime message sender' })
    return true
  }

  try {
    message = parseTrustedExtensionRuntimeMessage(runtimeMessage)
  } catch {
    sendResponse({ error: 'Invalid or unsupported runtime message' })
    return true
  }

  if (
    message.type === 'GET_BETA_INVITE_ACTIVATION' ||
    message.type === 'CHECK_BETA_INVITE_CODE' ||
    message.type === 'BIND_BETA_INVITE_WALLET'
  ) {
    void trustedStorageAccessReady
      .then(async ready => {
        if (!ready) throw new Error('Beta activation is unavailable. Please try again.')
        if (message.type === 'GET_BETA_INVITE_ACTIVATION') return betaInviteActivation.getStatus()
        if (message.type === 'CHECK_BETA_INVITE_CODE') {
          return betaInviteActivation.check(message.inviteCode as string)
        }
        return betaInviteActivation.bind()
      })
      .then(result => sendResponse({ result }))
      .catch(error => {
        sendResponse({ error: getBetaInviteErrorMessage(error) })
      })
    return true
  }

  if (message.type === 'SYNC_PROGRESS') {
    syncScheduler.applySyncProgressMessage(message)
    return false
  }

  if (message.type === 'WORKER_LOG') {
    void appendDiagnosticLog(
      {
        source: 'worker',
        level:
          message.level === 'error'
            ? 'error'
            : message.level === 'warn'
              ? 'warn'
              : message.level === 'info'
                ? 'info'
                : 'debug',
        message: String(message.message),
        timestamp: Date.now(),
        sequence: forwardedDiagnosticSequence++
      },
      { walletId: message.walletId }
    ).catch(() => {})
    if (!debugLogsEnabled) return false
    if (message.walletId || message.level === 'error' || message.level === 'warn') {
      const rawLevel = message.level as string
      const fallbackPrefix = `[Worker ${rawLevel.toUpperCase()}]`
      const prefix = message.walletId ? logger.getPrefix(message.walletId) : fallbackPrefix
      const workerMessage = sanitizeDiagnosticMessage(
        String(message.message).replace(/^\[Worker\]\s*/, '')
      )
      const consoleMethod = console[message.level as 'log'] || console.log
      consoleMethod(prefix, workerMessage)
    }
    return false
  }

  if (message.type === 'FORWARD_WALLET_LOG') {
    const { level, walletId, message: logMessage } = message.payload
    void appendDiagnosticLog(
      {
        source: 'offscreen',
        level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'debug',
        message: logMessage,
        timestamp: Date.now(),
        sequence: forwardedDiagnosticSequence++
      },
      { walletId }
    ).catch(() => {})
    if (!debugLogsEnabled) return false
    const prefix = logger.getPrefix(walletId)
    const consoleMethod = console[level as 'log'] || console.log
    consoleMethod(prefix, sanitizeDiagnosticMessage(logMessage))
    return false
  }

  if (message.type === 'APPEND_DIAGNOSTIC_LOG') {
    const entry = parseDiagnosticLogDraft(message.entry)
    if (!entry) {
      sendResponse({ success: false, error: 'Invalid diagnostic log entry' })
      return true
    }
    const source =
      getOwnExtensionSenderContext(sender, chrome.runtime.id) === 'offscreen-document'
        ? 'offscreen'
        : 'popup'
    appendDiagnosticLog({ ...entry, source }).then(
      () => sendResponse({ success: true }),
      () => sendResponse({ success: false, error: 'Diagnostic logging is unavailable' })
    )
    return true
  }

  if (message.type === 'EXPORT_DIAGNOSTIC_LOGS') {
    exportDiagnosticLogs().then(
      exported => sendResponse({ success: true, ...exported }),
      () => sendResponse({ success: false, error: 'Diagnostic export is unavailable' })
    )
    return true
  }

  if (message.type === 'ANALYTICS_EVENT' || message.type === 'ANALYTICS_PAGE_VIEW') {
    handleAnalyticsMessage(message)
    return false
  }

  if (message.type === 'SET_EXTENSION_DISPLAY_MODE') {
    if (typeof message.sidePanelMode !== 'boolean') {
      sendResponse({ success: false, error: 'Invalid extension display mode' })
      return true
    }

    const updateDisplayMode = async () => {
      // Chrome can destroy the side-panel page as soon as it is disabled, so
      // renew activity in Background instead of relying on the page's event handler.
      const lastUserActivityAt = Date.now()
      await credentialSession.touch(lastUserActivityAt)
      await chrome.storage.local.set({
        [SecureStorage.LAST_ACTIVITY_KEY]: lastUserActivityAt
      })

      const previousMode = getAppliedSidePanelMode()
      if (message.sidePanelMode) {
        await applyExtensionDisplayMode(true)
        try {
          await persistSidePanelMode(true)
        } catch (error) {
          await applyExtensionDisplayMode(previousMode).catch(() => {})
          throw error
        }
        return
      }

      // Disabling the panel can destroy the sender page immediately. Persist
      // first so the next toolbar click reliably restores popup mode.
      await persistSidePanelMode(false)
      try {
        await applyExtensionDisplayMode(false)
      } catch (error) {
        await Promise.allSettled([
          persistSidePanelMode(previousMode),
          applyExtensionDisplayMode(previousMode)
        ])
        throw error
      }
    }

    enqueueExtensionDisplayModeUpdate(updateDisplayMode)
      .then(() => sendResponse({ success: true, sidePanelMode: getAppliedSidePanelMode() }))
      .catch(error => {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to change extension display mode'
        })
      })
    return true
  }

  if (message.type === 'GET_EXTENSION_DISPLAY_MODE') {
    enqueueExtensionDisplayModeUpdate(async () => getAppliedSidePanelMode())
      .then(sidePanelMode => sendResponse({ success: true, sidePanelMode }))
      .catch(error => {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read extension display mode'
        })
      })
    return true
  }

  if (message.type === 'WALLET_UNLOCK') {
    handleWalletUnlock(message.password)
      .then(sendResponse)
      .catch(error => {
        sendResponse({ error: error.message })
      })
    return true
  }

  if (message.type === 'GET_WALLET_SESSION_STATE') {
    credentialSession
      .hasUnlockSession()
      .then(active => sendResponse({ active }))
      .catch(() => sendResponse({ active: false }))
    return true
  }

  if (message.type === 'GET_BACKGROUND_INITIALIZATION_STATE') {
    silentInitializeWasm()
      .then(() => sendResponse({ ready: true }))
      .catch(() => sendResponse({ ready: false }))
    return true
  }

  if (message.type === 'GET_NETWORK_MODE') {
    sendResponse({
      result: { networkMode: DEFAULT_NETWORK, restartRequired: networkRestartRequired }
    })
    return true
  }

  if (message.type === 'GET_ZERO_INDEXER_OPTIONS') {
    if (
      getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'offscreen-document' ||
      (message.network !== 'mainnet' && message.network !== 'testnet')
    ) {
      sendResponse({ success: false, error: 'Invalid privacy broadcast network' })
      return true
    }
    if (message.network !== DEFAULT_NETWORK) {
      sendResponse({ success: true, options: null })
      return true
    }
    void readZeroIndexerEnabled()
      .then(enabled => getZeroIndexerBroadcastOptions(DEFAULT_NETWORK, enabled))
      .then(options => sendResponse({ success: true, options }))
      .catch(() =>
        sendResponse({ success: false, error: 'Could not load privacy broadcast configuration' })
      )
    return true
  }

  if (message.type === 'GET_ZERO_INDEXER_ENABLED') {
    void readZeroIndexerEnabled()
      .then(enabled => sendResponse({ success: true, enabled }))
      .catch(() => sendResponse({ success: false, error: 'Could not load privacy preference' }))
    return true
  }

  if (message.type === 'SET_ZERO_INDEXER_ENABLED') {
    if (typeof message.enabled !== 'boolean') {
      sendResponse({ success: false, error: 'Invalid privacy broadcast preference' })
      return true
    }
    void enqueueZeroIndexerUpdate(async () => {
      await writeZeroIndexerEnabled(message.enabled)
      const warning = await applyLatestZeroIndexerRuntime()
      return { enabled: message.enabled, warning }
    })
      .then(({ enabled, warning }) => {
        sendResponse({ success: true, enabled, ...(warning ? { warning } : {}) })
      })
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Could not save privacy preference'
        })
      )
    return true
  }

  if (message.type === 'GET_ZERO_INDEXER_NODE_STATUS') {
    if (message.refresh !== undefined && typeof message.refresh !== 'boolean') {
      sendResponse({ success: false, error: 'Invalid node refresh request' })
      return true
    }
    void getZeroIndexerNodeStatus(message.refresh === true)
      .then(status => sendResponse({ success: true, status }))
      .catch(() => sendResponse({ success: false, error: 'Could not load broadcast nodes' }))
    return true
  }

  if (
    message.type === 'SELECT_ZERO_INDEXER_NODE' ||
    message.type === 'ADD_CUSTOM_ZERO_INDEXER_NODE' ||
    message.type === 'REMOVE_CUSTOM_ZERO_INDEXER_NODE'
  ) {
    void enqueueZeroIndexerUpdate(async () => {
      const status =
        message.type === 'SELECT_ZERO_INDEXER_NODE'
          ? await selectZeroIndexerNode(message.endpointId)
          : message.type === 'ADD_CUSTOM_ZERO_INDEXER_NODE'
            ? await addCustomZeroIndexerNode(message.label, message.url)
            : await removeCustomZeroIndexerNode(message.endpointId)
      const warning = await applyLatestZeroIndexerRuntime()
      return { status, warning }
    })
      .then(({ status, warning }) => {
        sendResponse({ success: true, status, ...(warning ? { warning } : {}) })
      })
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Could not update broadcast nodes'
        })
      )
    return true
  }

  if (message.type === 'SWITCH_NETWORK_MODE') {
    void switchGlobalNetworkMode(message.networkMode as Network)
      .then(result => sendResponse({ result }))
      .catch(error => {
        sendResponse({
          error:
            error instanceof Error && error.message.length <= 256
              ? error.message
              : 'Network mode could not be switched'
        })
      })
    return true
  }

  if (message.type === 'GET_CHAIN_ENDPOINT_SETTINGS') {
    void chainEndpointSettingsCoordinator
      .read()
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ error: 'Chain endpoint settings are unavailable' }))
    return true
  }

  if (message.type === 'APPLY_CHAIN_ENDPOINT_SETTINGS') {
    void applyChainEndpointSettings(message.settings, message.expectedSettings)
      .then(result => {
        sendResponse({ result })
      })
      .catch(error => {
        sendResponse({
          error:
            error instanceof Error && error.message.length <= 256
              ? error.message
              : 'Chain endpoint settings could not be applied'
        })
      })
    return true
  }

  if (
    message.type === 'SAVE_CUSTOM_EVM_NETWORK' ||
    message.type === 'REMOVE_CUSTOM_EVM_NETWORK' ||
    message.type === 'SELECT_ACTIVE_EVM_CHAIN'
  ) {
    void updateChainEndpointSettings(() => {
      if (message.type === 'SAVE_CUSTOM_EVM_NETWORK') {
        return chainEndpointSettingsCoordinator.saveCustomEvmNetwork(
          message.network,
          message.expectedNetwork
        )
      }
      if (message.type === 'REMOVE_CUSTOM_EVM_NETWORK') {
        return chainEndpointSettingsCoordinator.removeCustomEvmNetwork(message.network)
      }
      return chainEndpointSettingsCoordinator.selectActiveEvmChain(message.chainId as string)
    })
      .then(result => sendResponse({ result }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error && error.message.length <= 256
              ? error.message
              : 'Network settings could not be saved'
        })
      )
    return true
  }

  if (message.type === 'GET_USER_EVM_ASSETS') {
    if (!userEvmAssetCoordinator) {
      sendResponse({ error: 'User EVM Tokens are unavailable' })
      return true
    }
    void userEvmAssetCoordinator
      .list()
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ error: 'User EVM Tokens could not be loaded' }))
    return true
  }

  if (message.type === 'GET_MANAGED_TOKEN_ASSETS') {
    if (!userEvmAssetCoordinator || !detectedEvmAssetCoordinator || !tokenVisibility) {
      sendResponse({ error: 'Managed Tokens are unavailable' })
      return true
    }
    void tokenVisibility
      .list()
      .then(hiddenAssetIds =>
        sendResponse({
          result: {
            userAssets: userEvmAssetRecords,
            detectedAssets: detectedEvmAssetRecords,
            hiddenAssetIds,
            protocolAssetIds: intentsProtocolAssetIds
          }
        })
      )
      .catch(() => sendResponse({ error: 'Managed Tokens could not be loaded' }))
    return true
  }

  if (message.type === 'INSPECT_USER_EVM_ASSET') {
    if (!userEvmAssetCoordinator) {
      sendResponse({ error: 'User EVM Tokens are unavailable' })
      return true
    }
    void userEvmAssetCoordinator
      .inspect({ chainId: message.chainId, contractAddress: message.contractAddress })
      .then(result => sendResponse({ result }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error && error.message.length <= 256
              ? error.message
              : 'Token contract could not be verified'
        })
      )
    return true
  }

  if (message.type === 'ADD_USER_EVM_ASSET') {
    if (!userEvmAssetCoordinator) {
      sendResponse({ error: 'User EVM Tokens are unavailable' })
      return true
    }
    const coordinator = userEvmAssetCoordinator
    void credentialSession
      .hasUnlockSession()
      .then(async unlocked => {
        if (!unlocked) throw new Error('Unlock the wallet before adding a Token')
        const result = await coordinator.add(message.candidate)
        await tokenVisibility?.setHidden(result.assetId, false)
        await refreshMultichainRuntimeForUserAssets(true, [result.chainId])
        void refreshAssetPrices(result.assetId).catch(() => {})
        return result
      })
      .then(result => sendResponse({ result }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error && error.message.length <= 256
              ? error.message
              : 'Token could not be added'
        })
      )
    return true
  }

  if (message.type === 'ENABLE_INTENTS_EVM_ASSETS') {
    if (!userEvmAssetCoordinator || !tokenVisibility) {
      sendResponse({ error: 'EVM Tokens are unavailable' })
      return true
    }
    if (
      !Array.isArray(message.assets) ||
      message.assets.length === 0 ||
      message.assets.length > 64
    ) {
      sendResponse({ error: 'Invalid Intents EVM Token list' })
      return true
    }
    let inputs: Array<{
      chainId: string
      contractAddress: string
      expectedDecimals: number
      iconUrl?: string
    }>
    try {
      inputs = message.assets.map((value: unknown) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error('Invalid Intents EVM Token')
        }
        const record = value as Record<string, unknown>
        if (
          typeof record.chainId !== 'string' ||
          typeof record.contractAddress !== 'string' ||
          !Number.isSafeInteger(record.expectedDecimals) ||
          (record.expectedDecimals as number) < 0 ||
          (record.expectedDecimals as number) > 255 ||
          (record.iconUrl !== undefined && typeof record.iconUrl !== 'string')
        ) {
          throw new Error('Invalid Intents EVM Token')
        }
        return {
          chainId: record.chainId,
          contractAddress: record.contractAddress,
          expectedDecimals: record.expectedDecimals as number,
          ...(record.iconUrl === undefined ? {} : { iconUrl: record.iconUrl })
        }
      })
    } catch {
      sendResponse({ error: 'Invalid Intents EVM Token list' })
      return true
    }
    const coordinator = userEvmAssetCoordinator
    const visibility = tokenVisibility
    void credentialSession
      .hasUnlockSession()
      .then(async unlocked => {
        if (!unlocked) throw new Error('Unlock the wallet before changing Token visibility')
        const existingSources = new Map(
          userEvmAssetRecords.map(asset => [asset.assetId, asset.source] as const)
        )
        const enabled: UserEvmAssetRecord[] = []
        const errors: string[] = []
        for (const input of inputs) {
          try {
            const record = await coordinator.ensure(input)
            if (message.show) await visibility.setHidden(record.assetId, false)
            enabled.push(record)
          } catch (error) {
            errors.push(error instanceof Error ? error.message : 'Token could not be enabled')
          }
        }
        if (enabled.some(asset => existingSources.get(asset.assetId) !== asset.source)) {
          await refreshMultichainRuntimeForUserAssets(false, [
            ...new Set(enabled.map(asset => asset.chainId))
          ])
        }
        if (enabled.length === 0) {
          throw new Error(errors[0] || 'Tokens could not be enabled')
        }
        return { assets: enabled, failed: errors.length }
      })
      .then(result => sendResponse({ result }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error && error.message.length <= 256
              ? error.message
              : 'Tokens could not be enabled'
        })
      )
    return true
  }

  if (message.type === 'REMOVE_USER_EVM_ASSET') {
    if (!userEvmAssetCoordinator) {
      sendResponse({ error: 'User EVM Tokens are unavailable' })
      return true
    }
    const coordinator = userEvmAssetCoordinator
    void credentialSession
      .hasUnlockSession()
      .then(async unlocked => {
        if (!unlocked) throw new Error('Unlock the wallet before removing a Token')
        const chainId = parseAssetId(message.assetId).chainId
        const removed = await coordinator.remove(message.assetId)
        if (!removed) throw new Error('The Token is not in the user asset list')
        await refreshMultichainRuntimeForUserAssets(true, [chainId])
        return { removed: true as const }
      })
      .then(result => sendResponse({ result }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error && error.message.length <= 256
              ? error.message
              : 'Token could not be removed'
        })
      )
    return true
  }

  if (message.type === 'SET_TOKEN_HIDDEN') {
    if (!tokenVisibility) {
      sendResponse({ error: 'Token visibility is unavailable' })
      return true
    }
    const visibility = tokenVisibility
    void credentialSession
      .hasUnlockSession()
      .then(async unlocked => {
        if (!unlocked) throw new Error('Unlock the wallet before changing Token visibility')
        await visibility.setHidden(message.assetId, message.hidden)
        return { hidden: message.hidden as boolean }
      })
      .then(result => sendResponse({ result }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error && error.message.length <= 256
              ? error.message
              : 'Token visibility could not be changed'
        })
      )
    return true
  }

  if (message.type === 'GET_EVM_PORTFOLIO') {
    if (!evmPortfolioConformanceCoordinator) {
      sendResponse({ error: createEvmWalletRuntimeError('unavailable') })
      return true
    }
    const operation =
      message.action === 'read'
        ? evmPortfolioConformanceCoordinator.readCachedActive()
        : evmPortfolioConformanceCoordinator.refreshActive()
    void operation
      .then(result => sendResponse({ result }))
      .catch(error => {
        sendResponse({ error: mapEvmWalletRuntimeError(error) })
      })
    return true
  }

  if (message.type === 'REFRESH_INTENTS_PROTOCOL_ASSETS') {
    void refreshIntentsProtocolAssets(message.force === true)
      .then(() => sendResponse({ result: { refreshed: true } }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error && error.message.length <= 256
              ? error.message
              : 'Intents Token catalog could not be refreshed'
        })
      )
    return true
  }

  if (message.type === 'GET_PORTFOLIO') {
    if (!portfolioCoordinator) {
      sendResponse({ error: createEvmWalletRuntimeError('unavailable') })
      return true
    }
    const operation = async () => {
      const refreshChainIds = Array.isArray(message.chainIds)
        ? (message.chainIds as readonly string[])
        : undefined
      if (message.action === 'refresh' && refreshChainIds === undefined) {
        await Promise.all([
          refreshIntentsProtocolAssets().catch(error => {
            console.warn('[Portfolio] Intents token catalog refresh failed', error)
          }),
          refreshDetectedEvmAssetsForActiveAccount(message.forceDiscovery === true).catch(() => {})
        ])
      }
      const coordinator = portfolioCoordinator
      if (!coordinator) throw new Error('Portfolio runtime is unavailable')
      const baseModel =
        message.action === 'read'
          ? await coordinator.readCachedActive()
          : await coordinator.refreshActive(refreshChainIds)
      const model = baseModel
        ? ((await confidentialFundingCoordinator?.enrichPortfolio(baseModel).catch(error => {
            console.warn(
              '[Confidential Funding] Balance merge failed:',
              error instanceof Error ? error.name : 'UnknownError'
            )
            return baseModel
          })) ?? baseModel)
        : null
      if (message.action === 'refresh' && model) {
        void chrome.runtime
          .sendMessage({
            type: 'PORTFOLIO_UPDATED',
            walletId: model.scope.keyDomainId,
            accountId: model.scope.accountId
          })
          .catch(() => {})
      }
      await tokenVisibility?.revealHeldProtocolAssets(
        model?.assets.flatMap(asset =>
          asset.asset.kind === 'token' && asset.balance.totalRaw !== '0' ? [asset.asset.id] : []
        ) ?? []
      )
      const hiddenAssetIds = await tokenVisibility?.list().catch(() => [])
      return {
        model: model ? hidePortfolioAssets(model, hiddenAssetIds ?? []) : null,
        userAssets: userEvmAssetRecords,
        detectedAssets: detectedEvmAssetRecords,
        protocolAssets: intentsProtocolAssets
      }
    }
    void operation()
      .then(result => sendResponse({ result }))
      .catch(error => {
        const bitcoinStage =
          error instanceof PortfolioCoordinatorError &&
          error.cause instanceof BitcoinPortfolioCoordinatorError
            ? error.cause.stage
            : 'unknown'
        const bitcoinDiscoveryStage =
          error instanceof PortfolioCoordinatorError &&
          error.cause instanceof BitcoinPortfolioCoordinatorError &&
          error.cause.cause instanceof BitcoinDiscoveryReadError
            ? error.cause.cause.stage
            : 'unknown'
        console.warn(
          '[Portfolio] Request failed at stage:',
          error instanceof PortfolioCoordinatorError ? error.stage : 'unknown',
          'Bitcoin stage:',
          bitcoinStage,
          'Discovery stage:',
          bitcoinDiscoveryStage
        )
        sendResponse({ error: mapEvmWalletRuntimeError(error) })
      })
    return true
  }

  if (message.type === 'GET_ACTIVITY') {
    void activityCoordinator
      .readActive({
        includeSupplemental: message.action !== 'read',
        accountMode: message.executionMode ?? 'all',
        chainIds: Array.isArray(message.chainIds) ? message.chainIds : undefined,
        historyPageCount: message.historyPageCount
      })
      .then(result => sendResponse({ result }))
      .catch(error => {
        console.warn(
          '[Background] Activity request failed:',
          error instanceof Error ? error.name : 'UnknownError'
        )
        sendResponse({
          error: createEvmWalletRuntimeError('request-failed')
        })
      })
    return true
  }

  if (message.type === 'GET_BITCOIN_ACTIVITY') {
    void activityCoordinator
      .readActive({ includeSupplemental: message.action !== 'read', accountMode: 'main' })
      .then(result => sendResponse({ result }))
      .catch(error => {
        console.warn(
          '[Background] Bitcoin Activity request failed:',
          error instanceof Error ? error.name : 'UnknownError'
        )
        sendResponse({
          error: createBitcoinWalletRuntimeError('request-failed')
        })
      })
    return true
  }

  if (message.type === 'GET_BITCOIN_WALLET_IDENTITY') {
    if (!bitcoinFeatureRuntimePolicy.newOperationsEnabled) {
      sendResponse({ error: createBitcoinWalletRuntimeError('unavailable') })
      return true
    }
    void bitcoinDAppHandler
      .getActiveWalletIdentity()
      .then(result => sendResponse({ result }))
      .catch(error => sendResponse({ error: mapBitcoinWalletRuntimeError(error) }))
    return true
  }

  if (message.type === 'GET_ZCASH_LENDING_PUBLIC_KEY') {
    void getBackgroundZcashLendingPublicKey({
      walletId: message.walletId,
      accountId: message.accountId,
      signingMode: message.signingMode
    })
      .then(result => sendResponse({ result }))
      .catch(error => {
        console.warn(
          '[Lending] Zcash identity lookup failed:',
          error instanceof Error ? error.message : 'UnknownError'
        )
        sendResponse({ error: 'Zcash lending identity unavailable' })
      })
    return true
  }

  if (message.type === 'GET_ASSET_PRICES') {
    const operation =
      message.action === 'read'
        ? assetPriceService.readCached()
        : refreshAssetPrices(typeof message.assetId === 'string' ? message.assetId : undefined)
    void operation
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ result: null }))
    return true
  }

  if (
    message.type === 'GET_RHEA_SWAP_TOKENS' ||
    message.type === 'QUOTE_RHEA_SWAP' ||
    message.type === 'PREPARE_RHEA_SWAP' ||
    message.type === 'GET_RHEA_SWAP_EVM_PLAN' ||
    message.type === 'GET_RHEA_SWAP_EVM_SIGNATURE_PLAN' ||
    message.type === 'PREPARE_RHEA_SWAP_EVM_SIGNATURE' ||
    message.type === 'CONFIRM_RHEA_SWAP_EVM_SIGNATURE' ||
    message.type === 'CANCEL_RHEA_SWAP_EVM_SIGNATURE' ||
    message.type === 'PREPARE_RHEA_SWAP_SOLANA' ||
    message.type === 'CONFIRM_RHEA_SWAP_SOLANA' ||
    message.type === 'CANCEL_RHEA_SWAP_SOLANA' ||
    message.type === 'PREPARE_RHEA_SWAP_NEAR' ||
    message.type === 'CONFIRM_RHEA_SWAP_NEAR' ||
    message.type === 'CANCEL_RHEA_SWAP_NEAR' ||
    message.type === 'RECORD_RHEA_SWAP_SUBMISSION' ||
    message.type === 'REPORT_RHEA_SWAP_SUBMISSION' ||
    message.type === 'GET_RHEA_SWAP_ORDER_STATUS' ||
    message.type === 'DISCARD_RHEA_SWAP'
  ) {
    if (!rheaSwapService || !rheaSwapEvmSignatureCoordinator) {
      sendResponse({ error: 'RHEA Swap is unavailable in this build or network' })
      return true
    }
    const solanaCoordinator = rheaSwapSolanaCoordinator
    const nearCoordinator = rheaSwapNearCoordinator
    if (
      (message.type === 'PREPARE_RHEA_SWAP_SOLANA' ||
        message.type === 'CONFIRM_RHEA_SWAP_SOLANA' ||
        message.type === 'CANCEL_RHEA_SWAP_SOLANA') &&
      !solanaCoordinator
    ) {
      sendResponse({ error: 'RHEA Swap Solana execution is unavailable in this build' })
      return true
    }
    if (
      (message.type === 'PREPARE_RHEA_SWAP_NEAR' ||
        message.type === 'CONFIRM_RHEA_SWAP_NEAR' ||
        message.type === 'CANCEL_RHEA_SWAP_NEAR') &&
      !nearCoordinator
    ) {
      sendResponse({ error: 'RHEA Swap NEAR execution is unavailable in this build' })
      return true
    }
    const operation =
      message.type === 'GET_RHEA_SWAP_TOKENS'
        ? rheaSwapService.listTokens({
            direction: message.direction as 'from' | 'cross-chain-to',
            tokenListChainIds: message.tokenListChainIds as readonly number[]
          })
        : message.type === 'QUOTE_RHEA_SWAP'
          ? rheaSwapService.quote(message.request)
          : message.type === 'PREPARE_RHEA_SWAP'
            ? rheaSwapService.prepare(message.quoteHandle as string)
            : message.type === 'GET_RHEA_SWAP_EVM_PLAN'
              ? rheaSwapService.readEvmTransactionPlan(message.quoteHandle as string)
              : message.type === 'GET_RHEA_SWAP_EVM_SIGNATURE_PLAN'
                ? rheaSwapService.readEvmSignaturePlan(message.quoteHandle as string)
                : message.type === 'PREPARE_RHEA_SWAP_EVM_SIGNATURE'
                  ? accountContextTransition.runActiveOperation(() =>
                      rheaSwapEvmSignatureCoordinator.prepare(
                        message.quoteHandle as string,
                        message.binding,
                        message.executionMode
                      )
                    )
                  : message.type === 'CONFIRM_RHEA_SWAP_EVM_SIGNATURE'
                    ? accountContextTransition.runActiveOperation(() =>
                        rheaSwapEvmSignatureCoordinator.confirm(
                          message.quoteHandle as string,
                          message.payloadFingerprint as string
                        )
                      )
                    : message.type === 'CANCEL_RHEA_SWAP_EVM_SIGNATURE'
                      ? accountContextTransition
                          .runActiveOperation(() =>
                            rheaSwapEvmSignatureCoordinator.cancel(message.quoteHandle as string)
                          )
                          .then(() => Object.freeze({ success: true }))
                      : message.type === 'PREPARE_RHEA_SWAP_SOLANA'
                        ? accountContextTransition.runActiveOperation(() =>
                            solanaCoordinator
                              ? solanaCoordinator.prepare(
                                  message.quoteHandle as string,
                                  message.binding
                                )
                              : Promise.reject(
                                  new Error('RHEA Swap Solana execution is unavailable')
                                )
                          )
                        : message.type === 'CONFIRM_RHEA_SWAP_SOLANA'
                          ? accountContextTransition.runActiveOperation(() =>
                              solanaCoordinator
                                ? solanaCoordinator.confirm(
                                    message.quoteHandle as string,
                                    message.payloadFingerprint as string
                                  )
                                : Promise.reject(
                                    new Error('RHEA Swap Solana execution is unavailable')
                                  )
                            )
                          : message.type === 'CANCEL_RHEA_SWAP_SOLANA'
                            ? accountContextTransition
                                .runActiveOperation(() =>
                                  solanaCoordinator
                                    ? solanaCoordinator.cancel(message.quoteHandle as string)
                                    : Promise.reject(
                                        new Error('RHEA Swap Solana execution is unavailable')
                                      )
                                )
                                .then(() => Object.freeze({ success: true }))
                            : message.type === 'PREPARE_RHEA_SWAP_NEAR'
                              ? accountContextTransition.runActiveOperation(() =>
                                  nearCoordinator
                                    ? nearCoordinator.prepare(
                                        message.quoteHandle as string,
                                        message.binding
                                      )
                                    : Promise.reject(
                                        new Error('RHEA Swap NEAR execution is unavailable')
                                      )
                                )
                              : message.type === 'CONFIRM_RHEA_SWAP_NEAR'
                                ? accountContextTransition.runActiveOperation(() =>
                                    nearCoordinator
                                      ? nearCoordinator.confirm(
                                          message.quoteHandle as string,
                                          message.payloadFingerprint as string
                                        )
                                      : Promise.reject(
                                          new Error('RHEA Swap NEAR execution is unavailable')
                                        )
                                  )
                                : message.type === 'CANCEL_RHEA_SWAP_NEAR'
                                  ? accountContextTransition
                                      .runActiveOperation(() =>
                                        nearCoordinator
                                          ? nearCoordinator.cancel(message.quoteHandle as string)
                                          : Promise.reject(
                                              new Error('RHEA Swap NEAR execution is unavailable')
                                            )
                                      )
                                      .then(() => Object.freeze({ success: true }))
                                  : message.type === 'RECORD_RHEA_SWAP_SUBMISSION'
                                    ? rheaSwapService.recordTransactionSubmission(
                                        message.quoteHandle as string,
                                        message.sourceHash as string
                                      )
                                    : message.type === 'REPORT_RHEA_SWAP_SUBMISSION'
                                      ? rheaSwapService.reportSubmission(
                                          message.quoteHandle as string
                                        )
                                      : message.type === 'GET_RHEA_SWAP_ORDER_STATUS'
                                        ? rheaSwapService.getOrderStatus(
                                            message.quoteHandle as string
                                          )
                                        : rheaSwapService.discard(message.quoteHandle as string)
    void operation
      .then(result => {
        sendResponse(
          message.type === 'DISCARD_RHEA_SWAP' ||
            message.type === 'CANCEL_RHEA_SWAP_EVM_SIGNATURE' ||
            message.type === 'CANCEL_RHEA_SWAP_SOLANA' ||
            message.type === 'CANCEL_RHEA_SWAP_NEAR'
            ? { success: true }
            : { result }
        )
      })
      .catch(error => {
        const safeMessage = getSafeRheaSwapRuntimeErrorMessage(error)
        console.error('[RHEA Swap] Request failed', {
          operation: message.type,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: safeMessage
        })
        sendResponse({ error: safeMessage })
      })
    return true
  }

  if (message.type === 'GET_ASSET_MARKET_HISTORY') {
    if (
      typeof message.assetId !== 'string' ||
      !isAssetMarketHistoryRange(message.range) ||
      (message.action !== 'read' && message.action !== 'refresh')
    ) {
      sendResponse({ error: 'Invalid asset market history request' })
      return true
    }
    let supported: boolean
    const historyService = assetMarketHistoryService
    try {
      supported = historyService.supportsAsset(message.assetId)
    } catch {
      sendResponse({ error: 'Invalid asset market history request' })
      return true
    }
    if (!supported) {
      sendResponse({ status: 'unsupported' })
      return true
    }
    const operation =
      message.action === 'read'
        ? historyService.readCached(message.assetId, message.range)
        : historyService.refresh(message.assetId, message.range)
    void operation
      .then(result =>
        sendResponse({
          result,
          availableRanges: historyService.getAvailableRanges(message.assetId)
        })
      )
      .catch(error =>
        sendResponse(
          error instanceof UnsupportedAssetMarketHistoryError
            ? { status: 'unsupported' }
            : { error: 'Asset market history unavailable' }
        )
      )
    return true
  }

  if (message.type === 'GET_ADDITIONAL_RECEIVE_TARGETS') {
    void additionalReceiveTargetsCoordinator
      .readActive({
        keyDomainId: parseKeyDomainId(message.walletId),
        accountId: parseAccountId(message.accountId)
      })
      .then(result => sendResponse({ result }))
      .catch(error => {
        console.warn(
          '[Background] Receive targets request failed:',
          error instanceof Error ? error.name : 'UnknownError'
        )
        sendResponse({ error: 'Receive targets unavailable' })
      })
    return true
  }

  if (message.type === 'GET_ACCOUNT_NETWORKS') {
    void accountNetworksCoordinator
      .readCatalog()
      .then(result => sendResponse({ result }))
      .catch(error => {
        console.warn(
          '[Background] Account networks request failed:',
          error instanceof Error ? error.name : 'UnknownError'
        )
        sendResponse({ error: 'Account networks unavailable' })
      })
    return true
  }

  if (message.type === 'GET_BITCOIN_ADDRESS_BALANCES') {
    if (!bitcoinFeatureRuntimePolicy.newOperationsEnabled) {
      sendResponse({ error: createBitcoinWalletRuntimeError('unavailable') })
      return true
    }
    void bitcoinAddressBalancesCoordinator
      .readActive()
      .then(result => sendResponse({ result }))
      .catch(error => {
        console.warn(
          '[Background] Bitcoin address balances request failed:',
          error instanceof Error ? error.name : 'UnknownError'
        )
        sendResponse({ error: 'Bitcoin address balances unavailable' })
      })
    return true
  }

  if (message.type === 'SET_ACTIVE_BITCOIN_ADDRESS_TYPE') {
    if (!bitcoinFeatureRuntimePolicy.newOperationsEnabled) {
      sendResponse({ error: createBitcoinWalletRuntimeError('unavailable') })
      return true
    }
    void accountContextTransition
      .runActiveOperation(async () => {
        const result = await bitcoinAddressBalancesCoordinator.setActive({
          walletId: message.walletId,
          accountId: message.accountId,
          addressType: message.addressType
        })
        await bitcoinDAppHandler.notifyAccountsChanged()
        await multichainSessionDAppHandler?.notifyAllSessionsChanged()
        await chrome.runtime
          .sendMessage({
            type: 'PORTFOLIO_UPDATED',
            walletId: message.walletId,
            accountId: message.accountId
          })
          .catch(() => {})
        return result
      })
      .then(result => sendResponse({ result }))
      .catch(error => {
        console.warn(
          '[Background] Bitcoin account selection failed:',
          error instanceof Error ? error.name : 'UnknownError'
        )
        sendResponse({ error: 'Bitcoin account selection failed' })
      })
    return true
  }

  if (
    message.type === 'PREPARE_CONFIDENTIAL_FUNDING' ||
    message.type === 'CONFIRM_CONFIDENTIAL_FUNDING' ||
    message.type === 'GET_CONFIDENTIAL_FUNDING' ||
    message.type === 'CANCEL_CONFIDENTIAL_FUNDING'
  ) {
    if (!confidentialFundingCoordinator) {
      sendResponse({ error: 'Confidential funding is unavailable in this network' })
      return true
    }
    const operation =
      message.type === 'PREPARE_CONFIDENTIAL_FUNDING'
        ? confidentialFundingCoordinator.prepare(message.request)
        : message.type === 'CONFIRM_CONFIDENTIAL_FUNDING'
          ? confidentialFundingCoordinator.confirm(message.planId, message.payloadFingerprint)
          : message.type === 'GET_CONFIDENTIAL_FUNDING'
            ? confidentialFundingCoordinator.getPlan(message.planId)
            : confidentialFundingCoordinator.cancel(message.planId)
    void operation
      .then(result => sendResponse({ result }))
      .catch(error => {
        console.error('[Confidential Funding] Request failed', {
          operation: message.type,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage:
            error instanceof Error ? error.message : 'Confidential funding request failed'
        })
        sendResponse({
          error: error instanceof Error ? error.message : 'Confidential funding request failed'
        })
      })
    return true
  }

  if (
    message.type === 'PREPARE_EVM_TRANSFER' ||
    message.type === 'PREPARE_EVM_CONTRACT_CALL' ||
    message.type === 'GET_EVM_TOKEN_ALLOWANCE' ||
    message.type === 'PREPARE_EVM_CANCEL' ||
    message.type === 'GET_EVM_NONCE_RECOVERY' ||
    message.type === 'PREPARE_EVM_NONCE_RECOVERY' ||
    message.type === 'GET_PENDING_EVM_TRANSFER' ||
    message.type === 'APPROVE_EVM_TRANSFER' ||
    message.type === 'GET_KEYSTONE_EVM_SIGNING_REQUEST' ||
    message.type === 'SUBMIT_KEYSTONE_EVM_SIGNATURE' ||
    message.type === 'REJECT_EVM_TRANSFER' ||
    message.type === 'RESUME_EVM_TRANSFER'
  ) {
    if (!evmTransferRouter) {
      sendResponse({ error: createEvmWalletRuntimeError('unavailable') })
      return true
    }
    if (
      (message.type === 'GET_KEYSTONE_EVM_SIGNING_REQUEST' ||
        message.type === 'SUBMIT_KEYSTONE_EVM_SIGNATURE') &&
      !isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/evm-sign') &&
      !isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/ledger-sign')
    ) {
      sendResponse({ error: createEvmWalletRuntimeError('invalid-request') })
      return true
    }
    const debugRequestId =
      (message.type === 'PREPARE_EVM_TRANSFER' || message.type === 'PREPARE_EVM_CONTRACT_CALL') &&
      typeof message.debugRequestId === 'string'
        ? message.debugRequestId
        : undefined
    const operationStartedAt = performance.now()
    const operation =
      message.type === 'PREPARE_EVM_TRANSFER'
        ? evmTransferRouter.prepare(
            message.intent,
            message.nearIntentsBinding,
            message.feeSelection ?? message.feeTier,
            message.executionMode,
            message.rheaSwapBinding,
            debugRequestId
          )
        : message.type === 'PREPARE_EVM_CONTRACT_CALL'
          ? evmTransferRouter.prepareContractCall(
              message.intent,
              message.feeSelection ?? message.feeTier,
              message.rheaSwapBinding,
              message.executionMode,
              debugRequestId
            )
          : message.type === 'PREPARE_EVM_CANCEL'
            ? evmTransferRouter.prepareCancel(
                message.chainId,
                message.originalTransactionId,
                message.executionMode
              )
            : message.type === 'GET_EVM_TOKEN_ALLOWANCE'
              ? evmTransferRouter.getTokenAllowance(
                  message.chainId,
                  message.token,
                  message.spender,
                  message.expectedOwner,
                  message.executionMode
                )
              : message.type === 'GET_EVM_NONCE_RECOVERY'
                ? evmTransferRouter.getNonceRecovery(message.chainId, message.executionMode)
                : message.type === 'PREPARE_EVM_NONCE_RECOVERY'
                  ? evmTransferRouter.prepareNonceRecovery(
                      message.chainId,
                      message.executionMode,
                      message.feeSelection
                    )
                  : message.type === 'GET_PENDING_EVM_TRANSFER'
                    ? evmTransferRouter.getPendingApproval(message.transactionId)
                    : message.type === 'APPROVE_EVM_TRANSFER'
                      ? evmTransferRouter.approve(message.transactionId, message.payloadFingerprint)
                      : message.type === 'GET_KEYSTONE_EVM_SIGNING_REQUEST'
                        ? evmTransferRouter.getExternalSigningRequest(message.transactionId)
                        : message.type === 'SUBMIT_KEYSTONE_EVM_SIGNATURE'
                          ? evmTransferRouter.submitExternalSignature(
                              message.transactionId,
                              message.payloadFingerprint,
                              message.signatureCborBase64
                            )
                          : message.type === 'REJECT_EVM_TRANSFER'
                            ? evmTransferRouter.reject(message.transactionId)
                            : evmTransferRouter.resumeBroadcast(message.transactionId)
    void operation
      .then(result => {
        if (debugRequestId) {
          logDebugTiming(debugRequestId, 'background-evm-prepare', operationStartedAt)
        }
        if (
          ['APPROVE_EVM_TRANSFER', 'SUBMIT_KEYSTONE_EVM_SIGNATURE', 'RESUME_EVM_TRANSFER'].includes(
            message.type
          )
        ) {
          void chrome.alarms.create(EVM_TRANSACTION_MONITOR_ALARM, { when: Date.now() + 100 })
        }
        sendResponse({ result })
      })
      .catch(error => {
        logger.warn(
          `[EVM Transfer] ${message.type} failed (${error instanceof Error ? error.name : 'UnknownError'})`
        )
        console.error('[EVM Transfer] Request failed', {
          operation: message.type,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : 'EVM transfer request failed',
          ...(error instanceof EvmRpcError
            ? { rpcErrorCode: error.code, rpcCode: error.rpcCode, rpcMethod: error.rpcMethod }
            : error instanceof EvmTransactionError && error.rpcFailure
              ? {
                  rpcErrorCode: error.code,
                  rpcCode: error.rpcFailure.code,
                  rpcMethod: error.rpcFailure.method
                }
              : {})
        })
        sendResponse({ error: mapEvmWalletRuntimeError(error) })
      })
    return true
  }

  if (
    message.type === 'PREPARE_SOLANA_TRANSFER' ||
    message.type === 'GET_PENDING_SOLANA_TRANSFER' ||
    message.type === 'APPROVE_SOLANA_TRANSFER' ||
    message.type === 'REJECT_SOLANA_TRANSFER' ||
    message.type === 'RESUME_SOLANA_TRANSFER'
  ) {
    if (!solanaTransferController) {
      sendResponse({ error: createSolanaWalletRuntimeError('unavailable') })
      return true
    }
    const operation =
      message.type === 'PREPARE_SOLANA_TRANSFER'
        ? solanaTransferController.prepare(message.intent, message.nearIntentsBinding)
        : message.type === 'GET_PENDING_SOLANA_TRANSFER'
          ? solanaTransferController.getPendingApproval(message.transactionId)
          : message.type === 'APPROVE_SOLANA_TRANSFER'
            ? solanaTransferController.approve(message.transactionId, message.payloadFingerprint)
            : message.type === 'REJECT_SOLANA_TRANSFER'
              ? solanaTransferController.reject(message.transactionId)
              : solanaTransferController.resumeBroadcast(message.transactionId)
    void operation
      .then(result => {
        if (
          [
            'APPROVE_SOLANA_TRANSFER',
            'SUBMIT_KEYSTONE_SOLANA_SIGNATURE',
            'RESUME_SOLANA_TRANSFER'
          ].includes(message.type)
        ) {
          void chrome.alarms.create(SOLANA_TRANSACTION_MONITOR_ALARM, { when: Date.now() + 100 })
        }
        sendResponse({ result })
      })
      .catch(error => sendResponse({ error: mapSolanaWalletRuntimeError(error) }))
    return true
  }

  if (
    message.type === 'PREPARE_NEAR_TRANSFER' ||
    message.type === 'GET_PENDING_NEAR_TRANSFER' ||
    message.type === 'APPROVE_NEAR_TRANSFER' ||
    message.type === 'REJECT_NEAR_TRANSFER' ||
    message.type === 'RESUME_NEAR_TRANSFER'
  ) {
    if (!nearTransferController) {
      sendResponse({ error: createNearWalletRuntimeError('unavailable') })
      return true
    }
    const operation =
      message.type === 'PREPARE_NEAR_TRANSFER'
        ? nearTransferController.prepare(
            message.intent,
            message.nearIntentsBinding,
            message.nearLendingSupplyBinding
          )
        : message.type === 'GET_PENDING_NEAR_TRANSFER'
          ? nearTransferController.getPendingApproval(message.transactionId)
          : message.type === 'APPROVE_NEAR_TRANSFER'
            ? nearTransferController.approve(message.transactionId, message.payloadFingerprint)
            : message.type === 'REJECT_NEAR_TRANSFER'
              ? nearTransferController.reject(message.transactionId)
              : nearTransferController.resumeBroadcast(message.transactionId)
    void operation
      .then(result => {
        if (
          [
            'APPROVE_NEAR_TRANSFER',
            'SUBMIT_KEYSTONE_NEAR_SIGNATURE',
            'RESUME_NEAR_TRANSFER'
          ].includes(message.type)
        ) {
          void chrome.alarms.create(NEAR_TRANSACTION_MONITOR_ALARM, { when: Date.now() + 100 })
        }
        sendResponse({ result })
      })
      .catch(error => sendResponse({ error: mapNearWalletRuntimeError(error) }))
    return true
  }

  if (
    message.type === 'PREPARE_BITCOIN_TRANSFER' ||
    message.type === 'GET_PENDING_BITCOIN_TRANSFER' ||
    message.type === 'APPROVE_BITCOIN_TRANSFER' ||
    message.type === 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST' ||
    message.type === 'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE' ||
    message.type === 'REJECT_BITCOIN_TRANSFER' ||
    message.type === 'RESUME_BITCOIN_TRANSFER'
  ) {
    if (!bitcoinTransferController) {
      sendResponse({ error: createBitcoinWalletRuntimeError('unavailable') })
      return true
    }
    if (
      (message.type === 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST' ||
        message.type === 'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE') &&
      !isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/bitcoin-sign') &&
      !isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/ledger-sign')
    ) {
      sendResponse({ error: createBitcoinWalletRuntimeError('invalid-request') })
      return true
    }
    const operation =
      message.type === 'PREPARE_BITCOIN_TRANSFER'
        ? bitcoinTransferController.prepare(
            message.intent,
            message.nearIntentsBinding,
            message.feeTier,
            message.bitcoinAddressType,
            undefined,
            message.rheaSwapBinding
          )
        : message.type === 'GET_PENDING_BITCOIN_TRANSFER'
          ? bitcoinTransferController.getPendingApproval(message.transactionId)
          : message.type === 'APPROVE_BITCOIN_TRANSFER'
            ? bitcoinTransferController.approve(message.transactionId, message.payloadFingerprint)
            : message.type === 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST'
              ? bitcoinTransferController.getExternalSigningRequest(message.transactionId)
              : message.type === 'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE'
                ? bitcoinTransferController.submitExternalSignature(
                    message.transactionId,
                    message.payloadFingerprint,
                    message.signedPsbtBase64
                  )
                : message.type === 'REJECT_BITCOIN_TRANSFER'
                  ? bitcoinTransferController.reject(message.transactionId)
                  : bitcoinTransferController.resumeBroadcast(message.transactionId)
    void operation
      .then(result => {
        if (
          [
            'APPROVE_BITCOIN_TRANSFER',
            'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE',
            'RESUME_BITCOIN_TRANSFER'
          ].includes(message.type)
        ) {
          void chrome.alarms.create(BITCOIN_TRANSACTION_MONITOR_ALARM, { when: Date.now() + 100 })
        }
        sendResponse({ result })
      })
      .catch(error => {
        sendResponse({ error: mapBitcoinWalletRuntimeError(error) })
      })
    return true
  }

  if (message.type === 'CHANGE_WALLET_PASSWORD') {
    let credentialsChanged = false
    accountContextTransition
      .runActiveOperation(async () => {
        await rehydrateWalletStore()
        await credentialLifecycle.changePassword(message.currentPassword, message.newPassword, () =>
          backgroundZcashWalletRuntime.changePasswordAuthoritatively(
            message.currentPassword,
            message.newPassword
          )
        )
        credentialsChanged = true
        await performKeyringRuntimesResetAfterCredentialChange()
      })
      .then(() => {
        sendResponse({ success: true })
      })
      .catch(async error => {
        const requiresLock =
          credentialsChanged ||
          (await credentialLifecycle.passwordChangeFailureRequiresLock().catch(() => true))
        if (requiresLock && !credentialsChanged) {
          await accountContextTransition
            .runActiveOperation(performKeyringRuntimesResetAfterCredentialChange)
            .catch(() => {})
        }
        sendResponse({
          error: error instanceof Error ? error.message : 'Password change failed',
          requiresLock
        })
      })
    return true
  }

  if (message.type === 'GET_CONNECTED_DAPPS') {
    dappHandler
      .getAllConnectedDApps()
      .then(dapps => sendResponse({ dapps }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'GET_CURRENT_TAB_DAPP') {
    walletDAppConnection
      .getCurrentTabDAppStatus()
      .then(status => sendResponse(status))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'GET_DAPP_EXECUTION_MODE') {
    accountContextTransition
      .runActiveOperation(async () => {
        await rehydrateWalletStore()
        return dappExecutionModeCoordinator.read(await requireActiveDAppExecutionModeScope())
      })
      .then(state => sendResponse({ success: true, state }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Unable to read dApp execution mode'
        })
      )
    return true
  }

  if (message.type === 'SET_DAPP_EXECUTION_MODE') {
    accountContextTransition
      .runActiveOperation(async () => {
        await rehydrateWalletStore()
        const scope = await requireActiveDAppExecutionModeScope()
        return dappExecutionModeTransitionCoordinator.set(
          scope,
          message.mode as DAppExecutionMode,
          {
            ...(message.confirmPrivateSetup === true ? { confirmPrivateSetup: true } : {}),
            ...(message.confirmAffectedOperations === true
              ? { confirmAffectedOperations: true }
              : {})
          }
        )
      })
      .then(state => sendResponse({ success: true, state }))
      .catch(error => {
        if (error instanceof DAppExecutionModeConfirmationRequiredError) {
          sendResponse({ error: error.message, code: error.code, impact: error.impact })
          return
        }
        sendResponse({
          error: error instanceof Error ? error.message : 'Unable to change dApp execution mode'
        })
      })
    return true
  }

  if (message.type === 'CONNECT_CURRENT_ACCOUNT_TO_DAPP') {
    Promise.resolve()
      .then(async () => {
        if (!(await betaInviteActivation.isActivated()))
          throw new Error(BETA_INVITE_REQUIRED_MESSAGE)
        return walletDAppConnection.connectCurrentAccount(message.origin)
      })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'DISCONNECT_DAPP') {
    accountContextTransition
      .runActiveOperation(() => dappHandler.revokeAllPermissions(message.origin))
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'WALLET_CREATED') {
    handleWalletCreated(message.password)
      .then(credentials => sendResponse({ success: true, credentialStatus: credentials.status }))
      .catch(error => {
        console.warn('[Background] Wallet credential provisioning failed:', error)
        sendResponse({
          error: error instanceof Error ? error.message : 'Wallet credential provisioning failed'
        })
      })
    return true
  }

  if (message.type === 'GENERATE_ADD_WALLET_MNEMONIC') {
    enqueueWalletSessionTransition(() =>
      generateAddWalletMnemonic(message.wordCount as MnemonicWordCount)
    )
      .then(mnemonic => sendResponse({ success: true, mnemonic }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Recovery phrase generation failed'
        })
      )
    return true
  }

  if (message.type === 'GENERATE_PRIMARY_WALLET_MNEMONIC') {
    enqueueWalletSessionTransition(() =>
      generatePrimaryWalletMnemonic(
        message.wordCount as MnemonicWordCount,
        message.password as string
      )
    )
      .then(mnemonic => sendResponse({ success: true, mnemonic }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Recovery phrase generation failed'
        })
      )
    return true
  }

  if (message.type === 'PROVISION_PRIMARY_SOFTWARE_WALLET') {
    enqueueWalletSessionTransition(() =>
      accountContextTransition.runActiveOperation(() =>
        provisionPrimarySoftwareWallet(
          {
            mnemonic: message.mnemonic as string,
            password: message.password as string,
            accountName: message.accountName as string,
            ...(message.birthdayHeight === undefined
              ? {}
              : { birthdayHeight: message.birthdayHeight as number })
          },
          synchronizeCurrentSoftwareWalletNetworkMetadata
        )
      )
    )
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => {
        console.warn(
          '[Background] Primary software Wallet provisioning failed:',
          error instanceof Error ? error.message : 'UnknownError'
        )
        sendResponse({ error: error instanceof Error ? error.message : 'Wallet setup failed' })
      })
    return true
  }

  if (message.type === 'ADD_SOFTWARE_WALLET') {
    enqueueWalletSessionTransition(() =>
      accountContextTransition.runActiveOperation(() =>
        addSoftwareWallet(
          {
            mode: message.mode as SoftwareWalletProvisioningMode,
            mnemonic: message.mnemonic as string,
            accountName: message.accountName as string,
            ...(message.birthdayHeight === undefined
              ? {}
              : { birthdayHeight: message.birthdayHeight as number })
          },
          synchronizeCurrentSoftwareWalletNetworkMetadata
        )
      )
    )
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Wallet setup failed'
        })
      )
    return true
  }

  if (message.type === 'PREVIEW_PRIVATE_KEY_WALLET') {
    let chainFamily: EnabledPrivateKeyChainFamily
    try {
      chainFamily = resolveEnabledPrivateKeyChainFamily(message.chainFamily)
    } catch (error) {
      sendResponse({
        error: error instanceof Error ? error.message : 'Private-key chain is disabled'
      })
      return true
    }
    previewPrivateKeyWallet({
      privateKey: message.privateKey as string,
      chainFamily
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Private-key preview failed'
        })
      )
    return true
  }

  if (message.type === 'IMPORT_PRIVATE_KEY_WALLET') {
    let chainFamily: EnabledPrivateKeyChainFamily
    try {
      chainFamily = resolveEnabledPrivateKeyChainFamily(message.chainFamily)
    } catch (error) {
      sendResponse({
        error: error instanceof Error ? error.message : 'Private-key chain is disabled'
      })
      return true
    }
    enqueueWalletSessionTransition(() =>
      accountContextTransition.runActiveOperation(() =>
        handleImportPrivateKeyWallet({
          privateKey: message.privateKey as string,
          chainFamily,
          displayName: message.displayName as string
        })
      )
    )
      .then(result => sendResponse({ success: true, result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Private-key Wallet import failed'
        })
      )
    return true
  }

  if (message.type === 'EXPORT_PRIVATE_KEY') {
    let chainId: string
    try {
      chainId = resolveEnabledPrivateKeyExportChainId(message.chainId)
    } catch (error) {
      sendResponse({
        error: error instanceof Error ? error.message : 'Private-key chain is disabled'
      })
      return true
    }
    exportPrivateKey({
      walletId: message.walletId as string,
      accountId: message.accountId as string,
      chainId,
      password: message.password as string,
      ...(message.bitcoinAddressType === undefined
        ? {}
        : {
            bitcoinAddressType: message.bitcoinAddressType as
              | 'p2pkh'
              | 'p2sh-p2wpkh'
              | 'p2wpkh'
              | 'p2tr'
          })
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Private-key export failed'
        })
      )
    return true
  }

  if (message.type === 'RESYNC_ZCASH_WALLET') {
    enqueueWalletSessionTransition(() =>
      accountContextTransition.runActiveOperation(() =>
        handleResyncZcashWallet(
          message.walletId as string,
          message.accountId as string,
          message.birthdayHeight as number
        )
      )
    )
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Zcash resync failed'
        })
      )
    return true
  }

  if (message.type === 'GET_ZCASH_SEED_PHRASE') {
    void rehydrateWalletStore()
      .then(() => backgroundZcashWalletRuntime.getSeedPhrase(message.password, message.walletId))
      .then(seedPhrase => sendResponse({ success: true, seedPhrase }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Failed to retrieve seed phrase'
        })
      )
    return true
  }

  if (message.type === 'GET_ZCASH_BLOCK_BY_TIME') {
    backgroundZcashWalletRuntime
      .getBlockByTime(message.timestamp)
      .then(height => sendResponse({ success: true, height }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Unable to resolve Zcash block height'
        })
      )
    return true
  }

  if (message.type === 'GET_ZCASH_BLOCK_TIME') {
    backgroundZcashWalletRuntime
      .getBlockTime(message.height)
      .then(timestamp => sendResponse({ success: true, timestamp }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Unable to resolve Zcash block time'
        })
      )
    return true
  }

  if (message.type === 'RESOLVE_ZCASH_BIRTHDAY_HEIGHT') {
    accountContextTransition
      .runActiveOperation(async () => {
        await rehydrateWalletStore()
        await backgroundZcashWalletRuntime.initialize()
        if (backgroundZcashWalletRuntime.isLocked())
          await restoreBackgroundZcashRuntimeFromSession()
        return backgroundZcashWalletRuntime.resolveBirthdayHeight(
          message.walletId,
          message.accountId
        )
      })
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Unable to resolve wallet birthday height'
        })
      )
    return true
  }

  if (
    message.type === 'ESTIMATE_ZCASH_TRANSFER_FEE' ||
    message.type === 'ESTIMATE_ZCASH_MAX_TRANSFER' ||
    message.type === 'ESTIMATE_ZCASH_SHIELD_FEE'
  ) {
    const activeWalletId = useWalletStore.getState().currentWalletId || undefined
    const debugRequestId =
      typeof message.debugRequestId === 'string' ? message.debugRequestId : undefined
    const measure = <T>(stage: string, operation: () => Promise<T>): Promise<T> =>
      debugRequestId ? traceDebugStage(debugRequestId, stage, operation) : operation()
    measure('background-account-transition', () =>
      accountContextTransition.runActiveOperation(() =>
        withTxSyncPause(activeWalletId, async () => {
          await measure('background-prepare-wallet-core', prepareWalletCoreForTx)
          if (message.type === 'ESTIMATE_ZCASH_SHIELD_FEE') {
            const feeZats = await measure('background-estimate-shield-fee', () =>
              backgroundZcashWalletRuntime.estimateShieldFee(message.marginalFeeZats)
            )
            return { feeZats }
          }
          if (message.type === 'ESTIMATE_ZCASH_MAX_TRANSFER') {
            return measure('background-estimate-maximum', () =>
              backgroundZcashWalletRuntime.estimateMaxTransfer(
                message.to,
                message.memo,
                message.marginalFeeZats,
                message.fundingSource,
                debugRequestId
              )
            )
          }
          const feeZats = await measure('background-estimate-fee', () =>
            backgroundZcashWalletRuntime.estimateTransferFee(
              message.to,
              message.amount,
              message.memo,
              message.marginalFeeZats,
              message.fundingSource,
              debugRequestId
            )
          )
          return { feeZats }
        })
      )
    )
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Unable to estimate Zcash transfer'
        })
      )
    return true
  }

  if (message.type === 'WAIT_FOR_ZCASH_ACCOUNT_READY') {
    accountContextTransition
      .runActiveOperation(async () => {
        await rehydrateWalletStore()
        await backgroundZcashWalletRuntime.initialize()
        if (
          backgroundZcashWalletRuntime.isLocked() &&
          !(await restoreBackgroundZcashRuntimeFromSession())
        ) {
          throw new Error('Wallet is locked. Please unlock and try again.')
        }
        await backgroundZcashWalletRuntime.waitForAccountReady(message.timeoutMs)
      })
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Zcash account initialization failed'
        })
      )
    return true
  }

  if (message.type === 'ROTATE_ZCASH_SHIELDED_ADDRESS') {
    accountContextTransition
      .runActiveOperation(async () => {
        await assertActiveBackgroundAccountScope(message.walletId, message.accountId)
        return withTxSyncPause(message.walletId, async () => {
          await prepareWalletCoreForTx(message.walletId, message.accountId)
          const addresses = await backgroundZcashWalletRuntime.rotateShieldedReceiveAddress(
            message.walletId,
            message.accountId
          )
          await dappHandler.notifyAccountAddressesChanged({
            walletId: message.walletId,
            accountId: message.accountId,
            accounts: {
              transparent: addresses.transparent,
              shielded: addresses.shielded
            }
          })
          return addresses
        })
      })
      .then(addresses => sendResponse({ success: true, addresses }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error ? error.message : 'Unable to rotate shielded receive address'
        })
      )
    return true
  }

  if (message.type === 'SET_ZCASH_SHIELDED_ADDRESS') {
    accountContextTransition
      .runActiveOperation(async () => {
        await assertActiveBackgroundAccountScope(message.walletId, message.accountId)
        if (!(await credentialSession.hasUnlockSession())) {
          throw new Error('Wallet is locked. Please unlock and try again.')
        }
        const addresses = await backgroundZcashWalletRuntime.setShieldedReceiveAddress(
          message.walletId,
          message.accountId,
          message.shielded
        )
        await dappHandler.notifyAccountAddressesChanged({
          walletId: message.walletId,
          accountId: message.accountId,
          accounts: { transparent: addresses.transparent, shielded: addresses.shielded }
        })
        return addresses
      })
      .then(addresses => sendResponse({ success: true, addresses }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error ? error.message : 'Unable to select shielded receive address'
        })
      )
    return true
  }

  if (message.type === 'PROVISION_KEYSTONE_HARDWARE') {
    enqueueWalletSessionTransition(() =>
      accountContextTransition.runActiveOperation(() =>
        provisionKeystoneHardware({
          credential: message.credential,
          displayName: message.displayName,
          ...(message.password === undefined ? {} : { password: message.password }),
          ...(message.birthdayHeight === undefined
            ? {}
            : { birthdayHeight: message.birthdayHeight })
        })
      )
    )
      .then(result => sendResponse({ success: true, result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Hardware Wallet setup failed'
        })
      )
    return true
  }

  if (message.type === 'PROVISION_LEDGER_HARDWARE') {
    if (!isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/ledger-connect')) {
      sendResponse({ error: 'Unauthorized Ledger setup sender' })
      return true
    }
    enqueueWalletSessionTransition(() =>
      accountContextTransition.runActiveOperation(() =>
        provisionLedgerHardware({
          credential: message.credential,
          displayName: message.displayName,
          ...(message.password === undefined ? {} : { password: message.password }),
          ...(message.existingKeyDomainId === undefined
            ? {}
            : { existingKeyDomainId: message.existingKeyDomainId }),
          ...(message.anchorProof === undefined ? {} : { anchorProof: message.anchorProof }),
          ...(message.birthdayHeight === undefined
            ? {}
            : { birthdayHeight: message.birthdayHeight })
        })
      )
    )
      .then(result => sendResponse({ success: true, result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Ledger setup failed'
        })
      )
    return true
  }

  if (message.type === 'INSPECT_NEXT_ZCASH_ACCOUNT_HISTORY') {
    handleInspectNextZcashAccountHistory(message.walletId)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Unable to inspect Zcash account history'
        })
      )
    return true
  }

  if (message.type === 'ADD_ACCOUNT') {
    accountContextTransition
      .runActiveOperation(() =>
        handleAddWalletAccount(message.walletId, message.accountName, {
          ...(message.birthdayHeight === undefined
            ? {}
            : { birthdayHeight: message.birthdayHeight }),
          ...(message.expectedDerivationIndex === undefined
            ? {}
            : { expectedDerivationIndex: message.expectedDerivationIndex })
        })
      )
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Account setup failed'
        })
      )
    return true
  }

  if (message.type === 'SWITCH_ACCOUNT') {
    handleSwitchWalletAccount(message.walletId, message.accountId)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Account switch failed'
        })
      )
    return true
  }

  if (message.type === 'REMOVE_ACCOUNT') {
    walletCleanupCoordinator
      .removeAccount(message.walletId, message.accountId, message.verification)
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Account cleanup failed'
        })
      )
    return true
  }

  if (message.type === 'RENAME_ACCOUNT') {
    walletCleanupCoordinator
      .renameAccount(message.walletId, message.accountId, message.displayName)
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Account rename failed'
        })
      )
    return true
  }

  if (message.type === 'SET_ACCOUNT_PINNED') {
    walletCleanupCoordinator
      .setAccountPinned(message.walletId, message.accountId, message.pinned)
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Account preference update failed'
        })
      )
    return true
  }

  if (message.type === 'SET_ACCOUNT_HIDDEN') {
    walletCleanupCoordinator
      .setAccountHidden(message.walletId, message.accountId, message.hidden)
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Account preference update failed'
        })
      )
    return true
  }

  if (message.type === 'RENAME_WALLET') {
    walletCleanupCoordinator
      .renameNativeWallet(message.walletId, message.displayName)
      .then(result => sendResponse({ success: true, result }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Wallet rename failed'
        })
      )
    return true
  }

  if (message.type === 'REMOVE_WALLET') {
    walletCleanupCoordinator
      .removeWallet(message.walletId, message.verification)
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Wallet cleanup failed'
        })
      )
    return true
  }

  if (message.type === 'GET_WALLET_BACKUP_WORD_INDICES') {
    void backgroundZcashWalletRuntime
      .getWalletBackupWordIndices(message.walletId)
      .then(wordIndices => sendResponse({ success: true, wordIndices }))
      .catch(error =>
        sendResponse({ error: error instanceof Error ? error.message : 'Unable to verify backup' })
      )
    return true
  }

  if (message.type === 'CONFIRM_WALLET_BACKUP') {
    void backgroundZcashWalletRuntime
      .confirmWalletBackup(message.walletId, message.verification)
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({ error: error instanceof Error ? error.message : 'Unable to verify backup' })
      )
    return true
  }

  if (message.type === 'RESET_WALLET_DATA') {
    walletCleanupCoordinator
      .reset()
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({
          error: error instanceof Error ? error.message : 'Wallet reset failed'
        })
      )
    return true
  }

  if (message.type === 'WALLET_LOCKED') {
    handleWalletLock()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'ACCOUNT_SWITCHED') {
    if (message.walletId && message.accountId) {
      pendingRequestsManager.cancelExceptContext(message.walletId, message.accountId)
    } else {
      pendingRequestsManager.cancelAll()
    }
    Promise.resolve()
      .then(async () => {
        if (!message.walletId || !message.accountId) return
        await accountContextTransition.invalidateExcept({
          walletId: message.walletId,
          accountId: message.accountId
        })
        await switchActiveAccountPersistently(message.walletId, message.accountId)
        if (!backgroundZcashWalletRuntime.isLocked()) {
          await backgroundZcashWalletRuntime.ensureWalletCoreAccount(
            message.walletId,
            message.accountId
          )
        }
        syncScheduler.onAccountSwitched(message.walletId)
      })
      .then(() => handleAccountSwitched())
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'RPC_ENDPOINT_CHANGED') {
    waitForHydration()
      .then(() =>
        accountContextTransition.runActiveOperation(() =>
          backgroundZcashWalletRuntime.applyRpcEndpointChange(message.preferences)
        )
      )
      .then(() => {
        syncScheduler.onRequestSync()
        sendResponse({ success: true })
      })
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'GET_PENDING_REQUEST') {
    getApprovalContext(message.requestId)
      .then(request => sendResponse({ request }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'ESTIMATE_APPROVAL_FEE') {
    if (!isOwnExtensionRouteSender(sender, chrome.runtime.id, '/approval')) {
      sendResponse({ error: 'Unauthorized approval fee request' })
      return true
    }
    estimateApprovalFee(message.requestId)
      .then(fee => sendResponse({ fee }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'GET_SYNC_STATE') {
    const { currentWalletId, currentAccountId } = useWalletStore.getState()
    const wid = message.walletId || currentWalletId
    const aid = message.accountId || currentAccountId
    sendResponse(syncScheduler.getSyncState(wid, aid))
    return true
  }

  if (message.type === 'ABORT_SYNC') {
    syncScheduler.abortSync(message.walletId)
    sendResponse({ success: true })
    return true
  }

  if (message.type === 'BACKGROUND_SYNC') {
    rehydrateWalletStore()
      .catch(() => {})
      .then(() => syncScheduler.onRequestSync())
      .catch(console.warn)
    sendResponse({ success: true })
    return true
  }

  if (message.type === 'BACKGROUND_ZCASH_TX') {
    // Execute Zcash on-chain tx in background - survives popup close
    accountContextTransition
      .runActiveOperation(() => handleBackgroundZcashTx(message))
      .catch(console.warn)
    sendResponse({ success: true })
    return true
  }

  if (message.type === 'HW_PCZT_BUILD') {
    if (!isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/sign')) {
      sendResponse({ success: false, error: 'Unauthorized hardware signing sender' })
      return true
    }
    // Build the hardware PCZT in the background so sync is paused and the
    // account is restored before building (avoids "Account not initialized").
    accountContextTransition
      .runActiveOperation(async () => {
        const request = await readHardwareSignRequest(message.requestId)
        if (
          !request ||
          !isHardwareSignRequestFresh(request) ||
          request.kind !== message.kind ||
          request.walletId !== message.walletId ||
          request.accountId !== message.accountId ||
          request.to !== message.to ||
          request.amount !== message.amount ||
          request.maxTransfer !== message.maxTransfer ||
          request.memo !== message.memo ||
          request.fundingSource !== message.fundingSource ||
          request.marginalFeeZats !== message.marginalFeeZats
        ) {
          throw new Error('Hardware signing request expired or does not match this transaction.')
        }
        await clearPreparedHardwareSignRequest(message.requestId)
        const built = await handleHardwarePcztBuild(message)
        if (!built.success) return built
        await writePreparedHardwareSignRequest(message.requestId, {
          request,
          fullPcztBase64: built.full,
          vendor: built.vendor,
          ...(built.vendor === 'ledger' ? { redactedPcztBase64: built.redacted } : {})
        })
        return {
          success: true as const,
          redacted: built.redacted,
          feeZats: built.feeZats,
          amount: built.amount,
          vendor: built.vendor,
          ...(built.ledgerDisplayAddress === undefined
            ? {}
            : { ledgerDisplayAddress: built.ledgerDisplayAddress }),
          ...(built.vendor === 'ledger' ? { ledgerPayload: built.ledgerPayload } : {}),
          ...(built.ledgerDeviceModel === undefined
            ? {}
            : { ledgerDeviceModel: built.ledgerDeviceModel }),
          ...(built.ledgerSigningTransport === undefined
            ? {}
            : { ledgerSigningTransport: built.ledgerSigningTransport })
        }
      })
      .then(sendResponse)
      .catch(err =>
        sendResponse({ success: false, error: err?.message || 'Failed to build transaction' })
      )
    return true
  }

  if (message.type === 'SUBMIT_HARDWARE_PCZT') {
    if (!isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/sign')) {
      sendResponse({ success: false, error: 'Unauthorized hardware signing sender' })
      return true
    }
    let consumed = false
    accountContextTransition
      .runActiveOperation(async () => {
        const prepared = await consumePreparedHardwareSignRequest(message.requestId)
        if (!prepared) {
          throw new Error('Hardware signing request expired or does not match this transaction.')
        }
        const { request } = prepared
        consumed = true
        if ((prepared.vendor ?? 'keystone') !== 'keystone') {
          throw new Error('This request requires Ledger signing')
        }
        if (!isHardwareSignRequestFresh(request)) {
          throw new Error('Hardware signing request expired.')
        }
        await assertActiveBackgroundAccountScope(request.walletId, request.accountId)
        if (request.dappRequestId) {
          if (request.kind !== 'send' || !request.origin) {
            throw new Error('Invalid dApp hardware signing request.')
          }
          const snapshot = await dappHandler.getAuthorizedActiveAccountSnapshot(request.origin)
          if (!snapshot) {
            throw new Error('This site is no longer authorized. Review the request again.')
          }
        }
        return withTxSyncPause(request.walletId, async () => {
          await ensurePendingHardwareTransactionRecord(
            request.walletId,
            request.accountId,
            message.transactionId
          )
          const walletCore = await prepareWalletCoreForTx(request.walletId, request.accountId)
          try {
            const deadline = await readRheaZcashTransferDeadline(
              request.quoteBinding,
              request.to,
              request.amount
            )
            return await walletCore.pcztProveSend(
              prepared.fullPcztBase64,
              message.signedPcztBase64,
              deadline
            )
          } catch (error) {
            if (isTransactionSubmissionUnknown(error)) {
              await recordUncertainBroadcast(
                buildAccountKey(DEFAULT_NETWORK, request.walletId, request.accountId),
                message.transactionId as string,
                error.txId
              ).catch(() => logger.error('Uncertain hardware broadcast could not be recorded'))
            }
            throw error
          }
        })
      })
      .then(txHash => sendResponse({ success: true, txHash }))
      .catch(error =>
        sendResponse({
          success: false,
          error:
            error instanceof TimeoutError || isTransactionSubmissionUnknown(error)
              ? TRANSACTION_PENDING_MESSAGE
              : error instanceof Error
                ? error.message
                : 'Hardware transaction failed',
          completionPending: error instanceof TimeoutError || isTransactionSubmissionUnknown(error),
          retryable: !consumed
        })
      )
    return true
  }

  if (message.type === 'SUBMIT_LEDGER_SIGNATURES') {
    if (!isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/sign')) {
      sendResponse({ success: false, error: 'Unauthorized hardware signing sender' })
      return true
    }
    let consumed = false
    accountContextTransition
      .runActiveOperation(async () => {
        const prepared = await consumePreparedHardwareSignRequest(message.requestId)
        if (!prepared || prepared.vendor !== 'ledger' || !prepared.redactedPcztBase64) {
          throw new Error('Ledger signing request expired or does not match this transaction.')
        }
        consumed = true
        const { request, redactedPcztBase64 } = prepared
        if (!isHardwareSignRequestFresh(request)) throw new Error('Ledger signing request expired.')
        await assertActiveBackgroundAccountScope(request.walletId, request.accountId)
        const wallet = useWalletStore.getState().getWallet(request.walletId)
        const account = wallet?.accounts.find(item => item.id === request.accountId)
        if (wallet?.keySource !== 'ledger' || !account) {
          throw new Error('Ledger account is no longer active')
        }
        if (request.dappRequestId) {
          if (request.kind !== 'send' || !request.origin) {
            throw new Error('Invalid dApp hardware signing request.')
          }
          const snapshot = await dappHandler.getAuthorizedActiveAccountSnapshot(request.origin)
          if (!snapshot) {
            throw new Error('This site is no longer authorized. Review the request again.')
          }
        }
        const signatures = parseLedgerPcztSignatures(message.signatures)
        return withTxSyncPause(request.walletId, async () => {
          await ensurePendingHardwareTransactionRecord(
            request.walletId,
            request.accountId,
            message.transactionId
          )
          const walletCore = await prepareWalletCoreForTx(request.walletId, request.accountId)
          const signed = await walletCore.pcztApplyLedgerSignatures(
            redactedPcztBase64,
            account.derivationIndex,
            signatures
          )
          try {
            const deadline = await readRheaZcashTransferDeadline(
              request.quoteBinding,
              request.to,
              request.amount
            )
            return await walletCore.pcztProveSend(prepared.fullPcztBase64, signed, deadline)
          } catch (error) {
            if (isTransactionSubmissionUnknown(error)) {
              await recordUncertainBroadcast(
                buildAccountKey(DEFAULT_NETWORK, request.walletId, request.accountId),
                message.transactionId as string,
                error.txId
              ).catch(() => logger.error('Uncertain hardware broadcast could not be recorded'))
            }
            throw error
          }
        })
      })
      .then(txHash => sendResponse({ success: true, txHash }))
      .catch(error =>
        sendResponse({
          success: false,
          error:
            error instanceof TimeoutError || isTransactionSubmissionUnknown(error)
              ? TRANSACTION_PENDING_MESSAGE
              : error instanceof Error
                ? error.message
                : 'Ledger transaction failed',
          completionPending: error instanceof TimeoutError || isTransactionSubmissionUnknown(error),
          retryable: !consumed
        })
      )
    return true
  }

  if (message.type === 'START_TRANSACTION_MONITOR') {
    transactionMonitor
      .addTransaction(message.swap)
      .then(() => sendResponse({ success: true }))
      .catch(err =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to start transaction monitor'
        })
      )
    return true
  }

  if (message.type === 'START_RHEA_SWAP_MONITOR') {
    if (!rheaSwapTransactionMonitor) {
      sendResponse({ success: false, error: 'RHEA Swap monitor is unavailable' })
      return true
    }
    rheaSwapTransactionMonitor
      .add(message.transaction)
      .then(() => sendResponse({ success: true }))
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to start RHEA Swap monitor'
        })
      )
    return true
  }

  if (message.type === 'REGISTER_INTENTS_PROGRESS') {
    transactionMonitor
      .addTransaction(message.progress)
      .then(() => sendResponse({ success: true }))
      .catch(err =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save Intents progress'
        })
      )
    return true
  }

  if (message.type === 'GET_INTENTS_PROGRESS') {
    transactionMonitor
      .getProgress(message.accountKey)
      .then(progress => sendResponse({ success: true, progress }))
      .catch(err =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to load Intents progress'
        })
      )
    return true
  }

  if (message.type === 'STOP_TRANSACTION_MONITOR' && message.depositAddress) {
    transactionMonitor
      .removeTransaction(message.depositAddress)
      .then(() => sendResponse({ success: true }))
      .catch(err =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to stop transaction monitor'
        })
      )
    return true
  }

  if (message.type === 'START_ZCASH_TX_MONITOR' && message.tx) {
    zcashTxMonitor.addTransaction(message.tx).catch(console.warn)
    sendResponse({ success: true })
    return true
  }

  if (message.type === 'RECHECK_PENDING_TRANSACTIONS') {
    const { currentNetwork, currentWalletId, currentAccountId, wallets } = useWalletStore.getState()
    const currentWallet = wallets.find(wallet => wallet.id === currentWalletId)
    const currentAccountKey =
      currentWalletId && currentAccountId
        ? buildAccountKey(currentNetwork, currentWalletId, currentAccountId)
        : null
    const accountScope: AccountScope | null =
      currentWalletId &&
      currentAccountId &&
      message.accountKey === currentAccountKey &&
      currentAccountKey &&
      currentWallet?.accounts.some(account => account.id === currentAccountId)
        ? { accountKey: currentAccountKey, walletId: currentWalletId, accountId: currentAccountId }
        : null
    void Promise.allSettled([
      transactionMonitor.recheckNow(),
      accountScope
        ? zcashTxMonitor
            .restoreStuckWithdrawals([accountScope])
            .then(() => zcashTxMonitor.recheckNow())
        : zcashTxMonitor.recheckNow(),
      Promise.all([
        rheaSwapEvmSignatureCoordinator?.recoverSigned() ?? Promise.resolve(0),
        rheaSwapSolanaCoordinator?.recoverSigned() ?? Promise.resolve(0),
        rheaSwapNearCoordinator?.recoverSigned() ?? Promise.resolve(0)
      ]).then(() => rheaSwapTransactionMonitor?.recheckNow() ?? false)
    ]).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn('[Transaction Monitor] Foreground recheck failed:', result.reason)
        }
      }
      const rheaResult = results[2]
      sendResponse({
        success: results.every(result => result.status === 'fulfilled'),
        rheaPending: rheaResult.status === 'fulfilled' ? rheaResult.value : true
      })
    })
    return true
  }

  if (message.type === 'RECHECK_FAST_PENDING_TRANSACTIONS') {
    const evmOnly = message.family === 'evm'
    const monitors = evmOnly
      ? [evmTransactionMonitor?.handleAlarm() ?? Promise.resolve(null)]
      : [
          evmTransactionMonitor?.handleAlarm() ?? Promise.resolve(null),
          solanaTransactionMonitor?.handleAlarm() ?? Promise.resolve(null),
          nearTransactionMonitor?.handleAlarm() ?? Promise.resolve(null),
          nearIntentsTransactionMonitor?.handleAlarm() ?? Promise.resolve(null)
        ]
    void Promise.allSettled(monitors).then(async results => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn('[Transaction Monitor] Fast foreground recheck failed:', result.reason)
        }
      }

      const applied = results.some(result => {
        if (result.status !== 'fulfilled' || result.value === null) return false
        const value: unknown = result.value
        return (
          typeof value === 'object' &&
          value !== null &&
          typeof Reflect.get(value, 'applied') === 'number' &&
          Reflect.get(value, 'applied') > 0
        )
      })
      if (applied && portfolioCoordinator) {
        try {
          const cached = await portfolioCoordinator.readCachedActive()
          const fastChainIds = cached
            ? cached.chains.flatMap(chain =>
                chain.chain.family === 'evm' ||
                (!evmOnly && (chain.chain.family === 'solana' || chain.chain.family === 'near'))
                  ? [chain.chain.id]
                  : []
              )
            : undefined
          const refreshed = await portfolioCoordinator.refreshActive(fastChainIds)
          if (refreshed) {
            await chrome.runtime
              .sendMessage({
                type: 'PORTFOLIO_UPDATED',
                walletId: refreshed.scope.keyDomainId,
                accountId: refreshed.scope.accountId
              })
              .catch(() => {})
          }
        } catch (error) {
          console.warn('[Portfolio] Fast transaction refresh failed:', error)
        }
      }

      sendResponse({ success: results.every(result => result.status === 'fulfilled') })
    })
    return true
  }

  if (message.type === 'GET_TRANSACTION_HISTORY') {
    backgroundZcashWalletRuntime
      .getTransactionHistory(message.walletId, message.accountId)
      .then(history => sendResponse(history))
      .catch(() => sendResponse([]))
    return true
  }

  if (message.type === 'ADD_TRANSACTION') {
    const { accountKey, transaction } = message
    transactionRecorder
      .addTransaction({ accountKey, transaction })
      .then(tx => sendResponse({ success: true, transaction: tx }))
      .catch(err => sendResponse({ success: false, error: err.message }))
    return true
  }

  if (message.type === 'UPDATE_TRANSACTION') {
    const { accountKey, transactionId, updates } = message
    transactionRecorder
      .updateTransaction(accountKey, transactionId, updates, {
        onlyIfUnsubmitted: updates.status === 'failed'
      })
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }))
    return true
  }

  return false
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Selecting another wallet must not wait for Noir's wallet or WASM initialization.
  if (isRuntimeRecord(message) && handleEvmWalletChoiceMessage(message, sender, sendResponse)) {
    return true
  }
  if (isRuntimeRecord(message) && message.type === 'GET_WALLET_SESSION_STATE') {
    return handleRuntimeMessage(message, sender, sendResponse)
  }
  if (isRuntimeNetworkInitialized() && multichainRuntimeKey !== '') {
    return handleRuntimeMessage(message, sender, sendResponse)
  }
  void Promise.all([backgroundNetworkServicesReady, multichainRuntimeReady])
    .then(() => {
      handleRuntimeMessage(message, sender, sendResponse)
    })
    .catch(error => {
      console.warn('[Background] Runtime message rejected during initialization:', error)
      sendResponse({ error: 'Wallet network initialization failed' })
    })
  return true
})

/**
 * Ensures dappHandler is initialized and ready
 * Safe to call multiple times (idempotent)
 */
async function ensureDAppHandlerReady(): Promise<void> {
  // Initialize if not already done (idempotent)
  await dappHandler.initialize()

  // If wallet is locked, clear permission cache and don't restore
  if (backgroundZcashWalletRuntime.isLocked()) {
    dappHandler.clearPermissions()
    return
  }

  // Restore permissions if not already done
  if (!backgroundZcashWalletRuntime.isLocked()) {
    await dappHandler.restorePermissionsFromStorage()
  }
}

let backgroundSessionRestore: Promise<boolean> | null = null

function restoreBackgroundZcashRuntimeFromSession(): Promise<boolean> {
  if (!backgroundZcashWalletRuntime.isLocked()) return Promise.resolve(true)
  if (backgroundSessionRestore) return backgroundSessionRestore
  backgroundSessionRestore = (async () => {
    await rehydrateWalletStore()
    const { currentWalletId, currentAccountId } = useWalletStore.getState()
    if (!currentWalletId) return false
    const wallet = useWalletStore.getState().getWallet(currentWalletId)
    if (!wallet || isZcashHardwareKeySource(wallet.keySource)) return false
    if (!(await credentialSession.bindZcashCredential(currentWalletId))) return false
    await backgroundZcashWalletRuntime.initialize()
    return backgroundZcashWalletRuntime.restoreFromCredentialSession(
      currentWalletId,
      currentAccountId || undefined
    )
  })().finally(() => {
    backgroundSessionRestore = null
  })
  return backgroundSessionRestore
}

async function handleDAppRequest(
  request: any,
  origin: string,
  tabInfo: { readonly title?: string; readonly favIconUrl?: string; readonly pageUrl?: string } = {}
): Promise<any> {
  try {
    await ensureDAppHandlerReady()

    if (request.method === 'zcash_getAccounts') {
      const snapshot = await dappHandler.getAuthorizedActiveAccountSnapshot(origin)
      if (!snapshot) return null

      // This silent read needs only an attested unlock session and persisted
      // public addresses. Avoid restoring WASM here: an existing wallet sync
      // may legitimately hold the core lock while the service worker restarts.
      if (
        backgroundZcashWalletRuntime.isLocked() &&
        !(await credentialSession.hasUnlockSession())
      ) {
        return null
      }
      return snapshot
    }

    // Silent methods never trigger unlock
    const silentMethods = [
      'zcash_getAccounts',
      'zcash_getBalance',
      'zcash_getMaxTransfer',
      'zcash_getAddresses',
      'zcash_getPublicKey'
    ]
    const isSilentMethod = silentMethods.includes(request.method)

    if (request.method === 'zcash_requestAccounts') {
      const hasWallet = useWalletStore.getState().wallets.length > 0

      if (!hasWallet) {
        return await dappHandler.handleRequest({
          method: request.method,
          params: request.params,
          origin,
          tabInfo
        })
      }
    }

    // Non-silent methods require unlock
    if (!isSilentMethod) {
      const unlockRequired = await needsUnlock({
        hasUnlockSession: () => credentialSession.hasUnlockSession()
      })

      if (unlockRequired) {
        await promptUnlock()
        // After unlock, continue to process the request (don't throw error)
      }
    }

    if (backgroundZcashWalletRuntime.isLocked()) {
      logger.log(
        'Background Zcash wallet runtime is locked, attempting session restore...',
        useWalletStore.getState().currentWalletId || undefined
      )
      if (!(await restoreBackgroundZcashRuntimeFromSession())) {
        logger.error('No attested credential session available')
        throw new Error('Wallet not unlocked')
      }
      await backgroundZcashWalletRuntime.waitForAccountReady(20000)
      logger.log(
        'Background Zcash wallet runtime restored from credential session',
        useWalletStore.getState().currentWalletId || undefined
      )
    }

    // Process request
    return await dappHandler.handleRequest({
      method: request.method,
      params: request.params,
      origin,
      tabInfo
    })
  } catch (error: any) {
    console.warn('[Background] DApp request error:', error)
    throw error
  }
}

/**
 * Open unlock window and wait for unlock completion
 */
async function promptUnlock(
  options: { readonly restoreZcashRuntime?: boolean } = {}
): Promise<void> {
  await closeAllPopupWindows()

  const lastWindow = await chrome.windows.getLastFocused()
  const windowWidth = UI_CONFIG.DAPP_WINDOW.WIDTH
  const windowHeight = UI_CONFIG.DAPP_WINDOW.HEIGHT

  const left =
    lastWindow?.left !== undefined && lastWindow?.width !== undefined
      ? lastWindow.left + lastWindow.width - windowWidth - 20
      : undefined
  const top = lastWindow?.top !== undefined ? lastWindow.top + 100 : undefined

  const unlockWindow = await chrome.windows.create({
    url: 'index.html#unlock?from=dapp',
    type: 'popup',
    width: windowWidth,
    height: windowHeight,
    left: left,
    top: top,
    focused: true
  })
  if (typeof unlockWindow.id !== 'number') {
    throw new Error('Unlock window was created without an ID')
  }
  const unlockWindowId = unlockWindow.id

  const unlockPromise = new Promise<void>((resolve, reject) => {
    let settled = false
    let unlockReceived = false
    let timeoutId: ReturnType<typeof setTimeout>
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      chrome.runtime.onMessage.removeListener(listener)
      chrome.windows.onRemoved.removeListener(onWindowRemoved)
      if (error) reject(error)
      else resolve()
    }

    const onWindowRemoved = (removedId: number) => {
      if (removedId === unlockWindowId && !unlockReceived) {
        finish(new Eip1193ProviderError(4001, 'User cancelled the unlock request.'))
      }
    }

    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (
        !isRuntimeRecord(message) ||
        message.type !== 'UNLOCK_SUCCESS' ||
        !hasExactRuntimeKeys(message, ['type']) ||
        !isOwnExtensionRouteSender(sender, chrome.runtime.id, '/unlock', {
          windowId: unlockWindowId
        })
      ) {
        return
      }

      unlockReceived = true
      void (async () => {
        try {
          if (options.restoreZcashRuntime === false) {
            finish()
            return
          }
          if (!(await restoreBackgroundZcashRuntimeFromSession())) {
            console.warn('[Background] Failed to unlock the Zcash wallet runtime')
            finish(new Error('Background unlock failed'))
            return
          }
          finish()
        } catch (error) {
          console.warn('[Background] Error unlocking the Zcash wallet runtime:', error)
          finish(error)
        }
      })()
    }
    chrome.runtime.onMessage.addListener(listener)
    chrome.windows.onRemoved.addListener(onWindowRemoved)

    timeoutId = setTimeout(() => {
      finish(new Error('Unlock timeout'))
    }, 300000)
  })

  // Wait for unlock to complete
  await unlockPromise
}

let walletSessionTransition: Promise<void> = Promise.resolve()

function enqueueWalletSessionTransition<T>(operation: () => Promise<T>): Promise<T> {
  const result = walletSessionTransition.catch(() => {}).then(operation)
  walletSessionTransition = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function handleWalletUnlock(password: string): Promise<any> {
  return enqueueWalletSessionTransition(async () => {
    const result = await accountContextTransition.runActiveOperation(() =>
      performWalletUnlock(password)
    )
    if (result?.success) await walletCleanupCoordinator.resumePendingCleanup()
    return result
  })
}

function restoreZcashDAppPermissionsAfterUnlock(): void {
  void backgroundZcashWalletRuntime
    .waitForAccountReady(15000)
    .then(() =>
      accountContextTransition.runActiveOperation(async () => {
        if (
          backgroundZcashWalletRuntime.isLocked() ||
          !(await credentialSession.hasUnlockSession())
        )
          return

        await dappHandler.initialize()
        await dappHandler.restorePermissionsFromStorage()

        const account = await backgroundZcashWalletRuntime.getCurrentAccount()
        if (account) {
          await dappHandler.notifyAccountsChanged({
            transparent: account.addresses.transparent,
            shielded: account.addresses.shielded
          })
        }
        await evmDAppHandler.notifyAccountsChanged()
        await bitcoinDAppHandler.notifyAccountsChanged()
        await solanaDAppHandler?.notifyAccountsChanged()
        await nearDAppHandler?.notifyAccountsChanged()
        await multichainSessionDAppHandler?.notifyAllSessionsChanged()
      })
    )
    .catch(err => {
      console.warn('[Background] Account ready timeout, dApp restore deferred:', err)
    })
}

async function performWalletUnlock(password: string): Promise<any> {
  syncScheduler.pauseForTx()
  syncScheduler.abortSync()
  try {
    await rehydrateWalletStore()
    await backgroundZcashWalletRuntime.initialize()
    await backgroundZcashWalletRuntime.lock()
    if (!(await syncScheduler.waitForActiveSyncIdle(30_000))) {
      throw new Error('Wallet sync is still stopping. Please try unlocking again.')
    }

    const walletState = useWalletStore.getState()
    const activeRetainedV1Wallet = walletState.currentWalletId
      ? walletState.getWallet(walletState.currentWalletId)
      : null
    const storageV2SupportsZcash = await credentialLifecycle.activeAccountSupportsChain('zcash')
    const unlockPath = resolveWalletUnlockPath(
      await credentialLifecycle.getActiveWalletSetMode(),
      storageV2SupportsZcash,
      Boolean(activeRetainedV1Wallet)
    )
    if (unlockPath.kind === 'native-v2') {
      const attemptStatus = await SecureStorage.getLoginAttempts()
      if (attemptStatus.isLocked) {
        return {
          success: false,
          isLocked: true,
          remainingAttempts: 0,
          lockRemainingMs: attemptStatus.lockRemainingMs
        }
      }
      try {
        if (unlockPath.restoreZcashRuntime) {
          const restored = await backgroundZcashWalletRuntime.unlock(password, {
            allowMissingCredentialRecovery: true
          })
          if (!restored.success) return restored
        }
        const descriptor = await credentialSession.unlock(password, Date.now())
        if (!descriptor) throw new Error('No active Wallet credential was found')
        await Promise.all([
          SecureStorage.resetLoginAttempts(),
          SecureStorage.saveLastActivityTime()
        ])
        await Promise.allSettled([
          dappHandler.notifyAccountsChanged([]),
          evmDAppHandler.notifyAccountsChanged(),
          bitcoinDAppHandler.notifyAccountsChanged(),
          solanaDAppHandler?.notifyAccountsChanged(),
          nearDAppHandler?.notifyAccountsChanged(),
          multichainSessionDAppHandler?.notifyAllSessionsChanged()
        ])
        if (unlockPath.restoreZcashRuntime) restoreZcashDAppPermissionsAfterUnlock()
        return { success: true, credentialStatus: 'already-migrated', nativeV2Only: true }
      } catch (error) {
        console.warn(
          '[Background] Native V2 unlock failed:',
          error instanceof Error ? error.message : 'unknown error'
        )
        await performWalletLockState().catch(() => {})
        if (!(error instanceof CredentialAuthenticationError)) {
          return {
            success: false,
            failure: 'operation_failed',
            error: 'Unable to unlock wallet. Please try again.'
          }
        }
        const failed = await SecureStorage.recordFailedAttempt()
        return {
          success: false,
          failure: 'wrong_password',
          isLocked: failed.isLocked,
          remainingAttempts: failed.remainingAttempts,
          lockRemainingMs: failed.lockRemainingMs
        }
      }
    }

    const result = await backgroundZcashWalletRuntime.unlock(password, {
      allowMissingCredentialRecovery: true
    })
    if (!result.success) {
      return result
    }

    const credentials = result.recoveredWalletId
      ? await credentialLifecycle.resumeActiveRetainedWalletForRecovery(
          password,
          result.recoveredWalletId
        )
      : await credentialLifecycle.synchronizeRetainedV1(password)
    if (result.recoveredWalletId && result.recoveredAccountId) {
      const selection = await credentialLifecycle.selectActiveAccount(
        result.recoveredWalletId,
        result.recoveredAccountId
      )
      if (selection.status === 'storage-v2-inactive') {
        throw new Error('Recovered wallet storage is unavailable')
      }
    }
    const lastUserActivityAt = Date.now()
    await credentialSession.unlock(password, lastUserActivityAt)
    const currentWalletId = useWalletStore.getState().currentWalletId
    const currentWallet = currentWalletId
      ? useWalletStore.getState().getWallet(currentWalletId)
      : null
    if (
      currentWalletId &&
      !isZcashHardwareKeySource(currentWallet?.keySource) &&
      !(await credentialSession.bindZcashCredential(currentWalletId))
    ) {
      await performWalletLockState()
      throw new Error('Unable to bind the Zcash credential session')
    }
    await synchronizeCurrentSoftwareWalletNetworkMetadata()

    restoreZcashDAppPermissionsAfterUnlock()

    await SecureStorage.saveLastActivityTime()

    return { success: true, credentialStatus: credentials.status }
  } catch (error) {
    console.warn('Unlock error:', error)
    await performWalletLockState().catch(() => {})
    throw error
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

function handleWalletCreated(
  password: string
): Promise<Awaited<ReturnType<typeof credentialLifecycle.synchronizeRetainedV1>>> {
  return enqueueWalletSessionTransition(() =>
    accountContextTransition.runActiveOperation(async () => {
      syncScheduler.pauseForTx()
      syncScheduler.abortSync()
      try {
        await rehydrateWalletStore()
        await backgroundZcashWalletRuntime.initialize()
        await backgroundZcashWalletRuntime.lock()
        const credentials = await credentialLifecycle.synchronizeRetainedV1(password)
        await credentialSession.unlock(password)
        const unlocked = await backgroundZcashWalletRuntime.unlock(password, {
          skipFailCount: true
        })
        if (!unlocked.success) throw new Error('Wallet provisioning password is invalid')
        const currentWalletId = useWalletStore.getState().currentWalletId
        const currentWallet = currentWalletId
          ? useWalletStore.getState().getWallet(currentWalletId)
          : null
        if (
          currentWalletId &&
          !isZcashHardwareKeySource(currentWallet?.keySource) &&
          !(await credentialSession.bindZcashCredential(currentWalletId))
        ) {
          await performWalletLockState()
          throw new Error('Unable to bind the Zcash credential session')
        }
        await synchronizeCurrentSoftwareWalletNetworkMetadata()
        logger.log(
          'Zcash wallet runtime re-initialized after wallet creation',
          useWalletStore.getState().currentWalletId || undefined
        )
        syncScheduler.onRequestSync()
        return credentials
      } catch (error) {
        await performWalletLockState().catch(() => {})
        throw error
      } finally {
        syncScheduler.resumeAfterTx()
      }
    })
  )
}

/**
 * Handle wallet lock event
 * Preserves dApp connections (EIP-1193 standard: lock ≠ disconnect)
 */
function handleWalletLock(): Promise<void> {
  return enqueueWalletSessionTransition(async () => {
    await accountContextTransition.runActiveOperation(performWalletLockState)
  })
}

async function performWalletLockState(): Promise<void> {
  syncScheduler.pauseForTx()
  try {
    await cancelAllLedgerSigning('Wallet was locked. Review this action again.')
    pendingRequestsManager.cancelAll()
    syncScheduler.abortSync()

    // Account restoration can still be in scheduler preflight after the scan
    // itself stops. Drain it before recreating workers, even if Zcash cleanup fails.
    const [zcashResult] = await Promise.allSettled([
      backgroundZcashWalletRuntime.lock(),
      syncScheduler.waitForActiveSyncIdle(30_000)
    ])

    const workerResults = await Promise.allSettled([
      credentialSession.lock(),
      confidentialFundingStore.clearAllSessions(),
      forwardKeyringRpcToOffscreen<boolean>('worker.recreate', { walletId: '__global_lock__' })
    ])
    const workerFailure = workerResults.find(result => result.status === 'rejected')
    if (workerFailure) {
      const offscreenAlive = await chrome.offscreen?.hasDocument?.().catch(() => true)
      if (offscreenAlive !== false) {
        throw new Error('Unable to confirm that all keyring Workers were locked')
      }
    }
    if (zcashResult.status === 'rejected') throw zcashResult.reason

    dappHandler.clearPermissions()
    await dappHandler.notifyAccountsChanged([])
    await evmDAppHandler.notifyAccountsChanged()
    await bitcoinDAppHandler.notifyAccountsChanged()
    await solanaDAppHandler?.notifyAccountsChanged()
    await nearDAppHandler?.notifyAccountsChanged()
    await multichainSessionDAppHandler?.notifyAllSessionsChanged()
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

async function performKeyringRuntimesResetAfterCredentialChange(): Promise<void> {
  pendingRequestsManager.cancelAll()
  syncScheduler.abortSync()
  const [zcashResult, ...results] = await Promise.allSettled([
    backgroundZcashWalletRuntime.lock(),
    credentialSession.lock(),
    forwardKeyringRpcToOffscreen<boolean>('worker.recreate', {
      walletId: '__password_change__'
    })
  ])
  if (results.some(result => result.status === 'rejected')) {
    const offscreenAlive = await chrome.offscreen?.hasDocument?.().catch(() => true)
    if (offscreenAlive !== false) {
      throw new Error('Unable to confirm that all keyring Workers restarted after password change')
    }
  }
  if (zcashResult.status === 'rejected') throw zcashResult.reason
}

/**
 * Handle account switch event
 * Notifies all connected dApps about the account change
 */
async function handleAccountSwitched({
  refreshPortfolio = true
}: { refreshPortfolio?: boolean } = {}): Promise<void> {
  await cancelAllLedgerSigning('Account changed. Review this action again.')
  try {
    const account = backgroundZcashWalletRuntime.getCurrentAccount()

    if (account) {
      await dappHandler.notifyAccountsChanged({
        transparent: account.addresses.transparent,
        shielded: account.addresses.shielded
      })
    } else {
      await dappHandler.notifyAccountsChanged([])
    }
    await evmDAppHandler.notifyAccountsChanged()
    await bitcoinDAppHandler.notifyAccountsChanged()
    await solanaDAppHandler?.notifyAccountsChanged()
    await nearDAppHandler?.notifyAccountsChanged()
    await multichainSessionDAppHandler?.notifyAllSessionsChanged()
    if (refreshPortfolio) {
      portfolioCoordinator?.refreshActive().catch(error => {
        console.warn('[Portfolio] Account refresh failed:', error)
      })
    }
  } catch (error) {
    console.warn('[Background] Account switch notification error:', error)
    await dappHandler.notifyAccountsChanged([]).catch(() => {})
    await evmDAppHandler.notifyAccountsChanged().catch(() => {})
    await bitcoinDAppHandler.notifyAccountsChanged().catch(() => {})
    await solanaDAppHandler?.notifyAccountsChanged().catch(() => {})
    await nearDAppHandler?.notifyAccountsChanged().catch(() => {})
    await multichainSessionDAppHandler?.notifyAllSessionsChanged().catch(() => {})
  }
  await chrome.runtime.sendMessage({ type: 'ACCOUNT_CONTEXT_CHANGED' }).catch(() => {})
}

/**
 * Handle dApp disconnect request
 * Removes connection from storage and clears permissions
 */
async function handleDAppDisconnect(origin: string): Promise<boolean> {
  try {
    await cancelAllLedgerSigning('dApp authorization changed. Review this action again.')
    await accountContextTransition.runActiveOperation(() => dappHandler.revokePermission(origin))
    return true
  } catch (error: any) {
    console.warn('Disconnect error:', error)
    throw error
  }
}

/**
 * Pause sync, wait for the wallet's in-flight batch to go idle, run the
 * tx-critical work, then resume sync. Worker soft-read RPCs (account restore)
 * are blocked while a sync batch mutates wallet state, so every transaction
 * build/broadcast must run inside this window.
 */
async function withTxSyncPause<T>(walletId: string | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    syncScheduler.pauseForTx()
    const syncWaitMs = WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS
    const syncIdle = walletId
      ? await syncScheduler.waitForWalletSyncIdle(walletId, syncWaitMs)
      : await syncScheduler.waitForActiveSyncIdle(syncWaitMs)
    if (!syncIdle) {
      throw new Error('Wallet is syncing. Please try again after sync completes.')
    }
    return await fn()
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

async function ensureZcashAccountProvisioningSession(): Promise<void> {
  await rehydrateWalletStore()
  await backgroundZcashWalletRuntime.initialize()
  if (!(await credentialSession.hasUnlockSession())) {
    if (!backgroundZcashWalletRuntime.isLocked()) await backgroundZcashWalletRuntime.lock()
    throw new Error('Wallet is locked. Please unlock and try again.')
  }
  if (
    backgroundZcashWalletRuntime.isLocked() &&
    !(await restoreBackgroundZcashRuntimeFromSession())
  ) {
    throw new Error('Wallet is locked. Please unlock and try again.')
  }
  if (backgroundZcashWalletRuntime.getSessionPassword() === null) {
    const password = await credentialSession.getProvisioningPassword()
    const unlocked = await backgroundZcashWalletRuntime.unlock(password, { skipFailCount: true })
    if (!unlocked.success) {
      throw new Error('Wallet credential session could not authorize account setup')
    }
  }
}

async function prepareNextZcashSoftwareAccount(walletId: string): Promise<{
  derivationIndex: number
  transparentAddress: string
}> {
  syncScheduler.pauseForTx()
  try {
    const idle = await syncScheduler.quiesceWalletForMutation(walletId)
    if (!idle) {
      throw new Error('Wallet sync did not stop before account inspection')
    }

    await ensureZcashAccountProvisioningSession()

    return backgroundZcashWalletRuntime.previewNextSoftwareAccount(walletId)
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

async function handleInspectNextZcashAccountHistory(walletId: string): Promise<{
  derivationIndex: number
  status: 'used' | 'unknown'
  birthdayHeight?: number
}> {
  const preview = await prepareNextZcashSoftwareAccount(walletId)
  const inspection = await inspectZcashTransparentAccountHistory({
    nodeRpcUrl: getNetworkConfig(DEFAULT_NETWORK).nodeRpcUrl,
    transparentAddress: preview.transparentAddress,
    network: DEFAULT_NETWORK
  })
  return {
    derivationIndex: preview.derivationIndex,
    status: inspection.status,
    ...(inspection.status === 'used' && inspection.birthdayHeight !== null
      ? { birthdayHeight: inspection.birthdayHeight }
      : {})
  }
}

async function handleAddWalletAccount(
  walletId: string,
  accountName?: string,
  options: {
    readonly birthdayHeight?: number
    readonly expectedDerivationIndex?: number
  } = {}
): Promise<{ accountId: string; credentialStatus: string }> {
  syncScheduler.pauseForTx()
  try {
    const idle = await syncScheduler.quiesceWalletForMutation(walletId)
    if (!idle) {
      throw new Error('Wallet sync did not stop before account setup')
    }

    await ensureZcashAccountProvisioningSession()

    const accountId = await backgroundZcashWalletRuntime.addNewAccountAuthoritatively(
      walletId,
      accountName,
      options
    )
    const password = backgroundZcashWalletRuntime.getSessionPassword()
    if (!password) throw new Error('Wallet provisioning requires an unlocked session')
    const credentials = await credentialLifecycle.synchronizeRetainedV1(password)
    await synchronizeCurrentSoftwareWalletNetworkMetadata()
    syncScheduler.onRequestSync()
    return { accountId, credentialStatus: credentials.status }
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

async function handleResyncZcashWallet(
  walletId: string,
  accountId: string,
  birthdayHeight: number
): Promise<void> {
  await assertActiveBackgroundAccountScope(walletId, accountId)
  syncScheduler.pauseForTx()
  try {
    const syncIdle = await syncScheduler.quiesceWalletForMutation(walletId)
    if (!syncIdle) {
      throw new Error('Wallet sync did not stop before Zcash resync')
    }

    await backgroundZcashWalletRuntime.initialize()
    if (!(await credentialSession.hasUnlockSession())) {
      if (!backgroundZcashWalletRuntime.isLocked()) await backgroundZcashWalletRuntime.lock()
      throw new Error('Wallet is locked. Please unlock and try again.')
    }

    if (backgroundZcashWalletRuntime.getSessionPassword() === null) {
      const password = await credentialSession.getProvisioningPassword()
      const unlocked = await backgroundZcashWalletRuntime.unlock(password, { skipFailCount: true })
      if (!unlocked.success) {
        throw new Error('Wallet credential session could not authorize Zcash resync')
      }
    }

    await backgroundZcashWalletRuntime.resyncZcashWallet(walletId, accountId, birthdayHeight)
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

async function handleSwitchWalletAccount(walletId: string, accountId: string) {
  syncScheduler.pauseForTx()
  try {
    syncScheduler.abortSync()
    const syncIdle = await syncScheduler.waitForActiveSyncIdle(30_000)
    if (!syncIdle) throw new Error('Wallet sync did not stop before account switch')

    await rehydrateWalletStore()
    await backgroundZcashWalletRuntime.initialize()
    if (!(await credentialSession.hasUnlockSession())) {
      if (!backgroundZcashWalletRuntime.isLocked()) await backgroundZcashWalletRuntime.lock()
      throw new Error('Wallet is locked. Please unlock and try again.')
    }

    const wallet = useWalletStore.getState().getWallet(walletId)
    if (!wallet) {
      return accountContextTransition.runActiveOperation(async () => {
        const selection = await credentialLifecycle.selectActiveAccount(walletId, accountId)
        if (selection.status === 'storage-v2-inactive') throw new Error('Wallet not found')
        await synchronizeNativeActiveAccount(walletId, accountId)
        return { selectionStatus: selection.status, generationId: selection.generationId }
      })
    }
    const restoreFromSession =
      !isZcashHardwareKeySource(wallet.keySource) &&
      backgroundZcashWalletRuntime.getSessionPassword() === null
    // Native accounts have no current Zcash binding. Restore the selected
    // software credential directly instead of requiring the previous account.
    if (restoreFromSession && !(await credentialSession.bindZcashCredential(walletId))) {
      await backgroundZcashWalletRuntime.lock().catch(() => {})
      throw new Error('Wallet credential is not available in the active session')
    }
    if (
      !restoreFromSession &&
      backgroundZcashWalletRuntime.isLocked() &&
      !(await restoreBackgroundZcashRuntimeFromSession())
    ) {
      throw new Error('Wallet is locked. Please unlock and try again.')
    }

    const selection = await switchActiveAccountPersistently(walletId, accountId)
    pendingRequestsManager.cancelExceptContext(walletId, accountId)
    if (restoreFromSession) {
      await backgroundZcashWalletRuntime.restoreFromCredentialSession(walletId, accountId)
    } else {
      await backgroundZcashWalletRuntime.ensureWalletCoreAccount(walletId, accountId)
    }
    syncScheduler.onAccountSwitched(walletId)
    await handleAccountSwitched()
    return { selectionStatus: selection.status, generationId: selection.generationId }
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

async function synchronizeNativeActiveAccount(walletId: string, accountId: string): Promise<void> {
  useWalletStore.getState().clearCurrentAccount()
  backgroundZcashWalletRuntime.synchronizeActiveWalletFromStore()
  await flushWalletStore()
  syncScheduler.onZcashAccountUnavailable()
  pendingRequestsManager.cancelExceptContext(walletId, accountId)
  await Promise.allSettled([
    dappHandler.notifyAccountsChanged([]),
    evmDAppHandler.notifyAccountsChanged(),
    bitcoinDAppHandler.notifyAccountsChanged(),
    solanaDAppHandler?.notifyAccountsChanged(),
    nearDAppHandler?.notifyAccountsChanged(),
    multichainSessionDAppHandler?.notifyAllSessionsChanged(),
    portfolioCoordinator?.refreshActive()
  ])
  await chrome.runtime.sendMessage({ type: 'ACCOUNT_CONTEXT_CHANGED' }).catch(() => {})
}

async function handleImportPrivateKeyWallet(input: {
  readonly privateKey: string
  readonly chainFamily: 'eip155' | 'bip122' | 'solana' | 'near'
  readonly displayName: string
}) {
  syncScheduler.pauseForTx()
  try {
    syncScheduler.abortSync()
    const result = await importPrivateKeyWallet(input)
    await synchronizeNativeActiveAccount(result.keyDomainId, result.accountId)
    return result
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

/**
 * Rehydrate state, unlock from the session if needed, restore the account into
 * the wallet core and return it ready for a transaction. Must run inside
 * withTxSyncPause so the account restore isn't blocked by an active sync.
 */
async function prepareWalletCoreForTx(walletId?: string, accountId?: string) {
  await rehydrateWalletStore()
  await backgroundZcashWalletRuntime.initialize()

  if (!(await credentialSession.hasUnlockSession())) {
    if (!backgroundZcashWalletRuntime.isLocked()) await backgroundZcashWalletRuntime.lock()
    throw new Error('Wallet locked and no attested credential session is available')
  }
  const state = useWalletStore.getState()
  const targetWalletId = walletId || state.currentWalletId
  const targetAccountId = accountId || state.currentAccountId
  if (!targetWalletId) throw new Error('Wallet not initialized')
  const targetWallet = state.getWallet(targetWalletId)
  if (!targetWallet) throw new Error('Wallet not found')

  if (
    backgroundZcashWalletRuntime.getSessionPassword() === null &&
    !isZcashHardwareKeySource(targetWallet.keySource)
  ) {
    if (!(await credentialSession.bindZcashCredential(targetWalletId))) {
      await backgroundZcashWalletRuntime.lock().catch(() => {})
      throw new Error('Wallet locked and no attested credential session is available')
    }
    if (
      !(await backgroundZcashWalletRuntime.restoreFromCredentialSession(
        targetWalletId,
        targetAccountId || undefined
      ))
    ) {
      throw new Error('Wallet credential session could not restore the selected account')
    }
  } else if (
    backgroundZcashWalletRuntime.isLocked() &&
    !(await restoreBackgroundZcashRuntimeFromSession())
  ) {
    throw new Error('Wallet locked and no attested credential session is available')
  } else if (targetAccountId) {
    await backgroundZcashWalletRuntime.ensureWalletCoreAccount(targetWalletId, targetAccountId)
  }
  await backgroundZcashWalletRuntime.waitForAccountReady(30000)

  return backgroundZcashWalletRuntime.getWalletCore(targetWalletId, targetAccountId || undefined)
}

function getZcashLendingIdentityMode(mode: LendingSigningMode): IdentitySigningMode {
  if (mode === 'legacy') return 'legacy_index0'
  if (mode === 'derived') return 'derived'
  return 'current'
}

async function prepareWalletCoreForIdentity(walletId: string, accountId: string) {
  await rehydrateWalletStore()
  await backgroundZcashWalletRuntime.initialize()
  if (!(await credentialSession.hasUnlockSession())) {
    throw new Error('Wallet locked and no attested credential session is available')
  }
  if (
    backgroundZcashWalletRuntime.isLocked() ||
    backgroundZcashWalletRuntime.getSessionPassword() === null
  ) {
    return withTxSyncPause(walletId, () => prepareWalletCoreForTx(walletId, accountId))
  }
  return backgroundZcashWalletRuntime.getWalletCore(walletId, accountId)
}

async function getBackgroundZcashLendingPublicKey(input: {
  readonly walletId: string
  readonly accountId: string
  readonly signingMode: LendingSigningMode
}): Promise<{ readonly publicKey: string }> {
  return accountContextTransition.runActiveOperation(async () => {
    await assertActiveBackgroundAccountScope(input.walletId, input.accountId)
    const walletCore = await prepareWalletCoreForIdentity(input.walletId, input.accountId)
    const state = useWalletStore.getState()
    const account = state
      .getWallet(input.walletId)
      ?.accounts.find(candidate => candidate.id === input.accountId)
    if (!account) throw new Error('Active Zcash account is unavailable')
    const identity = await fetchCachedIdentity(
      backgroundZcashWalletRuntime.getNetwork(),
      input.walletId,
      input.accountId,
      account.derivationIndex,
      getZcashLendingIdentityMode(input.signingMode),
      walletCore,
      { usePing: true }
    )
    return Object.freeze({ publicKey: identity.pubkey })
  })
}

async function assertActiveBackgroundAccountScope(
  walletId: string,
  accountId: string,
  accountKey?: string
): Promise<void> {
  await credentialLifecycle.assertActiveAccountSupportsChain(walletId, accountId, 'zcash')
  await rehydrateWalletStore()
  const state = useWalletStore.getState()
  if (state.currentWalletId !== walletId || state.currentAccountId !== accountId) {
    throw new Error('Active account changed. Review this action again.')
  }
  if (
    accountKey !== undefined &&
    accountKey !== buildAccountKey(state.currentNetwork, walletId, accountId)
  ) {
    throw new Error('Transaction account scope does not match the active account')
  }
}

async function ensurePendingHardwareTransactionRecord(
  walletId: string,
  accountId: string,
  transactionId: unknown
): Promise<void> {
  if (typeof transactionId !== 'string' || !transactionId.trim()) {
    throw new Error('Missing transaction record')
  }
  const accountKey = buildAccountKey(useWalletStore.getState().currentNetwork, walletId, accountId)
  const transaction = (await loadTransactions(accountKey)).find(
    record => record.id === transactionId
  )
  if (!transaction || transaction.status !== 'pending' || transaction.txHash) {
    throw new Error('Transaction record is unavailable or already submitted')
  }
}

async function recordUncertainBroadcast(
  accountKey: string,
  transactionId: string,
  txHash: string,
  txHashes: string[] = [txHash]
): Promise<void> {
  await mutateTransactions(accountKey, transactions => {
    const pending = applyTransactionBroadcast(transactions, transactionId, txHash, undefined)
    if (txHashes.length <= 1) return pending
    return pending.map(transaction =>
      transaction.id === transactionId
        ? { ...transaction, chainHashes: txHashes.map(hash => ({ hash, chain: 'Zcash' })) }
        : transaction
    )
  })
}

/**
 * Build an unsigned PCZT for hardware signing in the background, using
 * the same sync-pause/account-restore coordination as software sends. The caller
 * persists the full PCZT in its trusted session binding and returns signer-only
 * data, so building during sync waits instead of failing with an uninitialized account.
 */
async function handleHardwarePcztBuild(params: {
  walletId: string
  accountId: string
  kind: HardwareSignKind
  to?: string
  amount?: string
  maxTransfer?: boolean
  memo?: string
  fundingSource?: 'shielded' | 'transparent'
  marginalFeeZats?: number
}): Promise<
  | {
      success: true
      full: string
      redacted: string
      feeZats?: string
      amount?: string
      vendor: 'keystone' | 'ledger'
      ledgerPayload?: LedgerSigningPayload
      ledgerDisplayAddress?: string
      ledgerDeviceModel?: string
      ledgerSigningTransport?: 'usb' | 'bluetooth'
    }
  | { success: false; error: string }
> {
  const {
    walletId,
    accountId,
    kind,
    to,
    amount,
    maxTransfer,
    memo,
    fundingSource,
    marginalFeeZats
  } = params
  try {
    await assertActiveBackgroundAccountScope(walletId, accountId)
    const wallet = useWalletStore.getState().getWallet(walletId)
    const account = wallet?.accounts.find(item => item.id === accountId)
    if (!wallet || !account || !isZcashHardwareKeySource(wallet.keySource)) {
      throw new Error('Select an active hardware account')
    }
    const vendor = wallet.keySource
    const ledgerCredential =
      vendor === 'ledger' ? await readLedgerProvisioningCredential(walletId) : undefined
    if (vendor === 'keystone' && fundingSource === 'transparent') {
      throw new Error('Transparent funding is not supported by Keystone hardware wallets')
    }
    const built = await withTxSyncPause(walletId, async () => {
      const walletCore = await prepareWalletCoreForTx(walletId, accountId)
      if (kind === 'shield' || fundingSource === 'transparent') {
        await prepareTransparentSpend(
          walletCore,
          kind === 'send' && !maxTransfer ? amount : undefined
        )
      }
      let effectiveAmount = amount
      if (maxTransfer) {
        if (kind !== 'send' || !to) throw new Error('Maximum transfer requires a recipient')
        const estimate = await walletCore.estimateMaxTransfer(
          to,
          memo,
          sanitizeMarginalFeeZats(marginalFeeZats),
          fundingSource
        )
        effectiveAmount = formatBaseUnitDecimalAmount(estimate.maxAmountZats, ZEC_DECIMALS)
        if (!safeBig(effectiveAmount).gt(0)) {
          throw new Error('No spendable balance is available for this transaction')
        }
      }
      const pair =
        kind === 'shield'
          ? await walletCore.pcztShieldCreate(marginalFeeZats)
          : await walletCore.pcztCreate({
              to: to!,
              amount: effectiveAmount!,
              memo,
              fundingSource,
              marginalFeeZats,
              signer: vendor
            })
      const ledgerPayload =
        vendor === 'ledger'
          ? await walletCore.pcztLedgerPayload(pair.redacted, account.derivationIndex)
          : undefined
      // Surface the real ZIP-317 fee for the chosen tier so the signing page can
      // display and record it. Best-effort: a failed estimate must not block signing.
      const feeZats = await (
        kind === 'shield'
          ? walletCore.estimateShieldFee(sanitizeMarginalFeeZats(marginalFeeZats))
          : walletCore.estimateTransferFee(
              to!,
              effectiveAmount!,
              memo,
              sanitizeMarginalFeeZats(marginalFeeZats),
              fundingSource
            )
      ).catch(() => undefined)
      return { ...pair, feeZats, ledgerPayload, amount: effectiveAmount }
    })
    return {
      success: true,
      full: built.full,
      redacted: built.redacted,
      feeZats: built.feeZats,
      amount: built.amount,
      vendor,
      ...(ledgerCredential === undefined
        ? {}
        : {
            ledgerDeviceModel: ledgerCredential.deviceModel,
            ...(ledgerCredential.ledgerSigningTransport === undefined
              ? {}
              : { ledgerSigningTransport: ledgerCredential.ledgerSigningTransport })
          }),
      ...(built.ledgerDisplayAddress === undefined
        ? {}
        : { ledgerDisplayAddress: built.ledgerDisplayAddress }),
      ...(built.ledgerPayload === undefined ? {} : { ledgerPayload: built.ledgerPayload })
    }
  } catch (error: any) {
    const rawMessage = error?.message || 'Failed to build transaction'
    // Preserve SAPLING_UNSUPPORTED so the popup can show its dedicated guidance;
    // map other transient protocol errors to a friendly message.
    const userMessage = rawMessage.includes('SAPLING_UNSUPPORTED')
      ? rawMessage
      : getRetryableWalletRpcUserMessage(rawMessage)
    return { success: false, error: userMessage }
  }
}

/**
 * Handle Zcash on-chain transaction in background
 * Supports shield and shielded-pool sends, including Unshield transfers.
 * Executes WASM call and updates transaction status,
 * so the operation completes even if popup is closed.
 */
async function handleBackgroundZcashTx(params: {
  action: 'send' | 'shield'
  walletId: string
  accountId: string
  accountKey: string
  transactionId: string
  txType?: TransactionType
  sendParams?: SendTransactionParams
  marginalFeeZats?: number
  monitorParams?: {
    depositAddress: string
    tokenInSymbol: string
    tokenOutSymbol: string
    amountIn: string
    amountOut: string
    actionName: string
    originChain?: string
    destinationChain?: string
  }
  analytics?: ZcashOperationAnalyticsContext
}): Promise<void> {
  const {
    action,
    walletId,
    accountId,
    accountKey,
    transactionId,
    txType,
    sendParams,
    marginalFeeZats,
    monitorParams,
    analytics
  } = params
  const actionLabel = action === 'shield' ? 'Shield' : 'Send'
  let onChainAmount = sendParams?.amount
  let broadcastTxHash: string | undefined
  logger.info(`Starting ${actionLabel} operation`, walletId, accountId)

  try {
    await assertActiveBackgroundAccountScope(walletId, accountId, accountKey)
    await withTxSyncPause(walletId, async () => {
      const pendingRecord = (await loadTransactions(accountKey)).find(tx => tx.id === transactionId)
      if (!pendingRecord || pendingRecord.status !== 'pending' || pendingRecord.txHash) {
        throw new Error('Transaction record is unavailable or already submitted')
      }
      const walletCore = await prepareWalletCoreForTx(walletId, accountId)
      if (action === 'shield') {
        if (!walletId || !accountId) {
          throw new Error('No account available. Please select an account and try again.')
        }
        const transparentBalance = getShieldableTransparentBalance(
          await prepareTransparentSpend(walletCore)
        )
        if (!hasEnoughTransparentBalanceToShield(transparentBalance)) {
          throw new Error(MIN_SHIELDING_BALANCE_MESSAGE)
        }
        onChainAmount = transparentBalance
        await transactionRecorder.updateTransaction(accountKey, transactionId, {
          amount: transparentBalance
        })
      }

      if (action === 'send' && sendParams?.fundingSource === 'transparent') {
        await prepareTransparentSpend(walletCore, sendParams.amount)
      }

      let txid: string
      let txHashes: string[]
      const transactionContext = { accountKey, transactionId }
      if (action === 'shield') {
        const shieldResult = await walletCore.shieldFunds(
          marginalFeeZats,
          undefined,
          transactionContext
        )
        txid = shieldResult.txid
        txHashes = [txid]
        broadcastTxHash = txid
        if (shieldResult.amount) {
          onChainAmount = shieldResult.amount
        }
      } else {
        const submissionDeadline = await readRheaZcashTransferDeadline(
          pendingRecord.quoteBinding,
          sendParams!.to,
          sendParams!.amount
        )
        const transferResult = await walletCore.sendTransaction(
          { ...sendParams!, marginalFeeZats },
          submissionDeadline,
          undefined,
          transactionContext
        )
        const successfulTransfer = requireSuccessfulTransfer(transferResult)
        txid = successfulTransfer.txHash
        txHashes = successfulTransfer.txHashes
        broadcastTxHash = txid
      }
      logger.info(`${actionLabel} broadcast completed`, walletId, accountId)

      const expiryHeight = await computeExpiryHeight(() =>
        withTimeout(walletCore.getLatestBlock(), 3_000, 'Transaction expiry height')
      )
      const isCrossChain = isIntentsSettledTransaction(txType)
      const isOnChainTx = action === 'send' || action === 'shield' || txType === 'supply'

      // Once a txid exists the tx is broadcast and irreversible; no bookkeeping
      // error below may downgrade it to "failed". The tx stays pending and its
      // monitor (or a later sync) finalizes it.
      try {
        if (action === 'shield' && onChainAmount) {
          await transactionRecorder.updateTransaction(accountKey, transactionId, {
            amount: onChainAmount
          })
        }
        await mutateTransactions(accountKey, txs => {
          if (!txs.some(tx => tx.id === transactionId)) return txs
          const broadcasted = applyTransactionBroadcast(txs, transactionId, txid, expiryHeight)
          if (txHashes.length === 1) return broadcasted
          return broadcasted.map(tx =>
            tx.id === transactionId
              ? {
                  ...tx,
                  chainHashes: txHashes.map(txHash => ({ hash: txHash, chain: 'Zcash' }))
                }
              : tx
          )
        })
      } catch {
        logger.warn(`${actionLabel} post-broadcast record update deferred`, walletId, accountId)
      }

      try {
        if (isOnChainTx) {
          await zcashTxMonitor.addTransaction({
            txHash: txid,
            accountKey,
            walletId,
            accountId,
            transactionId,
            amount: onChainAmount,
            type: isCrossChain ? txType : (txType ?? action),
            expiryHeight
          })
        }
      } catch {
        logger.warn(`${actionLabel} post-broadcast monitoring deferred`, walletId, accountId)
      }

      try {
        if (isCrossChain && monitorParams) {
          await transactionMonitor.addTransaction({
            depositAddress: monitorParams.depositAddress,
            tokenInSymbol: monitorParams.tokenInSymbol,
            tokenOutSymbol: monitorParams.tokenOutSymbol,
            amountIn: monitorParams.amountIn,
            amountOut: monitorParams.amountOut,
            actionName: monitorParams.actionName,
            accountKey,
            walletId,
            accountId,
            transactionId,
            originChain: monitorParams.originChain,
            destinationChain: monitorParams.destinationChain
          })
        }
      } catch {
        logger.warn(`${actionLabel} post-broadcast relay monitoring deferred`, walletId, accountId)
      }

      if (
        txType === 'swap' &&
        rheaSwapTransactionMonitor &&
        pendingRecord.quoteBinding?.provider === 'rhea-cross-chain-dex'
      ) {
        void chrome.alarms
          .create(RHEA_SWAP_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
          .catch(() => {})
      }

      if (analytics) {
        const event = projectZcashOperationEvent(
          action === 'shield' ? 'shield' : txType === 'swap' ? 'swap' : 'send',
          'broadcast',
          analytics,
          `zcash:${accountKey}:${transactionId}:broadcast`
        )
        trackEvent(event.name, event.options)
      }

      chrome.runtime
        .sendMessage({ type: 'ZCASH_TX_COMPLETED', accountKey, transactionId, txHash: txid })
        .catch(() => {})

      const statusMessage: TransactionStatusUpdatedMessage = {
        type: 'TRANSACTION_STATUS_UPDATED',
        accountKey,
        transactionId,
        status: 'pending'
      }
      chrome.runtime.sendMessage(statusMessage).catch(() => {})
    })

    if (walletId && accountId) {
      void refreshAfterOnChainBroadcast(walletId).catch(error => {
        logger.warn('Post-send balance refresh failed', walletId, accountId)
        console.error('[Background] refreshAfterOnChainBroadcast failed:', error)
      })
    }
  } catch (error: any) {
    if (isTransactionSubmissionUnknown(error)) {
      await recordUncertainBroadcast(accountKey, transactionId, error.txId, error.txIds).catch(() =>
        logger.error(
          `${actionLabel} uncertain broadcast could not be recorded`,
          walletId,
          accountId
        )
      )
      chrome.runtime
        .sendMessage({
          type: 'ZCASH_TX_COMPLETED',
          accountKey,
          transactionId,
          error: TRANSACTION_PENDING_MESSAGE,
          completionPending: true
        })
        .catch(() => {})
      return
    }
    if (!broadcastTxHash) {
      const recorded = await loadTransactions(accountKey)
        .then(records => records.find(record => record.id === transactionId))
        .catch(() => undefined)
      broadcastTxHash = recorded?.txHash || undefined
    }
    if (broadcastTxHash) {
      chrome.runtime
        .sendMessage({
          type: 'ZCASH_TX_COMPLETED',
          accountKey,
          transactionId,
          txHash: broadcastTxHash
        })
        .catch(() => {})
      return
    }
    if (error instanceof TimeoutError) {
      chrome.runtime
        .sendMessage({
          type: 'ZCASH_TX_COMPLETED',
          accountKey,
          transactionId,
          error: TRANSACTION_PENDING_MESSAGE,
          completionPending: true
        })
        .catch(() => {})
      return
    }
    logger.error(`${actionLabel} failed:`, walletId, accountId)

    const rawMessage = error?.message || `${actionLabel} failed`
    const userMessage = getRetryableWalletRpcUserMessage(rawMessage)

    if (analytics) {
      const event = projectZcashOperationEvent(
        action === 'shield' ? 'shield' : txType === 'swap' ? 'swap' : 'send',
        'failed',
        analytics,
        `zcash:${accountKey}:${transactionId}:failed`
      )
      trackEvent(event.name, event.options)
    }

    try {
      const txs = await loadTransactions(accountKey)
      const tx = txs.find(t => t.id === transactionId)
      if (tx) {
        await transactionRecorder.updateTransaction(accountKey, transactionId, {
          status: 'failed',
          notified: true
        })
      }
    } catch (e) {
      logger.error(`Failed to update ${actionLabel} transaction status:`, walletId, accountId)
    }

    chrome.runtime
      .sendMessage({
        type: 'ZCASH_TX_COMPLETED',
        accountKey,
        transactionId,
        error: userMessage
      })
      .catch(() => {})

    // Chrome notification for failure
    const notification = getActionFailureNotificationCopy(actionLabel, userMessage)
    chrome.notifications.create(`zcash-tx-fail-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: notification.title,
      message: notification.message,
      priority: 1
    })
  }
}
