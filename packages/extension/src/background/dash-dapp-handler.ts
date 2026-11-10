import { Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import { ANALYTICS_EVENTS } from '../lib/analytics/constants'
import { emitDAppEvent, observeDAppRequest, type DAppAnalyticsSink } from './dapp-analytics'
import type { DashNetworkConfig } from '@/config/networks'
import type { AccountRef, DAppManager } from '@/core/dapp/dapp-manager'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { parseChainId } from '@/core/chains/registry'
import {
  assertDashDAppEnabled,
  assertDashMessageSigningAllowed,
  assertDashReviewedPaymentUnchanged,
  assertDashTransactionSigningAllowed,
  DASH_CHAIN_DISABLED_CODE,
  DASH_CHAIN_MISMATCH_CODE,
  DashProviderError,
  mapDashInsufficientTransferError,
  parseDashMessageRequest,
  parseDashNoParams,
  parseDashPsbtRequest,
  parseDashPsbtsRequest,
  parseDashPushPsbtRequest,
  parseDashPushTransactionRequest,
  parseDashSendRequest,
  type DashDAppRuntimeMethod,
  type DashDAppSigner
} from '@/core/dapp/dash-provider'
import type { KeyDomainSource } from '@/core/keyring/domain'
import { parseSigningSummary } from '@/core/keyring/domain'
import type { PortfolioSourceStatus } from '@/core/portfolio'
import type { SigningResult } from '@/core/keyring/ports'
import type { ActiveDashDiscoveryContext } from '@/infrastructure/chains/dash/dash-discovery-coordinator'
import type { DashMultichainDerivationClient } from '@/infrastructure/keyring/multichain/dash-derivation-client'
import type { DashMultichainSigningClient } from '@/infrastructure/keyring/multichain/dash-signing-client'
import { computeDashSigningPayloadFingerprint } from '@/infrastructure/chains/dash/dash-prepared-psbt-validator'
import { dashBitcoinJsNetwork } from '@/infrastructure/chains/dash/dash-transaction-model'
import type { DashInsightRpc } from '@/infrastructure/chains/dash/dash-insight-client'
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '@/lib/bytes'
import type { BackgroundDashTransferController } from './dash-transfer-controller'
import { requestLedgerSignature } from './ledger-signing-coordinator'
import { dashReviewedPayment, ledgerDashPsbtSummary } from './ledger-dash-dapp-review'
import {
  assertDashHardwareSignedTransactionMatchesReview,
  assertDashLedgerMessageSignature,
  deriveLedgerDashP2pkh
} from '@/lib/ledger/dash-model'
import type { DAppChainAccountDescriptor } from './dapp-chain-account-catalog'
import {
  activeDAppSessionAccountMatches,
  selectDAppSessionAccounts,
  type DAppSessionAccountProposal,
  type DAppSessionAccountSelection
} from './dapp-session-accounts'
import type { TransactionGraph } from '@/core/transactions/domain'

export interface DashDAppApprovalPort {
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
    chainId: 'dash',
    eventName: 'accountsChanged' | 'networkChanged',
    data: unknown
  ) => Promise<void>
  readonly cancelPendingApprovals: (origin: string, chainId: 'dash') => number
}

export interface LedgerDashAccountBinding {
  readonly accountPath: string
  readonly xpub: string
  readonly expectedAddress: string
}

export interface BackgroundDashDAppHandlerOptions {
  readonly enabled: boolean
  readonly analytics?: DAppAnalyticsSink
  readonly network: DashNetworkConfig
  readonly manager: Pick<
    DAppManager,
    | 'getAllConnections'
    | 'getChainAuthorization'
    | 'removeChainAuthorization'
    | 'setChainAuthorizedAccounts'
  >
  readonly approval: DashDAppApprovalPort
  readonly loadActiveContext: () => Promise<ActiveDashDiscoveryContext | null>
  readonly listAccounts?: () => Promise<readonly DAppChainAccountDescriptor[]>
  readonly hasUnlockSession: () => Promise<boolean>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
  readonly transferController: BackgroundDashTransferController | null
  readonly derivation: Pick<DashMultichainDerivationClient, 'deriveAddress'>
  readonly signer: Pick<DashMultichainSigningClient, 'prepare' | 'confirm' | 'cancel'>
  readonly portfolio: {
    refreshActiveSource: () => Promise<{
      readonly generationId: string
      readonly chainAccount: { readonly id: string }
      readonly source: {
        readonly status: PortfolioSourceStatus
        readonly balances: readonly {
          readonly spendableRaw: string
          readonly totalRaw: string
          readonly updatedAt: number
        }[]
      }
    } | null>
  }
  readonly rpc: Pick<DashInsightRpc, 'broadcastRawTransaction'>
  readonly loadLedgerAccount: (
    context: ActiveDashDiscoveryContext,
    address: string
  ) => Promise<LedgerDashAccountBinding>
}

export interface DashDAppRequest {
  readonly method: DashDAppRuntimeMethod
  readonly params?: readonly unknown[]
}

export interface DashDAppTabInfo {
  readonly title?: string
  readonly favIconUrl?: string
  readonly pageUrl?: string
}

