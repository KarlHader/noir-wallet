import type { QuantusNetworkConfig } from '@/config/networks'
import type { AccountRef, DAppManager } from '@/core/dapp/dapp-manager'
import {
  QuantusProviderError,
  parseQuantusBroadcastExtrinsicRequest,
  parseQuantusChainRequest,
  parseQuantusNetworkRequest,
  parseQuantusNoParams,
  parseQuantusSendRequest,
  type QuantusDAppRuntimeMethod
} from '@/core/dapp/quantus-provider'
import { blake2b } from '@noble/hashes/blake2b'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import { transactionBroadcasted } from '@/core/transactions/transaction-analytics'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import type { QuantusBroadcastRpc, QuantusReadRpc } from '@/infrastructure/chains/quantus'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import { ANALYTICS_EVENTS } from '../lib/analytics/constants'
import { emitDAppEvent, observeDAppRequest, type DAppAnalyticsSink } from './dapp-analytics'
import { mapQuantusWalletRuntimeError } from './quantus-wallet-runtime-error'
import type {
  ActiveQuantusTransferContext,
  BackgroundQuantusTransferController,
  BackgroundQuantusTransferReview
} from './quantus-transfer-controller'

export interface QuantusDAppApprovalPort {
  readonly requestExternalApproval: (
    origin: string,
    action: string,
    data?: unknown,
    options?: {
      readonly onNetworkFeeTierChange?: (tier: 'low' | 'standard' | 'fast') => Promise<unknown>
      readonly cancelOnNetworkFeeTierChangeError?: boolean
    }
  ) => Promise<{
    readonly approved: boolean
    readonly requestId: string
    readonly selectedIds?: readonly string[]
  }>
  readonly broadcastProviderEvent: (
    origin: string,
    chainId: 'quantus',
    eventName: 'accountsChanged' | 'networkChanged',
    data: unknown
  ) => Promise<void>
  readonly cancelPendingApprovals: (origin: string, chainId: 'quantus') => number
}

export interface QuantusDAppBalance {
  readonly free: string
  readonly reserved: string
  readonly nonce: number
}

export interface BackgroundQuantusDAppHandlerOptions {
  readonly analytics?: DAppAnalyticsSink
  readonly network: QuantusNetworkConfig
  readonly manager: Pick<
    DAppManager,
    | 'getAllConnections'
    | 'getChainAuthorization'
    | 'removeChainAuthorization'
    | 'setChainAuthorizedAccounts'
  >
  readonly approval: QuantusDAppApprovalPort
  /** Absent when Quantus new operations are disabled in this build. */
  readonly transferController?: Pick<
    BackgroundQuantusTransferController,
    'prepare' | 'approveForDApp' | 'signForDApp' | 'findSignedOnlyForDApp' | 'reject'
  >
  readonly loadActiveAccount: () => Promise<ActiveQuantusDAppAccount | null>
  readonly hasUnlockSession: () => Promise<boolean>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
  readonly rpc: Pick<QuantusReadRpc, 'assertExpectedChain' | 'getAccountInfo'> &
    Pick<QuantusBroadcastRpc, 'submitExtrinsic'>
}

export interface QuantusDAppRequest {
  readonly method: QuantusDAppRuntimeMethod
  readonly params?: readonly unknown[]
}

export interface QuantusDAppTabInfo {
  readonly title?: string
  readonly favIconUrl?: string
  readonly pageUrl?: string
}

export interface ActiveQuantusDAppAccount {
  readonly keyDomainId: string
  readonly accountId: string
  readonly accountIndex: number
  readonly address: string
  readonly publicKey: string
  readonly reference: AccountRef
}

function dappApprovalMetadata(tabInfo: QuantusDAppTabInfo): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
    ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
  })
}

function accountRefsEqual(left: AccountRef, right: AccountRef): boolean {
  return left.walletId === right.walletId && left.accountId === right.accountId
}

function activeAccountsEqual(
  left: ActiveQuantusDAppAccount,
  right: ActiveQuantusDAppAccount
): boolean {
  return (
    accountRefsEqual(left.reference, right.reference) &&
    left.address === right.address &&
    left.publicKey === right.publicKey
  )
}

function publicKeyWithoutPrefix(publicKey: string): string {
  return publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey
}

