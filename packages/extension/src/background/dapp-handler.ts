import { accountManager } from '../core/wallet/account-manager'
import {
  dappManager,
  getConnectionAccountRefs,
  type ConnectedDApp
} from '../core/dapp/dapp-manager'
import { syncScheduler } from './sync-scheduler'
import type {
  AccountData,
  FundingSource,
  Network,
  SendTransactionParams,
  WalletItem,
  ZcashBalance
} from '@/types'
import { UI_CONFIG } from '@/config/ui'
import { SIGNING_ACCOUNT_INDEX, WALLET_CONFIG } from '@/config/wallet'
import { marginalFeeForTier, type FeeTier } from '@/config/fee'
import { safeBig } from '@/lib/big'
import { closeAllPopupWindows } from './window-manager'
import { useWalletStore, rehydrateWalletStore } from '@/store/wallet-store'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import { pendingRequestsManager } from './pending-requests'
import { getApprovalContext } from './approval-context'
import { sleep } from '@/lib/utils'
import { logger } from '@/lib/logger'
import { getDiagnosticRpcMethod } from '@/lib/diagnostic-log'
import { ANALYTICS_EVENTS, PAGE_IDS, trackEvent } from '@/lib/analytics'
import { transactionRecorder } from './transaction-recorder'
import { zcashTxMonitor, computeExpiryHeight } from './zcash-tx-monitor'
import { catchUpAfterOnChainTx } from './tx-sync'
import { checkLendingMcaAccount } from '@/core/services/lending-service'
import { openHardwareSignTab } from '@/lib/hardware-tab'
import { TimeoutError } from '@/lib/async-utils'
import { TRANSACTION_PENDING_MESSAGE } from '@/lib/transaction-status-copy'
import {
  getHardwareDAppMethodUnavailableReason,
  isHardwareKeySource
} from '@/lib/hardware-capabilities'
import { fetchCachedIdentity, type IdentitySigningMode } from '@/core/wallet/identity-cache'
import {
  getRetryableWalletRpcUserMessage,
  isRetryableWalletRpcError,
  isStaleWalletRpcError,
  isSyncBusyError,
  WALLET_BUSY_MESSAGE
} from '@/core/zcash/wallet-rpc-errors'
import {
  getShieldableTransparentBalance,
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'
import { requireSuccessfulTransfer } from '@/core/zcash/transfer-result'
import { isTransparentZcashAddress } from '@/lib/zcash-memo'
import { shouldAutoConnectDApp } from '@/config/dapp-matches'
import { getFundingSourceUnavailableReason } from '@/lib/funding-source'
import { prepareTransparentSpend } from '@/core/wallet/transparent-spend-preflight'

interface DAppRequest {
  method: string
  params?: any[]
  origin: string
}

interface DAppPermission {
  origin: string
  accounts: string[]
  timestamp: number
}

/** One account exposed to a dApp through batch (multi-wallet) authorization. */
interface BatchAccount {
  id: string
  label: string
  walletId: string
  accountId: string
  addresses: { transparent: string; shielded: string }
}

interface BatchAccountBalance {
  id: string
  walletId: string
  accountId: string
  balance: ZcashBalance
  synced: boolean
}

export class DAppHandler {
  private permissions: Map<string, DAppPermission> = new Map()
  private isReady = false
  private signMessageInFlight = new Map<
    string,
    Promise<{
      signature: string
      pubkey: string
      address: string
      signingMode: 'derived' | 'current' | 'legacy_index0'
      originAddress?: string
    }>
  >()
  private initPromise: Promise<void> | null = null

  async initialize(): Promise<void> {
    // If already initialized, return immediately
    if (this.isReady) {
      console.log('[DAppHandler] Already initialized, skipping')
      return
    }

    // If initialization in progress, wait for it
    if (this.initPromise) {
      console.log('[DAppHandler] Initialization in progress, waiting...')
      return this.initPromise
    }

    // Start initialization
    this.initPromise = (async () => {
      await dappManager.initialize()

      // DON'T restore permissions here - will be called explicitly after account ready

      this.isReady = true
      console.log('[DAppHandler] Initialized')
    })()

    await this.initPromise
    this.initPromise = null
  }

  /**
   * Restore permissions from persistent storage
   * Called after wallet unlock to repopulate in-memory cache
   */
  async restorePermissionsFromStorage(): Promise<void> {
    const connectedDApps = await dappManager.getAllConnections()
    const account = accountManager.getCurrentAccount()

    for (const dapp of connectedDApps) {
      if (!account) continue
      if (await this.isCurrentAccountUnauthorized(dapp.origin)) continue
      this.setPermissionForAccount(dapp.origin, account)
    }

    console.log(
      `[DAppHandler] Restored ${this.permissions.size} permissions from storage (of ${connectedDApps.length} connections)`
    )
  }

  /**
   * Clear permissions cache on wallet lock
   */
  clearPermissions(): void {
    this.permissions.clear()
    pendingRequestsManager.cancelMatching(() => true)
    console.log('[DAppHandler] Cleared permissions cache')
  }

  private setPermissionForAccount(origin: string, account: AccountData): void {
    this.permissions.set(origin, {
      origin,
      accounts: [account.addresses.transparent, account.addresses.shielded],
      timestamp: Date.now()
    })
  }

  /**
   * Wait for DAppHandler initialization to complete
   */
  private async waitForReady(timeout = 20000): Promise<void> {
    const start = Date.now()
    while (!this.isReady && Date.now() - start < timeout) {
      await sleep(100)
    }
    if (!this.isReady) {
      throw new Error('DAppHandler initialization timeout')
    }
  }

  async handleRequest(request: DAppRequest): Promise<any> {
    try {
      return await this.dispatchRequest(request)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Internal retryable protocol errors (WALLET_DIRTY/SYNC_BUSY/STALE_WALLET_RPC)
      // must not leak to dApps as raw error codes
      if (isRetryableWalletRpcError(msg)) {
        const reason = isSyncBusyError(msg)
          ? 'sync busy'
          : isStaleWalletRpcError(msg)
            ? 'stale wallet RPC'
            : 'wallet dirty'
        logger.warn(
          `dApp ${getDiagnosticRpcMethod(request.method)} request deferred: ${reason}`,
          undefined,
          undefined,
          err
        )
        throw new Error(WALLET_BUSY_MESSAGE)
      }
      throw err
    }
  }

  private async dispatchRequest(request: DAppRequest): Promise<any> {
    // Guard against requests before ready
    if (!this.isReady) {
      await this.waitForReady()
    }

    const { origin } = request

    console.log('[DAppHandler] Handling request:', request.method, 'from', origin)

    const wallet = useWalletStore.getState().getCurrentWallet()
    const hardwareUnavailableReason = getHardwareDAppMethodUnavailableReason(
      wallet?.keySource,
      request.method
    )
    if (hardwareUnavailableReason) {
      await this.ensurePermission(origin)
      throw new Error(hardwareUnavailableReason)
    }

    switch (request.method) {
      case 'zcash_getAccounts':
        return this.getAccounts(origin)

      case 'zcash_requestAccounts':
        return this.requestAccounts(origin)

      case 'zcash_getBalance':
        return this.getBalance(origin, request.params?.[0]?.accountId)

      case 'zcash_getMaxTransfer':
        return this.getMaxTransfer(origin, request.params?.[0])

      case 'zcash_getPublicKey':
        return this.getPublicKey(origin, request.params?.[0])

      case 'zcash_sendTransaction':
        return this.sendTransaction(origin, request.params?.[0])

      case 'zcash_signMessage':
        return this.signMessage(origin, request.params?.[0], request.params?.[1])

      case 'zcash_getAddresses':
        return this.getAddresses(origin)

      case 'zcash_shieldFunds':
        return this.shieldFunds(origin)

      case 'zcash_switchNetwork':
        throw new Error('zcash_switchNetwork is deprecated. Install the testnet extension instead.')

      case 'zcash_checkLendingMcaAccount':
        return this.checkLendingMcaAccount(origin)

      default:
        throw new Error(`Unknown method: ${request.method}`)
    }
  }

  private async getAccounts(
    origin: string
  ): Promise<{ transparent: string; shielded: string; accounts: BatchAccount[] } | null> {
    if (accountManager.isLocked()) {
      return null
    }

    if (shouldAutoConnectDApp(origin) && (await dappManager.canAutoConnect(origin))) {
      const accounts = await this.authorizeAllWalletAccounts(origin)
      const account = accountManager.getCurrentAccount()
      if (!account) return null
      return this.authorizedAccountResponse(origin, account, accounts)
    }

    if (await dappManager.isRevoked(origin)) return null

    if (this.permissions.has(origin)) {
      if (await this.isCurrentAccountUnauthorized(origin)) {
        this.permissions.delete(origin)
        return null
      }
      console.log('[DAppHandler] Returning cached accounts for:', origin)
      const account = await accountManager.getCurrentAccount()
      if (account) {
        return this.authorizedAccountResponse(origin, account, await this.resolveAccounts(origin))
      }
    }

    const isConnected = await dappManager.isConnected(origin)
    if (isConnected) {
      if (await this.isCurrentAccountUnauthorized(origin)) {
        return null
      }
      console.log('[DAppHandler] Restoring connection from storage for:', origin)

      if (!accountManager.isLocked()) {
        try {
          await accountManager.waitForAccountReady(15000)
        } catch (err) {
          console.warn('[DAppHandler] Account ready timeout, proceeding anyway:', err)
        }
      }

      if (await this.isCurrentAccountUnauthorized(origin)) {
        return null
      }

      const account = await accountManager.getCurrentAccount()
      if (account) {
        return this.authorizedAccountResponse(origin, account, await this.resolveAccounts(origin))
      }
    }

    console.log('[DAppHandler] No authorization found for:', origin)
    return null
  }

  private async authorizedAccountResponse(
    origin: string,
    account: AccountData,
    accounts: BatchAccount[]
  ) {
    const authorization = await dappManager.getAuthorization(origin)
    const { currentWalletId } = useWalletStore.getState()
    if (
      accountManager.isLocked() ||
      !authorization.accounts.some(
        ref => ref.walletId === currentWalletId && ref.accountId === account.id
      )
    ) {
      this.permissions.delete(origin)
      return null
    }
    this.setPermissionForAccount(origin, account)
    return {
      transparent: account.addresses.transparent,
      shielded: account.addresses.shielded,
      accounts: accounts.filter(candidate =>
        authorization.accounts.some(
          ref => ref.walletId === candidate.walletId && ref.accountId === candidate.accountId
        )
      )
    }
  }

  private async requestAccounts(
    origin: string
  ): Promise<{ transparent: string; shielded: string; accounts: BatchAccount[] }> {
    const isConnected = await dappManager.isConnected(origin)
    const authorizationRevision = await dappManager.getAuthorizationRevision(origin)

    let chosen: BatchAccount[]
    if (shouldAutoConnectDApp(origin) && (await dappManager.canAutoConnect(origin))) {
      chosen = await this.authorizeAllWalletAccounts(origin)
    } else {
      // Always show the approval window so the user can review / add accounts,
      // even when the dApp is already authorized (MetaMask-style).
      console.log('[DAppHandler] Connect approval requested for:', origin)
      chosen = await this.runConnectApproval(origin)
      await this.applyConnectApproval(origin, chosen, authorizationRevision)
    }

    if (!isConnected) {
      trackEvent(ANALYTICS_EVENTS.DAPP_CONNECTED, {
        pageId: PAGE_IDS.DAPP,
        params: { origin },
        extra: { account_count: chosen.length }
      })
    }

    const account = accountManager.getCurrentAccount()
    if (!account) {
      throw new Error('No account available')
    }

    await dappManager.updateLastActive(origin)

    const { currentWalletId, currentAccountId, currentNetwork } = useWalletStore.getState()

    const balance =
      currentWalletId && currentAccountId
        ? useAccountDataStore
            .getState()
            .getBalance(currentNetwork, currentWalletId, currentAccountId)
        : null
    if (!balance || (balance.transparent === '0' && balance.shielded === '0')) {
      console.log('[DAppHandler] No cached balance, triggering sync')
      syncScheduler.onRequestSync()
    }

    const accounts = await this.resolveAccounts(origin)
    await this.assertApprovedAccountAuthorized(
      origin,
      currentWalletId || '',
      account.id,
      authorizationRevision
    )
    this.setPermissionForAccount(origin, account)
    return {
      transparent: account.addresses.transparent,
      shielded: account.addresses.shielded,
      accounts
    }
  }

  private async getBalance(origin: string, accountId?: string): Promise<any> {
    await this.ensurePermission(origin)

    const { currentWalletId: walletId } = useWalletStore.getState()
    const currentAccountId = accountManager.getCurrentAccount()?.id
    const authorization = await dappManager.getAuthorization(origin)
    if (
      accountManager.isLocked() ||
      !walletId ||
      !currentAccountId ||
      !authorization.accounts.some(
        account => account.walletId === walletId && account.accountId === currentAccountId
      )
    ) {
      throw new Error('Wallet account or site connection changed. Reconnect and try again.')
    }

    syncScheduler.requestPassiveSync(WALLET_CONFIG.SYNC.DAPP_BALANCE_SYNC_STALE_MS)

    const zero: ZcashBalance = {
      transparent: '0',
      shielded: '0',
      total: '0',
      spendable: '0',
      available: '0',
      confirmed: { transparent: '0', shielded: '0' },
      pending: { transparent: '0', shielded: '0', total: '0' }
    }
    const accounts = await this.resolveAccountBalances(origin)
    const latestAuthorization = await dappManager.getAuthorization(origin)
    if (
      accountManager.isLocked() ||
      !useWalletStore.getState().getAccount(walletId, currentAccountId) ||
      latestAuthorization.revision !== authorization.revision ||
      !latestAuthorization.accounts.some(
        account => account.walletId === walletId && account.accountId === currentAccountId
      )
    ) {
      throw new Error('Wallet account or site connection changed. Reconnect and try again.')
    }
    const authorizedAccounts = accounts.filter(
      account =>
        !!useWalletStore.getState().getAccount(account.walletId, account.accountId) &&
        latestAuthorization.accounts.some(
          ref => ref.walletId === account.walletId && ref.accountId === account.accountId
        )
    )

    // `accountId` is the `${walletId}:${accountId}` key from `accounts`. When the
    // dApp targets a specific authorized account, surface that as the primary;
    // otherwise use the account connected when this request started.
    const primary = accountId
      ? (authorizedAccounts.find(account => account.id === accountId)?.balance ?? zero)
      : (authorizedAccounts.find(
          account => account.walletId === walletId && account.accountId === currentAccountId
        )?.balance ?? zero)

    return { ...primary, accounts: authorizedAccounts }
  }

  private async getMaxTransfer(
    origin: string,
    params: unknown
  ): Promise<{ maxAmount: string; fee: string }> {
    await this.ensurePermission(origin)
    if (accountManager.isLocked()) {
      throw new Error('Wallet is locked')
    }
    if (!params || typeof params !== 'object') {
      throw new Error('Invalid params: expected an object')
    }

    const input = params as Record<string, unknown>
    if (typeof input.to !== 'string' || input.to.length === 0) {
      throw new Error('Invalid params: "to" must be a non-empty string')
    }
    if (input.memo !== undefined && typeof input.memo !== 'string') {
      throw new Error('Invalid params: "memo" must be a string')
    }
    if (input.memo && new TextEncoder().encode(input.memo as string).length > 512) {
      throw new Error('Invalid params: "memo" exceeds maximum size of 512 bytes')
    }
    if (input.feeTier !== undefined && input.feeTier !== 'standard' && input.feeTier !== 'fast') {
      throw new Error('Invalid params: "feeTier" must be "standard" or "fast"')
    }
    if (!this.isValidZcashAddress(input.to)) {
      throw new Error(
        'Invalid params: "to" is not a valid Zcash transparent, TEX, shielded, or unified address.'
      )
    }
    if (input.memo && isTransparentZcashAddress(input.to)) {
      throw new Error('Invalid params: memo is only supported for shielded recipients (zs/u1)')
    }
    const fundingSource = this.validateFundingSource(input)
    const accounts = await this.resolveAccounts(origin)
    const current = accountManager.getCurrentAccount()
    const currentWalletId = useWalletStore.getState().currentWalletId
    const target = accounts.find(
      account => account.walletId === currentWalletId && account.accountId === current?.id
    )
    if (!target) {
      throw new Error('Current account is not authorized')
    }

    const feeTier = input.feeTier === 'fast' ? 'fast' : 'standard'
    const core = await accountManager.getWalletCore(target.walletId, target.accountId)
    const feeQuote = await core.getFeeQuote()
    const estimate = await accountManager.estimateMaxTransferFor(
      target.walletId,
      target.accountId,
      input.to,
      input.memo as string | undefined,
      marginalFeeForTier(feeTier, feeQuote.standardMarginalFeeZats),
      fundingSource,
      feeQuote.id
    )
    return {
      maxAmount: safeBig(estimate.maxAmountZats).div(1e8).toFixed(),
      fee: safeBig(estimate.feeZats).div(1e8).toFixed()
    }
  }

  private mapToBatchAccount(
    wallet: WalletItem,
    account: AccountData,
    displayNames: Record<string, string>,
    multiAccount: boolean
  ): BatchAccount {
    const displayName = displayNames[`${wallet.id}_${account.id}`] || account.name
    return {
      id: `${wallet.id}:${account.id}`,
      label: multiAccount ? `${wallet.name} / ${displayName}` : wallet.name,
      walletId: wallet.id,
      accountId: account.id,
      addresses: {
        transparent: account.addresses.transparent,
        shielded: account.addresses.shielded
      }
    }
  }

  /** Every non-hidden account across all wallets — populates the batch approval picker. */
  private buildAllSelectableAccounts(): BatchAccount[] {
    const { wallets, accountDisplayNames } = useWalletStore.getState()
    const out: BatchAccount[] = []
    for (const wallet of wallets) {
      const visible = wallet.accounts.filter(a => !a.isHidden)
      for (const account of visible) {
        out.push(this.mapToBatchAccount(wallet, account, accountDisplayNames, visible.length > 1))
      }
    }
    return out
  }

  /** Every account across all wallets for the first-party zkNoir application. */
  private buildAllWalletAccounts(): BatchAccount[] {
    const { wallets, accountDisplayNames } = useWalletStore.getState()
    const out: BatchAccount[] = []
    for (const wallet of wallets) {
      for (const account of wallet.accounts) {
        out.push(
          this.mapToBatchAccount(wallet, account, accountDisplayNames, wallet.accounts.length > 1)
        )
      }
    }
    return out
  }

  /** Keep the trusted first-party connection synchronized without opening Connect approval. */
  private async authorizeAllWalletAccounts(origin: string): Promise<BatchAccount[]> {
    if (accountManager.isLocked()) {
      throw new Error('Wallet is locked')
    }

    const revision = await dappManager.getAuthorizationRevision(origin)
    await rehydrateWalletStore()
    const accounts = this.buildAllWalletAccounts()
    if (accounts.length === 0) {
      throw new Error('No wallets available to authorize')
    }

    const existingConnection = await dappManager.getConnection(origin)
    const existingIds = new Set(
      (await dappManager.getAuthorizedAccounts(origin)).map(
        account => `${account.walletId}:${account.accountId}`
      )
    )
    const accountSetChanged =
      existingIds.size !== accounts.length || accounts.some(account => !existingIds.has(account.id))

    if (!existingConnection || accountSetChanged) {
      await this.persistAuthorized(origin, accounts, { automatic: true })
    }

    const { currentWalletId } = useWalletStore.getState()
    const current = accountManager.getCurrentAccount()
    if (!currentWalletId || !current) {
      throw new Error('No account available')
    }

    if (
      existingConnection?.boundWalletId !== currentWalletId ||
      existingConnection?.boundAccountId !== current.id
    ) {
      await dappManager.updateConnectionBinding(origin, {
        walletId: currentWalletId,
        accountId: current.id
      })
    }

    await this.assertApprovedAccountAuthorized(origin, currentWalletId, current.id, revision)
    this.setPermissionForAccount(origin, current)
    return accounts
  }

  /** Resolve persisted batch authorization into live descriptors, skipping pruned accounts. */
  private async buildBatchAccounts(origin: string): Promise<BatchAccount[]> {
    const authorized = await dappManager.getAuthorizedAccounts(origin)
    if (authorized.length === 0) return []

    const { wallets, accountDisplayNames } = useWalletStore.getState()
    const out: BatchAccount[] = []
    for (const { walletId, accountId } of authorized) {
      const wallet = wallets.find(w => w.id === walletId)
      const account = wallet?.accounts.find(a => a.id === accountId)
      if (!wallet || !account) continue
      const multiAccount = wallet.accounts.filter(a => !a.isHidden).length > 1
      out.push(this.mapToBatchAccount(wallet, account, accountDisplayNames, multiAccount))
    }
    return out
  }

  /**
   * Authorized accounts for the `accounts[]` field. Falls back to the connected
   * account for pre-batch connections that have no persisted `authorizedAccounts`
   * yet, so already-connected dApps still receive a one-element array.
   */
  private async resolveAccounts(origin: string): Promise<BatchAccount[]> {
    if (accountManager.isLocked()) return []

    const batch = await this.buildBatchAccounts(origin)
    if (batch.length > 0) return batch

    const account = accountManager.getCurrentAccount()
    const { currentWalletId: walletId, wallets, accountDisplayNames } = useWalletStore.getState()
    if (!account || !walletId) return []
    const wallet = wallets.find(w => w.id === walletId)
    if (!wallet) return []
    const multiAccount = wallet.accounts.filter(a => !a.isHidden).length > 1
    return [this.mapToBatchAccount(wallet, account, accountDisplayNames, multiAccount)]
  }

  /** Cached balances for every authorized account; locked/unsynced report `synced: false`. */
  private async resolveAccountBalances(origin: string): Promise<BatchAccountBalance[]> {
    const accounts = await this.resolveAccounts(origin)
    if (accounts.length === 0) return []

    const { currentNetwork: network } = useWalletStore.getState()
    const locked = accountManager.isLocked()
    const zero: ZcashBalance = {
      transparent: '0',
      shielded: '0',
      total: '0',
      spendable: '0',
      available: '0',
      confirmed: { transparent: '0', shielded: '0' },
      pending: { transparent: '0', shielded: '0', total: '0' }
    }

    return accounts.map(({ id, walletId, accountId }) => {
      const cached = locked
        ? null
        : useAccountDataStore.getState().getBalance(network, walletId, accountId)
      return cached
        ? { id, walletId, accountId, balance: cached, synced: true }
        : { id, walletId, accountId, balance: { ...zero }, synced: false }
    })
  }

  /**
   * Drive the multi-select connect approval. Every account already associated
   * with this connection (batch selection plus the single-account binding) is
   * preselected, so re-auth defaults to the full Connected-dApps set; fresh
   * connects preselect the current account (MetaMask-style "single by
   * default, add more"). Returns the chosen accounts, or throws if the user
   * rejects or selects none.
   */
  private async runConnectApproval(origin: string): Promise<BatchAccount[]> {
    await rehydrateWalletStore()
    const available = this.buildAllSelectableAccounts()
    if (available.length === 0) {
      throw new Error('No wallets available to authorize')
    }

    const existing = await dappManager.getAuthorizedAccounts(origin)
    let preselectedIds = existing
      .map(a => `${a.walletId}:${a.accountId}`)
      .filter(id => available.some(a => a.id === id))
    if (preselectedIds.length === 0) {
      const currentWalletId = useWalletStore.getState().currentWalletId
      const current = accountManager.getCurrentAccount()
      const currentId = currentWalletId && current ? `${currentWalletId}:${current.id}` : null
      if (currentId && available.some(a => a.id === currentId)) {
        preselectedIds = [currentId]
      }
    }

    const { approved, selectedIds } = await this.requestUserApprovalWithId(origin, 'connect', {
      accounts: available,
      preselectedIds
    })
    if (!approved) {
      trackEvent(ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { origin, method: 'connect' }
      })
      throw new Error('User rejected the request')
    }

    const chosen = available.filter(a => selectedIds?.includes(a.id))
    if (chosen.length === 0) {
      throw new Error('No accounts selected')
    }
    return chosen
  }

  /** Persist the user's authorized account selection for `origin`. */
  private async persistAuthorized(
    origin: string,
    chosen: BatchAccount[],
    authorization?: { automatic?: boolean; expectedRevision?: number }
  ): Promise<void> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const currentTab = tabs[0]
    await dappManager.setAuthorizedAccounts(
      origin,
      { title: currentTab?.title, favIconUrl: currentTab?.favIconUrl },
      chosen.map(a => ({ walletId: a.walletId, accountId: a.accountId })),
      authorization
    )
  }

  /**
   * Persist the approved selection and bind the connection to an account the
   * user actually chose. When the wallet's active account is not part of the
   * selection, switch to the first chosen account so the new session is
   * immediately usable instead of starting logged out.
   */
  private async applyConnectApproval(
    origin: string,
    chosen: BatchAccount[],
    revision?: number
  ): Promise<void> {
    const { currentWalletId } = useWalletStore.getState()
    const current = accountManager.getCurrentAccount()
    const target =
      chosen.find(a => a.walletId === currentWalletId && a.accountId === current?.id) ?? chosen[0]

    await this.persistAuthorized(origin, chosen, { expectedRevision: revision })
    await dappManager.updateConnectionBinding(origin, {
      walletId: target.walletId,
      accountId: target.accountId
    })

    if (target.walletId !== currentWalletId || target.accountId !== current?.id) {
      await this.switchActiveAccount(target.walletId, target.accountId)
    }
  }

  /**
   * Switch the wallet's active account from a dApp flow. Mirrors the
   * ACCOUNT_SWITCHED background handling (wallet core restore + sync target)
   * and notifies every connected dApp according to its own authorization.
   */
  private async switchActiveAccount(walletId: string, accountId: string): Promise<void> {
    await accountManager.switchAccount(walletId, accountId)
    if (!accountManager.isLocked()) {
      await accountManager.ensureWalletCoreAccount(walletId, accountId)
    }
    syncScheduler.onAccountSwitched(walletId, accountId)

    const account = accountManager.getCurrentAccount()
    if (account) {
      await this.notifyAccountsChanged({
        transparent: account.addresses.transparent,
        shielded: account.addresses.shielded
      })
    }
  }

  private async getPublicKey(
    origin: string,
    options?: { signingMode?: 'derived' | 'current' | 'legacy_index0' }
  ): Promise<{
    pubkey: string
    address: string
    signingMode: 'derived' | 'current' | 'legacy_index0'
    originAddress?: string
  } | null> {
    await this.ensurePermission(origin)

    if (accountManager.isLocked()) {
      return null
    }

    const account = accountManager.getCurrentAccount()
    if (!account) {
      return null
    }

    const walletId = useWalletStore.getState().currentWalletId
    const accountId = account.id

    if (!walletId || !accountId) {
      return null
    }

    const walletCore = await accountManager.getWalletCore(walletId, accountId)
    const network = useWalletStore.getState().currentNetwork
    const mode: IdentitySigningMode = options?.signingMode ?? 'current'
    const identity = await fetchCachedIdentity(
      network,
      walletId,
      accountId,
      account.derivationIndex,
      mode,
      walletCore
    )
    return {
      pubkey: identity.pubkey,
      address: identity.address,
      signingMode: identity.signingMode,
      originAddress: identity.originAddress
    }
  }

  private validateFundingSource(params: Record<string, unknown>): FundingSource {
    const value = params.fundingSource
    if (value === undefined) return 'shielded'
    if (value !== 'shielded' && value !== 'transparent') {
      throw new Error('Invalid params: "fundingSource" must be "shielded" or "transparent"')
    }
    return value
  }

  private validateSendTransactionParams(
    params: unknown
  ): SendTransactionParams & { fundingSource: FundingSource } {
    if (!params || typeof params !== 'object') {
      throw new Error('Invalid params: expected an object')
    }
    const p = params as Record<string, unknown>
    if (typeof p.to !== 'string' || p.to.length === 0) {
      throw new Error('Invalid params: "to" must be a non-empty string')
    }
    if (typeof p.amount !== 'string' || p.amount.length === 0) {
      throw new Error('Invalid params: "amount" must be a non-empty string')
    }
    if (p.type !== undefined) {
      throw new Error('Invalid params: "type" field is not supported; use "fundingSource".')
    }
    if (p.memo !== undefined && typeof p.memo !== 'string') {
      throw new Error('Invalid params: "memo" must be a string')
    }
    if (p.memo && new TextEncoder().encode(p.memo as string).length > 512) {
      throw new Error('Invalid params: "memo" exceeds maximum size of 512 bytes')
    }
    if (p.memo && isTransparentZcashAddress(p.to)) {
      throw new Error('Invalid params: memo is only supported for shielded recipients (zs/u1)')
    }
    if (p.marginalFeeZats !== undefined) {
      throw new Error(
        'Invalid params: "marginalFeeZats" is not accepted; the fee tier is selected in the wallet.'
      )
    }
    const fundingSource = this.validateFundingSource(p)

    if (!this.isValidZcashAddress(p.to)) {
      throw new Error(
        'Invalid params: "to" is not a valid Zcash transparent, TEX, shielded, or unified address.'
      )
    }

    const amount = Number(p.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Invalid params: "amount" must be a positive number')
    }
    const decimals = p.amount.includes('.') ? p.amount.split('.')[1].length : 0
    if (decimals > 8) {
      throw new Error('Invalid params: "amount" exceeds maximum precision of 8 decimal places')
    }

    return {
      to: p.to,
      amount: p.amount,
      memo: p.memo as string | undefined,
      fundingSource
    }
  }

  private isValidZcashAddress(address: string): boolean {
    // Transparent: t1 (mainnet P2PKH, 35 chars) or t3 (mainnet P2SH, 35 chars)
    if (/^t[13][a-km-zA-HJ-NP-Z1-9]{33}$/.test(address)) return true
    // Unified address: u1 (Bech32m encoding, variable length, typically 213+ chars)
    if (/^u1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,}$/.test(address)) return true
    // Testnet unified address: utest1 (Bech32m encoding)
    if (/^utest1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,}$/.test(address)) return true
    // Sapling shielded: zs (mainnet, 78 chars)
    if (/^zs[a-km-zA-HJ-NP-Z1-9]{76}$/.test(address)) return true
    // Testnet transparent: tm (35 chars)
    if (/^tm[a-km-zA-HJ-NP-Z1-9]{33}$/.test(address)) return true
    // ZIP-320 transparent-source-only P2PKH addresses (Bech32m)
    if (/^(?:tex|textest)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/.test(address)) return true
    // Testnet shielded: ztestsapling (variable length)
    if (/^ztestsapling[a-km-zA-HJ-NP-Z1-9]{60,}$/.test(address)) return true
    return false
  }

  private validateSignMessageParam(message: unknown): asserts message is string {
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('Invalid params: message must be a non-empty string')
    }
    if (message.length > 10000) {
      throw new Error('Invalid params: message exceeds maximum length of 10000 characters')
    }
  }

  private async sendTransaction(origin: string, input: unknown): Promise<string> {
    const params = this.validateSendTransactionParams(input)
    const { fundingSource } = params
    await this.ensurePermission(origin)

    const {
      requestId,
      approved,
      walletId,
      accountId,
      authorizationRevision,
      marginalFeeZats,
      feeQuoteId,
      feeTier
    } = await this.requestUserApprovalWithId(origin, 'sendTransaction', params)

    if (!approved) {
      trackEvent(ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { origin, method: 'sendTransaction' }
      })
      throw new Error('User rejected the transaction')
    }
    try {
      await this.assertApprovedAccountAuthorized(origin, walletId, accountId, authorizationRevision)
    } catch (error) {
      chrome.runtime
        .sendMessage({
          type: 'DAPP_TX_RESULT',
          requestId,
          success: false,
          error: error instanceof Error ? error.message : 'Transaction authorization expired'
        })
        .catch(() => {})
      throw error
    }

    // Hardware wallets sign in a dedicated tab, which records the transaction
    // and reports the result back.
    const wallet = useWalletStore.getState().getWallet(walletId)
    const unavailableReason = getFundingSourceUnavailableReason(wallet?.keySource, fundingSource)
    if (unavailableReason) throw new Error(unavailableReason)
    if (isHardwareKeySource(wallet?.keySource)) {
      return this.sendTransactionViaHardware(
        origin,
        params,
        requestId,
        walletId,
        accountId,
        marginalFeeZats,
        'send',
        feeQuoteId,
        feeTier
      )
    }

    const txParams: SendTransactionParams = {
      ...params,
      fundingSource,
      marginalFeeZats,
      feeQuoteId,
      feeTier
    }

    const network = useWalletStore.getState().currentNetwork
    const accountKey = buildAccountKey(network, walletId, accountId)

    const sourceAccount = useWalletStore.getState().getAccount(walletId, accountId)
    if (!sourceAccount) throw new Error('Wallet account no longer available')
    const approvedAccountIndex = sourceAccount.derivationIndex
    const fromAddress = sourceAccount?.addresses[fundingSource] || ''
    let txPaused = false
    let transactionId: string | undefined
    let broadcastHash: string | undefined

    try {
      syncScheduler.pauseForTx(walletId)
      txPaused = true

      const syncIdle = await syncScheduler.waitForWalletSyncIdle(
        walletId,
        WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS
      )
      if (!syncIdle) {
        throw new Error('Wallet is syncing. Please try again after sync completes.')
      }

      const walletCore = await accountManager.getWalletCore(walletId, accountId)
      if (fundingSource === 'transparent') {
        await prepareTransparentSpend(walletCore, params.amount, approvedAccountIndex)
        logger.log(
          '[Tx Preflight] Refreshed transparent UTXOs before dApp send',
          walletId,
          accountId
        )
      }

      const feeEstimate = await walletCore.estimateTransferFee(
        params.to,
        params.amount,
        params.memo,
        marginalFeeZats,
        fundingSource,
        feeQuoteId
      )
      const feeZec = safeBig(feeEstimate.feeZats).div(1e8).toFixed()

      const tx = await transactionRecorder.addTransaction({
        accountKey,
        transaction: {
          txHash: '',
          status: 'pending',
          type: 'send',
          amount: params.amount,
          to: params.to,
          from: fromAddress,
          fromType: fundingSource,
          memo: params.memo || '',
          fee: feeZec,
          timestamp: Date.now(),
          network,
          notified: false
        }
      })
      transactionId = tx.id
      await this.assertApprovedAccountAuthorized(origin, walletId, accountId, authorizationRevision)
      const transferResult = await walletCore.sendTransaction(txParams, approvedAccountIndex)
      const { txHash: hash, txHashes } = requireSuccessfulTransfer(transferResult)
      broadcastHash = hash
      const expiryHeight = await computeExpiryHeight(() => walletCore.getLatestBlock())

      try {
        await transactionRecorder.updateTransaction(accountKey, tx.id, {
          txHash: hash,
          expiryHeight,
          ...(txHashes.length > 1
            ? { chainHashes: txHashes.map(txHash => ({ hash: txHash, chain: 'Zcash' })) }
            : {})
        })
      } catch (error) {
        logger.warn('dApp send post-broadcast record update deferred', walletId, accountId, error)
      }
      try {
        await zcashTxMonitor.addTransaction({
          txHash: hash,
          accountKey,
          transactionId: tx.id,
          amount: params.amount,
          type: 'send',
          expiryHeight
        })
      } catch (error) {
        logger.warn('dApp send post-broadcast monitoring deferred', walletId, accountId, error)
      }

      void catchUpAfterOnChainTx(walletId, accountId).catch(err => {
        logger.warn('Post-send catch-up failed, scheduling sync retry', walletId, accountId, err)
        console.error('[DAppHandler] catchUpAfterOnChainTx failed:', err)
        accountManager.requestSync('transaction')
      })

      chrome.runtime
        .sendMessage({
          type: 'DAPP_TX_RESULT',
          requestId,
          success: true,
          txHash: hash
        })
        .catch(() => {})

      trackEvent(ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
        pageId: PAGE_IDS.DAPP,
        hasTransaction: 1,
        inputAmount: params.amount,
        inputSymbol: 'ZEC',
        params: { origin },
        extra: { tx_hash: hash, funding_source: fundingSource }
      })
      return hash
    } catch (err: any) {
      if (broadcastHash) {
        chrome.runtime
          .sendMessage({ type: 'DAPP_TX_RESULT', requestId, success: true, txHash: broadcastHash })
          .catch(() => {})
        return broadcastHash
      }
      if (err instanceof TimeoutError) {
        chrome.runtime
          .sendMessage({
            type: 'DAPP_TX_RESULT',
            requestId,
            success: false,
            error: TRANSACTION_PENDING_MESSAGE,
            completionPending: true
          })
          .catch(() => {})
        throw new Error(TRANSACTION_PENDING_MESSAGE)
      }
      if (transactionId) {
        await transactionRecorder
          .updateTransaction(accountKey, transactionId, { status: 'failed', notified: true })
          .catch(() => {})
      }
      const rawMessage = err?.message || 'Transaction failed'
      const userMessage = getRetryableWalletRpcUserMessage(rawMessage)
      trackEvent(ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED, {
        pageId: PAGE_IDS.DAPP,
        inputAmount: params.amount,
        inputSymbol: 'ZEC',
        extra: { origin, funding_source: fundingSource, error: String(userMessage).slice(0, 200) }
      })
      chrome.runtime
        .sendMessage({
          type: 'DAPP_TX_RESULT',
          requestId,
          success: false,
          error: userMessage
        })
        .catch(() => {})

      throw new Error(userMessage)
    } finally {
      if (txPaused) {
        syncScheduler.resumeAfterTx(walletId)
      }
    }
  }

  /** Wait up to 10 minutes for the user to finish the hardware signing flow */
  private static readonly HARDWARE_SIGN_TIMEOUT_MS = 10 * 60 * 1000

  /**
   * Approved dApp transaction on a hardware wallet: hand off to the signing
   * tab, which builds the PCZT, records the transaction and reports back via
   * HW_SIGN_RESULT. Resolves with the txid for the dApp.
   */
  private async sendTransactionViaHardware(
    origin: string,
    params: SendTransactionParams,
    dappRequestId: string,
    walletId: string,
    accountId: string,
    marginalFeeZats?: number,
    kind: 'send' | 'shield' = 'send',
    feeQuoteId?: string,
    feeTier?: FeeTier
  ): Promise<string> {
    const tab = await openHardwareSignTab({
      kind,
      walletId,
      accountId,
      to: params.to,
      amount: params.amount,
      memo: params.memo,
      fundingSource: params.fundingSource ?? 'shielded',
      dappRequestId,
      origin,
      marginalFeeZats,
      feeQuoteId,
      feeTier
    })

    return new Promise<string>((resolve, reject) => {
      let settled = false

      const settle = (result: { txHash?: string; error?: string }) => {
        if (settled) return
        settled = true
        chrome.runtime.onMessage.removeListener(onMessage)
        chrome.tabs.onRemoved.removeListener(onTabRemoved)
        clearTimeout(timer)

        // Keep the approval window (if still open) in sync with the outcome
        chrome.runtime
          .sendMessage({
            type: 'DAPP_TX_RESULT',
            requestId: dappRequestId,
            success: !!result.txHash,
            txHash: result.txHash,
            error: result.error
          })
          .catch(() => {})

        if (result.txHash) {
          trackEvent(ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
            pageId: PAGE_IDS.DAPP,
            hasTransaction: 1,
            inputAmount: params.amount,
            inputSymbol: 'ZEC',
            params: { origin, amount: params.amount, hardware: true },
            extra: { tx_hash: result.txHash }
          })
          resolve(result.txHash)
        } else {
          trackEvent(ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED, {
            pageId: PAGE_IDS.DAPP,
            inputAmount: params.amount,
            inputSymbol: 'ZEC',
            extra: { origin, hardware: true, error: result.error?.slice(0, 200) }
          })
          reject(new Error(result.error || 'Transaction failed'))
        }
      }

      const onMessage = (msg: any) => {
        if (msg?.type === 'HW_SIGN_RESULT' && msg.requestId === dappRequestId) {
          settle(
            msg.success ? { txHash: msg.txHash } : { error: msg.error || 'Transaction failed' }
          )
        }
      }

      const onTabRemoved = (tabId: number) => {
        if (tabId === tab.id) {
          settle({ error: 'User cancelled the transaction' })
        }
      }

      // Don't close the tab on timeout: the user may still be signing, and
      // the tab records/broadcasts independently. The dApp just stops waiting.
      const timer = setTimeout(() => {
        settle({ error: 'Hardware signing timed out' })
      }, DAppHandler.HARDWARE_SIGN_TIMEOUT_MS)

      chrome.runtime.onMessage.addListener(onMessage)
      chrome.tabs.onRemoved.addListener(onTabRemoved)
    })
  }

  private async signMessage(
    origin: string,
    message: string,
    options?: { signingMode?: 'derived' | 'current' | 'legacy_index0' }
  ): Promise<{
    signature: string
    pubkey: string
    address: string
    signingMode: 'derived' | 'current' | 'legacy_index0'
    originAddress?: string
  }> {
    this.validateSignMessageParam(message)
    await this.ensurePermission(origin)

    const { approved, walletId, accountId, authorizationRevision } = await this.requestUserApproval(
      origin,
      'signMessage',
      { message }
    )

    if (!approved) {
      trackEvent(ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { origin, method: 'signMessage' }
      })
      throw new Error('User rejected the signature request')
    }
    await this.assertApprovedAccountAuthorized(origin, walletId, accountId, authorizationRevision)

    trackEvent(ANALYTICS_EVENTS.DAPP_MESSAGE_SIGNED, {
      pageId: PAGE_IDS.DAPP,
      extra: { origin, signing_mode: options?.signingMode ?? 'current' }
    })

    const mode: IdentitySigningMode = options?.signingMode ?? 'current'
    const dedupKey = `${walletId}:${accountId}:${message}:${mode}`
    const pending = this.signMessageInFlight.get(dedupKey)
    if (pending) {
      logger.log('dedup hit', walletId)
      return pending
    }

    const walletCore = await accountManager.getWalletCore(walletId, accountId)
    await this.assertApprovedAccountAuthorized(origin, walletId, accountId, authorizationRevision)
    const approvedAccount = useWalletStore.getState().getAccount(walletId, accountId)
    if (!approvedAccount) throw new Error('Wallet account no longer available')
    const approvedAccountIndex = approvedAccount.derivationIndex
    const promise = this.resolveSigningResult(
      options?.signingMode,
      () => walletCore.signMessage(message, approvedAccountIndex),
      accountIndex => walletCore.signMessage(message, accountIndex),
      () => walletCore.signMessage(message, undefined, 0)
    ).finally(() => {
      if (this.signMessageInFlight.get(dedupKey) === promise) {
        this.signMessageInFlight.delete(dedupKey)
      }
    })

    this.signMessageInFlight.set(dedupKey, promise)
    return promise
  }

  private async resolveSigningResult<T extends { pubkey?: string; address?: string }>(
    mode: 'derived' | 'current' | 'legacy_index0' | undefined,
    getCurrent: () => Promise<T>,
    getDerived: (accountIndex: number) => Promise<T>,
    getLegacy?: () => Promise<T>
  ): Promise<T & { signingMode: 'derived' | 'current' | 'legacy_index0'; originAddress?: string }> {
    if (mode === 'legacy_index0' && getLegacy) {
      const result = await getLegacy()
      return { ...result, signingMode: 'legacy_index0' }
    }
    if (mode === 'derived') {
      const [derived, main] = await Promise.all([getDerived(SIGNING_ACCOUNT_INDEX), getCurrent()])
      return { ...derived, signingMode: 'derived', originAddress: (main as any).address }
    }
    const result = await getCurrent()
    return { ...result, signingMode: 'current' }
  }

  private async getAddresses(origin: string): Promise<{ transparent: string; shielded: string }> {
    await this.ensurePermission(origin)
    const account = accountManager.getCurrentAccount()
    if (!account) throw new Error('No account available')
    const cachedAddresses = this.permissions.get(origin)?.accounts
    return {
      transparent: cachedAddresses?.[0] || account.addresses.transparent,
      shielded: cachedAddresses?.[1] || account.addresses.shielded
    }
  }

  private async shieldFunds(origin: string): Promise<string> {
    await this.ensurePermission(origin)

    const account = accountManager.getCurrentAccount()
    const { currentWalletId, currentNetwork } = useWalletStore.getState()
    const balance =
      account && currentWalletId
        ? useAccountDataStore.getState().getBalance(currentNetwork, currentWalletId, account.id)
        : null

    const {
      requestId,
      approved,
      walletId,
      accountId,
      authorizationRevision,
      marginalFeeZats,
      feeQuoteId,
      feeTier
    } = await this.requestUserApprovalWithId(origin, 'shieldFunds', {
      amount: getShieldableTransparentBalance(balance)
    })

    if (!approved) {
      trackEvent(ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { origin, method: 'shieldFunds' }
      })
      throw new Error('User rejected the shield request')
    }
    try {
      await this.assertApprovedAccountAuthorized(origin, walletId, accountId, authorizationRevision)
    } catch (error) {
      chrome.runtime
        .sendMessage({
          type: 'DAPP_TX_RESULT',
          requestId,
          success: false,
          error: error instanceof Error ? error.message : 'Transaction authorization expired'
        })
        .catch(() => {})
      throw error
    }

    const latestBalance = useAccountDataStore
      .getState()
      .getBalance(currentNetwork, walletId, accountId)
    const latestTransparentBalance = getShieldableTransparentBalance(latestBalance)
    if (!hasEnoughTransparentBalanceToShield(latestTransparentBalance)) {
      throw new Error(MIN_SHIELDING_BALANCE_MESSAGE)
    }
    const approvedWallet = useWalletStore.getState().getWallet(walletId)
    if (isHardwareKeySource(approvedWallet?.keySource)) {
      return this.sendTransactionViaHardware(
        origin,
        { to: '', amount: latestTransparentBalance },
        requestId,
        walletId,
        accountId,
        marginalFeeZats,
        'shield',
        feeQuoteId,
        feeTier
      )
    }

    const accountKey = buildAccountKey(currentNetwork, walletId, accountId)
    const approvedAccount = useWalletStore.getState().getAccount(walletId, accountId)
    if (!approvedAccount) throw new Error('Wallet account no longer available')
    const approvedAccountIndex = approvedAccount.derivationIndex
    let transactionId: string | undefined
    let broadcastHash: string | undefined
    try {
      syncScheduler.pauseForTx(walletId)

      const syncIdle = await syncScheduler.waitForWalletSyncIdle(
        walletId,
        WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS
      )
      if (!syncIdle) {
        throw new Error('Wallet is syncing. Please try again after sync completes.')
      }

      const walletCore = await accountManager.getWalletCore(walletId, accountId)
      const freshBalance = await prepareTransparentSpend(
        walletCore,
        undefined,
        approvedAccountIndex
      )
      const freshTransparentBalance = getShieldableTransparentBalance(freshBalance)
      if (!hasEnoughTransparentBalanceToShield(freshTransparentBalance)) {
        throw new Error(MIN_SHIELDING_BALANCE_MESSAGE)
      }
      const feeEstimate = await walletCore.estimateShieldFee(marginalFeeZats, feeQuoteId)
      const feeZec = safeBig(feeEstimate.feeZats).div(1e8).toFixed()
      const tx = await transactionRecorder.addTransaction({
        accountKey,
        transaction: {
          txHash: '',
          status: 'pending',
          type: 'shield',
          amount: freshTransparentBalance,
          to: approvedAccount?.addresses.shielded ?? '',
          from: approvedAccount?.addresses.transparent ?? '',
          fromType: 'transparent',
          memo: 'Shielding transparent funds',
          fee: feeZec,
          timestamp: Date.now(),
          network: currentNetwork,
          notified: false
        }
      })
      transactionId = tx.id
      await this.assertApprovedAccountAuthorized(origin, walletId, accountId, authorizationRevision)
      const shieldResult = await walletCore.shieldFunds(
        marginalFeeZats,
        approvedAccountIndex,
        feeQuoteId
      )
      const { txid } = shieldResult
      broadcastHash = txid
      const amount = shieldResult.amount ?? freshTransparentBalance
      const expiryHeight = await computeExpiryHeight(() => walletCore.getLatestBlock())

      try {
        await transactionRecorder.updateTransaction(accountKey, tx.id, {
          txHash: txid,
          amount,
          expiryHeight
        })
      } catch (error) {
        logger.warn('dApp shield post-broadcast record update deferred', walletId, accountId, error)
      }
      try {
        await zcashTxMonitor.addTransaction({
          txHash: txid,
          accountKey,
          transactionId: tx.id,
          amount,
          type: 'shield',
          expiryHeight
        })
      } catch (error) {
        logger.warn('dApp shield post-broadcast monitoring deferred', walletId, accountId, error)
      }

      void catchUpAfterOnChainTx(walletId, accountId).catch(err => {
        logger.warn('Post-shield catch-up failed', walletId, accountId, err)
        console.error('[DAppHandler] catchUpAfterOnChainTx failed:', err)
        accountManager.requestSync('transaction')
      })

      chrome.runtime
        .sendMessage({ type: 'DAPP_TX_RESULT', requestId, success: true, txHash: txid })
        .catch(() => {})

      return txid
    } catch (err: any) {
      if (broadcastHash) {
        chrome.runtime
          .sendMessage({ type: 'DAPP_TX_RESULT', requestId, success: true, txHash: broadcastHash })
          .catch(() => {})
        return broadcastHash
      }
      if (err instanceof TimeoutError) {
        chrome.runtime
          .sendMessage({
            type: 'DAPP_TX_RESULT',
            requestId,
            success: false,
            error: TRANSACTION_PENDING_MESSAGE,
            completionPending: true
          })
          .catch(() => {})
        throw new Error(TRANSACTION_PENDING_MESSAGE)
      }
      if (transactionId) {
        await transactionRecorder
          .updateTransaction(accountKey, transactionId, { status: 'failed', notified: true })
          .catch(() => {})
      }
      const rawMessage = err?.message || 'Shield failed'
      const userMessage = getRetryableWalletRpcUserMessage(rawMessage)

      chrome.runtime
        .sendMessage({ type: 'DAPP_TX_RESULT', requestId, success: false, error: userMessage })
        .catch(() => {})

      throw new Error(userMessage)
    } finally {
      syncScheduler.resumeAfterTx(walletId)
    }
  }

  private async checkLendingMcaAccount(origin: string) {
    await this.ensurePermission(origin)

    if (accountManager.isLocked()) {
      return null
    }

    const walletId = useWalletStore.getState().currentWalletId
    const account = accountManager.getCurrentAccount()
    if (!walletId || !account) {
      return null
    }

    return checkLendingMcaAccount(walletId, account.id)
  }

  /**
   * True when the wallet's active account must not be exposed to `origin`.
   * The authorized set (batch selection united with the single-account
   * binding) is the source of truth. Older connections without an account
   * association must reconnect before reading any current account.
   */
  private async isCurrentAccountUnauthorized(origin: string): Promise<boolean> {
    const connection = await dappManager.getConnection(origin)
    if (!connection) return true
    const authorized = getConnectionAccountRefs(connection)
    if (authorized.length === 0) {
      return true
    }
    const { currentWalletId } = useWalletStore.getState()
    const account = accountManager.getCurrentAccount()
    if (!account || !currentWalletId) {
      return true
    }
    return !authorized.some(a => a.walletId === currentWalletId && a.accountId === account.id)
  }

  private async ensurePermission(origin: string): Promise<void> {
    if (await dappManager.isRevoked(origin)) {
      this.permissions.delete(origin)
      throw new Error('Not authorized. Call zcash_requestAccounts first.')
    }
    if (shouldAutoConnectDApp(origin) && (await dappManager.canAutoConnect(origin))) {
      await this.authorizeAllWalletAccounts(origin)
      return
    }

    if (await this.isCurrentAccountUnauthorized(origin)) {
      this.permissions.delete(origin)
      throw new Error(
        'Wallet account no longer matches this site connection. Call zcash_requestAccounts to reconnect.'
      )
    }

    if (this.permissions.has(origin)) {
      return
    }

    const isConnected = await dappManager.isConnected(origin)
    if (isConnected) {
      console.log('[DAppHandler] Restoring permission from persistent storage for:', origin)
      const account = await accountManager.getCurrentAccount()
      if (account) {
        this.setPermissionForAccount(origin, account)
        return
      }
    }

    throw new Error('Not authorized. Call zcash_requestAccounts first.')
  }

  private async assertApprovedAccountAuthorized(
    origin: string,
    walletId: string,
    accountId: string,
    expectedRevision?: number
  ): Promise<void> {
    const authorization = await dappManager.getAuthorization(origin)
    if (
      accountManager.isLocked() ||
      !useWalletStore.getState().getAccount(walletId, accountId) ||
      (expectedRevision !== undefined && authorization.revision !== expectedRevision) ||
      !authorization.accounts.some(
        account => account.walletId === walletId && account.accountId === accountId
      )
    ) {
      throw new Error('Wallet account or site connection changed. Reconnect and try again.')
    }
  }

  private async requestUserApproval(
    origin: string,
    action: string,
    data?: any
  ): Promise<{
    approved: boolean
    walletId: string
    accountId: string
    authorizationRevision: number
  }> {
    const result = await this.requestUserApprovalWithId(origin, action, data)
    return {
      approved: result.approved,
      walletId: result.walletId,
      accountId: result.accountId,
      authorizationRevision: result.authorizationRevision
    }
  }

  private async requestUserApprovalWithId(
    origin: string,
    action: string,
    data?: any
  ): Promise<{
    approved: boolean
    requestId: string
    walletId: string
    accountId: string
    authorizationRevision: number
    marginalFeeZats?: number
    feeQuoteId?: string
    feeTier?: FeeTier
    feeZats?: number
    selectedIds?: string[]
  }> {
    console.log('[DAppHandler] Requesting user approval for:', action, 'from:', origin)

    const capturedWalletId = useWalletStore.getState().currentWalletId || ''
    const account = accountManager.getCurrentAccount()
    const capturedAccountId = account?.id || ''
    const network = useWalletStore.getState().currentNetwork
    const authorizationRevision = await dappManager.getAuthorizationRevision(origin)

    await closeAllPopupWindows()
    return new Promise(resolve => {
      const requestId = pendingRequestsManager.create(
        origin,
        action,
        data,
        capturedWalletId,
        capturedAccountId,
        network,
        authorizationRevision
      )

      let windowId: number | undefined
      let finished = false
      let checkInterval: ReturnType<typeof setInterval> | undefined
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const finish = (
        approved: boolean,
        extras?: {
          marginalFeeZats?: number
          feeQuoteId?: string
          feeTier?: FeeTier
          feeZats?: number
          selectedIds?: string[]
        }
      ) => {
        if (finished) return
        finished = true
        clearInterval(checkInterval)
        clearTimeout(timeoutId)
        chrome.runtime.onMessage.removeListener(messageListener)
        pendingRequestsManager.cancel(requestId)
        if (!approved && windowId !== undefined) {
          chrome.windows.remove(windowId).catch(() => {})
        }
        resolve({
          approved,
          requestId,
          walletId: capturedWalletId,
          accountId: capturedAccountId,
          authorizationRevision,
          marginalFeeZats: extras?.marginalFeeZats,
          feeQuoteId: extras?.feeQuoteId,
          feeTier: extras?.feeTier,
          feeZats: extras?.feeZats,
          selectedIds: extras?.selectedIds
        })
      }

      const messageListener = (msg: any) => {
        if (msg.type === 'DAPP_APPROVAL_RESULT' && msg.requestId === requestId) {
          void (async () => {
            if (msg.success) {
              await getApprovalContext(requestId)
            }
            finish(msg.success, {
              marginalFeeZats: msg.marginalFeeZats,
              feeQuoteId: msg.feeQuoteId,
              feeTier: msg.feeTier,
              feeZats: msg.feeZats,
              selectedIds: msg.selectedIds
            })
          })().catch(() => finish(false))
        }
      }

      chrome.runtime.onMessage.addListener(messageListener)
      pendingRequestsManager.onCancel(requestId, () => finish(false))
      timeoutId = setTimeout(() => {
        finish(false)
      }, 120000)

      void (async () => {
        await getApprovalContext(requestId)
        const lastWindow = await chrome.windows.getLastFocused()
        if (finished) return
        const width = UI_CONFIG.DAPP_WINDOW.WIDTH
        const height = UI_CONFIG.DAPP_WINDOW.HEIGHT
        const window = await chrome.windows.create({
          url: `index.html#approval?requestId=${requestId}`,
          type: 'popup',
          width,
          height,
          focused: true,
          left:
            lastWindow?.left !== undefined && lastWindow?.width !== undefined
              ? lastWindow.left + lastWindow.width - width - 20
              : undefined,
          top: lastWindow?.top !== undefined ? lastWindow.top + 100 : undefined
        })
        if (finished) {
          if (window?.id !== undefined) await chrome.windows.remove(window.id).catch(() => {})
          return
        }
        if (window?.id === undefined) {
          finish(false)
          return
        }
        windowId = window.id
        checkInterval = setInterval(() => {
          if (windowId === undefined) return
          chrome.windows.get(windowId, w => {
            if (chrome.runtime.lastError || !w) finish(false)
          })
        }, 500)
      })().catch(() => finish(false))
    })
  }

  async revokePermission(origin: string): Promise<void> {
    this.permissions.delete(origin)
    await dappManager.removeConnection(origin)
    pendingRequestsManager.cancelMatching(request => request.origin === origin)
    await this.broadcastEvent(origin, 'accountsChanged', null)
    trackEvent(ANALYTICS_EVENTS.DAPP_DISCONNECTED, {
      pageId: PAGE_IDS.DAPP,
      extra: { origin }
    })
  }

  getPermissions(): DAppPermission[] {
    return Array.from(this.permissions.values())
  }

  async getAllConnectedDApps() {
    return await dappManager.getAllConnections()
  }

  async getCurrentTabDApp() {
    return await dappManager.getCurrentTabDApp()
  }

  /**
   * Current-tab connection plus whether the wallet's active account is
   * authorized for it — drives the wallet-side connect prompt.
   */
  async getCurrentTabDAppStatus(): Promise<{
    dapp: ConnectedDApp | null
    currentAccountAuthorized: boolean
  }> {
    const dapp = await dappManager.getCurrentTabDApp()
    if (!dapp) {
      return { dapp: null, currentAccountAuthorized: false }
    }
    const unauthorized = await this.isCurrentAccountUnauthorized(dapp.origin)
    return { dapp, currentAccountAuthorized: !unauthorized }
  }

  /**
   * Wallet-side "Connect" prompt action (MetaMask-style bottom bar): add the
   * active account to the connection's authorized set, rebind, restore the
   * session permission and push the account to the dApp so it reconnects
   * without a page refresh.
   */
  async connectCurrentAccountToDApp(origin: string): Promise<void> {
    const conn = await dappManager.getConnection(origin)
    if (!conn) {
      throw new Error('No connection found for this site')
    }

    const { currentWalletId } = useWalletStore.getState()
    const account = accountManager.getCurrentAccount()
    if (!currentWalletId || !account) {
      throw new Error('No active account')
    }

    await dappManager.addAuthorizedAccount(origin, {
      walletId: currentWalletId,
      accountId: account.id
    })
    await dappManager.updateConnectionBinding(origin, {
      walletId: currentWalletId,
      accountId: account.id
    })
    this.setPermissionForAccount(origin, account)

    await this.broadcastEvent(origin, 'accountsChanged', {
      transparent: account.addresses.transparent,
      shielded: account.addresses.shielded
    })

    trackEvent(ANALYTICS_EVENTS.DAPP_CONNECTED, {
      pageId: PAGE_IDS.DAPP,
      params: { origin },
      extra: { source: 'wallet_prompt' }
    })
  }

  /**
   * Notify all connected dApps about account changes
   * @param accounts - Account info or lock/disconnect state
   *   - { transparent, shielded } = connected and unlocked
   *   - [] = connected but locked (EIP-1193 standard)
   *   - null = disconnected (only on explicit disconnect)
   */
  async notifyAccountsChanged(
    accounts: { transparent: string; shielded: string } | [] | null
  ): Promise<void> {
    console.log('[DAppHandler] Broadcasting accountsChanged:', accounts)

    const connectedDApps = await dappManager.getAllConnections()
    const isLock = Array.isArray(accounts) && accounts.length === 0

    if (isLock) {
      for (const dapp of connectedDApps) {
        try {
          await this.broadcastEvent(dapp.origin, 'accountsChanged', [])
        } catch (error) {
          console.error(`[DAppHandler] Failed to notify ${dapp.origin}:`, error)
        }
      }
      return
    }

    const { currentWalletId } = useWalletStore.getState()
    const current = accountManager.getCurrentAccount()

    for (const dapp of connectedDApps) {
      if (dapp.boundWalletId == null) {
        continue
      }

      if (!current || !currentWalletId) {
        this.permissions.delete(dapp.origin)
        await this.broadcastEvent(dapp.origin, 'accountsChanged', null)
        continue
      }

      // The authorized set (batch selection united with the single-account
      // binding) decides whether this dApp may see the active account.
      // Unauthorized: log the dApp out now (accountsChanged: null) instead of
      // serving a stale session until the next refresh; the persisted
      // connection is kept so switching back — or the wallet-side connect
      // prompt — reconnects. Authorized: rebind, restore the in-memory
      // permission (it may have been dropped by an earlier logout) and push
      // the new addresses.
      const isAuthorized = !(await this.isCurrentAccountUnauthorized(dapp.origin))

      if (!isAuthorized) {
        this.permissions.delete(dapp.origin)
        await this.broadcastEvent(dapp.origin, 'accountsChanged', null)
        continue
      }

      if (dapp.boundWalletId !== currentWalletId || dapp.boundAccountId !== current.id) {
        await dappManager.updateConnectionBinding(dapp.origin, {
          walletId: currentWalletId,
          accountId: current.id
        })
      }
      try {
        await this.assertApprovedAccountAuthorized(dapp.origin, currentWalletId, current.id)
      } catch {
        this.permissions.delete(dapp.origin)
        continue
      }
      this.setPermissionForAccount(dapp.origin, current)

      try {
        await this.broadcastEvent(
          dapp.origin,
          'accountsChanged',
          accounts || {
            transparent: current.addresses.transparent,
            shielded: current.addresses.shielded
          }
        )
      } catch (error) {
        console.error(`[DAppHandler] Failed to notify ${dapp.origin}:`, error)
      }
    }
  }

  async notifyAccountAddressesChanged(params: {
    walletId: string
    accountId: string
    accounts: { transparent: string; shielded: string }
  }): Promise<void> {
    console.log('[DAppHandler] Broadcasting bound account addressesChanged:', params)
    await rehydrateWalletStore()

    const connectedDApps = await dappManager.getAllConnections()

    for (const dapp of connectedDApps) {
      if (dapp.boundWalletId !== params.walletId || dapp.boundAccountId !== params.accountId) {
        continue
      }

      try {
        await this.assertApprovedAccountAuthorized(dapp.origin, params.walletId, params.accountId)
      } catch {
        this.permissions.delete(dapp.origin)
        continue
      }

      this.permissions.set(dapp.origin, {
        origin: dapp.origin,
        accounts: [params.accounts.transparent, params.accounts.shielded],
        timestamp: Date.now()
      })

      try {
        await this.broadcastEvent(dapp.origin, 'accountsChanged', params.accounts)
      } catch (error) {
        console.error(`[DAppHandler] Failed to notify ${dapp.origin}:`, error)
      }
    }
  }

  async notifyChainChanged(chainInfo: { chainId: string; network: string }): Promise<void> {
    console.log('[DAppHandler] Broadcasting chainChanged:', chainInfo)

    const connectedDApps = await dappManager.getAllConnections()

    for (const dapp of connectedDApps) {
      if (this.permissions.has(dapp.origin)) {
        try {
          await this.broadcastEvent(dapp.origin, 'chainChanged', chainInfo)
        } catch (error) {
          console.error(`[DAppHandler] Failed to notify ${dapp.origin}:`, error)
        }
      }
    }
  }

  private async broadcastEvent(origin: string, eventName: string, data: any): Promise<void> {
    const tabs = await chrome.tabs.query({})

    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue

      // Strict origin matching
      let tabOrigin: string
      try {
        tabOrigin = new URL(tab.url).origin
      } catch (e) {
        continue // Invalid URL, skip
      }

      if (tabOrigin === origin) {
        try {
          if (eventName === 'accountsChanged' && data && !Array.isArray(data)) {
            const authorized = await dappManager.getAuthorizedAccounts(origin)
            if (
              accountManager.isLocked() ||
              !authorized.some(ref => {
                const account = useWalletStore.getState().getAccount(ref.walletId, ref.accountId)
                return (
                  !!account &&
                  account.addresses.transparent === data.transparent &&
                  account.addresses.shielded === data.shielded
                )
              })
            )
              return
          }
          await chrome.tabs.sendMessage(tab.id, {
            type: 'NOIR_EVENT',
            chainId: 'zcash',
            eventName,
            data
          })
        } catch (error) {
          // Tab might be closed or unresponsive, ignore
        }
      }
    }
  }
}

export const dappHandler = new DAppHandler()