interface ActiveDashDAppAccount {
  readonly context: ActiveDashDiscoveryContext
  readonly reference: AccountRef
  readonly address: string
  readonly publicKey: string
}

function dappApprovalMetadata(tabInfo: DashDAppTabInfo): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
    ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
  })
}

function accountRefsEqual(left: AccountRef, right: AccountRef): boolean {
  return left.walletId === right.walletId && left.accountId === right.accountId
}

function activeAccountsEqual(left: ActiveDashDAppAccount, right: ActiveDashDAppAccount): boolean {
  return (
    accountRefsEqual(left.reference, right.reference) &&
    left.address === right.address &&
    left.publicKey === right.publicKey &&
    left.context.generationId === right.context.generationId
  )
}

function signerKind(source: KeyDomainSource): DashDAppSigner {
  if (source.kind === 'software') return 'software'
  if (source.kind === 'private-key') return 'private-key'
  if (source.kind === 'hardware' && source.vendor === 'ledger') return 'ledger'
  if (source.kind === 'hardware' && source.vendor === 'keystone') return 'keystone'
  throw new DashProviderError(4200, 'Unsupported Dash signer')
}

function providerPublicKey(value: string): string {
  const hex = value.toLowerCase().replace(/^0x/, '')
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) throw new Error('Dash public key is invalid')
  return hex
}

function safeDuffs(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid Dash balance')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Dash balance exceeds the provider range')
  }
  return parsed
}

function mapLedgerMessageError(error: unknown): DashProviderError {
  if (error instanceof DashProviderError) return error
  const message = error instanceof Error ? error.message : ''
  const rejected = message.match(/Ledger Dash app rejected the request \(0x[0-9a-f]{4}\)/i)
  if (rejected?.[0].toLowerCase().endsWith('0x6985)')) {
    return new DashProviderError(4001, 'User rejected the signature request.')
  }
  if (rejected) return new DashProviderError(4200, rejected[0])
  if (/cancelled/i.test(message)) {
    return new DashProviderError(4001, 'User rejected the signature request.')
  }
  if (/does not match the approved message/i.test(message)) {
    return new DashProviderError(4200, 'Ledger Dash signature does not match the approved message.')
  }
  return new DashProviderError(4200, 'Ledger Dash message signing failed.')
}

function mapTransferError(error: unknown): DashProviderError {
  if (error instanceof DashProviderError) return error
  console.log('mapTransferError error: %o', error)
  const insufficient = mapDashInsufficientTransferError(error)
  if (insufficient) return insufficient
  const message = error instanceof Error ? error.message : ''
  if (/invalid dash/i.test(message)) {
    return new DashProviderError(-32602, 'Dash transfer request is invalid.')
  }
  if (/not available|authorization|changed|expired/i.test(message)) {
    return new DashProviderError(4100, 'The active Dash account is not available for this request.')
  }
  if (/software account/i.test(message)) {
    return new DashProviderError(4200, 'Dash dApp sends require a software account.')
  }
  return new DashProviderError(-32603, 'Noir Wallet could not complete the Dash transfer.')
}

function originTransactionId(graph: TransactionGraph): string {
  for (const segment of graph.segments) {
    const hash = segment.evidence?.transactionHash
    if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) return hash
  }
  throw new DashProviderError(-32603, 'Approved Dash transfer is missing its transaction id.')
}

function finalizeIncompletePsbtInputs(psbt: Psbt): void {
  psbt.data.inputs.forEach((input, index) => {
    if (input.finalScriptSig === undefined && input.finalScriptWitness === undefined) {
      psbt.finalizeInput(index)
    }
  })
}

export class BackgroundDashDAppHandler {
  constructor(private readonly options: BackgroundDashDAppHandlerOptions) {}