/** Maps a transfer-preparation failure onto the provider error contract. */
function toQuantusPrepareError(error: unknown): QuantusProviderError {
  const mapped = mapQuantusWalletRuntimeError(error)
  if (mapped.code === 'invalid-request') return new QuantusProviderError(-32602, mapped.message)
  if (mapped.code === 'account-unavailable') return new QuantusProviderError(4100, mapped.message)
  return new QuantusProviderError(
    -32603,
    mapped.code === 'request-failed'
      ? 'Noir Wallet could not prepare this Quantus transfer.'
      : mapped.message
  )
}

/** Reports one reviewed dApp operation; rejections and uncertain broadcasts are excluded. */
function reportQuantusDAppFailure(
  analytics: DAppAnalyticsSink | undefined,
  reviewed: BackgroundQuantusTransferReview,
  error: unknown
): void {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  if (code === 4001 || code === 4900) return
  void new IndexedDbTransactionRepository()
    .get(reviewed.graph.root.scope, reviewed.graph.root.id)
    .then(graph => {
      if (graph && !transactionBroadcasted(graph) && graph.root.status !== 'signed') {
        emitDAppEvent(analytics, 'quantus', ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED, {
          hasTransaction: 0,
          idempotencyKey: `dapp:quantus:failed:${reviewed.graph.root.id}`
        })
      }
    })
    .catch(() => {})
}

/**
 * Revalidates the reviewed transfer at the confirmation boundary: the same dApp
 * origin and account, the same network, and the same ChainAccount scope and
 * address that were reviewed. A late fee or RPC update cannot change the
 * recipient, amount, nonce, era or fee ceiling in the approved payload.
 */
function assertReviewedTransferStillActive(
  current: ActiveQuantusDAppAccount,
  approved: ActiveQuantusDAppAccount,
  context: ActiveQuantusTransferContext,
  scope: TransactionAccountScope,
  chainId: string
): void {
  if (
    !activeAccountsEqual(current, approved) ||
    context.chainAccount.scope.chainId !== chainId ||
    context.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
    context.chainAccount.scope.accountId !== scope.accountId ||
    context.chainAccount.identity.kind !== 'account-identifier' ||
    context.chainAccount.identity.value !== approved.address
  ) {
    throw new QuantusProviderError(
      4100,
      'The active Quantus account changed. Review the transaction request again.'
    )
  }
}

export class BackgroundQuantusDAppHandler {
  private readonly broadcasts = new Map<string, Promise<string>>()

  constructor(private readonly options: BackgroundQuantusDAppHandlerOptions) {}

  async request(
    request: QuantusDAppRequest,
    origin: string,
    tabInfo: QuantusDAppTabInfo
  ): Promise<unknown> {
    return observeDAppRequest(this.options.analytics, 'quantus', request.method, () =>
      this.handleRequest(request, origin, tabInfo)
    )
  }

  private async handleRequest(
    request: QuantusDAppRequest,
    origin: string,
    tabInfo: QuantusDAppTabInfo
  ): Promise<unknown> {
    switch (request.method) {
      case 'connect': {
        const [address] = await this.requestAccounts(origin, tabInfo, request.params, true)
        const active = await this.requireAuthorizedAccount(origin, address)
        return Object.freeze({
          address: active.address,
          publicKey: publicKeyWithoutPrefix(active.publicKey)
        })
      }
      case 'requestAccounts':
        return this.requestAccounts(origin, tabInfo, request.params)
      case 'getAccounts':
        parseQuantusNoParams(request.params)
        return this.getAccounts(origin)
      case 'getNetwork':
        parseQuantusNoParams(request.params)
        return this.networkName()
      case 'getChain':
        parseQuantusNoParams(request.params)
        return this.chainDescription()
      case 'getPublicKey': {
        parseQuantusNoParams(request.params)
        return publicKeyWithoutPrefix((await this.requireAuthorizedAccount(origin)).publicKey)
      }
      case 'getBalance':
        parseQuantusNoParams(request.params)
        return this.getBalance(origin)
      case 'sendQuantus':
        return this.sendQuantus(request.params, origin, tabInfo)
      case 'signQuantusTransfer':
        return this.signQuantusTransfer(request.params, origin, tabInfo)
      case 'broadcastExtrinsic':
        return this.broadcastExtrinsic(request.params, origin)
      case 'switchNetwork': {
        const requested = parseQuantusNetworkRequest(request.params)
        if (requested !== this.networkName()) this.throwFixedNetwork()
        return null
      }
      case 'switchChain': {
        const requested = parseQuantusChainRequest(request.params)
        if (requested !== this.chainDescription().enum) this.throwFixedNetwork()
        return null
      }
      case 'disconnect':
        parseQuantusNoParams(request.params)
        await this.options.runActiveOperation(async () => {
          await this.options.manager.removeChainAuthorization(origin, this.options.network.chainId)
          this.options.approval.cancelPendingApprovals(origin, 'quantus')
          await this.options.approval
            .broadcastProviderEvent(origin, 'quantus', 'accountsChanged', [])
            .catch(() => {})
        })
        emitDAppEvent(this.options.analytics, 'quantus', ANALYTICS_EVENTS.DAPP_DISCONNECTED)
        return null
    }
  }

