import { ANALYTICS_EVENTS } from '../lib/analytics/constants'
import { emitDAppEvent, observeDAppRequest, type DAppAnalyticsSink } from './dapp-analytics'
import type { Account, ChainAccount } from '@/core/accounts/domain'
import type { AccountRef, DAppManager } from '@/core/dapp/dapp-manager'
import {
  NativeTransferProviderError,
  parseNativeTransferNoParams,
  type NativeTransferDAppRuntimeMethod
} from '@/core/dapp/native-transfer-provider'
import type { KeyDomainSource } from '@/core/keyring/domain'
import type { DAppChainAccountDescriptor } from './dapp-chain-account-catalog'
import {
  activeDAppSessionAccountMatches,
  selectDAppSessionAccounts,
  type DAppSessionAccountProposal,
  type DAppSessionAccountSelection
} from './dapp-session-accounts'

export interface ActiveNativeTransferContext {
  readonly chainAccount: ChainAccount
  readonly accountIndex: Account['accountIndex']
  readonly keyDomainSource: KeyDomainSource
  readonly publicKey?: string
}

export interface NativeTransferDAppApprovalPort {
  readonly requestExternalApproval: (
    origin: string,
    action: string,
    data?: unknown
  ) => Promise<{
    readonly approved: boolean
    readonly requestId: string
    readonly selectedIds?: readonly string[]
  }>
  readonly broadcastProviderEvent: (
    origin: string,
    chainId: 'solana' | 'near',
    eventName: 'accountsChanged' | 'networkChanged' | 'accountCapabilitiesChanged',
    data: unknown
  ) => Promise<void>
  readonly cancelPendingApprovals: (origin: string, chainId: 'solana' | 'near') => number
}

export interface BackgroundNativeTransferDAppHandlerOptions {
  readonly analytics?: DAppAnalyticsSink
  readonly providerId: 'solana' | 'near'
  readonly familyName: 'Solana' | 'NEAR'
  readonly chainId: string
  readonly chainName: string
  readonly iconChain: string
  readonly connectApprovalAction: 'solanaConnect' | 'nearConnect'
  readonly manager: Pick<
    DAppManager,
    | 'getAllConnections'
    | 'getChainAuthorization'
    | 'removeChainAuthorization'
    | 'setChainAuthorizedAccounts'
  >
  readonly approval: NativeTransferDAppApprovalPort
  readonly loadActiveContext: () => Promise<ActiveNativeTransferContext | null>
  readonly listAccounts?: () => Promise<readonly DAppChainAccountDescriptor[]>
  readonly hasUnlockSession: () => Promise<boolean>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
  readonly parseAddress: (value: string) => string
}

export interface NativeTransferDAppRequest {
  readonly method: NativeTransferDAppRuntimeMethod
  readonly params?: readonly unknown[]
}

export interface NativeTransferDAppTabInfo {
  readonly title?: string
  readonly favIconUrl?: string
  readonly pageUrl?: string
}

interface ActiveDAppAccount {
  readonly context: ActiveNativeTransferContext
  readonly reference: AccountRef
  readonly address: string
  readonly publicKey?: string
}

function accountRefsEqual(left: AccountRef, right: AccountRef): boolean {
  return left.walletId === right.walletId && left.accountId === right.accountId
}

function activeAccountsEqual(left: ActiveDAppAccount, right: ActiveDAppAccount): boolean {
  return (
    accountRefsEqual(left.reference, right.reference) &&
    left.context.chainAccount.id === right.context.chainAccount.id &&
    left.address === right.address &&
    left.publicKey === right.publicKey
  )
}

export class BackgroundNativeTransferDAppHandler {
  constructor(private readonly options: BackgroundNativeTransferDAppHandlerOptions) {}

  async request(
    request: NativeTransferDAppRequest,
    origin: string,
    tabInfo: NativeTransferDAppTabInfo
  ): Promise<unknown> {
    return observeDAppRequest(this.options.analytics, this.options.providerId, request.method, () =>
      this.handleRequest(request, origin, tabInfo)
    )
  }

