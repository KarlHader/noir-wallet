import { transactionBroadcasted } from '@/core/transactions/transaction-analytics'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import { ANALYTICS_EVENTS } from '../lib/analytics/constants'
import { emitDAppEvent, observeDAppRequest, type DAppAnalyticsSink } from './dapp-analytics'
import type { EvmNetworkConfig } from '@/config/networks'
import {
  EvmRpcError,
  EvmTransactionError,
  type ActiveEvmPortfolioContext,
  type EvmBalanceRpc,
  type EvmDAppReadRpc
} from '@/infrastructure/chains/evm'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm/evm-account'
import type { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import {
  Eip1193ProviderError,
  EVM_DAPP_READ_METHODS,
  parseEip1193AddressBlockRequest,
  parseEip1193Call,
  parseEip1193ChainRequest,
  parseEip1193EstimateGas,
  parseEip1193Transfer,
  parseEthAccountsPermissionRequest,
  parseEvmAddress,
  parsePersonalSignRequest,
  parseTypedDataV4Request,
  toEip1193ChainId,
  type EvmDAppRuntimeMethod
} from '@/core/dapp/eip1193'
import { parseChainId } from '@/core/chains/registry'
import {
  connectionHasEvmAuthorization,
  type AccountRef,
  type DAppManager
} from '@/core/dapp/dapp-manager'
import type { SigningResult } from '@/core/keyring/ports'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import type { BackgroundEvmTransferController } from './evm-transfer-controller'
import type { EvmDAppOperationRecord } from './evm-dapp-operation-store'
import type { DAppChainAccountDescriptor } from './dapp-chain-account-catalog'
import type { EvmDAppPrivateTransferPort } from './evm-dapp-private-transfer'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import {
  activeDAppSessionAccountMatches,
  selectDAppSessionAccounts,
  type DAppSessionAccountProposal,
  type DAppSessionAccountSelection
} from './dapp-session-accounts'
import { toHex, verifyMessage, verifyTypedData, type Hex } from 'viem'
import { requestLedgerSignature } from './ledger-signing-coordinator'
import {
  digestLedgerPayload,
  ledgerEvmPersonalSummary,
  ledgerEvmTypedDataSummary
} from './ledger-evm-dapp-review'
import type { LedgerEvmSigningRequest } from '@/lib/ledger/evm'

export interface EvmDAppApprovalPort {
  readonly requestExternalApproval: (
    origin: string,
    action: string,
    data?: unknown,
    options?: {
      readonly onNetworkFeeTierChange?: (tier: 'low' | 'standard' | 'fast') => Promise<unknown>
      readonly onEvmFeeSelectionChange?: (selection: EvmFeeSelection) => Promise<unknown>
    }
  ) => Promise<{
    readonly approved: boolean
    readonly requestId: string
    readonly selectedIds?: readonly string[]
  }>
  readonly broadcastProviderEvent: (
    origin: string,
    chainId: 'evm',
    eventName: 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect',
    data: unknown
  ) => Promise<void>
  readonly cancelPendingApprovals: (origin: string, chainId: 'evm') => number
}

export interface BackgroundEvmDAppHandlerOptions {
  readonly analytics?: DAppAnalyticsSink
  readonly network: EvmNetworkConfig
  readonly manager: Pick<
    DAppManager,
    | 'getAllConnections'
    | 'getChainAuthorization'
    | 'addEvmAuthorizedAccount'
    | 'removeChainAuthorization'
    | 'setChainAuthorizedAccounts'
  >
  readonly approval: EvmDAppApprovalPort
  readonly loadActiveContext: () => Promise<ActiveEvmPortfolioContext | null>
  readonly listAccounts?: () => Promise<readonly DAppChainAccountDescriptor[]>
  readonly hasUnlockSession: () => Promise<boolean>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
  readonly transferController: BackgroundEvmTransferController | null
  readonly privateTransfer?: EvmDAppPrivateTransferPort
  readonly operationStore: Readonly<{
    put: (record: EvmDAppOperationRecord) => Promise<void>
    delete: (transactionId: string) => Promise<void>
  }>
  readonly signer: EvmMultichainSigningClient
  readonly rpc: Pick<EvmBalanceRpc, 'getNativeBalance'> & EvmDAppReadRpc
  readonly resolveExecutionIdentity?: (
    account: Readonly<{
      context: ActiveEvmPortfolioContext
      reference: AccountRef
      mainAddress: string
      mainAddressIndex: number
    }>
  ) => Promise<EvmDAppExecutionIdentity>
  readonly switchNetwork?: (
    requested: ReturnType<typeof parseEip1193ChainRequest>,
    origin: string,
    action: 'switch' | 'add',
    tabInfo: EvmDAppTabInfo
  ) => Promise<void>
}

export interface EvmDAppExecutionIdentity {
  readonly mode: DAppExecutionMode
  readonly address: string
}

export function mapEvmTransactionPreparationError(error: unknown): unknown {
  return error instanceof EvmTransactionError && error.code === 'insufficient-funds'
    ? new Eip1193ProviderError(-32000, 'Insufficient funds for the transaction and network fee.')
    : error
}

export interface EvmDAppRequest {
  readonly method: EvmDAppRuntimeMethod
  readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>
}

export interface EvmDAppTabInfo {
  readonly title?: string
  readonly favIconUrl?: string
  readonly pageUrl?: string
}

function dappApprovalMetadata(tabInfo: EvmDAppTabInfo): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
    ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
  })
}