  async notifyAccountsChanged(): Promise<void> {
    const connections = await this.options.manager.getAllConnections()
    const quantusConnections = connections.filter(connection =>
      connection.chainAuthorizations?.some(
        authorization => authorization.chainId === this.options.network.chainId
      )
    )
    if (quantusConnections.length === 0) return
    await Promise.all(
      quantusConnections.map(async connection => {
        const accounts = await this.getAccounts(connection.origin).catch(() => [])
        await this.options.approval
          .broadcastProviderEvent(connection.origin, 'quantus', 'accountsChanged', accounts)
          .catch(() => {})
      })
    )
  }

  private networkName(): 'mainnet' | 'testnet' {
    return this.options.network.networkMode
  }

  private chainDescription() {
    const mainnet = this.options.network.networkMode === 'mainnet'
    return Object.freeze({
      enum: mainnet ? ('QUANTUS_MAINNET' as const) : ('QUANTUS_PLANCK' as const),
      name: this.options.network.displayName,
      network: this.networkName()
    })
  }

  private throwFixedNetwork(): never {
    throw new QuantusProviderError(
      4901,
      'Noir Wallet uses a global network mode. Change it in wallet settings; the extension will restart before using the selected mode.'
    )
  }

  private async requireUnlockedActiveAccount(): Promise<ActiveQuantusDAppAccount> {
    if (!(await this.options.hasUnlockSession())) {
      throw new QuantusProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
    }
    const active = await this.options.loadActiveAccount()
    if (!active) {
      throw new QuantusProviderError(4100, 'The active wallet has no Quantus account.')
    }
    return active
  }

  private async requireAuthorizedAccount(
    origin: string,
    requestedAddress?: string
  ): Promise<ActiveQuantusDAppAccount> {
    const active = await this.requireUnlockedActiveAccount()
    const authorization = await this.options.manager.getChainAuthorization(
      origin,
      this.options.network.chainId
    )
    if (
      !authorization ||
      !authorization.accounts.some(account => accountRefsEqual(account, active.reference))
    ) {
      throw new QuantusProviderError(
        4100,
        'This site is not authorized for the active Quantus account.'
      )
    }
    if (requestedAddress !== undefined && requestedAddress !== active.address) {
      throw new QuantusProviderError(4100, 'The requested Quantus account is not authorized.')
    }
    return active
  }

  private async getAccounts(origin: string): Promise<readonly string[]> {
    try {
      const active = await this.requireUnlockedActiveAccount()
      const authorization = await this.options.manager.getChainAuthorization(
        origin,
        this.options.network.chainId
      )
      if (
        !authorization ||
        !authorization.accounts.some(account => accountRefsEqual(account, active.reference))
      ) {
        return Object.freeze([])
      }
      return Object.freeze([active.address])
    } catch {
      return Object.freeze([])
    }
  }

