import '@/core/services/lending-sdk-init'
import { ANALYTICS_EVENTS, handleAnalyticsMessage, trackEvent } from '@/lib/analytics'
import type { TrackOptions } from '@/lib/analytics/types'
import { dappHandler } from './dapp-handler'
import { accountManager } from '../core/wallet/account-manager'
import { UI_CONFIG } from '@/config/ui'
import { WALLET_CONFIG } from '@/config/wallet'
import { DEFAULT_NETWORK, getNetworkConfig } from '@/config/networks'
import { safeBig } from '@/lib/big'
import { closeAllPopupWindows } from './window-manager'
import { getApprovalContext, estimateApprovalFee } from './approval-context'
import { SecureStorage } from '../core/wallet/secure-storage'
import { needsUnlock } from '../lib/lock-utils'
import { transactionMonitor } from './transaction-monitor'
import { zcashTxMonitor, computeExpiryHeight } from './zcash-tx-monitor'
import { logger } from '@/lib/logger'
import { hasWalletDb, loadTransactions, mutateTransactions } from '@/lib/indexed-db'
import {
  useWalletStore,
  migrateWalletDataIfNeeded,
  rehydrateWalletStore,
  waitForHydration
} from '@/store/wallet-store'
import { transactionRecorder } from './transaction-recorder'
import { syncScheduler, SYNC_KEEPALIVE_ALARM } from './sync-scheduler'
import { refreshAfterOnChainBroadcast } from './tx-sync'
import { getRetryableWalletRpcUserMessage } from '@/core/zcash/wallet-rpc-errors'
import type { HardwareSignKind } from '@/lib/hardware-tab'
import { applyTransactionBroadcast } from '@/lib/transaction-replacement'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import {
  getShieldableTransparentBalance,
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'
import type { TransactionStatusUpdatedMessage } from '@/types/transaction-messages'
import { initializeExtensionUpdates } from './extension-update'
import { normalizeSyncTrigger, type FundingSource, type TransactionType } from '@/types'
import { isIntentsSettledTransaction } from '@/lib/cross-chain-transaction'
import { getActionFailureNotificationCopy } from '@/lib/transaction-status-copy'
import {
  applyExtensionDisplayMode,
  enqueueExtensionDisplayModeUpdate,
  getAppliedSidePanelMode,
  initializeExtensionDisplayMode,
  persistSidePanelMode
} from './extension-display-mode'
import { computePassiveSyncDelayMinutes, shouldRequestPeriodicSync } from './passive-sync-policy'
import { fetchLatestBlockHeight } from '@/config/rpc-registry-client'
import {
  isTransactionSubmissionUnknown,
  requireSuccessfulTransfer
} from '@/core/zcash/transfer-result'
import { withTimeout, TimeoutError } from '@/lib/async-utils'
import { TRANSACTION_PENDING_MESSAGE } from '@/lib/transaction-status-copy'
import { getFundingSourceUnavailableReason } from '@/lib/funding-source'
import {
  addCustomRpcEndpoint,
  getRpcEndpointStatus,
  removeCustomRpcEndpoint,
  selectAutomaticRpcEndpoint,
  selectRpcEndpoint,
  type RpcEndpointSettingsMutationResult
} from './rpc-endpoint-settings'
import { parseDiagnosticLogDraft } from '@/lib/diagnostic-log'
import { appendDiagnosticLog, getDiagnosticLogSalt } from '@/lib/diagnostic-log-store'
import { prepareTransparentSpend } from '@/core/wallet/transparent-spend-preflight'
import { readZeroIndexerEnabled, writeZeroIndexerEnabled } from '@/config/zero-indexer-settings'
import { applyZeroIndexerOptions } from '@/core/worker/client'
import {
  addCustomZeroIndexerNode,
  getZeroIndexerBroadcastOptions,
  getZeroIndexerNodeStatus,
  removeCustomZeroIndexerNode,
  selectZeroIndexerNode
} from './zero-indexer-node-settings'

logger.configureDiagnostics(getDiagnosticLogSalt, appendDiagnosticLog)

export { zcashTxMonitor }

export const BALANCE_SYNC_ALARM = 'wallet-balance-sync'
const BALANCE_SYNC_SCHEDULE_STATE_KEY = 'wallet_balance_sync_schedule'
const RPC_RUNTIME_RELOAD_UI_TIMEOUT_MS = 15_000
let zeroIndexerUpdateQueue: Promise<void> = Promise.resolve()

function enqueueZeroIndexerUpdate<T>(operation: () => Promise<T>): Promise<T> {
  const result = zeroIndexerUpdateQueue.catch(() => {}).then(operation)
  zeroIndexerUpdateQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function applyZeroIndexerRuntime(): Promise<{ warning?: string }> {
  const enabled = await readZeroIndexerEnabled()
  const options = await getZeroIndexerBroadcastOptions(DEFAULT_NETWORK, enabled)
  const update = applyZeroIndexerOptions(DEFAULT_NETWORK, options)
  try {
    await withTimeout(update, 5_000, 'Privacy broadcast runtime update')
    return {}
  } catch {
    void update.catch(() => {
      logger.error('[Privacy Broadcast] Runtime configuration update failed')
    })
    return { warning: 'Settings saved. They will apply when the wallet is ready.' }
  }
}

function updateZeroIndexerPreference(
  enabled: boolean
): Promise<{ enabled: boolean; warning?: string }> {
  return enqueueZeroIndexerUpdate(async () => {
    await writeZeroIndexerEnabled(enabled)
    const applied = await applyZeroIndexerRuntime()
    return { enabled: await readZeroIndexerEnabled(), ...applied }
  })
}

async function applyRpcSettingsMutation(
  result: RpcEndpointSettingsMutationResult
): Promise<RpcEndpointSettingsMutationResult & { warning?: string }> {
  if (!result.runtimeChanged) return result
  const reload = accountManager.applyRpcEndpointChange(result.preferences).then(() => {
    syncScheduler.onRequestSync('rpc-change')
  })
  try {
    await withTimeout(reload, RPC_RUNTIME_RELOAD_UI_TIMEOUT_MS, 'RPC endpoint reload')
    return result
  } catch (error) {
    void reload.catch(reloadError => {
      logger.error(
        '[RPC SWITCH] Background runtime reload failed',
        undefined,
        undefined,
        reloadError
      )
    })
    return {
      ...result,
      warning: error instanceof Error ? error.message : 'Wallet runtime reload failed'
    }
  }
}

if (__EXTENSION_UPDATES_ENABLED__) {
  initializeExtensionUpdates()
}

const debugLogsEnabled = typeof __DEBUG_LOGS__ !== 'boolean' || __DEBUG_LOGS__

logger.info('Background service worker started')

void getZeroIndexerNodeStatus()
  .then(async status => {
    if (Object.keys(status.probes).length > 0) return
    await getZeroIndexerNodeStatus(true)
    await enqueueZeroIndexerUpdate(applyZeroIndexerRuntime)
  })
  .catch(() => {
    logger.warn('[Privacy Broadcast] Node availability refresh failed')
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

chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(error => {
  console.warn('[Security] Failed to set session storage access level:', error)
})

// Initialize transaction monitors
transactionMonitor.init().catch(console.warn)
zcashTxMonitor.init().catch(console.warn)

type PeriodicSyncRequestOutcome = 'scheduled' | 'skipped' | 'probe-failed'

async function scheduleNextBalanceSyncAlarm(probeFailed: boolean): Promise<void> {
  const stored = await chrome.storage.session.get(BALANCE_SYNC_SCHEDULE_STATE_KEY)
  const previousFailureCount = Number(stored[BALANCE_SYNC_SCHEDULE_STATE_KEY]?.failureCount ?? 0)
  const failureCount = probeFailed ? Math.min(previousFailureCount + 1, 8) : 0
  const delayInMinutes = computePassiveSyncDelayMinutes({
    baseMinutes: WALLET_CONFIG.SYNC.BACKGROUND_POLL_MINUTES,
    jitterMinutes: WALLET_CONFIG.SYNC.BACKGROUND_POLL_JITTER_MINUTES,
    maxMinutes: WALLET_CONFIG.SYNC.BACKGROUND_POLL_MAX_BACKOFF_MINUTES,
    failureCount,
    randomUnit: Math.random()
  })

  await chrome.storage.session.set({
    [BALANCE_SYNC_SCHEDULE_STATE_KEY]: { failureCount }
  })
  await chrome.alarms.clear(BALANCE_SYNC_ALARM)
  chrome.alarms.create(BALANCE_SYNC_ALARM, { delayInMinutes })
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
async function silentInitializeWasm() {
  logger.log('[Background] Starting silent WASM initialization...')

  try {
    await waitForHydration()
    await migrateWalletDataIfNeeded()

    restoreStuckWithdrawMonitors().catch(err => {
      console.warn('[Background] Failed to restore stuck withdraw monitors:', err)
    })

    await accountManager.initialize()
    logger.log('[Background] AccountManager initialized')

    await chrome.runtime
      .sendMessage({ type: 'RECONCILE_WALLET_STATE', walletId: '*', all: true })
      .catch(err => {
        console.warn('[Background] Wallet reconcile failed:', err)
      })

    console.log('[Background] Silent WASM initialization completed')

    syncScheduler.resumeInterrupted().catch(err => {
      console.warn('[Background] Failed to resume interrupted sync:', err)
    })
  } catch (error) {
    console.warn('[Background] Silent WASM initialization failed:', error)
  }
}

async function restoreStuckWithdrawMonitors(): Promise<void> {
  const { wallets, currentNetwork } = useWalletStore.getState()
  const accountKeys: string[] = []
  for (const wallet of wallets) {
    for (const account of wallet.accounts) {
      accountKeys.push(`${currentNetwork}_${wallet.id}_${account.id}`)
    }
  }
  if (accountKeys.length > 0) {
    await transactionMonitor.restorePendingWithdrawals(accountKeys)
    await Promise.all([
      transactionMonitor.restoreSwapProgress(accountKeys),
      zcashTxMonitor.restoreStuckWithdrawals(accountKeys)
    ])
  }
}

// ============================================
// Extension Event Listeners
// ============================================

chrome.runtime.onInstalled.addListener(details => {
  console.log('[Background] Extension installed/updated:', details.reason)

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
  console.log('[Background] Browser started, ensuring WASM is ready...')
  silentInitializeWasm()
    .then(() => handlePeriodicBalanceSyncAlarm())
    .catch(console.warn)
})

async function checkOffscreenHealth(): Promise<void> {
  if (!chrome.offscreen?.hasDocument) return
  try {
    const alive = await chrome.offscreen.hasDocument()
    if (alive) {
      console.log('[Background] Sync keepalive: offscreen alive')
    } else {
      console.warn(
        '%c[Background] Offscreen Document disappeared during sync!',
        'background: #FF4444; color: #fff; font-weight: bold; padding: 4px 8px; border-radius: 4px;'
      )
    }
  } catch (err) {
    console.warn('[Background] Offscreen health check error:', err)
  }
}

async function requestPeriodicBalanceSync(): Promise<PeriodicSyncRequestOutcome> {
  if (syncScheduler.isRunning()) return 'skipped'

  // Alarms can wake a fresh MV3 service worker before either persisted store
  // has hydrated. Resolve wallet selection and cached scan height first.
  await Promise.all([rehydrateWalletStore(), useAccountDataStore.persist.rehydrate()])

  const { currentWalletId, currentNetwork } = useWalletStore.getState()
  if (!currentWalletId) return 'skipped'

  const syncState = useAccountDataStore
    .getState()
    .getWalletSyncState(currentNetwork, currentWalletId)
  const sessionPassword = accountManager.isLocked()
    ? await SecureStorage.getSessionPassword()
    : null

  const [
    isWalletUiOpen,
    hasPendingCrossChainTransaction,
    hasPendingZcashTransaction,
    hasPersistedSnapshot
  ] = await Promise.all([
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

  // An explicit UI or transaction flow may have started a sync while the
  // activity checks were reading extension contexts and persisted monitors.
  if (
    !shouldRequestPeriodicSync({
      isSchedulerRunning: syncScheduler.isRunning(),
      isWalletUiOpen,
      hasPendingTransactions,
      isWalletLocked: accountManager.isLocked() && !sessionPassword,
      hasPersistedSnapshot,
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

  const canUseForegroundSync = !accountManager.isLocked() || Boolean(sessionPassword)
  if (canUseForegroundSync && isWalletUiOpen) {
    syncScheduler.onRequestSync('requested')
    return 'scheduled'
  }
  if (canUseForegroundSync && hasPendingTransactions) {
    syncScheduler.onRequestSync('transaction')
    return 'scheduled'
  }

  return syncScheduler.requestPassiveSync(0) ? 'scheduled' : 'skipped'
}

async function handlePeriodicBalanceSyncAlarm(): Promise<void> {
  let probeFailed = false
  try {
    probeFailed = (await requestPeriodicBalanceSync()) === 'probe-failed'
  } catch (error) {
    probeFailed = true
    console.warn('[Background] Periodic balance sync request failed:', error)
  } finally {
    await scheduleNextBalanceSyncAlarm(probeFailed).catch(error => {
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

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'transaction-monitor-alarm') {
    transactionMonitor.handleAlarm().catch(console.warn)
  }
  if (alarm.name === 'zcash-tx-monitor-alarm') {
    zcashTxMonitor.handleAlarm().catch(console.warn)
  }
  if (alarm.name === BALANCE_SYNC_ALARM) {
    handlePeriodicBalanceSyncAlarm().catch(console.warn)
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

// Don't initialize dappHandler here - wait until wallet unlocked

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_DIAGNOSTIC_LOG_SALT') {
    if (sender.id !== chrome.runtime.id) return false
    getDiagnosticLogSalt()
      .then(salt => sendResponse({ success: true, salt }))
      .catch(() => sendResponse({ success: false, error: 'Diagnostic logging is unavailable' }))
    return true
  }

  if (message.type === 'APPEND_DIAGNOSTIC_LOG') {
    if (sender.id !== chrome.runtime.id) return false
    const entry = parseDiagnosticLogDraft(message.entry)
    if (!entry) {
      sendResponse({ success: false, error: 'Invalid diagnostic log entry' })
      return true
    }
    appendDiagnosticLog(entry)
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false, error: 'Diagnostic logging is unavailable' }))
    return true
  }

  if (message.type === 'SYNC_PROGRESS') {
    syncScheduler.applySyncProgressMessage(message)
    return false
  }

  // Ignore WORKER_RPC messages - they are handled by Offscreen Document
  if (message.type === 'WORKER_RPC') {
    return false
  }

  // Ignore OFFSCREEN_READY messages - they are handled by client.ts
  if (message.type === 'OFFSCREEN_READY') {
    return false
  }

  if (message.type === 'WORKER_LOG') {
    const rawLevel = message.level as string
    const forwardedEntry = parseDiagnosticLogDraft(message.entry)
    if (forwardedEntry) void appendDiagnosticLog(forwardedEntry).catch(() => {})

    if (!debugLogsEnabled && (message.level === 'log' || message.level === 'info')) {
      return false
    }
    if (message.walletId || message.level === 'error' || message.level === 'warn') {
      const fallbackPrefix = `[Worker ${rawLevel.toUpperCase()}]`
      const prefix = message.walletId
        ? logger.getPrefix(message.walletId, undefined, false)
        : fallbackPrefix
      const workerMessage = String(message.message).replace(/^\[Worker\]\s*/, '')
      const consoleLevel: 'log' | 'info' | 'warn' | 'error' =
        message.level === 'error' || message.level === 'warn' || message.level === 'info'
          ? message.level
          : 'log'
      console[consoleLevel](prefix, workerMessage)
    }
    return false
  }

  if (message.type === 'FORWARD_WALLET_LOG') {
    const { level, walletId, accountId, message: logMessage, error } = message.payload || {}
    if (typeof logMessage !== 'string') return false
    if (level === 'error') logger.error(logMessage, walletId, accountId, error)
    else if (level === 'warn') logger.warn(logMessage, walletId, accountId, error)
    else if (level === 'info') logger.info(logMessage, walletId, accountId, error)
    else logger.log(logMessage, walletId, accountId, error)
    return false
  }

  // Forward logs from Popup/Offscreen to Background for unified debugging
  if (message.type === 'FORWARD_LOG') {
    const { level, args } = message.payload
    if (!debugLogsEnabled && (level === 'log' || level === 'info')) {
      return false
    }
    const consoleLevel: 'log' | 'info' | 'warn' | 'error' =
      level === 'error' || level === 'warn' || level === 'info' ? level : 'log'
    console[consoleLevel](...args)
    return false
  }

  if (message.type === 'ANALYTICS_EVENT' || message.type === 'ANALYTICS_PAGE_VIEW') {
    handleAnalyticsMessage(message)
    return false
  }

  // Sender validation: DAPP_REQUEST must come from content-script (has tab)
  // All other messages must come from our own extension
  if (message.type === 'DAPP_REQUEST') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
    if (!sender.tab?.id) {
      sendResponse({
        requestId,
        error: 'Unauthorized: DAPP_REQUEST must originate from a content script'
      })
      return true
    }
  } else if (sender.id !== chrome.runtime.id) {
    return false
  }

  if (message.type === 'SET_EXTENSION_DISPLAY_MODE') {
    if (typeof message.sidePanelMode !== 'boolean') {
      sendResponse({ success: false, error: 'Invalid extension display mode' })
      return true
    }

    const updateDisplayMode = async () => {
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

  if (message.type === 'DAPP_REQUEST') {
    const { chainId, origin, request } = message
    const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
    const method = typeof request?.method === 'string' ? request.method : 'unknown'
    const respond = (response: { result: unknown } | { error: string }) => {
      if (debugLogsEnabled) {
        console.log('[Background] DApp response:', {
          method,
          requestId: requestId ?? 'missing',
          status: 'error' in response ? 'error' : 'success'
        })
      }
      sendResponse({ requestId, ...response })
    }

    if (!request || typeof request.method !== 'string') {
      respond({ error: 'Invalid dApp request' })
    } else if (chainId === 'zcash') {
      // Handle disconnect separately
      if (request.method === 'zcash_disconnect') {
        handleDAppDisconnect(origin || sender.origin)
          .then(result => respond({ result }))
          .catch(error =>
            respond({ error: error instanceof Error ? error.message : String(error) })
          )
        return true
      }

      // Handle other requests
      handleDAppRequest(request, origin || sender.origin)
        .then(result => respond({ result }))
        .catch(error => respond({ error: error instanceof Error ? error.message : String(error) }))
    } else {
      respond({ error: `Unsupported chain: ${String(chainId)}` })
    }

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

  if (message.type === 'GET_CONNECTED_DAPPS') {
    dappHandler
      .getAllConnectedDApps()
      .then(dapps => sendResponse({ dapps }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'GET_CURRENT_TAB_DAPP') {
    dappHandler
      .getCurrentTabDAppStatus()
      .then(status => sendResponse(status))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'CONNECT_CURRENT_ACCOUNT_TO_DAPP') {
    dappHandler
      .connectCurrentAccountToDApp(message.origin)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'DISCONNECT_DAPP') {
    dappHandler
      .revokePermission(message.origin)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'WALLET_CREATED') {
    rehydrateWalletStore()
      .then(() => accountManager.initialize())
      .then(() => {
        logger.log(
          'AccountManager re-initialized after wallet creation',
          useWalletStore.getState().currentWalletId || undefined
        )
        syncScheduler.onRequestSync('wallet-change')
        sendResponse({ success: true })
      })
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'PREPARE_ACCOUNT_REMOVAL') {
    const walletId = message.walletId as string | undefined
    if (!walletId) {
      sendResponse({ error: 'Wallet not found' })
      return true
    }
    syncScheduler
      .prepareWalletRemoval(walletId)
      .then(() => accountManager.discardWalletSnapshotForAccountRemoval(walletId))
      .then(() => sendResponse({ success: true }))
      .catch(error => {
        syncScheduler.finishAccountRemoval(walletId)
        sendResponse({ error: error.message })
      })
    return true
  }

  if (message.type === 'FINISH_ACCOUNT_REMOVAL') {
    const walletId = message.walletId as string | undefined
    const accountId = message.accountId as string | undefined
    const derivationIndex = message.derivationIndex as number | undefined
    if (!walletId) {
      sendResponse({ error: 'Wallet not found' })
      return true
    }
    Promise.resolve()
      .then(async () => {
        await rehydrateWalletStore()
        if (accountId && !useWalletStore.getState().getAccount(walletId, accountId)) {
          await useAccountDataStore
            .getState()
            .deleteAccountData(accountManager.getNetwork(), walletId, accountId, derivationIndex)
        }
      })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
      .finally(() => {
        syncScheduler.finishAccountRemoval(walletId)
      })
    return true
  }

  if (message.type === 'WALLET_REMOVED') {
    const walletId = message.walletId as string | undefined
    Promise.resolve()
      .then(async () => {
        if (walletId) {
          await syncScheduler.prepareWalletRemoval(walletId)
          await accountManager.purgeWalletRemnants(walletId)
        }
        await rehydrateWalletStore()
      })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'WALLET_REMOVAL_COMMITTED') {
    rehydrateWalletStore()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'WALLET_LOCKED') {
    handleWalletLock()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'ACCOUNT_SWITCHED') {
    rehydrateWalletStore()
      .catch(() => {})
      .then(async () => {
        if (message.walletId && message.accountId) {
          if (!useWalletStore.getState().getAccount(message.walletId, message.accountId)) {
            throw new Error('Account not found')
          }
          useWalletStore.getState().setCurrentAccount(message.walletId, message.accountId)
          syncScheduler.onAccountSwitched(message.walletId, message.accountId)
        }
        return handleAccountSwitched()
      })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'SHIELDED_ADDRESS_CHANGED') {
    const addresses = message.addresses
    const hasLatestAddresses = Boolean(
      message.walletId && message.accountId && addresses?.transparent && addresses?.shielded
    )
    const notifyPromise = hasLatestAddresses
      ? dappHandler.notifyAccountAddressesChanged({
          walletId: message.walletId,
          accountId: message.accountId,
          accounts: {
            transparent: addresses.transparent,
            shielded: addresses.shielded
          }
        })
      : rehydrateWalletStore()
          .catch(() => {})
          .then(() => handleAccountSwitched())

    notifyPromise
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'RPC_ENDPOINT_CHANGED') {
    waitForHydration()
      .then(() => accountManager.applyRpcEndpointChange(message.preferences))
      .then(() => {
        syncScheduler.onRequestSync('rpc-change')
        sendResponse({ success: true })
      })
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'GET_ZERO_INDEXER_ENABLED') {
    readZeroIndexerEnabled()
      .then(enabled => sendResponse({ success: true, enabled }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'SET_ZERO_INDEXER_ENABLED') {
    if (typeof message.enabled !== 'boolean') {
      sendResponse({ error: 'Invalid privacy broadcast preference' })
      return false
    }
    updateZeroIndexerPreference(message.enabled)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'GET_ZERO_INDEXER_OPTIONS') {
    if (message.network !== DEFAULT_NETWORK) {
      sendResponse({ success: false, error: 'Invalid privacy broadcast network' })
      return false
    }
    readZeroIndexerEnabled()
      .then(enabled => getZeroIndexerBroadcastOptions(DEFAULT_NETWORK, enabled))
      .then(options => sendResponse({ success: true, options }))
      .catch(() =>
        sendResponse({ success: false, error: 'Could not load privacy broadcast configuration' })
      )
    return true
  }

  if (message.type === 'GET_ZERO_INDEXER_NODES') {
    getZeroIndexerNodeStatus()
      .then(result => sendResponse({ success: true, result }))
      .catch(() => sendResponse({ success: false, error: 'Could not load ZeroIndexer nodes' }))
    return true
  }

  if (
    message.type === 'REFRESH_ZERO_INDEXER_NODES' ||
    message.type === 'SELECT_ZERO_INDEXER_NODE' ||
    message.type === 'ADD_CUSTOM_ZERO_INDEXER_NODE' ||
    message.type === 'REMOVE_CUSTOM_ZERO_INDEXER_NODE'
  ) {
    enqueueZeroIndexerUpdate(async () => {
      switch (message.type) {
        case 'REFRESH_ZERO_INDEXER_NODES':
          await getZeroIndexerNodeStatus(true)
          break
        case 'SELECT_ZERO_INDEXER_NODE':
          await selectZeroIndexerNode(message.endpointId)
          break
        case 'ADD_CUSTOM_ZERO_INDEXER_NODE':
          await addCustomZeroIndexerNode(message.label, message.url)
          break
        case 'REMOVE_CUSTOM_ZERO_INDEXER_NODE':
          await removeCustomZeroIndexerNode(message.endpointId)
          break
      }
      const applied = await applyZeroIndexerRuntime()
      return { result: await getZeroIndexerNodeStatus(), ...applied }
    })
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Could not update ZeroIndexer nodes'
        })
      )
    return true
  }

  if (message.type === 'ADD_CUSTOM_RPC_ENDPOINT') {
    addCustomRpcEndpoint(message.chain, message.label, message.url)
      .then(applyRpcSettingsMutation)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'GET_RPC_ENDPOINT_STATUS') {
    getRpcEndpointStatus()
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'SELECT_AUTOMATIC_RPC_ENDPOINT') {
    selectAutomaticRpcEndpoint(message.chain)
      .then(applyRpcSettingsMutation)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'SELECT_RPC_ENDPOINT') {
    selectRpcEndpoint(message.chain, message.endpointId)
      .then(applyRpcSettingsMutation)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ error: error.message }))
    return true
  }

  if (message.type === 'REMOVE_CUSTOM_RPC_ENDPOINT') {
    removeCustomRpcEndpoint(message.chain, message.endpointId)
      .then(applyRpcSettingsMutation)
      .then(result => sendResponse({ success: true, result }))
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
    estimateApprovalFee(message.requestId, message)
      .then(estimate => sendResponse(estimate))
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
      .then(() => syncScheduler.onRequestSync(normalizeSyncTrigger(message.trigger)))
      .catch(console.warn)
    sendResponse({ success: true })
    return true
  }

  if (message.type === 'BACKGROUND_ZCASH_TX') {
    // Execute Zcash on-chain tx in background - survives popup close
    handleBackgroundZcashTx(message).catch(console.warn)
    sendResponse({ success: true })
    return true
  }

  if (message.type === 'HW_PCZT_BUILD') {
    // Build the hardware-signing PCZT in the background so sync is paused and the
    // account is restored before building (avoids "Account not initialized").
    handleHardwarePcztBuild(message)
      .then(sendResponse)
      .catch(err =>
        sendResponse({ success: false, error: err?.message || 'Failed to build transaction' })
      )
    return true
  }

  if (message.type === 'HW_PCZT_FINALIZE') {
    handleHardwarePcztFinalize(message)
      .then(sendResponse)
      .catch(err =>
        sendResponse({ success: false, error: err?.message || 'Failed to send transaction' })
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

  if (message.type === 'REFRESH_INTENTS_PROGRESS') {
    transactionMonitor
      .refreshProgress(message.accountKey, message.depositAddress)
      .then(progress => sendResponse({ success: true, progress }))
      .catch(err =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to refresh Intents progress'
        })
      )
    return true
  }

  if (message.type === 'REMOVE_INTENTS_PROGRESS_FOR_ACCOUNTS') {
    transactionMonitor
      .removeProgressForAccounts(Array.isArray(message.accountKeys) ? message.accountKeys : [])
      .then(() => sendResponse({ success: true }))
      .catch(err =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to remove Intents progress'
        })
      )
    return true
  }

  if (message.type === 'CLEAR_INTENTS_PROGRESS') {
    transactionMonitor
      .clearProgress()
      .then(() => sendResponse({ success: true }))
      .catch(err =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to clear Intents progress'
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
    transactionMonitor.recheckNow().catch(console.warn)
    const { currentNetwork, currentWalletId, currentAccountId, wallets } = useWalletStore.getState()
    const currentWallet = wallets.find(wallet => wallet.id === currentWalletId)
    const currentAccountKey = `${currentNetwork}_${currentWalletId}_${currentAccountId}`
    const accountKey =
      typeof message.accountKey === 'string' &&
      currentWallet?.accounts.some(account => account.id === currentAccountId) &&
      message.accountKey === currentAccountKey
        ? currentAccountKey
        : undefined
    const recheck = accountKey
      ? zcashTxMonitor.restoreStuckWithdrawals([accountKey]).then(() => zcashTxMonitor.recheckNow())
      : zcashTxMonitor.recheckNow()
    recheck.catch(console.warn)
    sendResponse({ success: true })
    return true
  }

  if (message.type === 'GET_TRANSACTION_HISTORY') {
    accountManager
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
      .updateTransaction(accountKey, transactionId, updates)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }))
    return true
  }

  sendResponse({ success: true })
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
  if (accountManager.isLocked()) {
    console.log('[Background] Wallet locked, clearing permission cache')
    dappHandler.clearPermissions()
    return
  }

  // Restore permissions if not already done
  if (!accountManager.isLocked()) {
    await dappHandler.restorePermissionsFromStorage()
  }
}

async function handleDAppRequest(request: any, origin: string): Promise<any> {
  try {
    console.log('[Background] handleDAppRequest:', request.method, 'from:', origin)

    await ensureDAppHandlerReady()

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
        console.log('[Background] No wallet, proceeding to approval for onboarding')
        return await dappHandler.handleRequest({
          method: request.method,
          params: request.params,
          origin
        })
      }
    }

    // Non-silent methods require unlock
    if (!isSilentMethod) {
      const unlockRequired = await needsUnlock()

      if (unlockRequired) {
        console.log('[Background] Unlock required, opening window and waiting...')
        await promptUnlock()
        console.log('[Background] Unlock completed, continuing with request')
        // After unlock, continue to process the request (don't throw error)
      }
    }

    if (accountManager.isLocked()) {
      logger.log(
        'Background accountManager is locked, attempting session restore...',
        useWalletStore.getState().currentWalletId || undefined
      )
      const sessionPassword = await SecureStorage.getSessionPassword()
      if (sessionPassword) {
        await rehydrateWalletStore()
        const result = await accountManager.unlock(sessionPassword)
        if (result.success) {
          await accountManager.waitForAccountReady(20000)
          logger.log(
            'Background accountManager restored from session',
            useWalletStore.getState().currentWalletId || undefined
          )
        } else {
          logger.error('Failed to restore Background accountManager')
          throw new Error('Wallet not unlocked')
        }
      } else {
        logger.error('No session password available')
        throw new Error('Wallet not unlocked')
      }
    }

    // Process request
    return await dappHandler.handleRequest({
      method: request.method,
      params: request.params,
      origin
    })
  } catch (error: any) {
    console.warn('[Background] DApp request error:', error)
    throw error
  }
}

/**
 * Open unlock window and wait for unlock completion
 */
async function promptUnlock(): Promise<void> {
  await closeAllPopupWindows()

  // Create promise that resolves when unlock succeeds
  const unlockPromise = new Promise<void>((resolve, reject) => {
    const listener = async (message: any) => {
      if (message.type === 'UNLOCK_SUCCESS') {
        chrome.runtime.onMessage.removeListener(listener)
        console.log(
          '[Background] Unlock completed successfully, syncing Background accountManager...'
        )

        // Sync Background accountManager using session password
        try {
          const sessionPassword = await SecureStorage.getSessionPassword()
          if (sessionPassword) {
            await rehydrateWalletStore()
            const result = await accountManager.unlock(sessionPassword)
            if (result.success) {
              console.log('[Background] Background accountManager unlocked successfully')
              resolve()
            } else {
              console.warn('[Background] Failed to unlock Background accountManager')
              reject(new Error('Background unlock failed'))
            }
          } else {
            console.warn('[Background] No session password found')
            reject(new Error('No session password'))
          }
        } catch (error) {
          console.warn('[Background] Error unlocking Background accountManager:', error)
          reject(error)
        }
      }
    }
    chrome.runtime.onMessage.addListener(listener)

    // Timeout after 5 minutes
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener)
      reject(new Error('Unlock timeout'))
    }, 300000)
  })

  const lastWindow = await chrome.windows.getLastFocused()
  const windowWidth = UI_CONFIG.DAPP_WINDOW.WIDTH
  const windowHeight = UI_CONFIG.DAPP_WINDOW.HEIGHT

  const left =
    lastWindow?.left !== undefined && lastWindow?.width !== undefined
      ? lastWindow.left + lastWindow.width - windowWidth - 20
      : undefined
  const top = lastWindow?.top !== undefined ? lastWindow.top + 100 : undefined

  chrome.windows.create({
    url: 'index.html#unlock?from=dapp',
    type: 'popup',
    width: windowWidth,
    height: windowHeight,
    left: left,
    top: top,
    focused: true
  })

  console.log('[Background] Unlock window opened, waiting for completion...')

  // Wait for unlock to complete
  await unlockPromise
}