  private async handleRequest(
    request: NativeTransferDAppRequest,
    origin: string,
    tabInfo: NativeTransferDAppTabInfo
  ): Promise<unknown> {
    switch (request.method) {
      case 'connect': {
        const account = await this.authorizeAccount(origin, tabInfo, request.params, true)
        return Object.freeze({
          address: account.address,
          ...(account.publicKey === undefined ? {} : { publicKey: account.publicKey })
        })
      }
      case 'requestAccounts':
        await this.authorizeAccount(origin, tabInfo, request.params)
        return this.getAccounts(origin)
      case 'getAccounts':
        parseNativeTransferNoParams(request.params)
        return this.getAccounts(origin)
      case 'disconnect':
        parseNativeTransferNoParams(request.params)
        await this.options.runActiveOperation(async () => {
          await this.options.manager.removeChainAuthorization(origin, this.options.chainId)
          this.options.approval.cancelPendingApprovals(origin, this.options.providerId)
          await this.options.approval
            .broadcastProviderEvent(origin, this.options.providerId, 'accountsChanged', [])
            .catch(() => {})
        })
        emitDAppEvent(
          this.options.analytics,
          this.options.providerId,
          ANALYTICS_EVENTS.DAPP_DISCONNECTED
        )
        return null
    }
  }

  async notifyAccountsChanged(origin?: string): Promise<void> {
    const connections = await this.options.manager.getAllConnections()
    const matching = connections.filter(
      connection =>
        (origin === undefined || connection.origin === origin) &&
        connection.chainAuthorizations?.some(item => item.chainId === this.options.chainId)
    )
    if (matching.length === 0) return
    await Promise.all(
      matching.map(async connection => {
        const accounts = await this.getAccounts(connection.origin).catch(() => [])
        await this.options.approval
          .broadcastProviderEvent(
            connection.origin,
            this.options.providerId,
            'accountsChanged',
            accounts
          )
          .catch(() => {})
      })
    )
  }

  async prepareSessionAccountSelection(origin: string): Promise<DAppSessionAccountProposal> {
    const active = await this.requireUnlockedActiveAccount()
    const existing = await this.options.manager.getChainAuthorization(origin, this.options.chainId)
    const available = await this.listAvailableAccounts(active)
    const accounts = available.map(item =>
      Object.freeze({
        ...item,
        required: accountRefsEqual(item.reference, active.reference)
      })
    )
    return Object.freeze({
      chainId: this.options.chainId,
      chainName: this.options.chainName,
      iconChain: this.options.iconChain,
      accounts: Object.freeze(accounts),
      preselectedIds: Object.freeze(
        accounts
          .filter(
            item =>
              item.required ||
              existing?.accounts.some(account => accountRefsEqual(account, item.reference))
          )
          .map(item => item.id)
      ),
      activeReference: active.reference,
      activeAddress: active.address
    })
  }

  async resolveSessionAccountSelection(
    proposal: DAppSessionAccountProposal,
    selectedIds: readonly string[]
  ): Promise<DAppSessionAccountSelection> {
    const current = await this.requireUnlockedActiveAccount()
    if (!activeDAppSessionAccountMatches(proposal, current)) {
      throw new NativeTransferProviderError(
        4100,
        `The active ${this.options.familyName} account changed. Review the connection request again.`
      )
    }
    return selectDAppSessionAccounts(proposal, selectedIds)
  }

  async getSessionAccounts(origin: string): Promise<readonly string[]> {
    return this.getAccounts(origin)
  }

  private async loadActiveAccount(): Promise<ActiveDAppAccount> {
    const context = await this.options.loadActiveContext()
    if (!context || context.chainAccount.identity.kind !== 'account-identifier') {
      throw new NativeTransferProviderError(
        4100,
        `The active wallet has no ${this.options.familyName} account.`
      )
    }
    return Object.freeze({
      context,
      reference: Object.freeze({
        walletId: context.chainAccount.scope.keyDomainId,
        accountId: context.chainAccount.scope.accountId
      }),
      address: this.options.parseAddress(context.chainAccount.identity.value),
      ...(context.publicKey === undefined ? {} : { publicKey: context.publicKey })
    })
  }

  private async requireUnlockedActiveAccount(): Promise<ActiveDAppAccount> {
    if (!(await this.options.hasUnlockSession())) {
      throw new NativeTransferProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
    }
    return this.loadActiveAccount()
  }