  private async requestAccounts(
    origin: string,
    tabInfo: QuantusDAppTabInfo,
    params?: readonly unknown[],
    forceReview = false
  ): Promise<readonly string[]> {
    parseQuantusNoParams(params)
    const active = await this.requireUnlockedActiveAccount()
    const existing = await this.options.manager.getChainAuthorization(
      origin,
      this.options.network.chainId
    )
    if (
      !forceReview &&
      existing?.accounts.some(account => accountRefsEqual(account, active.reference))
    ) {
      return this.getAccounts(origin)
    }
    const accounts = Object.freeze([
      Object.freeze({
        id: JSON.stringify([active.reference.walletId, active.reference.accountId]),
        label: 'Current account',
        address: active.address,
        required: true
      })
    ])
    const decision = await this.options.approval.requestExternalApproval(origin, 'quantusConnect', {
      chainId: this.options.network.chainId,
      chainName: this.options.network.displayName,
      address: active.address,
      accounts,
      preselectedIds: accounts.map(item => item.id),
      ...dappApprovalMetadata(tabInfo)
    })
    if (!decision.approved) {
      throw new QuantusProviderError(4001, 'User rejected the connection request.')
    }
    return this.options.runActiveOperation(async () => {
      const current = await this.requireUnlockedActiveAccount()
      if (!activeAccountsEqual(current, active)) {
        throw new QuantusProviderError(
          4100,
          'The active Quantus account changed. Review the connection request again.'
        )
      }
      await this.options.manager.setChainAuthorizedAccounts(
        origin,
        tabInfo,
        this.options.network.chainId,
        [current.reference],
        current.reference
      )
      emitDAppEvent(this.options.analytics, 'quantus', ANALYTICS_EVENTS.DAPP_CONNECTED, {
        extra: { account_count: 1, source: 'approval' }
      })
      return Object.freeze([current.address])
    })
  }

  private async getBalance(origin: string): Promise<QuantusDAppBalance> {
    const active = await this.requireAuthorizedAccount(origin)
    await this.options.rpc.assertExpectedChain()
    const account = await this.options.rpc.getAccountInfo(active.address)
    return Object.freeze({
      free: account.free.toString(),
      reserved: account.reserved.toString(),
      nonce: account.nonce
    })
  }