  async request(
    request: DashDAppRequest,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<unknown> {
    assertDashDAppEnabled(this.options.enabled)
    return observeDAppRequest(this.options.analytics, 'dash', request.method, () =>
      this.handleRequest(request, origin, tabInfo)
    )
  }

  private async handleRequest(
    request: DashDAppRequest,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<unknown> {
    switch (request.method) {
      case 'connect': {
        const [address] = await this.requestAccounts(origin, tabInfo, request.params, true)
        const active = await this.requireAuthorizedAccount(origin, address)
        return Object.freeze({
          address: active.address,
          publicKey: providerPublicKey(active.publicKey)
        })
      }
      case 'requestAccounts':
        return this.requestAccounts(origin, tabInfo, request.params)
      case 'getAccounts':
        parseDashNoParams(request.params)
        return this.getAccounts(origin)
      case 'getNetwork':
        parseDashNoParams(request.params)
        return this.options.network.networkMode
      case 'getChain':
        parseDashNoParams(request.params)
        return Object.freeze({
          chainId: this.options.network.chainId,
          name: this.options.network.displayName,
          network: this.options.network.networkMode
        })
      case 'getPublicKey': {
        parseDashNoParams(request.params)
        return providerPublicKey((await this.requireAuthorizedAccount(origin)).publicKey)
      }
      case 'getBalance':
        parseDashNoParams(request.params)
        return this.getBalance(origin)
      case 'sendDash':
        return this.sendDash(request.params, origin, tabInfo)
      case 'signMessage':
        return this.signMessage(request.params, origin, tabInfo)
      case 'signPsbt':
        return this.signPsbt(request.params, origin, tabInfo)
      case 'signPsbts':
        return this.signPsbts(request.params, origin, tabInfo)
      case 'pushPsbt':
        return this.pushPsbt(request.params, origin)
      case 'pushTx':
        return this.pushTransaction(request.params, origin)
      case 'disconnect':
        parseDashNoParams(request.params)
        await this.options.runActiveOperation(async () => {
          await this.options.manager.removeChainAuthorization(origin, this.options.network.chainId)
          this.options.approval.cancelPendingApprovals(origin, 'dash')
          await this.options.approval
            .broadcastProviderEvent(origin, 'dash', 'accountsChanged', [])
            .catch(() => {})
        })
        emitDAppEvent(this.options.analytics, 'dash', ANALYTICS_EVENTS.DAPP_DISCONNECTED)
        return null
    }
  }

  async notifyAccountsChanged(): Promise<void> {
    if (!this.options.enabled) return
    const connections = await this.options.manager.getAllConnections()
    const dashConnections = connections.filter(connection =>
      connection.chainAuthorizations?.some(
        authorization => authorization.chainId === this.options.network.chainId
      )
    )
    if (dashConnections.length === 0) return
    await Promise.all(
      dashConnections.map(async connection => {
        const accounts = await this.getAccounts(connection.origin).catch(() => [])
        await this.options.approval
          .broadcastProviderEvent(connection.origin, 'dash', 'accountsChanged', accounts)
          .catch(() => {})
      })
    )
  }

  async prepareSessionAccountSelection(origin: string): Promise<DAppSessionAccountProposal> {
    const active = await this.requireUnlockedActiveAccount()
    const existing = await this.options.manager.getChainAuthorization(
      origin,
      this.options.network.chainId
    )
    const available = await this.listAvailableAccounts(active)
    const accounts = available.map(item =>
      Object.freeze({
        ...item,
        required: accountRefsEqual(item.reference, active.reference)
      })
    )
    return Object.freeze({
      chainId: this.options.network.chainId,
      chainName: this.options.network.displayName,
      iconChain: 'dash',
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
      throw new DashProviderError(
        4100,
        'The active Dash account changed. Review the connection request again.'
      )
    }
    return selectDAppSessionAccounts(proposal, selectedIds)
  }

  async getSessionAccounts(origin: string): Promise<readonly string[]> {
    return this.getAccounts(origin)
  }

  private async loadActiveAccount(): Promise<ActiveDashDAppAccount> {
    const context = await this.options.loadActiveContext()
    if (!context || context.chainAccount.scope.chainId !== this.options.network.chainId) {
      throw new DashProviderError(4100, 'The active wallet has no Dash account.')
    }
    const derived = await this.options.derivation
      .deriveAddress(context.chainAccount.scope.keyDomainId, {
        chainId: context.chainAccount.scope.chainId,
        accountIndex: context.accountIndex,
        change: false,
        addressIndex: 0
      })
      .catch(error => {
        const name = error instanceof Error ? error.name : 'UnknownError'
        const message = error instanceof Error ? error.message : 'Dash address derivation failed'
        console.error(`Dash dApp address derivation failed: ${name}: ${message}`)
        throw error
      })
    if (derived.chainId !== this.options.network.chainId) {
      throw new DashProviderError(DASH_CHAIN_MISMATCH_CODE, 'This chain is not Dash.')
    }
    return Object.freeze({
      context,
      reference: Object.freeze({
        walletId: context.chainAccount.scope.keyDomainId,
        accountId: context.chainAccount.scope.accountId
      }),
      address: derived.address,
      publicKey: derived.publicKey
    })
  }

  private async requireUnlockedActiveAccount(): Promise<ActiveDashDAppAccount> {
    if (!(await this.options.hasUnlockSession())) {
      throw new DashProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
    }
    return this.loadActiveAccount()
  }

  private async listAvailableAccounts(
    active: ActiveDashDAppAccount
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

  private async requireAuthorizedAccount(
    origin: string,
    requestedAddress?: string
  ): Promise<ActiveDashDAppAccount> {
    const active = await this.requireUnlockedActiveAccount()
    const authorization = await this.options.manager.getChainAuthorization(
      origin,
      this.options.network.chainId
    )
    if (
      !authorization ||
      !authorization.accounts.some(account => accountRefsEqual(account, active.reference))
    ) {
      throw new DashProviderError(4100, 'This site is not authorized for the active Dash account.')
    }
    if (requestedAddress !== undefined && requestedAddress !== active.address) {
      throw new DashProviderError(4100, 'The requested Dash account is not authorized.')
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
    } catch (error) {
      if (
        error instanceof DashProviderError &&
        (error.code === DASH_CHAIN_DISABLED_CODE || error.code === DASH_CHAIN_MISMATCH_CODE)
      ) {
        throw error
      }
      return Object.freeze([])
    }
  }

  private async requestAccounts(
    origin: string,
    tabInfo: DashDAppTabInfo,
    params?: readonly unknown[],
    forceReview = false
  ): Promise<readonly string[]> {
    parseDashNoParams(params)
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
    const available = await this.listAvailableAccounts(active)
    const preselectedIds = available
      .filter(
        item =>
          accountRefsEqual(item.reference, active.reference) ||
          existing?.accounts.some(account => accountRefsEqual(account, item.reference))
      )
      .map(item => item.id)
    const decision = await this.options.approval.requestExternalApproval(origin, 'dashConnect', {
      chainId: this.options.network.chainId,
      chainName: this.options.network.displayName,
      address: active.address,
      accounts: available.map(item => ({
        id: item.id,
        label: item.label,
        address: item.address,
        required: accountRefsEqual(item.reference, active.reference)
      })),
      preselectedIds,
      ...dappApprovalMetadata(tabInfo)
    })
    if (!decision.approved) {
      throw new DashProviderError(4001, 'User rejected the connection request.')
    }
    return this.options.runActiveOperation(async () => {
      const current = await this.requireUnlockedActiveAccount()
      if (!activeAccountsEqual(current, active)) {
        throw new DashProviderError(
          4100,
          'The active Dash account changed. Review the connection request again.'
        )
      }
      const selectedIds = decision.selectedIds ?? preselectedIds
      const chosen = available.filter(item => selectedIds.includes(item.id))
      if (!chosen.some(item => accountRefsEqual(item.reference, current.reference))) {
        throw new DashProviderError(4100, 'The active Dash account must remain authorized.')
      }
      await this.options.manager.setChainAuthorizedAccounts(
        origin,
        tabInfo,
        this.options.network.chainId,
        chosen.map(item => item.reference),
        current.reference
      )
      emitDAppEvent(this.options.analytics, 'dash', ANALYTICS_EVENTS.DAPP_CONNECTED, {
        extra: { account_count: chosen.length, source: 'approval' }
      })
      return Object.freeze([...new Set(chosen.map(item => item.address))])
    })
  }

  private async getBalance(origin: string) {
    const active = await this.requireAuthorizedAccount(origin)
    const portfolio = await this.options.portfolio.refreshActiveSource()
    if (
      portfolio &&
      (portfolio.generationId !== active.context.generationId ||
        portfolio.chainAccount.id !== active.context.chainAccount.id)
    ) {
      throw new Error('Dash Portfolio response does not match the authorized account')
    }
    const balance = portfolio?.source.balances[0]
    if (portfolio?.source.status === 'error' && (!balance || balance.updatedAt === 0)) {
      throw new DashProviderError(-32603, 'Dash balance is unavailable.')
    }
    if (!balance) return Object.freeze({ confirmed: 0, unconfirmed: 0, total: 0 })
    const confirmed = safeDuffs(balance.spendableRaw)
    const total = safeDuffs(balance.totalRaw)
    if (total < confirmed) throw new Error('Dash total balance is below confirmed balance')
    return Object.freeze({ confirmed, unconfirmed: total - confirmed, total })
  }

  private async sendDash(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<string> {
    const parsed = parseDashSendRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    const signer = signerKind(active.context.keyDomainSource)
    assertDashTransactionSigningAllowed(signer, this.options.network.networkMode)
    if (signer === 'ledger') return this.sendLedgerDash(parsed, active, origin, tabInfo)
    if (signer !== 'software') {
      throw new DashProviderError(4200, 'Dash dApp sends require a software account.')
    }
    if (!this.options.transferController) {
      throw new DashProviderError(
        DASH_CHAIN_DISABLED_CODE,
        'The Dash chain is not enabled in this wallet build.'
      )
    }
    const transferController = this.options.transferController
    let prepared: Awaited<ReturnType<BackgroundDashTransferController['prepare']>>
    try {
      prepared = await transferController.prepare({
        recipient: parsed.recipient,
        amount: { mode: 'exact', valueDuffs: parsed.amountDuffs }
      })
    } catch (error) {
      throw mapTransferError(error)
    }
    let submitted = false
    try {
      const reviewed = dashReviewedPayment(
        prepared.review.summary,
        prepared.review.payloadFingerprint.digestHex
      )
      assertDashReviewedPaymentUnchanged(
        {
          recipient: parsed.recipient,
          amountDuffs: parsed.amountDuffs,
          payloadFingerprint: reviewed.payloadFingerprint
        },
        reviewed
      )
      const decision = await this.options.approval.requestExternalApproval(
        origin,
        'dashTransaction',
        {
          chainName: this.options.network.displayName,
          review: prepared.review,
          ...dappApprovalMetadata(tabInfo)
        }
      )
      if (!decision.approved) {
        throw new DashProviderError(4001, 'User rejected the transaction request.')
      }
      const current = await this.requireAuthorizedAccount(origin, active.address)
      if (!activeAccountsEqual(current, active)) {
        throw new DashProviderError(
          4100,
          'The active Dash account changed. Review the transaction request again.'
        )
      }
      const pending = await transferController.getPendingApproval(prepared.graph.root.id)
      if (!pending) {
        throw new DashProviderError(4100, 'The reviewed Dash transaction is no longer pending.')
      }
      assertDashReviewedPaymentUnchanged(
        reviewed,
        dashReviewedPayment(pending.review.summary, pending.review.payloadFingerprint.digestHex)
      )
      const submission = await transferController.approve(
        prepared.graph.root.id,
        reviewed.payloadFingerprint
      )
      submitted = true
      if (submission.status !== 'broadcast') {
        throw new DashProviderError(
          4900,
          'The signed Dash transaction is pending automatic broadcast recovery.'
        )
      }
      const transactionId = originTransactionId(submission.graph)
      emitDAppEvent(this.options.analytics, 'dash', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
        hasTransaction: 1,
        idempotencyKey: `dapp:dash:broadcast:${prepared.graph.root.id}`
      })
      return transactionId
    } catch (error) {
      if (error instanceof DashProviderError) throw error
      throw mapTransferError(error)
    } finally {
      if (!submitted) {
        await transferController.reject(prepared.graph.root.id).catch(() => {})
      }
    }
  }

  private async sendLedgerDash(
    parsed: ReturnType<typeof parseDashSendRequest>,
    active: ActiveDashDAppAccount,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<string> {
    if (!this.options.transferController) {
      throw new DashProviderError(
        DASH_CHAIN_DISABLED_CODE,
        'The Dash chain is not enabled in this wallet build.'
      )
    }
    const transferController = this.options.transferController
    const chainId = this.options.network.chainId
    if (chainId !== DASH_CHAIN_IDS.mainnet) {
      throw new DashProviderError(4200, 'Dash hardware wallets support mainnet only.')
    }
    let prepared: Awaited<ReturnType<BackgroundDashTransferController['prepareLedger']>>
    try {
      prepared = await transferController.prepareLedger({
        recipient: parsed.recipient,
        amount: { mode: 'exact', valueDuffs: parsed.amountDuffs }
      })
    } catch (error) {
      throw mapTransferError(error)
    }
    let submitted = false
    try {
      const reviewed = dashReviewedPayment(
        prepared.review.summary,
        prepared.review.payloadFingerprint.digestHex
      )
      assertDashReviewedPaymentUnchanged(
        {
          recipient: parsed.recipient,
          amountDuffs: parsed.amountDuffs,
          payloadFingerprint: reviewed.payloadFingerprint
        },
        reviewed
      )
      const decision = await this.options.approval.requestExternalApproval(
        origin,
        'dashTransaction',
        {
          chainName: this.options.network.displayName,
          review: prepared.review,
          ...dappApprovalMetadata(tabInfo)
        }
      )
      if (!decision.approved) {
        throw new DashProviderError(4001, 'User rejected the transaction request.')
      }
      const current = await this.requireAuthorizedAccount(origin, active.address)
      if (!activeAccountsEqual(current, active)) {
        throw new DashProviderError(
          4100,
          'The active Dash account changed. Review the transaction request again.'
        )
      }
      const psbtBase64 = await transferController.getLedgerPsbt(prepared.graph.root.id)
      const binding = await this.options.loadLedgerAccount(current.context, current.address)
      const response = await requestLedgerSignature(
        {
          kind: 'dash-psbt',
          chainId,
          accountPath: binding.accountPath,
          xpub: binding.xpub,
          expectedAddress: binding.expectedAddress,
          psbtBase64
        },
        {
          scope: {
            keyDomainId: current.context.chainAccount.scope.keyDomainId,
            accountId: current.context.chainAccount.scope.accountId,
            chainId: current.context.chainAccount.scope.chainId
          },
          payloadFingerprint: prepared.review.payloadFingerprint,
          expiresAt: prepared.review.expiresAt,
          origin,
          summary: prepared.review.summary,
          validate: async () => {
            const latest = await this.requireAuthorizedAccount(origin, active.address)
            if (!activeAccountsEqual(latest, active)) {
              throw new Error('Ledger Dash account changed before signing')
            }
          }
        }
      )
      if (response.kind !== 'dash-psbt') {
        throw new Error('Ledger Dash signer returned the wrong response')
      }
      const submission = await transferController.submitLedgerSignature(
        prepared.graph.root.id,
        reviewed.payloadFingerprint,
        response.signedTransactionHex
      )
      submitted = true
      if (submission.status !== 'broadcast') {
        throw new DashProviderError(
          4900,
          'The signed Dash transaction is pending automatic broadcast recovery.'
        )
      }
      const transactionId = originTransactionId(submission.graph)
      emitDAppEvent(this.options.analytics, 'dash', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
        hasTransaction: 1,
        idempotencyKey: `dapp:dash:broadcast:${prepared.graph.root.id}`
      })
      return transactionId
    } catch (error) {
      if (error instanceof DashProviderError) throw error
      const message = error instanceof Error ? error.message : ''
      const rejected = message.match(/Ledger Dash app rejected the request \(0x[0-9a-f]{4}\)/i)
      if (rejected?.[0].toLowerCase().endsWith('0x6985)')) {
        throw new DashProviderError(4001, 'User rejected the transaction request.')
      }
      if (rejected) throw new DashProviderError(4200, rejected[0])
      if (/cancelled/i.test(message)) {
        throw new DashProviderError(4001, 'User rejected the transaction request.')
      }
      throw mapTransferError(error)
    } finally {
      if (!submitted) {
        await transferController.reject(prepared.graph.root.id).catch(() => {})
      }
    }
  }

  private async signLedgerMessage(
    parsed: ReturnType<typeof parseDashMessageRequest>,
    active: ActiveDashDAppAccount,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<string> {
    try {
      return await this.collectLedgerMessage(parsed, active, origin, tabInfo)
    } catch (error) {
      throw mapLedgerMessageError(error)
    }
  }

  private async collectLedgerMessage(
    parsed: ReturnType<typeof parseDashMessageRequest>,
    active: ActiveDashDAppAccount,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<string> {
    if (this.options.network.chainId !== DASH_CHAIN_IDS.mainnet) {
      throw new DashProviderError(4200, 'Dash hardware wallets support mainnet only.')
    }
    const chainId = DASH_CHAIN_IDS.mainnet
    const messageBytes = Uint8Array.from(parsed.message)
    const messageHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', messageBytes))]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
    const summary = parseSigningSummary(
      {
        schema: 'dash.message.v1',
        chainId,
        operation: 'message',
        review: { level: 'standard', issues: [] },
        fields: {
          signer: active.address,
          message: {
            encoding: 'utf8',
            value: parsed.displayMessage,
            byteLength: messageBytes.byteLength,
            sha256: messageHash
          },
          messageHash: `0x${messageHash}`
        }
      },
      { family: 'dash', chainId: parseChainId(chainId).id, operation: 'message' }
    )
    const payloadFingerprint = messageHash
    const expiresAt = Date.now() + 10 * 60_000
    const decision = await this.options.approval.requestExternalApproval(origin, 'dashMessage', {
      chainName: this.options.network.displayName,
      review: {
        summary,
        payloadFingerprint: { algorithm: 'sha256', digestHex: payloadFingerprint },
        expiresAt
      },
      ...dappApprovalMetadata(tabInfo)
    })
    if (!decision.approved) {
      throw new DashProviderError(4001, 'User rejected the signature request.')
    }
    const current = await this.requireAuthorizedAccount(origin, active.address)
    if (!activeAccountsEqual(current, active)) {
      throw new DashProviderError(
        4100,
        'The active Dash account changed. Review the signature request again.'
      )
    }
    const binding = await this.options.loadLedgerAccount(current.context, current.address)
    const signed = await requestLedgerSignature(
      {
        kind: 'dash-message',
        chainId,
        accountPath: binding.accountPath,
        expectedAddress: binding.expectedAddress,
        message: parsed.displayMessage
      },
      {
        scope: {
          keyDomainId: current.context.chainAccount.scope.keyDomainId,
          accountId: current.context.chainAccount.scope.accountId,
          chainId: current.context.chainAccount.scope.chainId
        },
        payloadFingerprint: { algorithm: 'sha256', digestHex: payloadFingerprint },
        expiresAt,
        origin,
        summary,
        validate: async () => {
          const latest = await this.requireAuthorizedAccount(origin, active.address)
          if (!activeAccountsEqual(latest, active)) {
            throw new Error('Ledger Dash account changed before signing')
          }
        }
      }
    )
    if (signed.kind !== 'dash-message' || binding.expectedAddress !== current.address) {
      throw new Error('Ledger Dash signature does not match the approved message')
    }
    assertDashLedgerMessageSignature(current.address, parsed.displayMessage, signed.signature)
    return signed.signature
  }

  private async signMessage(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<string> {
    const parsed = parseDashMessageRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    const signer = signerKind(active.context.keyDomainSource)
    if (signer === 'ledger') return this.signLedgerMessage(parsed, active, origin, tabInfo)
    assertDashMessageSigningAllowed(signer)
    const prepared = await this.options.signer.prepare(
      active.context.chainAccount.scope.keyDomainId,
      {
        kind: 'dash-message',
        chainId: active.context.chainAccount.scope.chainId,
        accountIndex: active.context.accountIndex,
        change: false,
        addressIndex: 0,
        message: parsed.message
      }
    )
    const result = await this.confirmSigning(origin, active, prepared, 'dashMessage', tabInfo)
    if (
      result.kind !== 'signature' ||
      result.signature.encoding !== 'base64' ||
      result.address !== active.address ||
      result.publicKey !== active.publicKey
    ) {
      throw new Error('Dash message signature does not match the approved account')
    }
    return result.signature.value
  }

  private async signPsbt(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<string> {
    const parsed = parseDashPsbtRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    const signer = signerKind(active.context.keyDomainSource)
    assertDashTransactionSigningAllowed(signer, this.options.network.networkMode)
    if (signer === 'ledger') return this.signLedgerPsbt(parsed, active, origin, tabInfo)
    const prepared = await this.options.signer.prepare(
      active.context.chainAccount.scope.keyDomainId,
      {
        kind: 'dash-psbt',
        chainId: active.context.chainAccount.scope.chainId,
        accountIndex: active.context.accountIndex,
        psbt: bytesToBase64(hexToBytes(parsed.psbtHex))
      }
    )
    if (
      prepared.summary.schema !== 'dash.psbt.v1' ||
      prepared.summary.fields.signer !== active.address ||
      prepared.summary.fields.signingInputIndexes.length === 0
    ) {
      await this.options.signer
        .cancel(active.context.chainAccount.scope.keyDomainId, prepared.commandId)
        .catch(() => {})
      throw new DashProviderError(4100, 'The PSBT has no input owned by the active account.')
    }
    const reviewed = dashReviewedPayment(prepared.summary, prepared.payloadFingerprint.digestHex)
    const result = await this.confirmSigning(
      origin,
      active,
      prepared,
      'dashTransaction',
      tabInfo,
      () => {
        assertDashReviewedPaymentUnchanged(
          reviewed,
          dashReviewedPayment(prepared.summary, prepared.payloadFingerprint.digestHex)
        )
      }
    )
    if (result.kind !== 'signed-payload' || result.payload.encoding !== 'base64') {
      throw new Error('Dash PSBT signature result is invalid')
    }
    const signedPsbtHex = bytesToHex(base64ToBytes(result.payload.value))
    if (!parsed.autoFinalized) return signedPsbtHex
    try {
      const signedPsbt = Psbt.fromHex(signedPsbtHex, {
        network: dashBitcoinJsNetwork(this.options.network.chainId)
      })
      finalizeIncompletePsbtInputs(signedPsbt)
      return signedPsbt.toHex()
    } catch {
      throw new DashProviderError(
        -32603,
        'Noir Wallet signed the owned inputs but could not finalize every PSBT input.'
      )
    }
  }

  private async signLedgerPsbt(
    parsed: ReturnType<typeof parseDashPsbtRequest>,
    active: ActiveDashDAppAccount,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<string> {
    if (this.options.network.chainId !== DASH_CHAIN_IDS.mainnet) {
      throw new DashProviderError(4200, 'Dash hardware wallets support mainnet only.')
    }
    const chainId = this.options.network.chainId
    const binding = await this.options.loadLedgerAccount(active.context, active.address)
    if (binding.expectedAddress !== active.address) {
      throw new Error('Ledger Dash account export does not match the active account')
    }
    const psbtBase64 = bytesToBase64(hexToBytes(parsed.psbtHex))
    const summary = await this.ledgerSummary(active, binding, psbtBase64)
    const payloadFingerprint = await computeDashSigningPayloadFingerprint(psbtBase64)
    const reviewed = dashReviewedPayment(summary, payloadFingerprint)
    const expiresAt = Date.now() + 10 * 60_000
    const decision = await this.options.approval.requestExternalApproval(
      origin,
      'dashTransaction',
      {
        chainName: this.options.network.displayName,
        review: {
          summary,
          payloadFingerprint: { algorithm: 'sha256', digestHex: payloadFingerprint },
          expiresAt
        },
        ...dappApprovalMetadata(tabInfo)
      }
    )
    if (!decision.approved) {
      throw new DashProviderError(4001, 'User rejected the signature request.')
    }
    const current = await this.requireAuthorizedAccount(origin, active.address)
    if (!activeAccountsEqual(current, active)) {
      throw new DashProviderError(
        4100,
        'The active Dash account changed. Review the signature request again.'
      )
    }
    const currentBinding = await this.options.loadLedgerAccount(current.context, current.address)
    if (
      currentBinding.accountPath !== binding.accountPath ||
      currentBinding.xpub !== binding.xpub ||
      currentBinding.expectedAddress !== binding.expectedAddress
    ) {
      throw new DashProviderError(
        4100,
        'The authorized Ledger Dash account changed before signing.'
      )
    }
    const again = await this.ledgerSummary(current, currentBinding, psbtBase64)
    assertDashReviewedPaymentUnchanged(
      reviewed,
      dashReviewedPayment(again, await computeDashSigningPayloadFingerprint(psbtBase64))
    )
    if (!parsed.autoFinalized) {
      throw new DashProviderError(
        4200,
        'Ledger Dash signing returns a finalized transaction. Omit autoFinalized: false.'
      )
    }
    const response = await requestLedgerSignature(
      {
        kind: 'dash-psbt',
        chainId,
        accountPath: binding.accountPath,
        xpub: binding.xpub,
        expectedAddress: binding.expectedAddress,
        psbtBase64
      },
      {
        scope: {
          keyDomainId: active.context.chainAccount.scope.keyDomainId,
          accountId: active.context.chainAccount.scope.accountId,
          chainId: active.context.chainAccount.scope.chainId
        },
        payloadFingerprint: { algorithm: 'sha256', digestHex: payloadFingerprint },
        expiresAt,
        origin,
        summary,
        validate: async () => {
          const latest = await this.requireAuthorizedAccount(origin, active.address)
          if (!activeAccountsEqual(latest, active)) {
            throw new Error('Ledger Dash account changed before signing')
          }
        }
      }
    )
    if (response.kind !== 'dash-psbt') {
      throw new Error('Ledger Dash signer returned the wrong response')
    }
    assertDashHardwareSignedTransactionMatchesReview(
      psbtBase64,
      response.signedTransactionHex,
      chainId
    )
    return response.signedTransactionHex
  }

  private async ledgerSummary(
    active: ActiveDashDAppAccount,
    binding: LedgerDashAccountBinding,
    psbtBase64: string
  ) {
    const psbt = Psbt.fromBase64(psbtBase64)
    return ledgerDashPsbtSummary({
      chainId: active.context.chainAccount.scope.chainId,
      signer: active.address,
      accountIndex: active.context.accountIndex,
      accountPath: binding.accountPath,
      psbtBase64,
      ownsInput: async index => {
        const entries = (psbt.data.inputs[index]?.bip32Derivation ?? []).filter(entry =>
          entry.path.startsWith(`${binding.accountPath}/`)
        )
        if (entries.length !== 1) return false
        const match = /^\/([01])\/(0|[1-9][0-9]*)$/.exec(
          entries[0].path.slice(binding.accountPath.length)
        )
        if (!match) return false
        const derived = deriveLedgerDashP2pkh(binding.xpub, match[1] === '1', Number(match[2]))
        const spent = psbt.txInputs[index]
        const previous = psbt.data.inputs[index]?.nonWitnessUtxo
        if (!previous || !spent) return false
        const output = Transaction.fromBuffer(previous).outs[spent.index]
        return (
          output?.script.toString('hex') === derived.scriptPubKeyHex &&
          Buffer.from(entries[0].pubkey).toString('hex') === derived.publicKey
        )
      }
    })
  }

  private async signPsbts(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: DashDAppTabInfo
  ): Promise<readonly string[]> {
    const requests = parseDashPsbtsRequest(params)
    const signed: string[] = []
    for (const request of requests) {
      signed.push(
        await this.signPsbt(
          [request.psbtHex, { autoFinalized: request.autoFinalized }],
          origin,
          tabInfo
        )
      )
    }
    return Object.freeze(signed)
  }

  private async pushPsbt(params: readonly unknown[] | undefined, origin: string): Promise<string> {
    const psbtHex = parseDashPushPsbtRequest(params)
    await this.requireAuthorizedAccount(origin)
    let transaction: Transaction
    try {
      const psbt = Psbt.fromHex(psbtHex, {
        network: dashBitcoinJsNetwork(this.options.network.chainId)
      })
      finalizeIncompletePsbtInputs(psbt)
      transaction = psbt.extractTransaction()
    } catch {
      throw new DashProviderError(-32602, 'Dash PSBT is not complete and broadcastable.')
    }
    return this.broadcastTransaction(transaction)
  }

  private async pushTransaction(
    params: readonly unknown[] | undefined,
    origin: string
  ): Promise<string> {
    const rawTransactionHex = parseDashPushTransactionRequest(params)
    await this.requireAuthorizedAccount(origin)
    let transaction: Transaction
    try {
      transaction = Transaction.fromHex(rawTransactionHex)
    } catch {
      throw new DashProviderError(-32602, 'Dash raw transaction is invalid.')
    }
    return this.broadcastTransaction(transaction)
  }

  private async broadcastTransaction(transaction: Transaction): Promise<string> {
    const transactionId = await this.options.rpc.broadcastRawTransaction(transaction.toHex())
    if (transactionId !== transaction.getId()) {
      throw new Error('Dash RPC returned a mismatched transaction ID')
    }
    emitDAppEvent(this.options.analytics, 'dash', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
      hasTransaction: 1,
      idempotencyKey: `dapp:dash:broadcast:${transactionId}`
    })
    return transactionId
  }

  private async confirmSigning(
    origin: string,
    active: ActiveDashDAppAccount,
    prepared: Awaited<ReturnType<DashMultichainSigningClient['prepare']>>,
    action: 'dashMessage' | 'dashTransaction',
    tabInfo: DashDAppTabInfo,
    beforeConfirm?: () => void
  ): Promise<SigningResult> {
    let confirmed = false
    try {
      const decision = await this.options.approval.requestExternalApproval(origin, action, {
        chainName: this.options.network.displayName,
        review: prepared,
        ...dappApprovalMetadata(tabInfo)
      })
      if (!decision.approved) {
        throw new DashProviderError(4001, 'User rejected the signature request.')
      }
      const result = await this.options.runActiveOperation(async () => {
        const current = await this.requireAuthorizedAccount(origin)
        if (!activeAccountsEqual(current, active)) {
          throw new DashProviderError(
            4100,
            'The active Dash account changed. Review the signature request again.'
          )
        }
        beforeConfirm?.()
        const signed = await this.options.signer.confirm(
          current.context.chainAccount.scope.keyDomainId,
          prepared.commandId
        )
        const verified = await this.requireAuthorizedAccount(origin)
        if (!activeAccountsEqual(verified, current)) {
          throw new DashProviderError(
            4100,
            'The Dash account authorization changed before signing completed.'
          )
        }
        return signed
      })
      confirmed = true
      return result
    } finally {
      if (!confirmed) {
        await this.options.signer
          .cancel(active.context.chainAccount.scope.keyDomainId, prepared.commandId)
          .catch(() => {})
      }
    }
  }
}