  private async listAvailableAccounts(
    active: ActiveDAppAccount
  ): Promise<readonly DAppChainAccountDescriptor[]> {
    const listed = (await this.options.listAccounts?.()) ?? []
    const activeDescriptor = listed.find(item => accountRefsEqual(item.reference, active.reference))
    const current =
      activeDescriptor ??
      Object.freeze({
        id: JSON.stringify([active.reference.walletId, active.reference.accountId]),
        label: 'Current account',
        reference: active.reference,
        address: active.address
      })
    return Object.freeze([
      current,
      ...listed.filter(item => !accountRefsEqual(item.reference, active.reference))
    ])
  }

  private async getAccounts(origin: string): Promise<readonly string[]> {
    try {
      const active = await this.requireUnlockedActiveAccount()
      const authorization = await this.options.manager.getChainAuthorization(
        origin,
        this.options.chainId
      )
      if (!authorization) return Object.freeze([])
      const available = await this.listAvailableAccounts(active)
      if (this.options.providerId === 'solana') {
        await this.options.approval
          .broadcastProviderEvent(
            origin,
            'solana',
            'accountCapabilitiesChanged',
            available
              .filter(item =>
                authorization.accounts.some(account => accountRefsEqual(account, item.reference))
              )
              .map(item => ({
                address: item.address,
                signMessage: item.messageSigningSupported === true
              }))
          )
          .catch(() => {})
      }
      return Object.freeze([
        ...new Set(
          available
            .filter(item =>
              authorization.accounts.some(account => accountRefsEqual(account, item.reference))
            )
            .map(item => item.address)
        )
      ])
    } catch {
      return Object.freeze([])
    }
  }

  private async authorizeAccount(
    origin: string,
    tabInfo: NativeTransferDAppTabInfo,
    params?: readonly unknown[],
    forceReview = false
  ): Promise<ActiveDAppAccount> {
    parseNativeTransferNoParams(params)
    const active = await this.requireUnlockedActiveAccount()
    const existing = await this.options.manager.getChainAuthorization(origin, this.options.chainId)
    if (
      !forceReview &&
      existing?.accounts.some(account => accountRefsEqual(account, active.reference))
    ) {
      return active
    }
    const available = await this.listAvailableAccounts(active)
    const preselectedIds = available
      .filter(
        item =>
          accountRefsEqual(item.reference, active.reference) ||
          existing?.accounts.some(account => accountRefsEqual(account, item.reference))
      )
      .map(item => item.id)
    const decision = await this.options.approval.requestExternalApproval(
      origin,
      this.options.connectApprovalAction,
      {
        chainId: this.options.chainId,
        chainName: this.options.chainName,
        address: active.address,
        accounts: available.map(item => ({
          id: item.id,
          label: item.label,
          address: item.address,
          required: accountRefsEqual(item.reference, active.reference)
        })),
        preselectedIds,
        ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
        ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
      }
    )
    if (!decision.approved) {
      throw new NativeTransferProviderError(4001, 'User rejected the connection request.')
    }
    return this.options.runActiveOperation(async () => {
      const current = await this.requireUnlockedActiveAccount()
      if (!activeAccountsEqual(current, active)) {
        throw new NativeTransferProviderError(
          4100,
          `The active ${this.options.familyName} account changed. Review the connection request again.`
        )
      }
      const selectedIds = decision.selectedIds ?? preselectedIds
      const chosen = available.filter(item => selectedIds.includes(item.id))
      if (!chosen.some(item => accountRefsEqual(item.reference, current.reference))) {
        throw new NativeTransferProviderError(
          4100,
          `The active ${this.options.familyName} account must remain authorized.`
        )
      }
      await this.options.manager.setChainAuthorizedAccounts(
        origin,
        tabInfo,
        this.options.chainId,
        chosen.map(item => item.reference),
        current.reference
      )
      emitDAppEvent(
        this.options.analytics,
        this.options.providerId,
        ANALYTICS_EVENTS.DAPP_CONNECTED,
        { extra: { account_count: chosen.length, source: 'approval' } }
      )
      return current
    })
  }
}