interface ActiveEvmDAppAccount {
  readonly context: ActiveEvmPortfolioContext
  readonly reference: AccountRef
  readonly address: string
  readonly addressIndex: number
  readonly executionMode: DAppExecutionMode
}

function accountRefsEqual(left: AccountRef, right: AccountRef): boolean {
  return left.walletId === right.walletId && left.accountId === right.accountId
}

function activeAccountsEqual(left: ActiveEvmDAppAccount, right: ActiveEvmDAppAccount): boolean {
  return (
    accountRefsEqual(left.reference, right.reference) &&
    left.address === right.address &&
    left.executionMode === right.executionMode
  )
}

function toRpcQuantity(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Invalid EVM quantity')
  }
  return `0x${BigInt(value).toString(16)}`
}

function permissionsFor(
  addresses: readonly string[]
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze([
    Object.freeze({
      parentCapability: 'eth_accounts',
      caveats: Object.freeze([
        Object.freeze({
          type: 'restrictReturnedAccounts',
          value: Object.freeze([...addresses])
        })
      ])
    })
  ])
}

export class BackgroundEvmDAppHandler {
  private readonly chainId: ReturnType<typeof parseChainId>['id']
  private readonly eip1193ChainId: `0x${string}`
  private active = true

  constructor(private readonly options: BackgroundEvmDAppHandlerOptions) {
    this.chainId = parseChainId(options.network.chainId).id
    this.eip1193ChainId = toEip1193ChainId(options.network.numericChainId)
  }

  deactivate(): void {
    this.active = false
  }

  private assertActiveRuntime(): void {
    if (!this.active) {
      throw new Eip1193ProviderError(
        4901,
        'The active EVM network changed. Review the request again.'
      )
    }
  }

  async request(
    request: EvmDAppRequest,
    origin: string,
    tabInfo: EvmDAppTabInfo
  ): Promise<unknown> {
    return observeDAppRequest(this.options.analytics, 'evm', request.method, () =>
      this.handleRequest(request, origin, tabInfo)
    )
  }

  private async handleRequest(
    request: EvmDAppRequest,
    origin: string,
    tabInfo: EvmDAppTabInfo
  ): Promise<unknown> {
    const params = Array.isArray(request.params) ? request.params : undefined
    if (request.method === 'eth_getCode') return this.getCode(params)
    if (request.method === 'eth_call' && params !== undefined) return this.call(params, origin)
    if (
      request.method === 'eth_getBalance' ||
      request.method === 'eth_getTransactionCount' ||
      request.method === 'eth_estimateGas'
    ) {
      const authorized = await this.loadOptionalAuthorizedAccount(origin)
      if (authorized) {
        if (request.method === 'eth_getBalance') return this.getBalance(params, origin)
        if (request.method === 'eth_getTransactionCount') {
          return this.getTransactionCount(params, origin)
        }
        return this.estimateGas(params, origin)
      }
    }
    if ((EVM_DAPP_READ_METHODS as readonly string[]).includes(request.method)) {
      try {
        return await this.options.rpc.requestDAppRead(
          request.method as (typeof EVM_DAPP_READ_METHODS)[number],
          request.params ?? []
        )
      } catch (error) {
        if (error instanceof EvmRpcError && error.rpcCode !== undefined && error.rpcMessage) {
          throw new Eip1193ProviderError(error.rpcCode, error.rpcMessage)
        }
        throw error
      }
    }
    switch (request.method) {
      case 'eth_chainId':
        return this.eip1193ChainId
      case 'net_version':
        return String(this.options.network.numericChainId)
      case 'eth_accounts':
        return this.getAccounts(origin)
      case 'eth_coinbase':
        return (await this.getAccounts(origin))[0] ?? null
      case 'eth_requestAccounts':
        return this.requestAccounts(origin, tabInfo)
      case 'wallet_getPermissions':
        return this.getPermissions(origin)
      case 'wallet_requestPermissions':
        parseEthAccountsPermissionRequest(params)
        await this.requestAccounts(origin, tabInfo, true)
        return this.getPermissions(origin)
      case 'wallet_revokePermissions':
        parseEthAccountsPermissionRequest(params)
        await this.options.runActiveOperation(async () => {
          await this.options.manager.removeChainAuthorization(origin, this.chainId)
          this.options.approval.cancelPendingApprovals(origin, 'evm')
          await this.options.approval
            .broadcastProviderEvent(origin, 'evm', 'accountsChanged', [])
            .catch(() => {})
        })
        emitDAppEvent(this.options.analytics, 'evm', ANALYTICS_EVENTS.DAPP_DISCONNECTED)
        return null
      case 'wallet_addEthereumChain': {
        const requested = parseEip1193ChainRequest(params, {
          allowAddChainMetadata: true
        })
        if (requested.chainId === this.eip1193ChainId) return null
        if (!this.options.switchNetwork) {
          throw new Eip1193ProviderError(4902, 'The requested EVM chain is not configured.')
        }
        await this.options.switchNetwork(requested, origin, 'add', tabInfo)
        return null
      }
      case 'wallet_switchEthereumChain': {
        const requested = parseEip1193ChainRequest(params)
        if (requested.chainId === this.eip1193ChainId) return null
        if (!this.options.switchNetwork) {
          throw new Eip1193ProviderError(4902, 'The requested EVM chain is not configured.')
        }
        await this.options.switchNetwork(requested, origin, 'switch', tabInfo)
        return null
      }
      case 'eth_sendTransaction':
        return this.sendTransaction(params, origin, tabInfo)
      case 'personal_sign':
        return this.signPersonalMessage(params, origin, tabInfo)
      case 'eth_signTypedData_v4':
        return this.signTypedData(params, origin, tabInfo)
    }
  }