async function handleWalletUnlock(password: string): Promise<any> {
  try {
    await accountManager.initialize()
    const result = await accountManager.unlock(password)

    if (!result.success) {
      throw new Error('Invalid password')
    }

    // Best-effort: wait for account restore, but don't block unlock on it
    // dApp permissions will be restored when account becomes ready
    accountManager
      .waitForAccountReady(15000)
      .then(async () => {
        await dappHandler.initialize()
        await dappHandler.restorePermissionsFromStorage()

        const account = await accountManager.getCurrentAccount()
        if (account) {
          await dappHandler.notifyAccountsChanged({
            transparent: account.addresses.transparent,
            shielded: account.addresses.shielded
          })
        }
      })
      .catch(err => {
        console.warn('[Background] Account ready timeout, dApp restore deferred:', err)
      })

    await SecureStorage.saveLastActivityTime()
    console.log('[Background] Activity time reset after unlock')

    return { success: true }
  } catch (error: any) {
    console.warn('Unlock error:', error)
    throw error
  }
}

/**
 * Handle wallet lock event
 * Preserves dApp connections (EIP-1193 standard: lock ≠ disconnect)
 */
async function handleWalletLock(): Promise<void> {
  await accountManager.lock()
  dappHandler.clearPermissions()
  await dappHandler.notifyAccountsChanged([])
  console.log('[Background] Wallet locked, background context cleared, dApps notified')
}

