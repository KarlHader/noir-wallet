import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { connectionAuthorizesAccount, dappManager } from '../core/dapp/dapp-manager'
import { shouldAutoConnectDApp } from '@/core/dapp/first-party-policy'
import { syncScheduler } from './sync-scheduler'
import type {
  AccountData,
  FundingSource,
  SendTransactionParams,
  WalletItem,
  ZcashBalance
} from '@/types'
import { UI_CONFIG } from '@/config/extension'
import { SIGNING_ACCOUNT_INDEX, WALLET_CONFIG, ZEC_DECIMALS } from '@/config/wallet'
import { MARGINAL_FEE_ZATS } from '@/config/fee'
import { sanitizeMarginalFeeZats } from '@/core/zcash/fee-policy'
import { safeBig } from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { prepareTransparentSpend } from '@/core/wallet/transparent-spend-preflight'
import { closeAllPopupWindows } from './window-manager'
import { useWalletStore, rehydrateWalletStore } from '@/store/wallet-store'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import { EVM_GAS_FUNDING_APPROVAL_TIMEOUT_MS, pendingRequestsManager } from './pending-requests'
import { getApprovalContext } from './approval-context'
import { signApprovedDAppMessage } from './dapp-message-signing'
import { sleep } from '@/lib/utils'
import { logger } from '@/lib/logger'
import { ANALYTICS_EVENTS, PAGE_IDS, trackEvent } from '@/background/analytics/reporter'
import { transactionRecorder } from './transaction-recorder'
import { zcashTxMonitor, computeExpiryHeight } from './zcash-tx-monitor'
import { catchUpAfterOnChainTx } from './tx-sync'
import { checkLendingMcaAccount, type LendingSigningMode } from '@/core/services/lending-service'
import { loadTransactions } from '@/lib/indexed-db'
import { TimeoutError, withTimeout } from '@/lib/async-utils'
import { TRANSACTION_PENDING_MESSAGE } from '@/lib/transaction-status-copy'
import { HARDWARE_SIGN_REQUEST_TTL_MS, openHardwareSignTab } from '@/lib/hardware-tab'
import { fetchCachedIdentity, type IdentitySigningMode } from '@/core/wallet/identity-cache'
import { formatWalletName, getAccountDisplayName } from '@/lib/format'
import {
  getRetryableWalletRpcUserMessage,
  isRetryableWalletRpcError,
  WALLET_BUSY_MESSAGE
} from '@/core/zcash/wallet-rpc-errors'
import {
  getShieldableTransparentBalance,
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'
import { requireSuccessfulTransfer } from '@/core/zcash/transfer-result'
import { isTransparentZcashAddress } from '@/lib/zcash-memo'
import {
  isOwnExtensionRouteSender,
  parseDAppApprovalResultMessage,
  parseHardwareSignResultMessage,
  type NoirRuntimeEventMessage
} from '@/lib/runtime-message-security'
import { switchActiveAccountPersistently } from './account-switch'
import { credentialSession } from './credential-session'
import { accountContextTransition } from './account-context-transition'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getZcashChainId } from '@/core/chains/registry'
import {
  activeDAppSessionAccountMatches,
  selectDAppSessionAccounts,
  type DAppSessionAccountProposal,
  type DAppSessionAccountSelection
} from './dapp-session-accounts'
import { dappExecutionModeRequestGate } from './dapp-execution-mode'
import { parseEvmFeeSelection, type EvmFeeSelection } from '@/infrastructure/chains/evm'

type DAppTabInfo = {
  readonly title?: string
  readonly favIconUrl?: string
  readonly pageUrl?: string
}

function dappApprovalMetadata(tabInfo: DAppTabInfo): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
    ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
  })
}

interface DAppRequest {
  method: string
  params?: any[]
  origin: string
  tabInfo?: DAppTabInfo
}

interface DAppPermission {
  origin: string
  accounts: string[]
  timestamp: number
}