  async notifyAccountsChanged(): Promise<void> {
    const connections = await this.options.manager.getAllConnections()
    const evmConnections = connections.filter(connectionHasEvmAuthorization)
    if (evmConnections.length === 0) return
    await Promise.all(
      evmConnections.map(async connection => {
        const accounts = await this.getAccounts(connection.origin).catch(() => [])
        await this.options.approval
          .broadcastProviderEvent(connection.origin, 'evm', 'accountsChanged', accounts)
          .catch(() => {})
      })
    )
  }

  /** The wallet connection coordinator holds the account-transition lock. */
  async connectCurrentAccountToDApp(origin: string): Promise<void> {
    this.assertActiveRuntime()
    const active = await this.requireUnlockedActiveAccount()
    await this.options.manager.addEvmAuthorizedAccount(origin, this.chainId, active.reference)
    const accounts = await this.getAccounts(origin)
    await this.options.approval.broadcastProviderEvent(origin, 'evm', 'accountsChanged', accounts)
    emitDAppEvent(this.options.analytics, 'evm', ANALYTICS_EVENTS.DAPP_CONNECTED, {
      extra: { account_count: accounts.length, source: 'wallet' }
    })
  }

  async notifyChainChanged(numericChainId: number): Promise<void> {
    const chainId = toEip1193ChainId(numericChainId)
    const connections = await this.options.manager.getAllConnections()
    const evmConnections = connections.filter(connectionHasEvmAuthorization)
    await Promise.all(
      evmConnections.map(connection =>
        this.options.approval
          .broadcastProviderEvent(connection.origin, 'evm', 'chainChanged', chainId)
          .catch(() => {})
      )
    )
  }