  /**
   * A connected dApp can request one reviewed native transfer. The wallet keeps
   * the signing and submission path (fee ceiling, signed-byte persistence,
   * broadcast and monitoring); the dApp only supplies recipient and amount.
   */
  private async sendQuantus(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: QuantusDAppTabInfo
  ): Promise<string> {
    const transferController = this.options.transferController
    if (!transferController) {
      throw new QuantusProviderError(
        4200,
        'Quantus transfers are unavailable in this wallet build.'
      )
    }
    const { reviewed, active } = await this.prepareReviewedTransfer(params, origin)
    let confirmed = false
    try {
      const decision = await this.options.approval.requestExternalApproval(
        origin,
        'quantusTransaction',
        {
          chainId: this.options.network.chainId,
          chainName: this.options.network.displayName,
          review: reviewed.review,
          ...dappApprovalMetadata(tabInfo)
        }
      )
      if (!decision.approved) {
        throw new QuantusProviderError(4001, 'User rejected the transaction request.')
      }
      const submission = await transferController.approveForDApp(
        reviewed.graph.root.id,
        reviewed.review.payloadFingerprint.digestHex,
        async context => {
          assertReviewedTransferStillActive(
            await this.requireAuthorizedAccount(origin),
            active,
            context,
            reviewed.graph.root.scope,
            this.options.network.chainId
          )
        }
      )
      confirmed = true
      if (submission.status !== 'broadcast') {
        throw new QuantusProviderError(
          4900,
          'The signed Quantus transaction is pending automatic broadcast recovery.'
        )
      }
      const transactionHash = submission.graph.segments.find(segment => segment.role === 'origin')
        ?.evidence?.transactionHash
      if (typeof transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(transactionHash)) {
        throw new QuantusProviderError(
          -32603,
          'The approved Quantus transfer has no transaction hash.'
        )
      }
      if (transactionBroadcasted(submission.graph)) {
        emitDAppEvent(this.options.analytics, 'quantus', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
          hasTransaction: 1,
          idempotencyKey: `dapp:quantus:broadcast:${reviewed.graph.root.id}`
        })
      }
      return transactionHash
    } catch (error) {
      reportQuantusDAppFailure(this.options.analytics, reviewed, error)
      throw error
    } finally {
      if (!confirmed) await transferController.reject(reviewed.graph.root.id).catch(() => {})
    }
  }

  /**
   * Signs the same reviewed native transfer and returns the exact signed bytes
   * without submitting them. The dApp owns submission, so the wallet writes no
   * Activity entry for these bytes and reports no `dapp_transaction_sent` event.
   */
  private async signQuantusTransfer(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: QuantusDAppTabInfo
  ): Promise<string> {
    const transferController = this.options.transferController
    if (!transferController) {
      throw new QuantusProviderError(4200, 'Quantus signing is unavailable in this wallet build.')
    }
    const intent = parseQuantusSendRequest(params)
    await this.requireAuthorizedAccount(origin)
    const recovered = await transferController.findSignedOnlyForDApp(
      { recipient: intent.recipient, amountRaw: intent.amountRaw, keepAlive: true },
      origin
    )
    if (recovered) {
      await this.requireAuthorizedAccount(origin)
      return recovered
    }
    const { reviewed, active } = await this.prepareReviewedTransfer(params, origin)
    let handedOff = false
    try {
      const decision = await this.options.approval.requestExternalApproval(
        origin,
        'quantusSignTransfer',
        {
          chainId: this.options.network.chainId,
          chainName: this.options.network.displayName,
          operation: 'sign-only',
          review: reviewed.review,
          ...dappApprovalMetadata(tabInfo)
        }
      )
      if (!decision.approved) {
        throw new QuantusProviderError(4001, 'User rejected the signing request.')
      }
      const idempotencyKey = bytesToHex(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(
              JSON.stringify([
                origin,
                reviewed.graph.root.scope.keyDomainId,
                reviewed.graph.root.scope.accountId,
                this.options.network.chainId,
                reviewed.graph.root.id,
                reviewed.review.payloadFingerprint.digestHex
              ])
            )
          )
        )
      )
      const signed = await transferController.signForDApp(
        reviewed.graph.root.id,
        reviewed.review.payloadFingerprint.digestHex,
        async context => {
          assertReviewedTransferStillActive(
            await this.requireAuthorizedAccount(origin),
            active,
            context,
            reviewed.graph.root.scope,
            this.options.network.chainId
          )
        },
        origin,
        idempotencyKey
      )
      handedOff = true
      // The bytes must belong to the reviewed transfer and stay unsubmitted.
      if (
        signed.graph.root.id !== reviewed.graph.root.id ||
        signed.graph.root.status !== 'signed' ||
        typeof signed.signedExtrinsicHex !== 'string' ||
        !/^0x(?:[0-9a-f]{2})+$/.test(signed.signedExtrinsicHex) ||
        !/^0x[0-9a-f]{64}$/.test(signed.extrinsicHash)
      ) {
        throw new QuantusProviderError(-32603, 'The signed Quantus transfer is not valid.')
      }
      return signed.signedExtrinsicHex
    } catch (error) {
      reportQuantusDAppFailure(this.options.analytics, reviewed, error)
      throw error
    } finally {
      if (!handedOff) await transferController.reject(reviewed.graph.root.id).catch(() => {})
    }
  }

  private async prepareReviewedTransfer(
    params: readonly unknown[] | undefined,
    origin: string
  ): Promise<
    Readonly<{ reviewed: BackgroundQuantusTransferReview; active: ActiveQuantusDAppAccount }>
  > {
    const transferController = this.options.transferController
    if (!transferController) {
      throw new QuantusProviderError(
        4200,
        'Quantus transfers are unavailable in this wallet build.'
      )
    }
    const intent = parseQuantusSendRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    try {
      // Keep-alive is fixed for dApp requests so a site cannot drain the account.
      const reviewed = await transferController.prepare({ ...intent, keepAlive: true })
      return Object.freeze({ reviewed, active })
    } catch (error) {
      throw toQuantusPrepareError(error)
    }
  }

  private async broadcastExtrinsic(
    params: readonly unknown[] | undefined,
    origin: string
  ): Promise<string> {
    const extrinsic = parseQuantusBroadcastExtrinsicRequest(params)
    const expectedHash = `0x${bytesToHex(blake2b(hexToBytes(extrinsic), { dkLen: 32 }))}`
    const key = `${this.options.network.chainId}:${expectedHash}`
    const existing = this.broadcasts.get(key)
    if (existing) {
      await this.requireAuthorizedAccount(origin)
      return existing
    }
    const operation = this.options.runActiveOperation(async () => {
      await this.requireAuthorizedAccount(origin)
      await this.options.rpc.assertExpectedChain()
      await this.requireAuthorizedAccount(origin)
      // Authorization is for the relay, not proof that the external signer owns this wallet account.
      const result = await this.options.rpc.submitExtrinsic(extrinsic)
      if (result !== expectedHash) {
        throw new QuantusProviderError(-32603, 'Quantus RPC returned a mismatched extrinsic hash.')
      }
      emitDAppEvent(this.options.analytics, 'quantus', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
        hasTransaction: 1,
        idempotencyKey: `dapp:quantus:broadcast:${expectedHash}`
      })
      return result
    })
    this.broadcasts.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.broadcasts.get(key) === operation) this.broadcasts.delete(key)
    }
  }
}