/**
 * Handle account switch event
 * Notifies all connected dApps about the account change
 */
async function handleAccountSwitched(): Promise<void> {
  try {
    const account = accountManager.getCurrentAccount()

    if (account) {
      await dappHandler.notifyAccountsChanged({
        transparent: account.addresses.transparent,
        shielded: account.addresses.shielded
      })
    } else {
      await dappHandler.notifyAccountsChanged([])
    }
  } catch (error) {
    console.warn('[Background] Account switch notification error:', error)
    await dappHandler.notifyAccountsChanged([]).catch(() => {})
  }
}

/**
 * Handle dApp disconnect request
 * Removes connection from storage and clears permissions
 */
async function handleDAppDisconnect(origin: string): Promise<boolean> {
  try {
    await dappHandler.revokePermission(origin)
    console.log('[Background] Disconnected dApp:', origin)
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
    syncScheduler.pauseForTx(walletId)
    const syncWaitMs = WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS
    const syncIdle = walletId
      ? await syncScheduler.waitForWalletSyncIdle(walletId, syncWaitMs)
      : await syncScheduler.waitForActiveSyncIdle(syncWaitMs)
    if (!syncIdle) {
      throw new Error('The current sync batch is still finishing. Please try again shortly.')
    }
    return await fn()
  } finally {
    syncScheduler.resumeAfterTx(walletId)
  }
}