const APPROVAL_ACTION_PREFIXES = Object.freeze({
  zcash: Object.freeze(['connect', 'sendTransaction', 'signMessage', 'shieldFunds']),
  evm: Object.freeze([
    'evmConnect',
    'evmTransaction',
    'evmPrivateTransfer',
    'evmGasFunding',
    'evmMessage',
    'evmNetwork'
  ]),
  bitcoin: Object.freeze(['bitcoinConnect', 'bitcoinTransaction', 'bitcoinMessage']),
  solana: Object.freeze(['solanaConnect', 'solanaTransaction', 'solanaMessage']),
  near: Object.freeze(['nearConnect', 'nearTransaction', 'nearMessage']),
  multichain: Object.freeze(['multichainConnect'])
})

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
      return
    }

    // If initialization in progress, wait for it
    if (this.initPromise) {
      return this.initPromise
    }

    // Start initialization
    this.initPromise = (async () => {
      await dappManager.initialize()

      // DON'T restore permissions here - will be called explicitly after account ready

      this.isReady = true
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
    const account = backgroundZcashWalletRuntime.getCurrentAccount()

    for (const dapp of connectedDApps) {
      if (!account) continue
      if (await this.isCurrentAccountUnauthorized(dapp.origin)) continue
      this.setPermissionForAccount(dapp.origin, account)
    }
  }

  /**
   * Clear permissions cache on wallet lock
   */
  clearPermissions(): void {
    this.permissions.clear()
    pendingRequestsManager.cancelAll()
  }

  async removeAccountReferences(walletId: string, accountId?: string): Promise<void> {
    const result = await dappManager.removeAccountReferences(walletId, accountId)
    await Promise.all(
      result.affectedOrigins.map(async origin => {
        this.permissions.delete(origin)
        await this.broadcastEvent(origin, 'accountsChanged', null).catch(() => {})
      })
    )
  }

  async clearConnections(): Promise<void> {
    const origins = await dappManager.clearConnections()
    this.permissions.clear()
    await Promise.all(
      origins.map(origin => this.broadcastEvent(origin, 'accountsChanged', null).catch(() => {}))
    )
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

  /**
   * Methods requiring message signing, which the supported Zcash hardware protocols
   * do not provide (they sign PCZTs). Transactions are supported via
   * the hardware signing tab.
   */
  private static readonly HARDWARE_UNSUPPORTED_METHODS = new Set([
    'zcash_signMessage',
    'zcash_getPublicKey',
    'zcash_checkLendingMcaAccount'
  ])

  async handleRequest(request: DAppRequest): Promise<any> {
    try {
      return await this.dispatchRequest(request)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Internal retryable protocol errors (WALLET_DIRTY/SYNC_BUSY/STALE_WALLET_RPC)
      // must not leak to dApps as raw error codes
      if (isRetryableWalletRpcError(msg)) {
        logger.warn(`dApp request ${request.method} hit transient wallet state: ${msg}`)
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

    if (DAppHandler.HARDWARE_UNSUPPORTED_METHODS.has(request.method)) {
      const wallet = useWalletStore.getState().getCurrentWallet()
      if (isZcashHardwareKeySource(wallet?.keySource)) {
        throw new Error('This operation is not supported by hardware wallets.')
      }
    }

    switch (request.method) {
      case 'zcash_getAccounts':
        return this.getAccounts(origin)

      case 'zcash_requestAccounts':
        return this.requestAccounts(origin, request.tabInfo)

      case 'zcash_getBalance':
        return this.getBalance(origin, request.params?.[0]?.accountId)

      case 'zcash_getMaxTransfer':
        return this.getMaxTransfer(origin, request.params?.[0])

      case 'zcash_getPublicKey':
        return this.getPublicKey(origin, request.params?.[0])

      case 'zcash_sendTransaction':
        return this.sendTransaction(origin, request.params?.[0], request.tabInfo ?? {})

      case 'zcash_signMessage':
        return this.signMessage(
          origin,
          request.params?.[0],
          request.params?.[1],
          request.tabInfo ?? {}
        )

      case 'zcash_getAddresses':
        return this.getAddresses(origin)

      case 'zcash_shieldFunds':
        return this.shieldFunds(origin, request.tabInfo ?? {})

      case 'zcash_getTransactionHistory':
        return this.getTransactionHistory(origin)

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
    if (backgroundZcashWalletRuntime.isLocked()) {
      return null
    }

    if (shouldAutoConnectDApp(origin) && (await dappManager.canAutoConnect(origin))) {
      const accounts = await this.authorizeAllWalletAccounts(origin)
      const account = backgroundZcashWalletRuntime.getCurrentAccount()
      if (!account) return null
      return this.authorizedAccountResponse(origin, account, accounts)
    }

    if (await dappManager.isRevoked(origin)) return null

    if (this.permissions.has(origin)) {
      if (await this.isCurrentAccountUnauthorized(origin)) {
        this.permissions.delete(origin)
        return null
      }
      const account = await backgroundZcashWalletRuntime.getCurrentAccount()
      if (account) {
        return this.authorizedAccountResponse(origin, account, await this.resolveAccounts(origin))
      }
    }

    const isConnected = await dappManager.isConnected(origin)
    if (isConnected) {
      if (await this.isCurrentAccountUnauthorized(origin)) {
        return null
      }
      if (!backgroundZcashWalletRuntime.isLocked()) {
        try {
          await backgroundZcashWalletRuntime.waitForAccountReady(15000)
        } catch (err) {
          console.warn('[DAppHandler] Account ready timeout, proceeding anyway:', err)
        }
      }

      if (await this.isCurrentAccountUnauthorized(origin)) {
        return null
      }

      const account = await backgroundZcashWalletRuntime.getCurrentAccount()
      if (account) {
        return this.authorizedAccountResponse(origin, account, await this.resolveAccounts(origin))
      }
    }

    return null
  }

  private async authorizedAccountResponse(
    origin: string,
    account: AccountData,
    accounts: BatchAccount[]
  ): Promise<{ transparent: string; shielded: string; accounts: BatchAccount[] } | null> {
    const authorization = await dappManager.getAuthorization(origin)
    const { currentWalletId, currentAccountId } = useWalletStore.getState()
    if (
      backgroundZcashWalletRuntime.isLocked() ||
      currentAccountId !== account.id ||
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
    origin: string,
    tabInfo: {
      readonly title?: string
      readonly favIconUrl?: string
      readonly pageUrl?: string
    } = {}
  ): Promise<{ transparent: string; shielded: string; accounts: BatchAccount[] }> {
    const isConnected = await dappManager.isConnected(origin)
    const authorizationRevision = await dappManager.getAuthorizationRevision(origin)

    let chosen: BatchAccount[]
    if (shouldAutoConnectDApp(origin) && (await dappManager.canAutoConnect(origin))) {
      chosen = await this.authorizeAllWalletAccounts(origin)
    } else {
      // Always show the approval window so the user can review / add accounts,
      // even when the dApp is already authorized (MetaMask-style).
      chosen = await this.runConnectApproval(origin, tabInfo)
      await this.applyConnectApproval(origin, chosen, tabInfo, authorizationRevision)
    }

    if (!isConnected) {
      trackEvent(ANALYTICS_EVENTS.DAPP_CONNECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { account_count: chosen.length }
      })
    }

    const account = backgroundZcashWalletRuntime.getCurrentAccount()
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

    syncScheduler.requestPassiveSync(WALLET_CONFIG.SYNC.DAPP_BALANCE_SYNC_STALE_MS)

    const zero = { transparent: '0', shielded: '0', total: '0', spendable: '0', available: '0' }
    const accounts = await this.resolveAccountBalances(origin)

    // `accountId` is the `${walletId}:${accountId}` key from `accounts`. When the
    // dApp targets a specific authorized account, surface that as the primary;
    // otherwise default to the connected (current) account for legacy callers.
    let primary: ZcashBalance = zero
    if (accountId) {
      primary = accounts.find(a => a.id === accountId)?.balance ?? zero
    } else if (!backgroundZcashWalletRuntime.isLocked()) {
      const account = backgroundZcashWalletRuntime.getCurrentAccount()
      const { currentWalletId: walletId, currentNetwork: network } = useWalletStore.getState()
      if (account && walletId) {
        primary = useAccountDataStore.getState().getBalance(network, walletId, account.id) ?? zero
      }
    }

    return { ...primary, accounts }
  }

  private async getMaxTransfer(
    origin: string,
    params: unknown
  ): Promise<{ maxAmount: string; fee: string }> {
    await this.ensurePermission(origin)
    if (backgroundZcashWalletRuntime.isLocked()) {
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
    const current = backgroundZcashWalletRuntime.getCurrentAccount()
    const currentWalletId = useWalletStore.getState().currentWalletId
    const target = accounts.find(
      account => account.walletId === currentWalletId && account.accountId === current?.id
    )
    if (!target) {
      throw new Error('Current account is not authorized')
    }

    const feeTier = input.feeTier === 'fast' ? 'fast' : 'standard'
    const estimate = await backgroundZcashWalletRuntime.estimateMaxTransferFor(
      target.walletId,
      target.accountId,
      input.to,
      input.memo as string | undefined,
      MARGINAL_FEE_ZATS[feeTier],
      fundingSource
    )
    return {
      maxAmount: formatBaseUnitDecimalAmount(estimate.maxAmountZats, ZEC_DECIMALS),
      fee: formatBaseUnitDecimalAmount(estimate.feeZats, ZEC_DECIMALS)
    }
  }

  private mapToBatchAccount(
    wallet: WalletItem,
    account: AccountData,
    wallets: WalletItem[],
    displayNames: Record<string, string>,
    multiAccount: boolean
  ): BatchAccount {
    const displayName = getAccountDisplayName(wallet.id, account.id, account.name, displayNames)
    const walletDisplayName = formatWalletName(wallet, wallets)
    return {
      id: `${wallet.id}:${account.id}`,
      label: multiAccount ? `${walletDisplayName} · ${displayName}` : walletDisplayName,
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
        out.push(
          this.mapToBatchAccount(wallet, account, wallets, accountDisplayNames, visible.length > 1)
        )
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
          this.mapToBatchAccount(
            wallet,
            account,
            wallets,
            accountDisplayNames,
            wallet.accounts.length > 1
          )
        )
      }
    }
    return out
  }

  /** Keep the trusted first-party connection synchronized without opening Connect approval. */
  private async authorizeAllWalletAccounts(origin: string): Promise<BatchAccount[]> {
    if (backgroundZcashWalletRuntime.isLocked()) {
      throw new Error('Wallet is locked')
    }

    if (!(await dappManager.canAutoConnect(origin))) {
      throw new Error('Not authorized. Call zcash_requestAccounts first.')
    }
    const authorizationRevision = await dappManager.getAuthorizationRevision(origin)
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
      const { currentWalletId } = useWalletStore.getState()
      const current = backgroundZcashWalletRuntime.getCurrentAccount()
      const binding =
        accounts.find(
          account => account.walletId === currentWalletId && account.accountId === current?.id
        ) ?? accounts[0]
      await this.persistAuthorized(origin, accounts, binding, {}, { automatic: true })
    }

    const { currentWalletId } = useWalletStore.getState()
    const current = backgroundZcashWalletRuntime.getCurrentAccount()
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

    await this.assertApprovedAccountAuthorized(
      origin,
      currentWalletId,
      current.id,
      authorizationRevision
    )
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
      out.push(this.mapToBatchAccount(wallet, account, wallets, accountDisplayNames, multiAccount))
    }
    return out
  }

  /**
   * Authorized accounts for the `accounts[]` field. Falls back to the connected
   * account for pre-batch connections that have no persisted `authorizedAccounts`
   * yet, so already-connected dApps still receive a one-element array.
   */
  private async resolveAccounts(origin: string): Promise<BatchAccount[]> {
    if (backgroundZcashWalletRuntime.isLocked()) return []

    const batch = await this.buildBatchAccounts(origin)
    if (batch.length > 0) return batch

    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    const { currentWalletId: walletId, wallets, accountDisplayNames } = useWalletStore.getState()
    if (!account || !walletId) return []
    const wallet = wallets.find(w => w.id === walletId)
    if (!wallet) return []
    const multiAccount = wallet.accounts.filter(a => !a.isHidden).length > 1
    return [this.mapToBatchAccount(wallet, account, wallets, accountDisplayNames, multiAccount)]
  }

  /** Cached balances for every authorized account; locked/unsynced report `synced: false`. */
  private async resolveAccountBalances(origin: string): Promise<BatchAccountBalance[]> {
    const accounts = await this.resolveAccounts(origin)
    if (accounts.length === 0) return []

    const { currentNetwork: network } = useWalletStore.getState()
    const locked = backgroundZcashWalletRuntime.isLocked()
    const zero = { transparent: '0', shielded: '0', total: '0', spendable: '0', available: '0' }

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
   * preselected, so re-auth defaults to the full explicit authorization set;
   * valid pre-batch connections fall back to their single binding. Fresh
   * connects preselect the current account (MetaMask-style "single by
   * default, add more"). Returns the chosen accounts, or throws if the user
   * rejects or selects none.
   */
  private async runConnectApproval(
    origin: string,
    tabInfo: { readonly title?: string; readonly favIconUrl?: string; readonly pageUrl?: string }
  ): Promise<BatchAccount[]> {
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
      const current = backgroundZcashWalletRuntime.getCurrentAccount()
      const currentId = currentWalletId && current ? `${currentWalletId}:${current.id}` : null
      if (currentId && available.some(a => a.id === currentId)) {
        preselectedIds = [currentId]
      }
    }

    const { approved, selectedIds } = await this.requestUserApprovalWithId(origin, 'connect', {
      accounts: available,
      preselectedIds,
      ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
      ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
    })
    if (!approved) {
      trackEvent(ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { method: 'connect' }
      })
      throw new Error('User rejected the request')
    }

    const chosen = available.filter(a => selectedIds?.includes(a.id))
    if (chosen.length === 0) {
      throw new Error('No accounts selected')
    }
    return chosen
  }

  async prepareSessionAccountSelection(origin: string): Promise<DAppSessionAccountProposal> {
    await rehydrateWalletStore()
    if (backgroundZcashWalletRuntime.isLocked()) {
      throw new Error('Unlock Noir Wallet before connecting this site.')
    }
    const currentWalletId = useWalletStore.getState().currentWalletId
    const current = backgroundZcashWalletRuntime.getCurrentAccount()
    if (!currentWalletId || !current) throw new Error('The active wallet has no Zcash account.')
    const available = this.buildAllSelectableAccounts()
    const active = available.find(
      account => account.walletId === currentWalletId && account.accountId === current.id
    )
    if (!active) throw new Error('The active Zcash account is unavailable.')
    const existing = await dappManager.getAuthorizedAccounts(origin)
    const accounts = available.map(account =>
      Object.freeze({
        id: account.id,
        label: account.label,
        address: account.addresses.shielded,
        reference: Object.freeze({ walletId: account.walletId, accountId: account.accountId }),
        required: account.id === active.id
      })
    )
    return Object.freeze({
      chainId: getZcashChainId(DEFAULT_NETWORK),
      chainName: DEFAULT_NETWORK === 'mainnet' ? 'Zcash' : 'Zcash Testnet',
      iconChain: 'zec',
      accounts: Object.freeze(accounts),
      preselectedIds: Object.freeze(
        accounts
          .filter(
            item =>
              item.required ||
              existing.some(
                account =>
                  account.walletId === item.reference.walletId &&
                  account.accountId === item.reference.accountId
              )
          )
          .map(item => item.id)
      ),
      activeReference: Object.freeze({ walletId: currentWalletId, accountId: current.id }),
      activeAddress: active.addresses.shielded
    })
  }

  async resolveSessionAccountSelection(
    proposal: DAppSessionAccountProposal,
    selectedIds: readonly string[]
  ): Promise<DAppSessionAccountSelection> {
    const currentWalletId = useWalletStore.getState().currentWalletId
    const current = backgroundZcashWalletRuntime.getCurrentAccount()
    if (
      !currentWalletId ||
      !current ||
      !activeDAppSessionAccountMatches(proposal, {
        reference: { walletId: currentWalletId, accountId: current.id },
        address: current.addresses.shielded
      })
    ) {
      throw new Error('The active Zcash account changed. Review the connection request again.')
    }
    return selectDAppSessionAccounts(proposal, selectedIds)
  }

  async getSessionAccounts(origin: string): Promise<readonly string[]> {
    if (backgroundZcashWalletRuntime.isLocked()) return Object.freeze([])
    const accounts = await this.buildBatchAccounts(origin)
    return Object.freeze(accounts.map(account => account.addresses.shielded))
  }

  /** Persist the user's authorized account selection for `origin`. */
  private async persistAuthorized(
    origin: string,
    chosen: BatchAccount[],
    binding: BatchAccount,
    tabInfo: { readonly title?: string; readonly favIconUrl?: string; readonly pageUrl?: string },
    authorization?: { readonly automatic?: boolean; readonly expectedRevision?: number }
  ): Promise<void> {
    await dappManager.setAuthorizedAccounts(
      origin,
      tabInfo,
      chosen.map(a => ({ walletId: a.walletId, accountId: a.accountId })),
      { walletId: binding.walletId, accountId: binding.accountId },
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
    tabInfo: { readonly title?: string; readonly favIconUrl?: string; readonly pageUrl?: string },
    expectedRevision: number
  ): Promise<void> {
    const { currentWalletId } = useWalletStore.getState()
    const current = backgroundZcashWalletRuntime.getCurrentAccount()
    const target =
      chosen.find(a => a.walletId === currentWalletId && a.accountId === current?.id) ?? chosen[0]

    await this.persistAuthorized(origin, chosen, target, tabInfo, { expectedRevision })

    if (target.walletId !== currentWalletId || target.accountId !== current?.id) {
      await this.switchActiveAccount(target.walletId, target.accountId)
    }
  }

  /**
   * Switch the wallet's active account from a dApp flow through the same
   * authoritative V1/V2 persistence boundary as popup-initiated switches.
   */
  private async switchActiveAccount(walletId: string, accountId: string): Promise<void> {
    const wallet = useWalletStore.getState().getWallet(walletId)
    const restoreFromSession =
      !backgroundZcashWalletRuntime.isLocked() &&
      Boolean(wallet && !isZcashHardwareKeySource(wallet.keySource)) &&
      backgroundZcashWalletRuntime.getSessionPassword() === null
    if (restoreFromSession && !(await credentialSession.bindZcashCredential(walletId))) {
      await backgroundZcashWalletRuntime.lock().catch(() => {})
      throw new Error('Wallet credential is not available in the active session')
    }
    await switchActiveAccountPersistently(walletId, accountId)
    if (!backgroundZcashWalletRuntime.isLocked()) {
      if (restoreFromSession) {
        await backgroundZcashWalletRuntime.restoreFromCredentialSession(walletId, accountId)
      } else {
        await backgroundZcashWalletRuntime.ensureWalletCoreAccount(walletId, accountId)
      }
    }
    syncScheduler.onAccountSwitched(walletId)

    const account = backgroundZcashWalletRuntime.getCurrentAccount()
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

    if (backgroundZcashWalletRuntime.isLocked()) {
      return null
    }

    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    if (!account) {
      return null
    }

    const walletId = useWalletStore.getState().currentWalletId
    const accountId = account.id

    if (!walletId || !accountId) {
      return null
    }

    const walletCore = await backgroundZcashWalletRuntime.getWalletCore(walletId, accountId)
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

  private async sendTransaction(
    origin: string,
    input: unknown,
    tabInfo: DAppTabInfo
  ): Promise<string> {
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
      feeZats
    } = await this.requestUserApprovalWithId(origin, 'sendTransaction', {
      ...params,
      ...dappApprovalMetadata(tabInfo)
    })

    if (!approved) {
      trackEvent(ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { method: 'sendTransaction' }
      })
      throw new Error('User rejected the transaction')
    }

    // Hardware wallets sign in a dedicated tab; the tab
    // records the transaction and reports the result back
    const wallet = useWalletStore.getState().getWallet(walletId)
    if (wallet?.keySource === 'keystone' && fundingSource === 'transparent') {
      throw new Error('Transparent funding is not supported by Keystone hardware wallets.')
    }
    if (isZcashHardwareKeySource(wallet?.keySource)) {
      await this.ensureApprovedAccountContext(origin, walletId, accountId, authorizationRevision)
      return this.sendTransactionViaHardware(
        origin,
        params,
        requestId,
        walletId,
        accountId,
        fundingSource,
        marginalFeeZats
      )
    }

    return accountContextTransition.runActiveOperation(async () => {
      await this.ensureApprovedAccountContext(origin, walletId, accountId, authorizationRevision)
      const txParams: SendTransactionParams = { ...params, fundingSource, marginalFeeZats }

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
        syncScheduler.pauseForTx()
        txPaused = true

        const syncIdle = await syncScheduler.waitForWalletSyncIdle(
          walletId,
          WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS
        )
        if (!syncIdle) {
          throw new Error('Wallet is syncing. Please try again after sync completes.')
        }

        const walletCore = await backgroundZcashWalletRuntime.getWalletCore(walletId, accountId)
        if (fundingSource === 'transparent') {
          await prepareTransparentSpend(walletCore, txParams.amount, approvedAccountIndex)
        }

        const fallbackFeeZec = safeBig(WALLET_CONFIG.NETWORK_FEE).times(
          sanitizeMarginalFeeZats(marginalFeeZats) / MARGINAL_FEE_ZATS.standard
        )
        const approvedFeeZats =
          typeof feeZats === 'number' && Number.isSafeInteger(feeZats) && feeZats > 0
            ? feeZats
            : null
        const feeZec =
          approvedFeeZats !== null
            ? formatBaseUnitDecimalAmount(String(approvedFeeZats), ZEC_DECIMALS)
            : fallbackFeeZec.toFixed()

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
        await this.ensureApprovedAccountContext(origin, walletId, accountId, authorizationRevision)
        const transferResult = await walletCore.sendTransaction(
          txParams,
          undefined,
          approvedAccountIndex
        )
        const { txHash: hash, txHashes } = requireSuccessfulTransfer(transferResult)
        broadcastHash = hash
        const expiryHeight = await computeExpiryHeight(() =>
          withTimeout(walletCore.getLatestBlock(), 3_000, 'Transaction expiry height')
        )

        try {
          await transactionRecorder.updateTransaction(accountKey, tx.id, {
            txHash: hash,
            expiryHeight,
            ...(txHashes.length > 1
              ? { chainHashes: txHashes.map(txHash => ({ hash: txHash, chain: 'Zcash' })) }
              : {})
          })
        } catch {
          logger.warn('dApp send post-broadcast record update deferred', walletId, accountId)
        }

        try {
          await zcashTxMonitor.addTransaction({
            txHash: hash,
            accountKey,
            walletId,
            accountId,
            transactionId: tx.id,
            amount: params.amount,
            type: 'send',
            expiryHeight
          })
        } catch {
          logger.warn('dApp send post-broadcast monitoring deferred', walletId, accountId)
        }

        void catchUpAfterOnChainTx(walletId, accountId).catch(err => {
          logger.warn('Post-send catch-up failed, scheduling sync retry', walletId, accountId)
          console.error('[DAppHandler] catchUpAfterOnChainTx failed:', err)
          backgroundZcashWalletRuntime.requestSync()
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
          inputSymbol: 'ZEC',
          extra: { funding_source: fundingSource }
        })
        return hash
      } catch (err: any) {
        if (broadcastHash) {
          chrome.runtime
            .sendMessage({
              type: 'DAPP_TX_RESULT',
              requestId,
              success: true,
              txHash: broadcastHash
            })
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
          inputSymbol: 'ZEC',
          extra: { funding_source: fundingSource }
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
          syncScheduler.resumeAfterTx()
        }
      }
    })
  }

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
    fundingSource: FundingSource,
    marginalFeeZats?: number
  ): Promise<string> {
    const tab = await openHardwareSignTab({
      kind: 'send',
      walletId,
      accountId,
      to: params.to,
      amount: params.amount,
      memo: params.memo,
      dappRequestId,
      origin,
      fundingSource,
      marginalFeeZats
    })
    const hardwareTabId = tab.id
    if (typeof hardwareTabId !== 'number' || !Number.isInteger(hardwareTabId)) {
      throw new Error('Hardware signing tab was created without an ID')
    }

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
            inputSymbol: 'ZEC',
            extra: { hardware: true }
          })
          resolve(result.txHash)
        } else {
          trackEvent(ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED, {
            pageId: PAGE_IDS.DAPP,
            inputSymbol: 'ZEC',
            extra: { hardware: true }
          })
          reject(new Error(result.error || 'Transaction failed'))
        }
      }

      const onMessage = (msg: unknown, sender: chrome.runtime.MessageSender) => {
        if (
          !isOwnExtensionRouteSender(sender, chrome.runtime.id, '/hardware/sign', {
            tabId: hardwareTabId
          })
        ) {
          return
        }

        let result
        try {
          result = parseHardwareSignResultMessage(msg, dappRequestId)
        } catch {
          return
        }
        settle(
          result.success
            ? { txHash: result.txHash }
            : { error: result.error || 'Transaction failed' }
        )
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
      }, HARDWARE_SIGN_REQUEST_TTL_MS)

      chrome.runtime.onMessage.addListener(onMessage)
      chrome.tabs.onRemoved.addListener(onTabRemoved)
    })
  }

  private async signMessage(
    origin: string,
    message: string,
    options: { signingMode?: 'derived' | 'current' | 'legacy_index0' } | undefined,
    tabInfo: DAppTabInfo
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
      { message, ...dappApprovalMetadata(tabInfo) }
    )

    if (!approved) {
      trackEvent(ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { method: 'signMessage' }
      })
      throw new Error('User rejected the signature request')
    }

    return accountContextTransition.runActiveOperation(async () => {
      await this.ensureApprovedAccountContext(origin, walletId, accountId, authorizationRevision)
      const mode: IdentitySigningMode = options?.signingMode ?? 'current'
      const dedupKey = `${walletId}:${accountId}:${message}:${mode}`
      const pending = this.signMessageInFlight.get(dedupKey)
      if (pending) {
        logger.log('dedup hit', walletId)
        return pending
      }

      const walletCore = await backgroundZcashWalletRuntime.getWalletCore(walletId, accountId)
      await this.ensureApprovedAccountContext(origin, walletId, accountId, authorizationRevision)
      const approvedAccount = useWalletStore.getState().getAccount(walletId, accountId)
      if (!approvedAccount) throw new Error('Wallet account no longer available')
      const approvedAccountIndex = approvedAccount.derivationIndex
      const promise = signApprovedDAppMessage(
        walletCore,
        message,
        approvedAccountIndex,
        options?.signingMode,
        SIGNING_ACCOUNT_INDEX
      ).finally(() => {
        if (this.signMessageInFlight.get(dedupKey) === promise) {
          this.signMessageInFlight.delete(dedupKey)
        }
      })

      this.signMessageInFlight.set(dedupKey, promise)
      const result = await promise
      trackEvent(ANALYTICS_EVENTS.DAPP_MESSAGE_SIGNED, {
        pageId: PAGE_IDS.DAPP,
        extra: { signing_mode: mode }
      })
      return result
    })
  }

  private async getAddresses(origin: string): Promise<{ transparent: string; shielded: string }> {
    await this.ensurePermission(origin)
    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    if (!account) throw new Error('No account available')
    return {
      transparent: account.addresses.transparent,
      shielded: account.addresses.shielded
    }
  }

  private async shieldFunds(origin: string, tabInfo: DAppTabInfo): Promise<string> {
    await this.ensurePermission(origin)

    const wallet = useWalletStore.getState().getCurrentWallet()
    if (isZcashHardwareKeySource(wallet?.keySource)) {
      throw new Error('Shield is not supported via dApp for hardware wallets.')
    }

    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    const { currentWalletId, currentNetwork } = useWalletStore.getState()
    const balance =
      account && currentWalletId
        ? useAccountDataStore.getState().getBalance(currentNetwork, currentWalletId, account.id)
        : null

    const { requestId, approved, walletId, accountId, authorizationRevision, marginalFeeZats } =
      await this.requestUserApprovalWithId(origin, 'shieldFunds', {
        amount: getShieldableTransparentBalance(balance),
        ...dappApprovalMetadata(tabInfo)
      })

    if (!approved) {
      trackEvent(ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { method: 'shieldFunds' }
      })
      throw new Error('User rejected the shield request')
    }

    return accountContextTransition.runActiveOperation(async () => {
      await this.ensureApprovedAccountContext(origin, walletId, accountId, authorizationRevision)
      let txPaused = false
      const accountKey = buildAccountKey(currentNetwork, walletId, accountId)
      const approvedAccount = useWalletStore.getState().getAccount(walletId, accountId)
      if (!approvedAccount) throw new Error('Wallet account no longer available')
      const approvedAccountIndex = approvedAccount.derivationIndex
      let transactionId: string | undefined
      let broadcastHash: string | undefined
      try {
        syncScheduler.pauseForTx()
        txPaused = true

        const syncIdle = await syncScheduler.waitForWalletSyncIdle(
          walletId,
          WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS
        )
        if (!syncIdle) {
          throw new Error('Wallet is syncing. Please try again after sync completes.')
        }

        const walletCore = await backgroundZcashWalletRuntime.getWalletCore(walletId, accountId)
        const latestTransparentBalance = getShieldableTransparentBalance(
          await prepareTransparentSpend(walletCore, undefined, approvedAccountIndex)
        )
        if (!hasEnoughTransparentBalanceToShield(latestTransparentBalance)) {
          throw new Error(MIN_SHIELDING_BALANCE_MESSAGE)
        }
        const feeZec = safeBig(WALLET_CONFIG.NETWORK_FEE)
          .times(sanitizeMarginalFeeZats(marginalFeeZats) / MARGINAL_FEE_ZATS.standard)
          .toFixed()
        const tx = await transactionRecorder.addTransaction({
          accountKey,
          transaction: {
            txHash: '',
            status: 'pending',
            type: 'shield',
            amount: latestTransparentBalance,
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
        await this.ensureApprovedAccountContext(origin, walletId, accountId, authorizationRevision)
        const shieldResult = await walletCore.shieldFunds(
          sanitizeMarginalFeeZats(marginalFeeZats),
          approvedAccountIndex
        )
        const { txid } = shieldResult
        broadcastHash = txid
        const amount = shieldResult.amount ?? latestTransparentBalance
        const expiryHeight = await computeExpiryHeight(() =>
          withTimeout(walletCore.getLatestBlock(), 3_000, 'Transaction expiry height')
        )

        try {
          await transactionRecorder.updateTransaction(accountKey, tx.id, {
            txHash: txid,
            amount,
            expiryHeight
          })
        } catch {
          logger.warn('dApp shield post-broadcast record update deferred', walletId, accountId)
        }

        try {
          await zcashTxMonitor.addTransaction({
            txHash: txid,
            accountKey,
            walletId,
            accountId,
            transactionId: tx.id,
            amount,
            type: 'shield',
            expiryHeight
          })
        } catch {
          logger.warn('dApp shield post-broadcast monitoring deferred', walletId, accountId)
        }

        void catchUpAfterOnChainTx(walletId, accountId).catch(err => {
          logger.warn('Post-shield catch-up failed', walletId, accountId)
          console.error('[DAppHandler] catchUpAfterOnChainTx failed:', err)
          backgroundZcashWalletRuntime.requestSync()
        })

        chrome.runtime
          .sendMessage({ type: 'DAPP_TX_RESULT', requestId, success: true, txHash: txid })
          .catch(() => {})

        return txid
      } catch (err: any) {
        if (broadcastHash) {
          chrome.runtime
            .sendMessage({
              type: 'DAPP_TX_RESULT',
              requestId,
              success: true,
              txHash: broadcastHash
            })
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
        if (txPaused) {
          syncScheduler.resumeAfterTx()
        }
      }
    })
  }

  private async getTransactionHistory(origin: string): Promise<
    Array<{
      txid: string
      type: string
      amount: string
      status: string
      timestamp: number
      memo?: string
    }>
  > {
    await this.ensurePermission(origin)

    if (backgroundZcashWalletRuntime.isLocked()) return []

    const { currentWalletId, currentAccountId, currentNetwork } = useWalletStore.getState()
    if (!currentWalletId || !currentAccountId) return []

    const accountKey = buildAccountKey(currentNetwork, currentWalletId, currentAccountId)
    const transactions = await loadTransactions(accountKey)

    return transactions
      .filter(tx => tx.network === currentNetwork)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(tx => ({
        txid: tx.txHash,
        type:
          tx.type === 'supply' || tx.type === 'withdraw' || tx.type === 'claim'
            ? `lending_${tx.type}`
            : tx.type,
        amount: tx.amount,
        status:
          tx.status === 'success' || tx.status === 'confirming' || tx.status === 'relay_confirmed'
            ? 'mined'
            : tx.status,
        timestamp: tx.timestamp,
        memo: tx.memo || undefined
      }))
  }

  private async checkLendingMcaAccount(origin: string) {
    await this.ensurePermission(origin)

    if (backgroundZcashWalletRuntime.isLocked()) {
      return null
    }

    const walletId = useWalletStore.getState().currentWalletId
    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    if (!walletId || !account) {
      return null
    }

    return checkLendingMcaAccount(walletId, account.id, mode =>
      this.resolveLendingPublicKey(walletId, account.id, mode)
    )
  }

  private async resolveLendingPublicKey(
    walletId: string,
    accountId: string,
    mode: LendingSigningMode
  ): Promise<string> {
    const wallet = useWalletStore.getState().getWallet(walletId)
    const account = wallet?.accounts.find(candidate => candidate.id === accountId)
    if (!account) throw new Error('Zcash lending account is unavailable')
    const walletCore = await backgroundZcashWalletRuntime.getWalletCore(walletId, accountId)
    const identityMode: IdentitySigningMode =
      mode === 'legacy' ? 'legacy_index0' : mode === 'derived' ? 'derived' : 'current'
    return (
      await fetchCachedIdentity(
        backgroundZcashWalletRuntime.getNetwork(),
        walletId,
        accountId,
        account.derivationIndex,
        identityMode,
        walletCore,
        { usePing: true }
      )
    ).pubkey
  }

  /**
   * True when the wallet's active account must not be exposed to `origin`.
   * The explicit authorized set is the source of truth. Connections that
   * predate it may use their single-account binding; missing associations
   * fail closed and require a fresh approval.
   */
  private async isCurrentAccountUnauthorized(origin: string): Promise<boolean> {
    const connection = await dappManager.getConnection(origin)
    if (!connection) return true
    const { currentWalletId } = useWalletStore.getState()
    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    if (!account || !currentWalletId) {
      return true
    }
    return !connectionAuthorizesAccount(connection, {
      walletId: currentWalletId,
      accountId: account.id
    })
  }

  async getAuthorizedActiveAccountSnapshot(
    origin: string
  ): Promise<{ transparent: string; shielded: string; accounts: BatchAccount[] } | null> {
    await rehydrateWalletStore()
    const connection = await dappManager.getConnection(origin)
    if (!connection) return null

    const { currentWalletId, currentAccountId, wallets, accountDisplayNames } =
      useWalletStore.getState()
    if (!currentWalletId || !currentAccountId) return null
    if (
      !connectionAuthorizesAccount(connection, {
        walletId: currentWalletId,
        accountId: currentAccountId
      })
    ) {
      return null
    }

    const wallet = wallets.find(item => item.id === currentWalletId)
    const account = wallet?.accounts.find(item => item.id === currentAccountId)
    if (!wallet || !account) return null

    const authorizedAccounts = await this.buildBatchAccounts(origin)
    const accounts =
      authorizedAccounts.length > 0
        ? authorizedAccounts
        : [
            this.mapToBatchAccount(
              wallet,
              account,
              wallets,
              accountDisplayNames,
              wallet.accounts.filter(item => !item.isHidden).length > 1
            )
          ]

    return {
      transparent: account.addresses.transparent,
      shielded: account.addresses.shielded,
      accounts
    }
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

    const connection = await dappManager.getConnection(origin)
    if (!connection) {
      this.permissions.delete(origin)
      throw new Error('Not authorized. Call zcash_requestAccounts first.')
    }

    const { currentWalletId } = useWalletStore.getState()
    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    if (
      !account ||
      !currentWalletId ||
      !connectionAuthorizesAccount(connection, {
        walletId: currentWalletId,
        accountId: account.id
      })
    ) {
      this.permissions.delete(origin)
      throw new Error(
        'Wallet account no longer matches this site connection. Call zcash_requestAccounts to reconnect.'
      )
    }

    if (this.permissions.has(origin)) {
      return
    }

    this.setPermissionForAccount(origin, account)
    return
  }

  private async ensureApprovedAccountContext(
    origin: string,
    walletId: string,
    accountId: string,
    authorizationRevision?: number
  ): Promise<void> {
    await this.ensurePermission(origin)
    await this.assertApprovedAccountAuthorized(origin, walletId, accountId, authorizationRevision)
    const state = useWalletStore.getState()
    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    if (
      state.currentWalletId !== walletId ||
      state.currentAccountId !== accountId ||
      account?.id !== accountId
    ) {
      throw new Error('The active account changed. Review the request again.')
    }
    const wallet = state.getWallet(walletId)
    if (
      !isZcashHardwareKeySource(wallet?.keySource) &&
      (backgroundZcashWalletRuntime.isLocked() || !(await credentialSession.hasUnlockSession()))
    ) {
      throw new Error('Wallet is locked. Unlock and review the request again.')
    }
  }

  private async assertApprovedAccountAuthorized(
    origin: string,
    walletId: string,
    accountId: string,
    authorizationRevision?: number
  ): Promise<void> {
    const authorization = await dappManager.getAuthorization(origin)
    if (
      (authorizationRevision !== undefined && authorization.revision !== authorizationRevision) ||
      !authorization.accounts.some(
        account => account.walletId === walletId && account.accountId === accountId
      )
    ) {
      this.permissions.delete(origin)
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

  async requestExternalApproval(
    origin: string,
    action: string,
    data?: unknown,
    options?: {
      readonly onNetworkFeeTierChange?: (tier: 'low' | 'standard' | 'fast') => Promise<unknown>
      readonly onEvmFeeSelectionChange?: (selection: EvmFeeSelection) => Promise<unknown>
      readonly cancelOnNetworkFeeTierChangeError?: boolean
    }
  ): Promise<{
    readonly approved: boolean
    readonly requestId: string
    readonly selectedIds?: readonly string[]
    readonly selectedScopes?: Readonly<Record<string, readonly string[]>>
  }> {
    const result = await this.requestUserApprovalWithId(origin, action, data, options)
    return Object.freeze({
      approved: result.approved,
      requestId: result.requestId,
      ...(result.selectedIds === undefined
        ? {}
        : { selectedIds: Object.freeze([...result.selectedIds]) }),
      ...(result.selectedScopes === undefined
        ? {}
        : { selectedScopes: Object.freeze({ ...result.selectedScopes }) })
    })
  }

  async broadcastProviderEvent(
    origin: string,
    chainId: NoirRuntimeEventMessage['chainId'],
    eventName: NoirRuntimeEventMessage['eventName'],
    data: unknown
  ): Promise<void> {
    await this.broadcastEvent(origin, eventName, data, chainId)
  }

  cancelPendingApprovals(
    origin: string,
    chainId: 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'near' | 'multichain'
  ): number {
    const actions = APPROVAL_ACTION_PREFIXES[chainId]
    return pendingRequestsManager.cancelOrigin(origin, action => actions.includes(action))
  }

  countPendingApprovalsForContext(
    walletId: string,
    accountId: string,
    chainId: 'zcash' | 'evm' | 'bitcoin'
  ): number {
    const actions = APPROVAL_ACTION_PREFIXES[chainId]
    return pendingRequestsManager.countContext(walletId, accountId, action =>
      actions.includes(action)
    )
  }

  cancelPendingApprovalsForContext(
    walletId: string,
    accountId: string,
    chainId: 'zcash' | 'evm' | 'bitcoin'
  ): number {
    const actions = APPROVAL_ACTION_PREFIXES[chainId]
    return pendingRequestsManager.cancelContextMatching(walletId, accountId, action =>
      actions.includes(action)
    )
  }

  private async requestUserApprovalWithId(
    origin: string,
    action: string,
    data?: any,
    options?: {
      readonly onNetworkFeeTierChange?: (tier: 'low' | 'standard' | 'fast') => Promise<unknown>
      readonly onEvmFeeSelectionChange?: (selection: EvmFeeSelection) => Promise<unknown>
      readonly cancelOnNetworkFeeTierChangeError?: boolean
    }
  ): Promise<{
    approved: boolean
    requestId: string
    walletId: string
    accountId: string
    authorizationRevision: number
    marginalFeeZats?: number
    feeZats?: number
    selectedIds?: string[]
    selectedScopes?: Readonly<Record<string, readonly string[]>>
  }> {
    const capturedWalletId = useWalletStore.getState().currentWalletId || ''
    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    const capturedAccountId = account?.id || ''
    const capturedNetwork = useWalletStore.getState().currentNetwork
    const authorizationRevision = await dappManager.getAuthorizationRevision(origin)
    const executionModeRequestToken =
      capturedWalletId &&
      capturedAccountId &&
      APPROVAL_ACTION_PREFIXES.evm.some(candidate => candidate === action)
        ? dappExecutionModeRequestGate.capture({
            network: DEFAULT_NETWORK,
            keyDomainId: capturedWalletId,
            accountId: capturedAccountId
          })
        : null

    if (executionModeRequestToken) {
      await dappExecutionModeRequestGate.waitForStable(executionModeRequestToken)
    }
    await closeAllPopupWindows()
    if (executionModeRequestToken) {
      await dappExecutionModeRequestGate.waitForStable(executionModeRequestToken)
    }

    const requestId = pendingRequestsManager.create(
      origin,
      action,
      data,
      capturedWalletId,
      capturedAccountId,
      capturedNetwork,
      authorizationRevision
    )

    const lastWindow = await chrome.windows.getLastFocused()
    const windowWidth = UI_CONFIG.DAPP_WINDOW.WIDTH
    const windowHeight = UI_CONFIG.DAPP_WINDOW.HEIGHT

    const left =
      lastWindow?.left !== undefined && lastWindow?.width !== undefined
        ? lastWindow.left + lastWindow.width - windowWidth - 20
        : undefined
    const top = lastWindow?.top !== undefined ? lastWindow.top + 100 : undefined

    return new Promise(resolve => {
      chrome.windows.create(
        {
          url: `index.html#approval?requestId=${requestId}`,
          type: 'popup',
          width: windowWidth,
          height: windowHeight,
          left,
          top,
          focused: true
        },
        window => {
          if (!window || !window.id) {
            pendingRequestsManager.cancel(requestId)
            resolve({
              approved: false,
              requestId,
              walletId: capturedWalletId,
              accountId: capturedAccountId,
              authorizationRevision
            })
            return
          }

          const windowId = window.id

          let finished = false
          let feeUpdateInFlight = false
          let checkInterval: ReturnType<typeof setInterval>
          let timeoutId: ReturnType<typeof setTimeout>
          let removeCancellationListener = () => {}

          const finish = (
            approved: boolean,
            extras?: {
              marginalFeeZats?: number
              feeZats?: number
              selectedIds?: string[]
              selectedScopes?: Readonly<Record<string, readonly string[]>>
            }
          ) => {
            if (finished) return
            finished = true
            clearInterval(checkInterval)
            clearTimeout(timeoutId)
            removeCancellationListener()
            chrome.runtime.onMessage.removeListener(messageListener)
            pendingRequestsManager.complete(requestId)
            if (!approved) {
              chrome.windows.remove(windowId).catch(() => {})
            }
            resolve({
              approved,
              requestId,
              walletId: capturedWalletId,
              accountId: capturedAccountId,
              authorizationRevision,
              marginalFeeZats: extras?.marginalFeeZats,
              feeZats: extras?.feeZats,
              selectedIds: extras?.selectedIds,
              selectedScopes: extras?.selectedScopes
            })
          }

          const messageListener = (
            msg: unknown,
            sender: chrome.runtime.MessageSender,
            sendResponse: (response?: unknown) => void
          ): boolean | undefined => {
            if (!isOwnExtensionRouteSender(sender, chrome.runtime.id, '/approval', { windowId })) {
              return
            }

            if (
              typeof msg === 'object' &&
              msg !== null &&
              !Array.isArray(msg) &&
              Reflect.get(msg, 'type') === 'DAPP_NETWORK_FEE_TIER_CHANGE' &&
              Reflect.get(msg, 'requestId') === requestId &&
              (Reflect.get(msg, 'feeTier') === 'low' ||
                Reflect.get(msg, 'feeTier') === 'standard' ||
                Reflect.get(msg, 'feeTier') === 'fast') &&
              options?.onNetworkFeeTierChange
            ) {
              if (feeUpdateInFlight) {
                sendResponse({ error: 'Wait for the network fee update to complete' })
                return false
              }
              const feeTier = Reflect.get(msg, 'feeTier') as 'low' | 'standard' | 'fast'
              feeUpdateInFlight = true
              void Promise.resolve()
                .then(() => options.onNetworkFeeTierChange?.(feeTier))
                .then(updatedData => {
                  feeUpdateInFlight = false
                  if (finished || !pendingRequestsManager.updateData(requestId, updatedData)) {
                    sendResponse({ error: 'Approval request is no longer active' })
                    return
                  }
                  sendResponse({ data: updatedData })
                })
                .catch(error => {
                  feeUpdateInFlight = false
                  if (options.cancelOnNetworkFeeTierChangeError) {
                    pendingRequestsManager.cancel(requestId)
                  }
                  sendResponse({
                    error: error instanceof Error ? error.message : 'Network fee update failed'
                  })
                })
              return true
            }

            if (
              typeof msg === 'object' &&
              msg !== null &&
              !Array.isArray(msg) &&
              Reflect.get(msg, 'type') === 'DAPP_EVM_FEE_SELECTION_CHANGE' &&
              Reflect.get(msg, 'requestId') === requestId &&
              options?.onEvmFeeSelectionChange
            ) {
              let feeSelection: EvmFeeSelection
              try {
                feeSelection = parseEvmFeeSelection(Reflect.get(msg, 'feeSelection'))
              } catch (error) {
                sendResponse({
                  error: error instanceof Error ? error.message : 'Invalid EVM fee selection'
                })
                return false
              }
              if (feeUpdateInFlight) {
                sendResponse({ error: 'Wait for the network fee update to complete' })
                return false
              }
              feeUpdateInFlight = true
              void Promise.resolve()
                .then(() => options.onEvmFeeSelectionChange?.(feeSelection))
                .then(updatedData => {
                  feeUpdateInFlight = false
                  if (finished || !pendingRequestsManager.updateData(requestId, updatedData)) {
                    sendResponse({ error: 'Approval request is no longer active' })
                    return
                  }
                  sendResponse({ data: updatedData })
                })
                .catch(error => {
                  feeUpdateInFlight = false
                  sendResponse({
                    error: error instanceof Error ? error.message : 'Network fee update failed'
                  })
                })
              return true
            }

            let result
            try {
              result = parseDAppApprovalResultMessage(msg, requestId)
            } catch {
              return
            }
            if (feeUpdateInFlight && result.success) {
              sendResponse({ error: 'Wait for the network fee update to complete' })
              return false
            }
            if (!result.success) {
              finish(false)
              sendResponse({ success: true })
              return false
            }
            void getApprovalContext(requestId)
              .then(() => {
                if (finished) {
                  sendResponse({ error: 'Approval request is no longer active' })
                  return
                }
                finish(true, {
                  marginalFeeZats: result.marginalFeeZats,
                  feeZats: result.feeZats,
                  selectedIds: result.selectedIds ? [...result.selectedIds] : undefined,
                  selectedScopes: result.selectedScopes
                })
                sendResponse({ success: true })
              })
              .catch(error => {
                finish(false)
                sendResponse({ error: error instanceof Error ? error.message : 'Approval expired' })
              })
            return true
          }

          removeCancellationListener = pendingRequestsManager.onCancel(requestId, () =>
            finish(false)
          )

          chrome.runtime.onMessage.addListener(messageListener)

          checkInterval = setInterval(() => {
            chrome.windows.get(windowId, w => {
              if (chrome.runtime.lastError || !w) {
                finish(false)
              }
            })
          }, 500)

          timeoutId = setTimeout(
            () => {
              finish(false)
            },
            action === 'evmGasFunding' ? EVM_GAS_FUNDING_APPROVAL_TIMEOUT_MS : 120000
          )
        }
      )
    })
  }

  async revokePermission(origin: string): Promise<void> {
    await dappManager.removeLegacyAuthorization(origin)
    await dappManager.removeChainAuthorization(origin, getZcashChainId(DEFAULT_NETWORK))
    this.permissions.delete(origin)
    this.cancelPendingApprovals(origin, 'zcash')
    await this.broadcastEvent(origin, 'accountsChanged', null).catch(() => {})
    this.trackDisconnected()
  }

  async revokeAllPermissions(origin: string): Promise<void> {
    await dappManager.removeConnection(origin)
    this.permissions.delete(origin)
    pendingRequestsManager.cancelOrigin(origin)
    await Promise.allSettled([
      this.broadcastEvent(origin, 'accountsChanged', null),
      this.broadcastEvent(origin, 'accountsChanged', [], 'evm'),
      this.broadcastEvent(origin, 'accountsChanged', [], 'bitcoin')
    ])
    this.trackDisconnected()
  }

  private trackDisconnected(): void {
    trackEvent(ANALYTICS_EVENTS.DAPP_DISCONNECTED, {
      pageId: PAGE_IDS.DAPP
    })
  }

  getPermissions(): DAppPermission[] {
    return Array.from(this.permissions.values())
  }

  async getAllConnectedDApps() {
    return await dappManager.getAllConnections()
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
    const account = backgroundZcashWalletRuntime.getCurrentAccount()
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
    const current = backgroundZcashWalletRuntime.getCurrentAccount()

    for (const dapp of connectedDApps) {
      if (dapp.boundWalletId == null) {
        continue
      }

      if (!current || !currentWalletId) {
        this.permissions.delete(dapp.origin)
        await this.broadcastEvent(dapp.origin, 'accountsChanged', null)
        continue
      }

      // The explicit authorized set (or a valid pre-batch single binding)
      // decides whether this dApp may see the active account.
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
    const connectedDApps = await dappManager.getAllConnections()

    for (const dapp of connectedDApps) {
      if (dapp.boundWalletId !== params.walletId || dapp.boundAccountId !== params.accountId) {
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

  private async broadcastEvent(
    origin: string,
    eventName: NoirRuntimeEventMessage['eventName'],
    data: unknown,
    chainId: NoirRuntimeEventMessage['chainId'] = 'zcash'
  ): Promise<void> {
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
          await chrome.tabs.sendMessage(tab.id, {
            type: 'NOIR_EVENT',
            chainId,
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