  async prepareSessionAccountSelection(
    origin: string,
    scope: { readonly chainId: string; readonly chainName: string; readonly iconChain: string }
  ): Promise<DAppSessionAccountProposal> {
    const chainId = parseChainId(scope.chainId).id
    if (parseChainId(chainId).namespace !== 'eip155') {
      throw new Eip1193ProviderError(5100, 'The requested CAIP-25 scope is not an EVM chain.')
    }
    const active = await this.requireUnlockedActiveAccount()
    const existing = await this.options.manager.getChainAuthorization(origin, chainId)
    const available = await this.listAvailableAccounts(active)
    const accounts = available.map(item =>
      Object.freeze({
        ...item,
        required: accountRefsEqual(item.reference, active.reference)
      })
    )
    return Object.freeze({
      chainId,
      chainName: scope.chainName,
      iconChain: scope.iconChain,
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
    this.assertActiveRuntime()
    const current = await this.requireUnlockedActiveAccount()
    if (!activeDAppSessionAccountMatches(proposal, current)) {
      throw new Eip1193ProviderError(
        4100,
        'The active EVM account changed. Review the connection request again.'
      )
    }
    return selectDAppSessionAccounts(proposal, selectedIds)
  }

  async getSessionAccounts(
    origin: string,
    chainIdValue: string = this.chainId
  ): Promise<readonly string[]> {
    try {
      const chainId = parseChainId(chainIdValue).id
      if (parseChainId(chainId).namespace !== 'eip155') return Object.freeze([])
      const active = await this.requireUnlockedActiveAccount()
      const authorization = await this.options.manager.getChainAuthorization(origin, chainId)
      if (!authorization) return Object.freeze([])
      const available = await this.listAvailableAccounts(active)
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

  getCaip2ChainId(): string {
    return this.chainId
  }

  private async loadActiveAccount(): Promise<ActiveEvmDAppAccount> {
    const context = await this.options.loadActiveContext()
    if (!context) throw new Eip1193ProviderError(4100, 'The active wallet has no EVM account.')
    const binding = parseEvmAccountBinding(context.chainAccount, this.chainId)
    const reference = Object.freeze({
      walletId: context.chainAccount.scope.keyDomainId,
      accountId: context.chainAccount.scope.accountId
    })
    const mainAddress = binding.address.toLowerCase()
    const executionIdentity = this.options.resolveExecutionIdentity
      ? await this.options.resolveExecutionIdentity(
          Object.freeze({
            context,
            reference,
            mainAddress,
            mainAddressIndex: binding.addressIndex
          })
        )
      : Object.freeze({ mode: 'main' as const, address: mainAddress })
    const address = parseEvmAddress(executionIdentity.address, 'Execution account').toLowerCase()
    if (executionIdentity.mode === 'main' && address !== mainAddress) {
      throw new Error('Main execution identity does not match the active EVM account')
    }
    if (executionIdentity.mode === 'private' && address === mainAddress) {
      throw new Error('Confidential address must differ from the Main EVM account')
    }
    return Object.freeze({
      context,
      reference,
      address,
      addressIndex: binding.addressIndex,
      executionMode: executionIdentity.mode
    })
  }

  private assertSoftwareSigningAccount(active: ActiveEvmDAppAccount): void {
    if (!supportsEvmPrivateExecution(active.context.keyDomainSource)) {
      throw new Eip1193ProviderError(
        4200,
        'Keystone EVM signing is available only from the Noir Wallet transaction screen.'
      )
    }
  }

  private async requireUnlockedActiveAccount(): Promise<ActiveEvmDAppAccount> {
    if (!(await this.options.hasUnlockSession())) {
      throw new Eip1193ProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
    }
    return this.loadActiveAccount()
  }

  private async listAvailableAccounts(
    active: ActiveEvmDAppAccount
  ): Promise<readonly DAppChainAccountDescriptor[]> {
    const listed = (await this.options.listAccounts?.()) ?? []
    const activeDescriptor = listed.find(item => accountRefsEqual(item.reference, active.reference))
    const current = Object.freeze(
      activeDescriptor
        ? { ...activeDescriptor, address: active.address }
        : {
            id: JSON.stringify([active.reference.walletId, active.reference.accountId]),
            label: 'Current account',
            reference: active.reference,
            address: active.address
          }
    )
    if (active.executionMode === 'private') return Object.freeze([current])
    return Object.freeze([
      current,
      ...listed.filter(item => !accountRefsEqual(item.reference, active.reference))
    ])
  }

  private async requireAuthorizedAccount(
    origin: string,
    requestedAddress?: string
  ): Promise<ActiveEvmDAppAccount> {
    const active = await this.requireUnlockedActiveAccount()
    const authorization = await this.options.manager.getChainAuthorization(origin, this.chainId)
    if (
      !authorization ||
      !authorization.accounts.some(account => accountRefsEqual(account, active.reference))
    ) {
      throw new Eip1193ProviderError(
        4100,
        'This site is not authorized for the active EVM account.'
      )
    }
    if (requestedAddress && requestedAddress.toLowerCase() !== active.address) {
      throw new Eip1193ProviderError(4100, 'The requested EVM account is not authorized.')
    }
    return active
  }

  private async requireUnchangedExecutionIdentity(
    origin: string,
    expected: ActiveEvmDAppAccount
  ): Promise<ActiveEvmDAppAccount> {
    this.assertActiveRuntime()
    const current = await this.requireAuthorizedAccount(origin, expected.address)
    if (!activeAccountsEqual(current, expected)) {
      throw new Eip1193ProviderError(
        4100,
        'The active EVM account changed. Review the request again.'
      )
    }
    return current
  }

  private async getAccounts(origin: string): Promise<readonly string[]> {
    try {
      const active = await this.requireUnlockedActiveAccount()
      const authorization = await this.options.manager.getChainAuthorization(origin, this.chainId)
      if (!authorization) return Object.freeze([])
      const available = await this.listAvailableAccounts(active)
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

  private async requestAccounts(
    origin: string,
    tabInfo: EvmDAppTabInfo,
    forceReview = false
  ): Promise<readonly string[]> {
    const active = await this.requireUnlockedActiveAccount()
    const existing = await this.options.manager.getChainAuthorization(origin, this.chainId)
    if (
      !forceReview &&
      existing?.accounts.some(account => accountRefsEqual(account, active.reference))
    ) {
      return this.getAccounts(origin)
    }
    const available = await this.listAvailableAccounts(active)
    const preselectedIds = available
      .filter(
        item =>
          accountRefsEqual(item.reference, active.reference) ||
          existing?.accounts.some(account => accountRefsEqual(account, item.reference))
      )
      .map(item => item.id)
    const decision = await this.options.approval.requestExternalApproval(origin, 'evmConnect', {
      chainId: this.chainId,
      chainName: this.options.network.displayName,
      address: active.address,
      executionMode: active.executionMode,
      accounts: available.map(item => ({
        id: item.id,
        label: item.label,
        address: item.address,
        required: accountRefsEqual(item.reference, active.reference)
      })),
      preselectedIds,
      ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
      ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
    })
    if (!decision.approved) {
      throw new Eip1193ProviderError(4001, 'User rejected the connection request.')
    }
    return this.options.runActiveOperation(async () => {
      this.assertActiveRuntime()
      const current = await this.requireUnlockedActiveAccount()
      if (!activeAccountsEqual(current, active)) {
        throw new Eip1193ProviderError(
          4100,
          'The active EVM account changed. Review the connection request again.'
        )
      }
      const selectedIds = decision.selectedIds ?? preselectedIds
      const chosen = available.filter(item => selectedIds.includes(item.id))
      if (!chosen.some(item => accountRefsEqual(item.reference, current.reference))) {
        throw new Eip1193ProviderError(4100, 'The active EVM account must remain authorized.')
      }
      await this.options.manager.setChainAuthorizedAccounts(
        origin,
        tabInfo,
        this.chainId,
        chosen.map(item => item.reference),
        current.reference
      )
      emitDAppEvent(this.options.analytics, 'evm', ANALYTICS_EVENTS.DAPP_CONNECTED, {
        extra: { account_count: chosen.length, source: 'approval' }
      })
      return Object.freeze([...new Set(chosen.map(item => item.address))])
    })
  }

  private async getPermissions(
    origin: string
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const accounts = await this.getAccounts(origin)
    return accounts.length > 0 ? permissionsFor(accounts) : Object.freeze([])
  }

  private async getBalance(
    params: readonly unknown[] | undefined,
    origin: string
  ): Promise<string> {
    if (!Array.isArray(params) || params.length !== 2 || params[1] !== 'latest') {
      throw new Eip1193ProviderError(-32602, 'eth_getBalance supports the latest block tag only.')
    }
    const address = parseEvmAddress(params[0], 'Balance account')
    const active = await this.requireAuthorizedAccount(origin, address)
    return toRpcQuantity(await this.options.rpc.getNativeBalance(active.address))
  }

  private async getCode(params: readonly unknown[] | undefined): Promise<string> {
    const request = parseEip1193AddressBlockRequest(params, {
      method: 'eth_getCode',
      addressLabel: 'Contract address',
      allowPending: false
    })
    return this.options.rpc.getCode(request.address)
  }

  private async loadOptionalAuthorizedAccount(
    origin: string
  ): Promise<ActiveEvmDAppAccount | null> {
    try {
      return await this.requireAuthorizedAccount(origin)
    } catch (error) {
      if (error instanceof Eip1193ProviderError && error.code === 4100) return null
      throw error
    }
  }

  private async call(params: readonly unknown[] | undefined, origin: string): Promise<string> {
    const request = parseEip1193Call(params, this.chainId)
    const active = request.from
      ? await this.requireAuthorizedAccount(origin, request.from)
      : await this.loadOptionalAuthorizedAccount(origin)
    return this.options.rpc.call(
      {
        ...(active === null ? {} : { from: active.address }),
        to: request.to,
        valueRaw: request.valueRaw,
        data: request.data
      },
      request.blockTag
    )
  }

  private async getTransactionCount(
    params: readonly unknown[] | undefined,
    origin: string
  ): Promise<string> {
    const request = parseEip1193AddressBlockRequest(params, {
      method: 'eth_getTransactionCount',
      addressLabel: 'Transaction count account',
      allowPending: true
    })
    const active = await this.requireAuthorizedAccount(origin, request.address)
    return toRpcQuantity(
      await this.options.rpc.getTransactionCount(active.address, request.blockTag)
    )
  }

  private async estimateGas(
    params: readonly unknown[] | undefined,
    origin: string
  ): Promise<string> {
    const request = parseEip1193EstimateGas(params, this.chainId)
    const active = await this.requireAuthorizedAccount(origin, request.from)
    return toRpcQuantity(
      await this.options.rpc.estimateGas({
        from: active.address,
        to: request.to,
        valueRaw: request.valueRaw,
        data: request.data
      })
    )
  }

  private async sendTransaction(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: EvmDAppTabInfo
  ): Promise<string> {
    if (!this.options.transferController) {
      throw new Eip1193ProviderError(4200, 'EVM transactions are unavailable in this wallet build.')
    }
    const transferController = this.options.transferController
    const trustedErc20 = this.options.network.usdcContract
    const parsed = parseEip1193Transfer(params, {
      chainId: this.chainId,
      nativeAssetId: `${this.chainId}/slip44:${this.options.network.nativeCurrency.slip44Reference}`,
      ...(trustedErc20 === undefined
        ? {}
        : {
            trustedErc20Contract: trustedErc20,
            trustedErc20AssetId: `${this.chainId}/erc20:${trustedErc20.toLowerCase()}`
          })
    })
    const active = await this.requireAuthorizedAccount(origin, parsed.from)
    if (
      !supportsEvmPrivateExecution(active.context.keyDomainSource) &&
      !(
        active.context.keyDomainSource.kind === 'hardware' &&
        active.context.keyDomainSource.vendor === 'ledger'
      )
    ) {
      this.assertSoftwareSigningAccount(active)
    }
    const isContractCall = parsed.kind === 'contract-call'
    if (active.executionMode === 'private' && !isContractCall) {
      if (!this.options.privateTransfer || !('assetId' in parsed.intent)) {
        throw new Eip1193ProviderError(
          4200,
          'Confidential asset transfers are unavailable on this network.'
        )
      }
      const destinationHash = await this.options.privateTransfer.send({
        origin,
        chainId: this.chainId,
        account: Object.freeze({
          keyDomainId: active.reference.walletId,
          accountId: active.reference.accountId,
          address: active.address,
          addressIndex: active.addressIndex
        }),
        intent: parsed.intent,
        ...(parsed.tokenContract === undefined ? {} : { tokenContract: parsed.tokenContract }),
        tabInfo,
        ensureIdentity: async () => {
          await this.requireUnchangedExecutionIdentity(origin, active)
        }
      })
      emitDAppEvent(this.options.analytics, 'evm', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
        hasTransaction: 1,
        idempotencyKey: `dapp:evm:private:${destinationHash}`,
        extra: { funding_source: 'private' }
      })
      return destinationHash
    }
    const executionAccount =
      active.executionMode === 'private'
        ? Object.freeze({
            kind: 'pea' as const,
            address: active.address,
            addressIndex: active.addressIndex
          })
        : undefined
    const prepareTransaction = () =>
      isContractCall
        ? transferController.prepareContractCall(
            parsed.intent,
            undefined,
            undefined,
            executionAccount
          )
        : transferController.prepare(parsed.intent, undefined, undefined, 'main', executionAccount)
    let prepared: Awaited<ReturnType<typeof prepareTransaction>>
    while (true) {
      try {
        prepared = await prepareTransaction()
        break
      } catch (error) {
        const funding = error instanceof EvmTransactionError ? error.insufficientFunds : undefined
        if (
          active.executionMode !== 'private' ||
          this.options.network.networkMode !== 'mainnet' ||
          !funding
        ) {
          throw mapEvmTransactionPreparationError(error)
        }
        const decision = await this.options.approval.requestExternalApproval(
          origin,
          'evmGasFunding',
          {
            chainId: this.options.network.numericChainId,
            chainName: this.options.network.displayName,
            iconChain: this.options.network.iconChain,
            privateAddress: active.address,
            nativeCurrency: this.options.network.nativeCurrency,
            ...funding,
            ...dappApprovalMetadata(tabInfo)
          }
        )
        if (!decision.approved) {
          throw new Eip1193ProviderError(
            4001,
            'User rejected funding the Confidential Gas balance.'
          )
        }
        await this.requireUnchangedExecutionIdentity(origin, active)
      }
    }
    const persistOperation = async (transactionId: EvmDAppOperationRecord['transactionId']) => {
      await this.options.operationStore.put(
        Object.freeze({
          schemaVersion: 1 as const,
          transactionId,
          keyDomainId: active.reference.walletId,
          accountId: active.reference.accountId,
          origin
        })
      )
    }
    try {
      await persistOperation(prepared.graph.root.id)
    } catch {
      await transferController.reject(prepared.graph.root.id).catch(() => {})
      throw new Error('The dApp transaction could not be persisted for approval')
    }
    let submitted = false
    let approvalActive = true
    try {
      await this.requireUnchangedExecutionIdentity(origin, active)
      const approvalData = (review: typeof prepared.review, feeSelection: EvmFeeSelection) => ({
        chainName: this.options.network.displayName,
        iconChain: this.options.network.iconChain,
        executionMode: active.executionMode,
        privacyRoute:
          active.executionMode === 'private' && isContractCall ? 'direct-contract' : 'onchain',
        nativeCurrency: this.options.network.nativeCurrency,
        token:
          'assetId' in parsed.intent &&
          parsed.intent.assetId.includes('/erc20:') &&
          trustedErc20 !== undefined
            ? { symbol: 'USDC', decimals: 6 }
            : null,
        review,
        intent: parsed.intent,
        feeSelection,
        ...(feeSelection.kind === 'tier' ? { feeTier: feeSelection.tier } : {}),
        feeEditingAvailable: true,
        ...dappApprovalMetadata(tabInfo)
      })
      const reprepareForFeeSelection = async (feeSelection: EvmFeeSelection) => {
        const replacement = isContractCall
          ? await transferController.prepareContractCall(
              parsed.intent,
              feeSelection,
              undefined,
              executionAccount
            )
          : await transferController.prepare(
              parsed.intent,
              undefined,
              feeSelection,
              'main',
              executionAccount
            )
        let adopted = false
        try {
          if (!approvalActive) throw new Error('Approval request is no longer active')
          try {
            await persistOperation(replacement.graph.root.id)
          } catch {
            throw new Error('The dApp transaction could not be persisted for approval')
          }
          if (!approvalActive) throw new Error('Approval request is no longer active')
          await transferController.reject(prepared.graph.root.id).catch(() => {})
          await this.options.operationStore.delete(prepared.graph.root.id).catch(() => {})
          if (!approvalActive) throw new Error('Approval request is no longer active')
          prepared = replacement
          adopted = true
          return approvalData(replacement.review, feeSelection)
        } finally {
          if (!adopted) {
            await transferController.reject(replacement.graph.root.id).catch(() => {})
            await this.options.operationStore.delete(replacement.graph.root.id).catch(() => {})
          }
        }
      }
      let decision: Awaited<ReturnType<typeof this.options.approval.requestExternalApproval>>
      try {
        decision = await this.options.approval.requestExternalApproval(
          origin,
          'evmTransaction',
          approvalData(prepared.review, { kind: 'tier', tier: 'standard' }),
          {
            onNetworkFeeTierChange: tier => reprepareForFeeSelection({ kind: 'tier', tier }),
            onEvmFeeSelectionChange: reprepareForFeeSelection
          }
        )
      } finally {
        approvalActive = false
      }
      if (!decision.approved) {
        throw new Eip1193ProviderError(4001, 'User rejected the transaction request.')
      }
      let submission = await this.options.transferController.approveForDApp(
        prepared.graph.root.id,
        prepared.review.payloadFingerprint.digestHex,
        async context => {
          const current = await this.requireUnchangedExecutionIdentity(origin, active)
          if (
            current.context.generationId !== context.generationId ||
            current.context.chainAccount.id !== context.chainAccount.id
          ) {
            throw new Eip1193ProviderError(
              4100,
              'The active EVM account changed. Review the transaction request again.'
            )
          }
        }
      )
      if (submission.status === 'external-signature-required') {
        if (
          active.context.keyDomainSource.kind !== 'hardware' ||
          active.context.keyDomainSource.vendor !== 'ledger'
        ) {
          throw new Eip1193ProviderError(4200, 'Unsupported external EVM signer')
        }
        const external = await transferController.getExternalSigningRequest(prepared.graph.root.id)
        if (
          external?.vendor !== 'ledger' ||
          !external.ledgerRequest ||
          external.ledgerRequest.kind !== 'transaction'
        ) {
          throw new Error('Ledger EVM signing request is unavailable')
        }
        const signed = await requestLedgerSignature(external.ledgerRequest, {
          scope: { ...active.context.chainAccount.scope, chainId: this.chainId },
          payloadFingerprint: { algorithm: 'sha256', digestHex: external.payloadFingerprint },
          expiresAt: external.expiresAt,
          origin,
          summary: prepared.review.summary,
          validate: async () => {
            await this.requireUnchangedExecutionIdentity(origin, active)
            const current = await transferController.getExternalSigningRequest(
              prepared.graph.root.id
            )
            if (
              current?.vendor !== 'ledger' ||
              current.payloadFingerprint !== external.payloadFingerprint ||
              JSON.stringify(current.ledgerRequest) !== JSON.stringify(external.ledgerRequest)
            ) {
              throw new Error('Ledger EVM transaction changed before signing')
            }
          }
        })
        submission = await transferController.submitExternalSignature(
          prepared.graph.root.id,
          external.payloadFingerprint,
          signed.signatureHex
        )
      }
      submitted = true
      await this.options.operationStore.delete(prepared.graph.root.id).catch(() => {})
      const transactionHash = submission.graph.segments.find(segment => segment.role === 'origin')
        ?.evidence?.transactionHash
      if (!transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
        throw new Error('Approved EVM transfer is missing its signed transaction hash')
      }
      if (submission.status === 'broadcast' && transactionBroadcasted(submission.graph)) {
        emitDAppEvent(this.options.analytics, 'evm', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
          hasTransaction: 1,
          idempotencyKey: `dapp:evm:broadcast:${prepared.graph.root.id}`,
          extra: {
            funding_source:
              'executionMode' in active && active.executionMode === 'private' ? 'private' : 'main',
            hardware: active.context.keyDomainSource.kind === 'hardware'
          }
        })
      }
      return transactionHash.toLowerCase()
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 4001)) {
        void new IndexedDbTransactionRepository()
          .get(prepared.graph.root.scope, prepared.graph.root.id)
          .then(graph => {
            if (graph && !transactionBroadcasted(graph) && graph.root.status !== 'signed') {
              emitDAppEvent(
                this.options.analytics,
                'evm',
                ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED,
                {
                  hasTransaction: 0,
                  idempotencyKey: `dapp:evm:failed:${prepared.graph.root.id}`
                }
              )
            }
          })
          .catch(() => {})
      }
      throw error
    } finally {
      if (!submitted) {
        await this.options.transferController.reject(prepared.graph.root.id).catch(() => {})
        await this.options.operationStore.delete(prepared.graph.root.id).catch(() => {})
      }
    }
  }

  private async signPersonalMessage(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: EvmDAppTabInfo
  ): Promise<string> {
    const parsed = parsePersonalSignRequest(params)
    const active = await this.requireAuthorizedAccount(origin, parsed.address)
    if (
      active.context.keyDomainSource.kind === 'hardware' &&
      active.context.keyDomainSource.vendor === 'ledger'
    ) {
      return this.signLedgerMessage(
        origin,
        active,
        {
          kind: 'personal-sign',
          messageHex: toHex(parsed.message),
          derivationPath: active.context.chainAccount.derivation.path,
          expectedAddress: active.address
        },
        await ledgerEvmPersonalSummary(this.chainId, active.address, parsed.message),
        parsed.message,
        { method: 'personal_sign', message: parsed.displayMessage },
        tabInfo
      )
    }
    this.assertSoftwareSigningAccount(active)
    return this.signMessage(
      origin,
      active,
      {
        kind:
          active.executionMode === 'private' ? 'pea-evm-personal-message' : 'evm-personal-message',
        chainId: this.chainId,
        addressIndex: active.addressIndex,
        message: parsed.message
      },
      { method: 'personal_sign', message: parsed.displayMessage },
      tabInfo
    )
  }

  private async signTypedData(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: EvmDAppTabInfo
  ): Promise<string> {
    const parsed = parseTypedDataV4Request(params, this.options.network.numericChainId)
    const active = await this.requireAuthorizedAccount(origin, parsed.address)
    if (
      active.context.keyDomainSource.kind === 'hardware' &&
      active.context.keyDomainSource.vendor === 'ledger'
    ) {
      const typedData = JSON.parse(parsed.typedDataJson) as Readonly<Record<string, unknown>>
      return this.signLedgerMessage(
        origin,
        active,
        {
          kind: 'typed-data',
          typedData,
          derivationPath: active.context.chainAccount.derivation.path,
          expectedAddress: active.address
        },
        ledgerEvmTypedDataSummary(this.chainId, active.address, typedData),
        new TextEncoder().encode(parsed.typedDataJson),
        { method: 'eth_signTypedData_v4', primaryType: parsed.primaryType },
        tabInfo
      )
    }
    this.assertSoftwareSigningAccount(active)
    return this.signMessage(
      origin,
      active,
      {
        kind: active.executionMode === 'private' ? 'pea-evm-typed-data' : 'evm-typed-data',
        chainId: this.chainId,
        addressIndex: active.addressIndex,
        typedDataJson: parsed.typedDataJson
      },
      { method: 'eth_signTypedData_v4', primaryType: parsed.primaryType },
      tabInfo
    )
  }

  private async signMessage(
    origin: string,
    active: ActiveEvmDAppAccount,
    payload: Parameters<EvmMultichainSigningClient['prepare']>[1],
    display: Readonly<Record<string, unknown>>,
    tabInfo: EvmDAppTabInfo
  ): Promise<string> {
    const prepared = await this.options.signer.prepare(
      active.context.chainAccount.scope.keyDomainId,
      payload
    )
    let confirmed = false
    try {
      await this.requireUnchangedExecutionIdentity(origin, active)
      const decision = await this.options.approval.requestExternalApproval(origin, 'evmMessage', {
        chainName: this.options.network.displayName,
        executionMode: active.executionMode,
        review: prepared,
        ...display,
        ...dappApprovalMetadata(tabInfo)
      })
      if (!decision.approved) {
        throw new Eip1193ProviderError(4001, 'User rejected the signature request.')
      }
      const signed = await this.options.runActiveOperation(async () => {
        const current = await this.requireUnchangedExecutionIdentity(origin, active)
        const result = await this.options.signer.confirm(
          current.context.chainAccount.scope.keyDomainId,
          prepared.commandId
        )
        const verified = await this.requireAuthorizedAccount(origin, active.address)
        this.assertActiveRuntime()
        if (!activeAccountsEqual(verified, current)) {
          throw new Eip1193ProviderError(
            4100,
            'The EVM account authorization changed before signing completed.'
          )
        }
        return result
      })
      confirmed = true
      return this.requireMatchingSignature(signed, active.address)
    } finally {
      if (!confirmed) {
        await this.options.signer
          .cancel(active.context.chainAccount.scope.keyDomainId, prepared.commandId)
          .catch(() => {})
      }
    }
  }

  private async signLedgerMessage(
    origin: string,
    active: ActiveEvmDAppAccount,
    request: Extract<LedgerEvmSigningRequest, { kind: 'personal-sign' | 'typed-data' }>,
    summary: Awaited<ReturnType<typeof ledgerEvmPersonalSummary>>,
    payload: Uint8Array,
    display: Readonly<Record<string, unknown>>,
    tabInfo: EvmDAppTabInfo
  ): Promise<string> {
    if (!this.options.transferController)
      throw new Eip1193ProviderError(4200, 'Ledger EVM signing is unavailable')
    const binding = await this.options.transferController.getLedgerSignerBinding(
      active.context.chainAccount
    )
    if (
      binding.derivationPath !== request.derivationPath ||
      binding.address.toLowerCase() !== active.address
    ) {
      throw new Error('Ledger EVM signing account binding changed')
    }
    const payloadFingerprint = await digestLedgerPayload(payload)
    const expiresAt = Date.now() + 10 * 60_000
    const decision = await this.options.approval.requestExternalApproval(origin, 'evmMessage', {
      chainName: this.options.network.displayName,
      executionMode: active.executionMode,
      review: {
        summary,
        payloadFingerprint: { algorithm: 'sha256', digestHex: payloadFingerprint },
        expiresAt
      },
      ...display,
      ...dappApprovalMetadata(tabInfo)
    })
    if (!decision.approved)
      throw new Eip1193ProviderError(4001, 'User rejected the signature request.')
    const signed = await requestLedgerSignature(request, {
      scope: { ...active.context.chainAccount.scope, chainId: this.chainId },
      payloadFingerprint: { algorithm: 'sha256', digestHex: payloadFingerprint },
      expiresAt,
      origin,
      summary,
      validate: async () => {
        await this.requireUnchangedExecutionIdentity(origin, active)
        const current = await this.options.transferController!.getLedgerSignerBinding(
          active.context.chainAccount
        )
        if (
          current.derivationPath !== binding.derivationPath ||
          current.address !== binding.address
        ) {
          throw new Error('Ledger EVM account changed before signing')
        }
      }
    })
    const valid =
      request.kind === 'personal-sign'
        ? await verifyMessage({
            address: active.address as Hex,
            message: { raw: request.messageHex as Hex },
            signature: signed.signatureHex as Hex
          })
        : await verifyTypedData({
            ...request.typedData,
            address: active.address as Hex,
            signature: signed.signatureHex as Hex
          } as Parameters<typeof verifyTypedData>[0])
    if (!valid) throw new Error('Ledger EVM signature does not match the approved request')
    await this.requireUnchangedExecutionIdentity(origin, active)
    return signed.signatureHex
  }

  private requireMatchingSignature(result: SigningResult, expectedAddress: string): string {
    if (
      result.kind !== 'signature' ||
      result.signature.encoding !== 'hex' ||
      result.address?.toLowerCase() !== expectedAddress
    ) {
      throw new Error('EVM signature result does not match the approved account')
    }
    return result.signature.value
  }
}