/**
 * Rehydrate state, unlock from the session if needed, restore the account into
 * the wallet core and return it ready for a transaction. Must run inside
 * withTxSyncPause so the account restore isn't blocked by an active sync.
 */
async function prepareWalletCoreForTx(walletId?: string, accountId?: string) {
  await rehydrateWalletStore()
  await accountManager.initialize()

  if (accountManager.isLocked()) {
    const sessionPassword = await SecureStorage.getSessionPassword()
    if (!sessionPassword) {
      throw new Error('Wallet locked and no session password available')
    }
    const result = await accountManager.unlock(sessionPassword)
    if (!result.success) {
      throw new Error('Failed to unlock wallet in background')
    }
  }

  if (walletId && accountId) {
    await accountManager.ensureWalletCoreAccount(walletId, accountId)
  }
  await accountManager.waitForAccountReady(30000)

  return accountManager.getWalletCore(walletId || undefined)
}

/**
 * Build an unsigned PCZT for a hardware signing flow in the background, using
 * the same sync-pause/account-restore coordination as software sends. Returns
 * the full PCZT (kept by the signing tab) plus the redacted copy sent to the
 * external signer, so building during sync waits instead of failing with
 * "Account not initialized".
 */
async function handleHardwarePcztBuild(params: {
  walletId: string
  accountId: string
  kind: HardwareSignKind
  to?: string
  amount?: string
  maxTransfer?: boolean
  memo?: string
  fundingSource?: FundingSource
  marginalFeeZats?: number
  feeQuoteId?: string
}): Promise<
  | {
      success: true
      full: string
      redacted: string
      feeZats?: string
      amount?: string
      ledgerDisplayAddress?: string
    }
  | { success: false; error: string }
