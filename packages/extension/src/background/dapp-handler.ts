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
import { isValidMarginalFeeZats, type FeeTier } from '@/config/fee'
import { marginalFeeForTier } from '@/core/zcash/fee-policy'
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
import { checkZcashMcaAccount, type McaSigningMode } from '@/core/services/zcash-mca-account'
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
import { credentialSession } from './credential-session'
import { accountContextTransition } from './account-context-transition'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { isStoredAccountNetworkEnabled } from '@/lib/wallet-metadata-storage'
import { getZcashChainId } from '@/core/chains/registry'
import { Caip25ProviderError } from '@/core/dapp/caip25'
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

function requireApprovedZcashFeeQuote(result: {
  readonly marginalFeeZats?: number
  readonly feeQuoteId?: string
  readonly feeTier?: FeeTier
  readonly feeZats?: number
}): { marginalFeeZats: number; feeQuoteId: string; feeTier: FeeTier; feeZats: number } {
  if (
    !isValidMarginalFeeZats(result.marginalFeeZats) ||
    !result.feeQuoteId ||
    (result.feeTier !== 'standard' && result.feeTier !== 'fast') ||
    !Number.isSafeInteger(result.feeZats) ||
    (result.feeZats ?? 0) <= 0
  ) {
    throw new Error('Approved network fee is unavailable. Review the request again.')
  }
  return {
    marginalFeeZats: result.marginalFeeZats,
    feeQuoteId: result.feeQuoteId,
    feeTier: result.feeTier,
    feeZats: result.feeZats as number
  }
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

interface DAppApprovalDecision {
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
  selectedScopes?: Readonly<Record<string, readonly string[]>>
  transferPrivacyRevision?: number
}

const CONNECT_APPROVAL_ACTIONS = new Set([
  'connect',
  'evmConnect',
  'bitcoinConnect',
  'solanaConnect',
  'nearConnect',
  'multichainConnect'
])

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

interface BoundZcashAccount {
  readonly walletId: string
  readonly accountId: string
  readonly wallet: WalletItem
  readonly account: AccountData
  readonly revision: number
}

export class DAppHandler {
  private readonly boundBalanceRefreshTimes = new Map<string, number>()
  private permissions: Map<string, DAppPermission> = new Map()
  private approvalWindowLaunch: Promise<void> = Promise.resolve()
  private readonly activeConnectApprovals = new Map<
    string,
    { promise: Promise<DAppApprovalDecision>; windowId?: number }
  >()
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
    for (const dapp of connectedDApps) {
      const bound = await this.getBoundZcashAccount(dapp.origin)
      if (bound) this.setPermissionForAccount(dapp.origin, bound.account)
    }
  }

  /**
   * Clear the Zcash permission cache and approvals when its runtime is locked.
   */
  clearPermissions(): void {
    this.permissions.clear()
    // Native accounts can stay unlocked without a Zcash runtime. Global wallet
    // locking cancels every chain's approvals in performWalletLockState.
    pendingRequestsManager.cancelAll(action => APPROVAL_ACTION_PREFIXES.zcash.includes(action))
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
    return this.getSilentAccounts(origin)
  }

  /** Restore first-party consent from public metadata without waking the Zcash core. */
  async getSilentAccounts(
    origin: string
  ): Promise<{ transparent: string; shielded: string; accounts: BatchAccount[] } | null> {
    if (!(await credentialSession.hasUnlockSession())) return null
    await rehydrateWalletStore()
    if (
      shouldAutoConnectDApp(origin) &&
      (await dappManager.canAutoConnect(origin)) &&
      (await this.hasActiveZcashAccount())
    ) {
      await this.authorizeAllWalletAccounts(origin)
    }
    return this.getAuthorizedActiveAccountSnapshot(origin)
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
    const chosen = await this.runConnectApproval(origin, tabInfo)
    await accountContextTransition.runActiveOperation(() =>
      this.applyConnectApproval(origin, chosen, tabInfo, authorizationRevision)
    )

    if (!isConnected) {
      trackEvent(ANALYTICS_EVENTS.DAPP_CONNECTED, {
        pageId: PAGE_IDS.DAPP,
        extra: { account_count: chosen.length }
      })
    }

    const bound = await this.getBoundZcashAccount(origin)
    if (!bound) throw new Error('No authorized Zcash account available')

    await dappManager.updateLastActive(origin)

    const { currentNetwork } = useWalletStore.getState()

    const balance = useAccountDataStore
      .getState()
      .getBalance(currentNetwork, bound.walletId, bound.accountId)
    const state = useWalletStore.getState()
    if (
      state.currentWalletId === bound.walletId &&
      state.currentAccountId === bound.accountId &&
      (!balance || (balance.transparent === '0' && balance.shielded === '0'))
    ) {
      syncScheduler.onRequestSync()
    }

    const accounts = await this.resolveAccounts(origin)
    await this.assertApprovedAccountAuthorized(
      origin,
      bound.walletId,
      bound.accountId,
      bound.revision
    )
    this.setPermissionForAccount(origin, bound.account)
    return {
      transparent: bound.account.addresses.transparent,
      shielded: bound.account.addresses.shielded,
      accounts
    }
  }

  private async getBalance(origin: string, accountId?: string): Promise<any> {
    const bound = await this.ensurePermission(origin)
    const network = useWalletStore.getState().currentNetwork

    const refreshKey = `${network}:${bound.walletId}:${bound.accountId}`
    const cachedBalance = useAccountDataStore
      .getState()
      .getBalance(network, bound.walletId, bound.accountId)
    if (
      !cachedBalance ||
      Date.now() - (this.boundBalanceRefreshTimes.get(refreshKey) ?? 0) >=
        WALLET_CONFIG.SYNC.DAPP_BALANCE_SYNC_STALE_MS
    ) {
      await this.runBoundZcashOperation(bound.walletId, bound.accountId, async () => {
        if (
          cachedBalance &&
          Date.now() - (this.boundBalanceRefreshTimes.get(refreshKey) ?? 0) <
            WALLET_CONFIG.SYNC.DAPP_BALANCE_SYNC_STALE_MS
        )
          return
        await this.ensureApprovedAccountContext(
          origin,
          bound.walletId,
          bound.accountId,
          bound.revision
        )
        await backgroundZcashWalletRuntime.refreshBalances(bound.walletId, true, {
          localOnly: true,
          canApply: () => {
            const state = useWalletStore.getState()
            return (
              state.currentNetwork === network &&
              state.wallets.some(
                wallet =>
                  wallet.id === bound.walletId &&
                  wallet.accounts.some(account => account.id === bound.accountId)
              )
            )
          }
        })
        await this.ensureApprovedAccountContext(
          origin,
          bound.walletId,
          bound.accountId,
          bound.revision
        )
        this.boundBalanceRefreshTimes.set(refreshKey, Date.now())
      })
    }
    if (!useAccountDataStore.getState().getBalance(network, bound.walletId, bound.accountId)) {
      throw new Error('Zcash balance is unavailable. Try again after the wallet refreshes.')
    }

    const zero = { transparent: '0', shielded: '0', total: '0', spendable: '0', available: '0' }
    const accounts = await this.resolveAccountBalances(origin)
    const latestAuthorization = await dappManager.getAuthorization(origin)
    const currentState = useWalletStore.getState()
    const latestBound = await this.getBoundZcashAccount(origin)
    if (
      currentState.currentNetwork !== network ||
      latestAuthorization.revision !== bound.revision ||
      latestBound?.accountId !== bound.accountId ||
      latestBound.walletId !== bound.walletId
    ) {
      throw new Error('Wallet account or site connection changed. Reconnect and try again.')
    }
    const authorizedAccounts: BatchAccountBalance[] = []
    for (const account of accounts) {
      const wallet = currentState.wallets.find(item => item.id === account.walletId)
      const storedAccount = wallet?.accounts.find(item => item.id === account.accountId)
      if (
        wallet &&
        storedAccount &&
        (await this.isZcashEnabled(wallet, storedAccount)) &&
        latestAuthorization.accounts.some(
          ref => ref.walletId === account.walletId && ref.accountId === account.accountId
        )
      ) {
        authorizedAccounts.push(account)
      }
    }

    // `accountId` is the `${walletId}:${accountId}` key from `accounts`. When the
    // dApp targets a specific authorized account, surface that as the primary;
    // otherwise use the account connected when this request started.
    const primary: ZcashBalance = accountId
      ? (authorizedAccounts.find(account => account.id === accountId)?.balance ?? zero)
      : (authorizedAccounts.find(
          account => account.walletId === bound.walletId && account.accountId === bound.accountId
        )?.balance ?? zero)

    return { ...primary, accounts: authorizedAccounts }
  }

  private async getMaxTransfer(
    origin: string,
    params: unknown
  ): Promise<{ maxAmount: string; fee: string }> {
    const bound = await this.ensurePermission(origin)
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
    const destination = input.to
    const feeTier = input.feeTier === 'fast' ? 'fast' : 'standard'
    return this.runBoundZcashOperation(bound.walletId, bound.accountId, async () => {
      await this.ensureApprovedAccountContext(
        origin,
        bound.walletId,
        bound.accountId,
        bound.revision
      )
      const core = await backgroundZcashWalletRuntime.getWalletCore(bound.walletId, bound.accountId)
      const feeQuote = await core.getFeeQuote()
      const estimate = await backgroundZcashWalletRuntime.estimateMaxTransferFor(
        bound.walletId,
        bound.accountId,
        destination,
        input.memo as string | undefined,
        marginalFeeForTier(feeTier, feeQuote.standardMarginalFeeZats),
        fundingSource,
        undefined,
        feeQuote.id
      )
      await this.ensureApprovedAccountContext(
        origin,
        bound.walletId,
        bound.accountId,
        bound.revision
      )
      return {
        maxAmount: formatBaseUnitDecimalAmount(estimate.maxAmountZats, ZEC_DECIMALS),
        fee: formatBaseUnitDecimalAmount(estimate.feeZats, ZEC_DECIMALS)
      }
    })
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

  private isZcashEnabled(wallet: WalletItem, account: AccountData): Promise<boolean> {
    if (
      wallet.keySource === 'private-key' &&
      !account.addresses.transparent &&
      !account.addresses.shielded
    ) {
      return Promise.resolve(false)
    }
    return isZcashHardwareKeySource(wallet.keySource) || wallet.keySource === 'private-key'
      ? Promise.resolve(true)
      : isStoredAccountNetworkEnabled(wallet.id, account.id, DEFAULT_NETWORK, 'zcash')
  }

  private async hasActiveZcashAccount(): Promise<boolean> {
    const state = useWalletStore.getState()
    const wallet = state.wallets.find(item => item.id === state.currentWalletId)
    const account = backgroundZcashWalletRuntime.getCurrentAccount()
    return Boolean(wallet && account && (await this.isZcashEnabled(wallet, account)))
  }

  private async getBoundZcashAccount(origin: string): Promise<BoundZcashAccount | null> {
    if (!(await credentialSession.hasUnlockSession())) return null
    await rehydrateWalletStore()
    const connection = await dappManager.getConnection(origin)
    const authorization = await dappManager.getAuthorization(origin)
    if (
      !connection?.boundWalletId ||
      !connection.boundAccountId ||
      !connectionAuthorizesAccount(connection, {
        walletId: connection.boundWalletId,
        accountId: connection.boundAccountId
      }) ||
      !authorization.accounts.some(
        ref =>
          ref.walletId === connection.boundWalletId && ref.accountId === connection.boundAccountId
      )
    )
      return null
    const wallet = useWalletStore
      .getState()
      .wallets.find(item => item.id === connection.boundWalletId)
    const account = wallet?.accounts.find(item => item.id === connection.boundAccountId)
    if (!wallet || !account || !(await this.isZcashEnabled(wallet, account))) return null
    const latestConnection = await dappManager.getConnection(origin)
    if (
      !(await credentialSession.hasUnlockSession()) ||
      (await dappManager.getAuthorizationRevision(origin)) !== authorization.revision ||
      latestConnection?.boundWalletId !== wallet.id ||
      latestConnection.boundAccountId !== account.id
    )
      return null
    return {
      walletId: wallet.id,
      accountId: account.id,
      wallet,
      account,
      revision: authorization.revision
    }
  }

  /** Every non-hidden account across all wallets — populates the batch approval picker. */
  private async buildAllSelectableAccounts(): Promise<BatchAccount[]> {
    const { wallets, accountDisplayNames } = useWalletStore.getState()
    const out: BatchAccount[] = []
    for (const wallet of wallets) {
      const visible = wallet.accounts.filter(a => !a.isHidden)
      for (const account of visible) {
        if (!(await this.isZcashEnabled(wallet, account))) continue
        out.push(
          this.mapToBatchAccount(wallet, account, wallets, accountDisplayNames, visible.length > 1)
        )
      }
    }
    return out
  }

  /** Every account across all wallets for the first-party zkNoir application. */
  private async buildAllWalletAccounts(): Promise<BatchAccount[]> {
    const { wallets, accountDisplayNames } = useWalletStore.getState()
    const out: BatchAccount[] = []
    for (const wallet of wallets) {
      for (const account of wallet.accounts) {
        if (!(await this.isZcashEnabled(wallet, account))) continue
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
    if (!(await credentialSession.hasUnlockSession())) {
      throw new Error('Wallet is locked')
    }

    if (!(await dappManager.canAutoConnect(origin))) {
      throw new Error('Not authorized. Call zcash_requestAccounts first.')
    }
    const authorizationRevision = await dappManager.getAuthorizationRevision(origin)
    await rehydrateWalletStore()
    const accounts = await this.buildAllWalletAccounts()
    if (accounts.length === 0) {
      throw new Error('No wallets available to authorize')
    }
    const { currentWalletId, currentAccountId, currentNetwork, wallets } = useWalletStore.getState()
    const activeWallet = wallets.find(wallet => wallet.id === currentWalletId)
    const current = activeWallet?.accounts.find(account => account.id === currentAccountId)
    if (
      !currentWalletId ||
      !current ||
      !activeWallet ||
      !(await this.isZcashEnabled(activeWallet, current))
    ) {
      throw new Error('The active Zcash account is unavailable.')
    }

    const existingConnection = await dappManager.getConnection(origin)
    const existingIds = new Set(
      (await dappManager.getAuthorizedAccounts(origin)).map(
        account => `${account.walletId}:${account.accountId}`
      )
    )
    const accountSetChanged =
      existingIds.size !== accounts.length || accounts.some(account => !existingIds.has(account.id))

    if (
      existingConnection?.boundWalletId &&
      existingConnection.boundAccountId &&
      !accounts.some(
        account =>
          account.walletId === existingConnection.boundWalletId &&
          account.accountId === existingConnection.boundAccountId
      )
    ) {
      return accounts
    }

    const binding =
      accounts.find(
        account =>
          account.walletId === existingConnection?.boundWalletId &&
          account.accountId === existingConnection.boundAccountId
      ) ??
      accounts.find(
        account => account.walletId === currentWalletId && account.accountId === current.id
      ) ??
      accounts[0]
    if (!existingConnection || accountSetChanged) {
      await this.persistAuthorized(
        origin,
        accounts,
        binding,
        {},
        {
          automatic: true,
          expectedRevision: authorizationRevision
        }
      )
    }

    await this.assertApprovedAccountAuthorized(
      origin,
      binding.walletId,
      binding.accountId,
      authorizationRevision
    )
    const unlocked = await credentialSession.hasUnlockSession()
    const state = useWalletStore.getState()
    if (
      !unlocked ||
      state.currentWalletId !== currentWalletId ||
      state.currentAccountId !== currentAccountId ||
      state.currentNetwork !== currentNetwork
    ) {
      throw new Error('Wallet account changed. Reconnect and try again.')
    }
    const boundAccount = useWalletStore.getState().getAccount(binding.walletId, binding.accountId)
    if (!boundAccount) throw new Error('The site Zcash account is unavailable.')
    this.setPermissionForAccount(origin, boundAccount)
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
      if (!(await this.isZcashEnabled(wallet, account))) continue
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
    const batch = await this.buildBatchAccounts(origin)
    if (batch.length > 0) return batch

    const bound = await this.getBoundZcashAccount(origin)
    if (!bound) return []
    const { wallets, accountDisplayNames } = useWalletStore.getState()
    const multiAccount = bound.wallet.accounts.filter(a => !a.isHidden).length > 1
    return [
      this.mapToBatchAccount(
        bound.wallet,
        bound.account,
        wallets,
        accountDisplayNames,
        multiAccount
      )
    ]
  }

  /** Cached balances for every authorized account; locked/unsynced report `synced: false`. */
  private async resolveAccountBalances(origin: string): Promise<BatchAccountBalance[]> {
    const accounts = await this.resolveAccounts(origin)
    if (accounts.length === 0) return []

    const { currentNetwork: network } = useWalletStore.getState()
    const locked = !(await credentialSession.hasUnlockSession())
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
    const available = await this.buildAllSelectableAccounts()
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
      } else {
        preselectedIds = [available[0].id]
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
    const stillAvailable = new Set(
      (await this.buildAllSelectableAccounts()).map(account => account.id)
    )
    if (chosen.some(account => !stillAvailable.has(account.id))) {
      throw new Error('The selected Zcash accounts changed. Review the connection request again.')
    }
    return chosen
  }

  async prepareSessionAccountSelection(origin: string): Promise<DAppSessionAccountProposal> {
    await rehydrateWalletStore()
    if (!(await credentialSession.hasUnlockSession())) {
      throw new Caip25ProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
    }
    const currentWalletId = useWalletStore.getState().currentWalletId
    const current = backgroundZcashWalletRuntime.getCurrentAccount()
    if (!currentWalletId || !current) throw new Error('The active wallet has no Zcash account.')
    const available = await this.buildAllSelectableAccounts()
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
    if (!(await credentialSession.hasUnlockSession())) {
      throw new Caip25ProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
    }
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
    const available = new Set((await this.buildAllSelectableAccounts()).map(account => account.id))
    if (selectedIds.some(id => !available.has(id))) {
      throw new Error('The selected Zcash accounts changed. Review the connection request again.')
    }
    return selectDAppSessionAccounts(proposal, selectedIds)
  }

  async getSessionAccounts(origin: string): Promise<readonly string[]> {
    if (!(await credentialSession.hasUnlockSession())) return Object.freeze([])
    await rehydrateWalletStore()
    const accounts = await this.buildBatchAccounts(origin)
    if (!(await credentialSession.hasUnlockSession())) return Object.freeze([])
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

  /** Persist the site selection without changing the wallet's active account. */
  private async applyConnectApproval(
    origin: string,
    chosen: BatchAccount[],
    tabInfo: { readonly title?: string; readonly favIconUrl?: string; readonly pageUrl?: string },
    expectedRevision: number
  ): Promise<void> {
    const available = new Set((await this.buildAllSelectableAccounts()).map(account => account.id))
    if (chosen.some(account => !available.has(account.id))) {
      throw new Error('The selected Zcash accounts changed. Review the connection request again.')
    }
    const existing = await dappManager.getConnection(origin)
    const { currentWalletId } = useWalletStore.getState()
    const current = backgroundZcashWalletRuntime.getCurrentAccount()
    const target =
      chosen.find(
        a => a.walletId === existing?.boundWalletId && a.accountId === existing.boundAccountId
      ) ??
      chosen.find(a => a.walletId === currentWalletId && a.accountId === current?.id) ??
      chosen[0]

    const wallet = useWalletStore.getState().getWallet(target.walletId)
    if (!isZcashHardwareKeySource(wallet?.keySource)) {
      await credentialSession.getCredentialBinding(target.walletId)
    }
    await this.persistAuthorized(origin, chosen, target, tabInfo, { expectedRevision })
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
    const bound = await this.ensurePermission(origin)
    const { walletId, accountId, account } = bound

    return this.runBoundZcashOperation(walletId, accountId, async () => {
      await this.ensureApprovedAccountContext(origin, walletId, accountId, bound.revision)
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
      await this.ensureApprovedAccountContext(origin, walletId, accountId, bound.revision)
      return {
        pubkey: identity.pubkey,
        address: identity.address,
        signingMode: identity.signingMode,
        originAddress: identity.originAddress
      }
    })
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
      feeQuoteId,
      feeTier,
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
    const approvedFee = requireApprovedZcashFeeQuote({
      marginalFeeZats,
      feeQuoteId,
      feeTier,
      feeZats
    })

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
        authorizationRevision,
        fundingSource,
        approvedFee.marginalFeeZats,
        approvedFee.feeQuoteId,
        approvedFee.feeTier
      )
    }

    return this.runBoundZcashOperation(walletId, accountId, async () => {
      await this.ensureApprovedAccountContext(origin, walletId, accountId, authorizationRevision)
      const txParams: SendTransactionParams = {
        ...params,
        fundingSource,
        marginalFeeZats: approvedFee.marginalFeeZats,
        feeQuoteId: approvedFee.feeQuoteId
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

        const feeEstimate = await walletCore.estimateTransferFee(
          params.to,
          params.amount,
          params.memo,
          approvedFee.marginalFeeZats,
          fundingSource,
          undefined,
          approvedFee.feeQuoteId
        )
        if (
          feeEstimate.feeQuote.id !== approvedFee.feeQuoteId ||
          feeEstimate.feeZats !== String(approvedFee.feeZats)
        ) {
          throw new Error('Network fee changed. Review the transaction again.')
        }
        const feeZec = formatBaseUnitDecimalAmount(feeEstimate.feeZats, ZEC_DECIMALS)

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
    authorizationRevision: number,
    fundingSource: FundingSource,
    marginalFeeZats: number,
    feeQuoteId: string,
    feeTier: FeeTier
  ): Promise<string> {
    const tab = await openHardwareSignTab({
      kind: 'send',
      walletId,
      accountId,
      to: params.to,
      amount: params.amount,
      memo: params.memo,
      dappRequestId,
      authorizationRevision,
      origin,
      fundingSource,
      marginalFeeZats,
      feeQuoteId,
      feeTier
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

    return this.runBoundZcashOperation(walletId, accountId, async () => {
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
    const bound = await this.ensurePermission(origin)
    await this.assertApprovedAccountAuthorized(
      origin,
      bound.walletId,
      bound.accountId,
      bound.revision
    )
    return {
      transparent: bound.account.addresses.transparent,
      shielded: bound.account.addresses.shielded
    }
  }

  private async shieldFunds(origin: string, tabInfo: DAppTabInfo): Promise<string> {
    const bound = await this.ensurePermission(origin)

    const wallet = bound.wallet
    if (isZcashHardwareKeySource(wallet?.keySource)) {
      throw new Error('Shield is not supported via dApp for hardware wallets.')
    }

    const { currentNetwork } = useWalletStore.getState()
    const balance = useAccountDataStore
      .getState()
      .getBalance(currentNetwork, bound.walletId, bound.accountId)

    const {
      requestId,
      approved,
      walletId,
      accountId,
      authorizationRevision,
      marginalFeeZats,
      feeQuoteId,
      feeTier,
      feeZats
    } = await this.requestUserApprovalWithId(origin, 'shieldFunds', {
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
    const approvedFee = requireApprovedZcashFeeQuote({
      marginalFeeZats,
      feeQuoteId,
      feeTier,
      feeZats
    })

    return this.runBoundZcashOperation(walletId, accountId, async () => {
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
        const feeEstimate = await walletCore.estimateShieldFee(
          approvedFee.marginalFeeZats,
          approvedFee.feeQuoteId
        )
        if (
          feeEstimate.feeQuote.id !== approvedFee.feeQuoteId ||
          feeEstimate.feeZats !== String(approvedFee.feeZats)
        ) {
          throw new Error('Network fee changed. Review the shield request again.')
        }
        const feeZec = formatBaseUnitDecimalAmount(feeEstimate.feeZats, ZEC_DECIMALS)
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
          approvedFee.marginalFeeZats,
          approvedAccountIndex,
          undefined,
          approvedFee.feeQuoteId
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

  private async checkLendingMcaAccount(origin: string) {
    const bound = await this.ensurePermission(origin)
    return this.runBoundZcashOperation(bound.walletId, bound.accountId, async () => {
      await this.ensureApprovedAccountContext(
        origin,
        bound.walletId,
        bound.accountId,
        bound.revision
      )
      return checkZcashMcaAccount(bound.walletId, bound.accountId, mode =>
        this.resolveLendingPublicKey(bound.walletId, bound.accountId, mode)
      )
    })
  }

  private async resolveLendingPublicKey(
    walletId: string,
    accountId: string,
    mode: McaSigningMode
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
  async getAuthorizedActiveAccountSnapshot(
    origin: string
  ): Promise<{ transparent: string; shielded: string; accounts: BatchAccount[] } | null> {
    const bound = await this.getBoundZcashAccount(origin)
    if (!bound) return null
    const { wallets } = useWalletStore.getState()

    const authorizedAccounts = await this.buildBatchAccounts(origin)
    const accounts =
      authorizedAccounts.length > 0
        ? authorizedAccounts
        : [
            this.mapToBatchAccount(
              bound.wallet,
              bound.account,
              wallets,
              useWalletStore.getState().accountDisplayNames,
              bound.wallet.accounts.filter(item => !item.isHidden).length > 1
            )
          ]
    const latestBound = await this.getBoundZcashAccount(origin)
    if (
      latestBound?.revision !== bound.revision ||
      latestBound.walletId !== bound.walletId ||
      latestBound.accountId !== bound.accountId
    )
      return null

    return {
      transparent: bound.account.addresses.transparent,
      shielded: bound.account.addresses.shielded,
      accounts
    }
  }

  private async ensurePermission(origin: string): Promise<BoundZcashAccount> {
    if (await dappManager.isRevoked(origin)) {
      this.permissions.delete(origin)
      throw new Error('Not authorized. Call zcash_requestAccounts first.')
    }
    if (
      shouldAutoConnectDApp(origin) &&
      (await dappManager.canAutoConnect(origin)) &&
      (await this.hasActiveZcashAccount())
    ) {
      await this.authorizeAllWalletAccounts(origin)
    }
    const bound = await this.getBoundZcashAccount(origin)
    if (!bound) {
      this.permissions.delete(origin)
      throw new Error('Not authorized. Call zcash_requestAccounts first.')
    }
    this.setPermissionForAccount(origin, bound.account)
    return bound
  }

  private async runBoundZcashOperation<T>(
    walletId: string,
    accountId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return accountContextTransition.runActiveOperation(async () => {
      syncScheduler.pauseForTx()
      try {
        if (!(await syncScheduler.waitForActiveSyncIdle(WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS))) {
          throw new Error('Wallet is syncing. Please try again after sync completes.')
        }
        await backgroundZcashWalletRuntime.prepareDAppAccount(walletId, accountId)
        return await operation()
      } finally {
        syncScheduler.resumeAfterTx()
      }
    })
  }

  private async ensureApprovedAccountContext(
    origin: string,
    walletId: string,
    accountId: string,
    authorizationRevision?: number
  ): Promise<void> {
    const bound = await this.ensurePermission(origin)
    await this.assertApprovedAccountAuthorized(origin, walletId, accountId, authorizationRevision)
    if (bound.walletId !== walletId || bound.accountId !== accountId) {
      throw new Error('The site account changed. Review the request again.')
    }
    if (!(await this.isZcashEnabled(bound.wallet, bound.account))) {
      throw new Error('The active Zcash account is unavailable.')
    }
    if (
      !isZcashHardwareKeySource(bound.wallet.keySource) &&
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
    const connection = await dappManager.getConnection(origin)
    if (
      (authorizationRevision !== undefined && authorization.revision !== authorizationRevision) ||
      connection?.boundWalletId !== walletId ||
      connection.boundAccountId !== accountId ||
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
      readonly onEvmTransferPrivacyChange?: (enabled: boolean) => Promise<unknown>
      readonly cancelOnNetworkFeeTierChangeError?: boolean
    }
  ): Promise<{
    readonly approved: boolean
    readonly requestId: string
    readonly selectedIds?: readonly string[]
    readonly selectedScopes?: Readonly<Record<string, readonly string[]>>
    readonly transferPrivacyRevision?: number
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
        : { selectedScopes: Object.freeze({ ...result.selectedScopes }) }),
      ...(result.transferPrivacyRevision === undefined
        ? {}
        : { transferPrivacyRevision: result.transferPrivacyRevision })
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
      readonly onEvmTransferPrivacyChange?: (enabled: boolean) => Promise<unknown>
      readonly cancelOnNetworkFeeTierChangeError?: boolean
    }
  ): Promise<DAppApprovalDecision> {
    if (!CONNECT_APPROVAL_ACTIONS.has(action)) {
      return this.createUserApprovalWithId(origin, action, data, options)
    }

    const state = useWalletStore.getState()
    const key = JSON.stringify([
      origin,
      action,
      state.currentNetwork,
      state.currentWalletId,
      backgroundZcashWalletRuntime.getCurrentAccount()?.id,
      data
    ])
    const active = this.activeConnectApprovals.get(key)
    if (active) {
      if (active.windowId !== undefined) {
        await chrome.windows.update(active.windowId, { focused: true }).catch(() => {})
      }
      return active.promise
    }

    const entry = {} as { promise: Promise<DAppApprovalDecision>; windowId?: number }
    entry.promise = this.createUserApprovalWithId(origin, action, data, options, windowId => {
      entry.windowId = windowId
    })
    this.activeConnectApprovals.set(key, entry)
    try {
      return await entry.promise
    } finally {
      if (this.activeConnectApprovals.get(key) === entry) {
        this.activeConnectApprovals.delete(key)
      }
    }
  }

  private async createUserApprovalWithId(
    origin: string,
    action: string,
    data?: any,
    options?: {
      readonly onNetworkFeeTierChange?: (tier: 'low' | 'standard' | 'fast') => Promise<unknown>
      readonly onEvmFeeSelectionChange?: (selection: EvmFeeSelection) => Promise<unknown>
      readonly onEvmTransferPrivacyChange?: (enabled: boolean) => Promise<unknown>
      readonly cancelOnNetworkFeeTierChangeError?: boolean
    },
    onWindowCreated?: (windowId: number) => void
  ): Promise<DAppApprovalDecision> {
    const bound =
      action !== 'connect' && APPROVAL_ACTION_PREFIXES.zcash.includes(action)
        ? await this.getBoundZcashAccount(origin)
        : null
    if (action !== 'connect' && APPROVAL_ACTION_PREFIXES.zcash.includes(action) && !bound) {
      throw new Error('Wallet account or site connection changed. Reconnect and try again.')
    }
    const capturedWalletId = bound?.walletId ?? useWalletStore.getState().currentWalletId ?? ''
    const capturedAccountId =
      bound?.accountId ?? backgroundZcashWalletRuntime.getCurrentAccount()?.id ?? ''
    const capturedNetwork = useWalletStore.getState().currentNetwork
    let releaseLaunch = () => {}
    const nextLaunch = new Promise<void>(resolve => {
      releaseLaunch = resolve
    })
    const previousLaunch = this.approvalWindowLaunch
    this.approvalWindowLaunch = nextLaunch
    await previousLaunch
    let authorizationRevision = 0
    let requestId = ''
    let left: number | undefined
    let top: number | undefined
    const windowWidth = UI_CONFIG.DAPP_WINDOW.WIDTH
    const windowHeight = UI_CONFIG.DAPP_WINDOW.HEIGHT
    try {
      authorizationRevision = await dappManager.getAuthorizationRevision(origin)
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
      pendingRequestsManager.cancelAll()
      await closeAllPopupWindows()
      if (executionModeRequestToken) {
        await dappExecutionModeRequestGate.waitForStable(executionModeRequestToken)
      }

      requestId = pendingRequestsManager.create(
        origin,
        action,
        data,
        capturedWalletId,
        capturedAccountId,
        capturedNetwork,
        authorizationRevision
      )

      const lastWindow = await chrome.windows.getLastFocused()

      left =
        lastWindow?.left !== undefined && lastWindow?.width !== undefined
          ? lastWindow.left + lastWindow.width - windowWidth - 20
          : undefined
      top = lastWindow?.top !== undefined ? lastWindow.top + 100 : undefined
    } catch (error) {
      releaseLaunch()
      throw error
    }

    return await new Promise<DAppApprovalDecision>((resolve, reject) => {
      let retriedWithoutPosition = false
      const failWindowCreation = () => {
        reject(new Error('Wallet approval window could not be opened.'))
      }
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
        function handleApprovalWindow(window) {
          const windowError = chrome.runtime.lastError?.message
          if (
            !window?.id &&
            !retriedWithoutPosition &&
            (left !== undefined || top !== undefined) &&
            /bounds|screen space/i.test(windowError ?? '')
          ) {
            retriedWithoutPosition = true
            try {
              chrome.windows.create(
                {
                  url: `index.html#approval?requestId=${requestId}`,
                  type: 'popup',
                  width: windowWidth,
                  height: windowHeight,
                  focused: true
                },
                handleApprovalWindow
              )
            } catch {
              failWindowCreation()
            }
            return
          }
          if (!window || !window.id) {
            failWindowCreation()
            return
          }

          const windowId = window.id
          onWindowCreated?.(windowId)

          let finished = false
          let feeUpdateInFlight = false
          let checkInterval: ReturnType<typeof setInterval>
          let timeoutId: ReturnType<typeof setTimeout>
          let removeCancellationListener = () => {}

          const finish = (
            approved: boolean,
            extras?: {
              marginalFeeZats?: number
              feeQuoteId?: string
              feeTier?: FeeTier
              feeZats?: number
              selectedIds?: string[]
              selectedScopes?: Readonly<Record<string, readonly string[]>>
              transferPrivacyRevision?: number
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
              feeQuoteId: extras?.feeQuoteId,
              feeTier: extras?.feeTier,
              feeZats: extras?.feeZats,
              selectedIds: extras?.selectedIds,
              selectedScopes: extras?.selectedScopes,
              transferPrivacyRevision: extras?.transferPrivacyRevision
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
              Reflect.get(msg, 'type') === 'DAPP_EVM_TRANSFER_PRIVACY_CHANGE' &&
              Reflect.get(msg, 'requestId') === requestId &&
              options?.onEvmTransferPrivacyChange
            ) {
              const enabled = Reflect.get(msg, 'enabled')
              if (typeof enabled !== 'boolean') {
                sendResponse({ error: 'Invalid transfer privacy selection' })
                return false
              }
              if (feeUpdateInFlight) {
                sendResponse({ error: 'Wait for the network fee update to complete' })
                return false
              }
              feeUpdateInFlight = true
              void Promise.resolve()
                .then(() => options.onEvmTransferPrivacyChange?.(enabled))
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
                  if (finished || !pendingRequestsManager.get(requestId)) {
                    sendResponse({ error: 'Approval request is no longer active' })
                    return
                  }
                  sendResponse({
                    error: error instanceof Error ? error.message : 'Transfer privacy update failed'
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
                  feeQuoteId: result.feeQuoteId,
                  feeTier: result.feeTier,
                  feeZats: result.feeZats,
                  selectedIds: result.selectedIds ? [...result.selectedIds] : undefined,
                  selectedScopes: result.selectedScopes,
                  transferPrivacyRevision: result.transferPrivacyRevision
                })
                sendResponse({ success: true })
              })
              .catch(error => {
                finish(false)
                sendResponse({
                  error: error instanceof Error ? error.message : 'Approval expired'
                })
              })
            return true
          }

          removeCancellationListener = pendingRequestsManager.onCancel(requestId, () =>
            finish(false)
          )
          if (finished) {
            releaseLaunch()
            return
          }

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
          releaseLaunch()
        }
      )
    })
      .catch(error => {
        pendingRequestsManager.cancel(requestId)
        throw error
      })
      .finally(releaseLaunch)
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
    const isLock =
      Array.isArray(accounts) &&
      accounts.length === 0 &&
      !(await credentialSession.hasUnlockSession())

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

    for (const dapp of connectedDApps) {
      if (dapp.boundWalletId == null) {
        continue
      }
      const bound = await this.getBoundZcashAccount(dapp.origin)
      if (!bound) {
        this.permissions.delete(dapp.origin)
        await this.broadcastEvent(dapp.origin, 'accountsChanged', null)
        continue
      }
      this.setPermissionForAccount(dapp.origin, bound.account)

      try {
        await this.broadcastEvent(dapp.origin, 'accountsChanged', {
          transparent: bound.account.addresses.transparent,
          shielded: bound.account.addresses.shielded
        })
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