> {
  const { walletId, accountId, kind, to, amount, maxTransfer, memo, marginalFeeZats, feeQuoteId } =
    params
  const fundingSource = params.fundingSource ?? 'shielded'
  try {
    if (fundingSource !== 'shielded' && fundingSource !== 'transparent') {
      throw new Error('Invalid transaction funding source')
    }
    const built = await withTxSyncPause(walletId, async () => {
      while (true) {
        try {
          const wallet = useWalletStore.getState().getWallet(walletId)
          const unavailableReason = getFundingSourceUnavailableReason(
            wallet?.keySource,
            fundingSource
          )
          if (unavailableReason) throw new Error(unavailableReason)
          const walletCore = await prepareWalletCoreForTx(walletId, accountId)
          if (kind === 'shield' || fundingSource === 'transparent') {
            await prepareTransparentSpend(
              walletCore,
              kind === 'shield' || maxTransfer ? undefined : amount
            )
            logger.log(
              '[Tx Preflight] Refreshed transparent UTXOs before hardware build',
              walletId,
              accountId
            )
          }
          let effectiveAmount = amount
          if (maxTransfer) {
            if (kind !== 'send' || !to) {
              throw new Error('Max transfer recalculation is only supported for sends')
            }
            const estimate = await walletCore.estimateMaxTransfer(
              to,
              memo,
              marginalFeeZats,
              fundingSource,
              feeQuoteId
            )
            effectiveAmount = safeBig(estimate.maxAmountZats).div(1e8).toFixed()
            if (!safeBig(effectiveAmount).gt(0)) {
              throw new Error('No spendable balance is available for this transaction')
            }
          }
          const pair =
            kind === 'shield'
              ? await walletCore.pcztShieldCreate(marginalFeeZats, feeQuoteId)
              : await walletCore.pcztCreate({
                  to: to!,
                  amount: effectiveAmount!,
                  memo,
                  fundingSource,
                  marginalFeeZats,
                  feeQuoteId
                })
          const feeEstimate = await (kind === 'shield'
            ? walletCore.estimateShieldFee(marginalFeeZats, feeQuoteId)
            : walletCore.estimateTransferFee(
                to!,
                effectiveAmount!,
                memo,
                marginalFeeZats,
                fundingSource,
                feeQuoteId
              ))
          return { ...pair, feeZats: feeEstimate.feeZats, amount: effectiveAmount }
        } catch (error) {
          const switched = await syncScheduler.failoverRpcEndpoint(error)
          if (!switched) throw error
          logger.warn(
            '[RPC FAILOVER] retrying hardware transaction build',
            walletId,
            undefined,
            error
          )
        }
      }
    })
    return {
      success: true,
      full: built.full,
      redacted: built.redacted,
      feeZats: built.feeZats,
      amount: built.amount,
      ledgerDisplayAddress: built.ledgerDisplayAddress
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

async function ensurePendingTransactionRecord(
  accountKey: string,
  transactionId: string
): Promise<void> {
  if (typeof transactionId !== 'string' || !transactionId.trim()) {
    throw new Error('Missing transaction record')
  }
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

/** Prove and broadcast a device-signed PCZT at a safe sync batch boundary. */
async function handleHardwarePcztFinalize(params: {
  walletId: string
  accountId: string
  transactionId: string
  fullPczt: string
  signedPczt: string
}): Promise<
  { success: true; txHash: string } | { success: false; error: string; completionPending?: boolean }
> {
  const { walletId, accountId, transactionId, fullPczt, signedPczt } = params
  try {
    if (!walletId || !accountId || !fullPczt || !signedPczt) {
      throw new Error('Missing hardware transaction data')
    }

    const txHash = await withTxSyncPause(walletId, async () => {
      await ensurePendingTransactionRecord(
        buildAccountKey(accountManager.getNetwork(), walletId, accountId),
        transactionId
      )
      const walletCore = await prepareWalletCoreForTx(walletId, accountId)
      return walletCore.pcztProveSend(fullPczt, signedPczt)
    })
    return { success: true, txHash }
  } catch (error) {
    if (isTransactionSubmissionUnknown(error)) {
      await recordUncertainBroadcast(
        buildAccountKey(accountManager.getNetwork(), walletId, accountId),
        transactionId,
        error.txId
      ).catch(recordError => {
        logger.error(
          'Hardware uncertain broadcast could not be recorded',
          walletId,
          accountId,
          recordError
        )
      })
      return { success: false, error: TRANSACTION_PENDING_MESSAGE, completionPending: true }
    }
    if (error instanceof TimeoutError) {
      return { success: false, error: TRANSACTION_PENDING_MESSAGE, completionPending: true }
    }
    const message = error instanceof Error ? error.message : 'Failed to send transaction'
    return { success: false, error: getRetryableWalletRpcUserMessage(message) }
  }
}

/**
 * Handle Zcash on-chain transaction in background
 * Supports both 'send' and 'shield' actions.
 * Executes WASM call and updates transaction status,
 * so the operation completes even if popup is closed.
 */
async function handleBackgroundZcashTx(params: {
  action: 'send' | 'shield'
  walletId?: string
  accountId?: string
  accountKey: string
  transactionId: string
  txType?: TransactionType
  sendParams?: { to: string; amount: string; memo?: string; fundingSource?: FundingSource }
  marginalFeeZats?: number
  feeQuoteId?: string
  monitorParams?: {
    kind: 'swap'
    direction: 'from_zcash'
    depositAddress: string
    tokenInSymbol: string
    tokenOutSymbol: string
    amountIn: string
    amountOut: string
    usdAmount?: string
    actionName: string
    originChain?: string
    destinationChain?: string
    originAsset?: string
    destinationAsset?: string
    quoteExpiresAt?: number
  }
  analytics?: {
    onSuccess?: { name: string; options: TrackOptions }
    onFail?: { name: string; options: TrackOptions }
  }
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
    feeQuoteId,
    monitorParams,
    analytics
  } = params
  const actionLabel = action === 'shield' ? 'Shield' : 'Send'
  let onChainAmount = sendParams?.amount
  let broadcastTxHash: string | undefined
  logger.info(`Starting ${actionLabel} operation`, walletId, accountId)

  try {
    await withTxSyncPause(walletId, async () => {
      await ensurePendingTransactionRecord(accountKey, transactionId)
      const walletCore = await prepareWalletCoreForTx(walletId, accountId)
      const fundingSource = sendParams?.fundingSource ?? 'shielded'
      if (action === 'send' && fundingSource !== 'shielded' && fundingSource !== 'transparent') {
        throw new Error('Invalid transaction funding source')
      }

      if (action === 'shield' || fundingSource === 'transparent') {
        const freshBalance = await prepareTransparentSpend(
          walletCore,
          action === 'send' ? sendParams?.amount : undefined
        )
        logger.log(
          '[Tx Preflight] Refreshed transparent UTXOs before software send',
          walletId,
          accountId
        )

        if (action === 'shield') {
          if (!walletId || !accountId) {
            throw new Error('No account available. Please select an account and try again.')
          }
          const transparentBalance = getShieldableTransparentBalance(freshBalance)
          if (!hasEnoughTransparentBalanceToShield(transparentBalance)) {
            throw new Error(MIN_SHIELDING_BALANCE_MESSAGE)
          }
          onChainAmount = transparentBalance
          await transactionRecorder.updateTransaction(accountKey, transactionId, {
            amount: transparentBalance
          })
        }
      }

      let txid: string
      let txHashes: string[]
      if (action === 'shield') {
        const shieldResult = await walletCore.shieldFunds(marginalFeeZats, undefined, feeQuoteId)
        txid = shieldResult.txid
        txHashes = [txid]
        broadcastTxHash = txid
        if (shieldResult.amount) {
          onChainAmount = shieldResult.amount
        }
      } else {
        const transferResult = await walletCore.sendTransaction({
          ...sendParams!,
          fundingSource,
          marginalFeeZats,
          feeQuoteId
        })
        const successfulTransfer = requireSuccessfulTransfer(transferResult)
        txid = successfulTransfer.txHash
        txHashes = successfulTransfer.txHashes
        broadcastTxHash = txid
      }
      logger.info(`${actionLabel} broadcast completed`, walletId, accountId)
      const expiryHeight = await computeExpiryHeight(() => walletCore.getLatestBlock())
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
      } catch (error) {
        logger.warn(
          `${actionLabel} post-broadcast record update deferred`,
          walletId,
          accountId,
          error
        )
      }

      try {
        if (isOnChainTx) {
          await zcashTxMonitor.addTransaction({
            txHash: txid,
            accountKey,
            transactionId,
            amount: onChainAmount,
            type: isCrossChain ? txType : action,
            expiryHeight
          })
        }
      } catch (error) {
        logger.warn(`${actionLabel} post-broadcast monitoring deferred`, walletId, accountId, error)
      }

      try {
        if (isCrossChain && monitorParams) {
          await transactionMonitor.addTransaction({
            kind: monitorParams.kind,
            direction: monitorParams.direction,
            depositAddress: monitorParams.depositAddress,
            tokenInSymbol: monitorParams.tokenInSymbol,
            tokenOutSymbol: monitorParams.tokenOutSymbol,
            amountIn: monitorParams.amountIn,
            amountOut: monitorParams.amountOut,
            usdAmount: monitorParams.usdAmount,
            actionName: monitorParams.actionName,
            accountKey,
            transactionId,
            originChain: monitorParams.originChain,
            destinationChain: monitorParams.destinationChain,
            originAsset: monitorParams.originAsset,
            destinationAsset: monitorParams.destinationAsset,
            quoteExpiresAt: monitorParams.quoteExpiresAt
          })
        }
      } catch (error) {
        logger.warn(
          `${actionLabel} post-broadcast relay monitoring deferred`,
          walletId,
          accountId,
          error
        )
      }

      if (analytics?.onSuccess) {
        trackEvent(analytics.onSuccess.name, {
          ...analytics.onSuccess.options,
          extra: {
            ...analytics.onSuccess.options.extra,
            tx_hash: txid
          }
        })
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
        logger.warn('Post-send balance refresh failed', walletId, accountId, error)
        console.error('[Background] refreshAfterOnChainBroadcast failed:', error)
      })
    }
  } catch (error: any) {
    if (isTransactionSubmissionUnknown(error)) {
      await recordUncertainBroadcast(accountKey, transactionId, error.txId, error.txIds).catch(
        recordError => {
          logger.error(
            `${actionLabel} uncertain broadcast could not be recorded`,
            walletId,
            accountId,
            recordError
          )
        }
      )
      logger.warn(`${actionLabel} submission outcome pending`, walletId, accountId)
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
      logger.warn(`${actionLabel} post-broadcast completion deferred`, walletId, accountId, error)
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
      logger.warn(`${actionLabel} outcome pending after timeout`, walletId, accountId, error)
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
    logger.error(`${actionLabel} failed`, walletId, accountId, error)

    const rawMessage = error?.message || `${actionLabel} failed`
    const userMessage = getRetryableWalletRpcUserMessage(rawMessage)

    if (analytics?.onFail) {
      trackEvent(analytics.onFail.name, {
        ...analytics.onFail.options,
        extra: {
          ...analytics.onFail.options.extra,
          error: rawMessage.slice(0, 200)
        }
      })
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
      logger.error(`Failed to update ${actionLabel} transaction status`, walletId, accountId, e)
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
