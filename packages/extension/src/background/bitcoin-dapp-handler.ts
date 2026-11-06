import { transactionBroadcasted } from '@/core/transactions/transaction-analytics'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import { ANALYTICS_EVENTS } from '../lib/analytics/constants'
import { emitDAppEvent, observeDAppRequest, type DAppAnalyticsSink } from './dapp-analytics'
import type { BitcoinNetworkConfig } from '@/config/networks'
import type { AccountRef, DAppManager } from '@/core/dapp/dapp-manager'
import {
  BitcoinProviderError,
  parseBitcoinChainRequest,
  parseBitcoinMessageRequest,
  parseBitcoinNetworkRequest,
  parseBitcoinNoParams,
  parseBitcoinPsbtRequest,
  parseBitcoinPsbtsRequest,
  parseBitcoinPushPsbtRequest,
  parseBitcoinPushTransactionRequest,
  parseBitcoinSendRequest,
  type BitcoinDAppRuntimeMethod
} from '@/core/dapp/bitcoin-provider'
import type { SigningResult } from '@/core/keyring/ports'
import type {
  ActiveBitcoinDiscoveryContext,
  ActiveBitcoinPortfolioSource
} from '@/infrastructure/chains/bitcoin'
import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import type { BitcoinMultichainDerivationClient } from '@/infrastructure/keyring/multichain/bitcoin-derivation-client'
import type { BitcoinMultichainSigningClient } from '@/infrastructure/keyring/multichain/bitcoin-signing-client'
import { bitcoinAccountRootFromPath } from '@/infrastructure/chains/bitcoin/bitcoin-transaction-model'
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '@/lib/bytes'
import type {
  BackgroundBitcoinTransferController,
  BackgroundBitcoinTransferReview
} from './bitcoin-transfer-controller'
import { mapBitcoinWalletRuntimeError } from './bitcoin-wallet-runtime-error'
import type { BitcoinTransactionRpc } from '@/infrastructure/chains/bitcoin'
import { networks, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import { requestLedgerSignature } from './ledger-signing-coordinator'
import { ledgerBitcoinMessageSummary, ledgerBitcoinPsbtSummary } from './ledger-bitcoin-dapp-review'
import { digestLedgerPayload } from './ledger-evm-dapp-review'
import {
  verifyLedgerBitcoinBip322Signature,
  verifyLedgerBitcoinPsbtResponse
} from '@/lib/ledger/bitcoin-model'
import type { DAppChainAccountDescriptor } from './dapp-chain-account-catalog'
import {
  activeDAppSessionAccountMatches,
  selectDAppSessionAccounts,
  type DAppSessionAccountProposal,
  type DAppSessionAccountSelection
} from './dapp-session-accounts'

export interface BitcoinDAppApprovalPort {
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
    chainId: 'bitcoin',
    eventName: 'accountsChanged' | 'networkChanged',
    data: unknown
  ) => Promise<void>
  readonly cancelPendingApprovals: (origin: string, chainId: 'bitcoin') => number
}

export interface BackgroundBitcoinDAppHandlerOptions {
  readonly analytics?: DAppAnalyticsSink
  readonly network: BitcoinNetworkConfig
  readonly manager: Pick<
    DAppManager,
    | 'getAllConnections'
    | 'getChainAuthorization'
    | 'removeChainAuthorization'
    | 'setChainAuthorizedAccounts'
  >
  readonly approval: BitcoinDAppApprovalPort
  readonly loadActiveContext: () => Promise<ActiveBitcoinDiscoveryContext | null>
  readonly listAccounts?: () => Promise<readonly DAppChainAccountDescriptor[]>
  readonly hasUnlockSession: () => Promise<boolean>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
  readonly getAddressType: (
    context: ActiveBitcoinDiscoveryContext
  ) => Promise<BitcoinSupportedAddressType>
  readonly transferController: BackgroundBitcoinTransferController | null
  readonly derivation: Pick<BitcoinMultichainDerivationClient, 'deriveAddress'>
  readonly signer: Pick<BitcoinMultichainSigningClient, 'prepare' | 'confirm' | 'cancel'>
  readonly portfolio: Pick<
    import('@/infrastructure/chains/bitcoin').BitcoinPortfolioCoordinator,
    'refreshActiveSource'
  >
  readonly rpc: Pick<BitcoinTransactionRpc, 'broadcastRawTransaction'>
}

export interface BitcoinDAppRequest {
  readonly method: BitcoinDAppRuntimeMethod
  readonly params?: readonly unknown[]
}

export interface BitcoinDAppTabInfo {
  readonly title?: string
  readonly favIconUrl?: string
  readonly pageUrl?: string
}

function dappApprovalMetadata(tabInfo: BitcoinDAppTabInfo): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
    ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
  })
}

interface ActiveBitcoinDAppAccount {
  readonly context: ActiveBitcoinDiscoveryContext
  readonly reference: AccountRef
  readonly address: string
  readonly publicKey: string
  readonly addressType: BitcoinSupportedAddressType
}

export interface ActiveBitcoinWalletIdentity {
  readonly chainId: string
  readonly address: string
  readonly publicKey: string
  readonly addressType: BitcoinSupportedAddressType
}

function accountRefsEqual(left: AccountRef, right: AccountRef): boolean {
  return left.walletId === right.walletId && left.accountId === right.accountId
}

function activeAccountsEqual(
  left: ActiveBitcoinDAppAccount,
  right: ActiveBitcoinDAppAccount
): boolean {
  return (
    accountRefsEqual(left.reference, right.reference) &&
    left.address === right.address &&
    left.publicKey === right.publicKey &&
    left.addressType === right.addressType
  )
}

function safeSats(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid Bitcoin ${label}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Bitcoin ${label} exceeds the provider range`)
  }
  return parsed
}

function finalizeIncompletePsbtInputs(psbt: Psbt): void {
  psbt.data.inputs.forEach((input, index) => {
    if (input.finalScriptSig === undefined && input.finalScriptWitness === undefined) {
      psbt.finalizeInput(index)
    }
  })
}

export class BackgroundBitcoinDAppHandler {
  constructor(private readonly options: BackgroundBitcoinDAppHandlerOptions) {}

  async getActiveWalletIdentity(): Promise<ActiveBitcoinWalletIdentity> {
    const active = await this.requireUnlockedActiveAccount()
    return Object.freeze({
      chainId: active.context.chainAccount.scope.chainId,
      address: active.address,
      publicKey: active.publicKey,
      addressType: active.addressType
    })
  }

  async request(
    request: BitcoinDAppRequest,
    origin: string,
    tabInfo: BitcoinDAppTabInfo
  ): Promise<unknown> {
    return observeDAppRequest(this.options.analytics, 'bitcoin', request.method, () =>
      this.handleRequest(request, origin, tabInfo)
    )
  }

  private async handleRequest(
    request: BitcoinDAppRequest,
    origin: string,
    tabInfo: BitcoinDAppTabInfo
  ): Promise<unknown> {
    switch (request.method) {
      case 'connect': {
        const [address] = await this.requestAccounts(origin, tabInfo, request.params, true)
        const active = await this.requireAuthorizedAccount(origin, address)
        return Object.freeze({ address: active.address, publicKey: active.publicKey.slice(2) })
      }
      case 'requestAccounts':
        return this.requestAccounts(origin, tabInfo, request.params)
      case 'getAccounts':
        parseBitcoinNoParams(request.params)
        return this.getAccounts(origin)
      case 'getNetwork':
        parseBitcoinNoParams(request.params)
        return this.networkName()
      case 'getChain':
        parseBitcoinNoParams(request.params)
        return this.chainDescription()
      case 'getPublicKey': {
        parseBitcoinNoParams(request.params)
        return (await this.requireAuthorizedAccount(origin)).publicKey.slice(2)
      }
      case 'getBalance':
        parseBitcoinNoParams(request.params)
        return this.getBalance(origin)
      case 'sendBitcoin':
        return this.sendBitcoin(request.params, origin, tabInfo)
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
      case 'switchNetwork': {
        const requested = parseBitcoinNetworkRequest(request.params)
        if (requested !== this.networkName()) this.throwFixedNetwork()
        return null
      }
      case 'switchChain': {
        const requested = parseBitcoinChainRequest(request.params)
        if (requested !== this.chainDescription().enum) this.throwFixedNetwork()
        return null
      }
      case 'disconnect':
        parseBitcoinNoParams(request.params)
        await this.options.runActiveOperation(async () => {
          await this.options.manager.removeChainAuthorization(origin, this.options.network.chainId)
          this.options.approval.cancelPendingApprovals(origin, 'bitcoin')
          await this.options.approval
            .broadcastProviderEvent(origin, 'bitcoin', 'accountsChanged', [])
            .catch(() => {})
        })
        emitDAppEvent(this.options.analytics, 'bitcoin', ANALYTICS_EVENTS.DAPP_DISCONNECTED)
        return null
    }
  }

  async notifyAccountsChanged(origin?: string): Promise<void> {
    const connections = await this.options.manager.getAllConnections()
    const bitcoinConnections = connections.filter(
      connection =>
        (origin === undefined || connection.origin === origin) &&
        connection.chainAuthorizations?.some(
          authorization => authorization.chainId === this.options.network.chainId
        )
    )
    if (bitcoinConnections.length === 0) return
    await Promise.all(
      bitcoinConnections.map(async connection => {
        const accounts = await this.getAccounts(connection.origin).catch(() => [])
        await this.options.approval
          .broadcastProviderEvent(connection.origin, 'bitcoin', 'accountsChanged', accounts)
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
      iconChain: 'btc',
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
      throw new BitcoinProviderError(
        4100,
        'The active Bitcoin account changed. Review the connection request again.'
      )
    }
    return selectDAppSessionAccounts(proposal, selectedIds)
  }

  async getSessionAccounts(origin: string): Promise<readonly string[]> {
    return this.getAccounts(origin)
  }

  private networkName(): 'livenet' | 'testnet' {
    return this.options.network.networkMode === 'mainnet' ? 'livenet' : 'testnet'
  }

  private chainDescription() {
    return Object.freeze({
      enum:
        this.options.network.networkMode === 'mainnet'
          ? ('BITCOIN_MAINNET' as const)
          : ('BITCOIN_TESTNET' as const),
      name:
        this.options.network.networkMode === 'mainnet'
          ? ('Bitcoin Mainnet' as const)
          : ('Bitcoin Testnet' as const),
      network: this.networkName()
    })
  }

  private throwFixedNetwork(): never {
    throw new BitcoinProviderError(
      4901,
      'Noir Wallet uses a global network mode. Change it in wallet settings; the extension will restart before using the selected mode.'
    )
  }

  private async loadActiveAccount(): Promise<ActiveBitcoinDAppAccount> {
    const context = await this.options.loadActiveContext()
    if (!context) {
      throw new BitcoinProviderError(4100, 'The active wallet has no Bitcoin account.')
    }
    const addressType = await this.options.getAddressType(context)
    const derived = await this.options.derivation.deriveAddress(
      context.chainAccount.scope.keyDomainId,
      {
        chainId: context.chainAccount.scope.chainId,
        addressType,
        accountIndex: context.accountIndex,
        change: false,
        addressIndex: 0
      }
    )
    return Object.freeze({
      context,
      reference: Object.freeze({
        walletId: context.chainAccount.scope.keyDomainId,
        accountId: context.chainAccount.scope.accountId
      }),
      address: derived.address,
      publicKey: derived.publicKey,
      addressType
    })
  }

  private async requireUnlockedActiveAccount(): Promise<ActiveBitcoinDAppAccount> {
    if (!(await this.options.hasUnlockSession())) {
      throw new BitcoinProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
    }
    return this.loadActiveAccount()
  }

  private async listAvailableAccounts(
    active: ActiveBitcoinDAppAccount
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
  ): Promise<ActiveBitcoinDAppAccount> {
    const active = await this.requireUnlockedActiveAccount()
    const authorization = await this.options.manager.getChainAuthorization(
      origin,
      this.options.network.chainId
    )
    if (
      !authorization ||
      !authorization.accounts.some(account => accountRefsEqual(account, active.reference))
    ) {
      throw new BitcoinProviderError(
        4100,
        'This site is not authorized for the active Bitcoin account.'
      )
    }
    if (requestedAddress !== undefined && requestedAddress !== active.address) {
      throw new BitcoinProviderError(4100, 'The requested Bitcoin account is not authorized.')
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
    } catch {
      return Object.freeze([])
    }
  }

  private async requestAccounts(
    origin: string,
    tabInfo: BitcoinDAppTabInfo,
    params?: readonly unknown[],
    forceReview = false
  ): Promise<readonly string[]> {
    parseBitcoinNoParams(params)
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
    const decision = await this.options.approval.requestExternalApproval(origin, 'bitcoinConnect', {
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
      ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
      ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
    })
    if (!decision.approved) {
      throw new BitcoinProviderError(4001, 'User rejected the connection request.')
    }
    return this.options.runActiveOperation(async () => {
      const current = await this.requireUnlockedActiveAccount()
      if (!activeAccountsEqual(current, active)) {
        throw new BitcoinProviderError(
          4100,
          'The active Bitcoin account changed. Review the connection request again.'
        )
      }
      const selectedIds = decision.selectedIds ?? preselectedIds
      const chosen = available.filter(item => selectedIds.includes(item.id))
      if (!chosen.some(item => accountRefsEqual(item.reference, current.reference))) {
        throw new BitcoinProviderError(4100, 'The active Bitcoin account must remain authorized.')
      }
      await this.options.manager.setChainAuthorizedAccounts(
        origin,
        tabInfo,
        this.options.network.chainId,
        chosen.map(item => item.reference),
        current.reference
      )
      emitDAppEvent(this.options.analytics, 'bitcoin', ANALYTICS_EVENTS.DAPP_CONNECTED, {
        extra: { account_count: chosen.length, source: 'approval' }
      })
      return Object.freeze([...new Set(chosen.map(item => item.address))])
    })
  }

  private async getBalance(origin: string) {
    const active = await this.requireAuthorizedAccount(origin)
    const portfolio = await this.options.portfolio.refreshActiveSource()
    this.assertPortfolioMatchesActive(portfolio, active)
    const balance = portfolio?.source.balances[0]
    if (!balance) return Object.freeze({ confirmed: 0, unconfirmed: 0, total: 0 })
    const confirmed = safeSats(balance.spendableRaw, 'confirmed balance')
    const total = safeSats(balance.totalRaw, 'total balance')
    if (total < confirmed) throw new Error('Bitcoin total balance is below confirmed balance')
    return Object.freeze({ confirmed, unconfirmed: total - confirmed, total })
  }

  private assertPortfolioMatchesActive(
    portfolio: ActiveBitcoinPortfolioSource | null,
    active: ActiveBitcoinDAppAccount
  ): void {
    if (
      portfolio &&
      (portfolio.generationId !== active.context.generationId ||
        portfolio.chainAccount.id !== active.context.chainAccount.id)
    ) {
      throw new Error('Bitcoin Portfolio response does not match the authorized account')
    }
  }

  private async sendBitcoin(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: BitcoinDAppTabInfo
  ): Promise<string> {
    if (!this.options.transferController) {
      throw new BitcoinProviderError(
        4200,
        'Bitcoin transfers are unavailable in this wallet build.'
      )
    }
    const transferController = this.options.transferController
    const parsed = parseBitcoinSendRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    if (
      active.context.keyDomainSource.kind !== 'software' &&
      !(
        active.context.keyDomainSource.kind === 'hardware' &&
        active.context.keyDomainSource.vendor === 'ledger'
      )
    ) {
      this.assertSoftwareSigningAccount(active)
    }
    let prepared: BackgroundBitcoinTransferReview
    try {
      prepared = await transferController.prepare(
        parsed.intent,
        undefined,
        undefined,
        active.addressType,
        parsed.feeRateSatsPerVbyte
      )
    } catch (error) {
      const mapped = mapBitcoinWalletRuntimeError(error)
      throw new BitcoinProviderError(
        mapped.code === 'invalid-request'
          ? -32602
          : mapped.code === 'account-unavailable'
            ? 4100
            : -32603,
        mapped.message
      )
    }
    let submitted = false
    let approvalActive = true
    try {
      let decision: Awaited<ReturnType<typeof this.options.approval.requestExternalApproval>>
      try {
        decision = await this.options.approval.requestExternalApproval(
          origin,
          'bitcoinTransaction',
          {
            chainName: this.options.network.displayName,
            review: prepared.review,
            feeTier: 'standard',
            feeEditingAvailable: parsed.feeRateSatsPerVbyte === undefined,
            ...dappApprovalMetadata(tabInfo)
          },
          parsed.feeRateSatsPerVbyte === undefined
            ? {
                onNetworkFeeTierChange: async feeTier => {
                  await transferController.reject(prepared.graph.root.id)
                  const replacement = await transferController.prepare(
                    parsed.intent,
                    undefined,
                    feeTier,
                    active.addressType
                  )
                  if (!approvalActive) {
                    await transferController.reject(replacement.graph.root.id).catch(() => {})
                    throw new Error('Approval request is no longer active')
                  }
                  prepared = replacement
                  return {
                    chainName: this.options.network.displayName,
                    review: replacement.review,
                    feeTier,
                    feeEditingAvailable: true,
                    ...dappApprovalMetadata(tabInfo)
                  }
                },
                cancelOnNetworkFeeTierChangeError: true
              }
            : undefined
        )
      } finally {
        approvalActive = false
      }
      if (!decision.approved) {
        throw new BitcoinProviderError(4001, 'User rejected the transaction request.')
      }
      let submission = await this.options.transferController.approveForDApp(
        prepared.graph.root.id,
        prepared.review.payloadFingerprint.digestHex,
        async context => {
          const current = await this.requireAuthorizedAccount(origin)
          if (
            !activeAccountsEqual(current, active) ||
            current.context.generationId !== context.generationId ||
            current.context.chainAccount.id !== context.chainAccount.id
          ) {
            throw new BitcoinProviderError(
              4100,
              'The active Bitcoin account changed. Review the transaction request again.'
            )
          }
        }
      )
      if (submission.status === 'external-signature-required') {
        if (
          active.context.keyDomainSource.kind !== 'hardware' ||
          active.context.keyDomainSource.vendor !== 'ledger'
        ) {
          throw new BitcoinProviderError(4200, 'Unsupported external Bitcoin signer')
        }
        const external = await transferController.getExternalSigningRequest(prepared.graph.root.id)
        if (external?.vendor !== 'ledger' || external.ledgerRequest?.kind !== 'psbt') {
          throw new Error('Ledger Bitcoin signing request is unavailable')
        }
        const signed = await requestLedgerSignature(external.ledgerRequest, {
          scope: {
            ...active.context.chainAccount.scope,
            chainId: active.context.chainAccount.scope.chainId
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: external.payloadFingerprint },
          expiresAt: external.expiresAt,
          origin,
          summary: prepared.review.summary,
          validate: async () => {
            const current = await this.requireAuthorizedAccount(origin, active.address)
            const latest = await transferController.getExternalSigningRequest(
              prepared.graph.root.id
            )
            if (
              !activeAccountsEqual(current, active) ||
              current.context.generationId !== active.context.generationId ||
              latest?.vendor !== 'ledger' ||
              latest.payloadFingerprint !== external.payloadFingerprint ||
              JSON.stringify(latest.ledgerRequest) !== JSON.stringify(external.ledgerRequest)
            ) {
              throw new Error('Ledger Bitcoin transaction changed before signing')
            }
          }
        })
        if (signed.kind !== 'psbt')
          throw new Error('Ledger Bitcoin signer returned the wrong response')
        submission = await transferController.submitExternalSignature(
          prepared.graph.root.id,
          external.payloadFingerprint,
          signed.signedPsbtBase64
        )
      }
      submitted = true
      if (submission.status !== 'broadcast') {
        throw new BitcoinProviderError(
          4900,
          'The signed Bitcoin transaction is pending automatic broadcast recovery.'
        )
      }
      const transactionHash = submission.graph.segments.find(segment => segment.role === 'origin')
        ?.evidence?.transactionHash
      if (!transactionHash || !/^[0-9a-f]{64}$/.test(transactionHash)) {
        throw new Error('Approved Bitcoin transfer is missing its transaction hash')
      }
      if (transactionBroadcasted(submission.graph)) {
        emitDAppEvent(this.options.analytics, 'bitcoin', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
          hasTransaction: 1,
          idempotencyKey: `dapp:bitcoin:broadcast:${prepared.graph.root.id}`,
          extra: { hardware: active.context.keyDomainSource.kind === 'hardware' }
        })
      }
      return transactionHash
    } catch (error) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          (Reflect.get(error, 'code') === 4001 || Reflect.get(error, 'code') === 4900)
        )
      ) {
        void new IndexedDbTransactionRepository()
          .get(prepared.graph.root.scope, prepared.graph.root.id)
          .then(graph => {
            if (graph && !transactionBroadcasted(graph) && graph.root.status !== 'signed') {
              emitDAppEvent(
                this.options.analytics,
                'bitcoin',
                ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED,
                {
                  hasTransaction: 0,
                  idempotencyKey: `dapp:bitcoin:failed:${prepared.graph.root.id}`
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
      }
    }
  }

  private async signMessage(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: BitcoinDAppTabInfo
  ): Promise<string> {
    const parsed = parseBitcoinMessageRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    if (
      active.context.keyDomainSource.kind === 'hardware' &&
      active.context.keyDomainSource.vendor === 'ledger'
    ) {
      const binding = await this.ledgerBinding(active)
      const summary = await ledgerBitcoinMessageSummary(
        active.context.chainAccount.scope.chainId,
        active.address,
        parsed.displayMessage
      )
      const payloadFingerprint = await digestLedgerPayload(parsed.message)
      const expiresAt = Date.now() + 10 * 60_000
      const decision = await this.options.approval.requestExternalApproval(
        origin,
        'bitcoinMessage',
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
      if (!decision.approved)
        throw new BitcoinProviderError(4001, 'User rejected the signature request.')
      const response = await requestLedgerSignature(
        { kind: 'bip322-simple', message: parsed.displayMessage, ...binding },
        {
          scope: {
            ...active.context.chainAccount.scope,
            chainId: active.context.chainAccount.scope.chainId
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: payloadFingerprint },
          expiresAt,
          origin,
          summary,
          validate: async () => {
            await this.requireUnchangedLedgerAccount(origin, active, binding)
          }
        }
      )
      if (response.kind !== 'bip322-simple')
        throw new Error('Ledger Bitcoin signer returned the wrong response')
      if (
        !verifyLedgerBitcoinBip322Signature({
          message: parsed.displayMessage,
          signature: response.signature,
          address: active.address,
          publicKey: active.publicKey,
          masterFingerprintHex: binding.masterFingerprintHex,
          accountPath: binding.accountPath,
          network: binding.network
        })
      )
        throw new Error('Ledger BIP322 signature does not match the approved message')
      await this.requireUnchangedLedgerAccount(origin, active, binding)
      return response.signature
    }
    this.assertSoftwareSigningAccount(active)
    const prepared = await this.options.signer.prepare(
      active.context.chainAccount.scope.keyDomainId,
      {
        kind: 'bitcoin-bip322-message',
        chainId: active.context.chainAccount.scope.chainId,
        addressType: active.addressType,
        accountIndex: active.context.accountIndex,
        change: false,
        addressIndex: 0,
        message: parsed.message
      }
    )
    const result = await this.confirmSigning(origin, active, prepared, 'bitcoinMessage', tabInfo)
    if (
      result.kind !== 'signature' ||
      result.signature.encoding !== 'utf8' ||
      result.address !== active.address ||
      result.publicKey !== active.publicKey
    ) {
      throw new Error('Bitcoin message signature does not match the approved account')
    }
    return result.signature.value
  }

  private async signPsbt(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: BitcoinDAppTabInfo
  ): Promise<string> {
    const parsed = parseBitcoinPsbtRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    if (
      active.context.keyDomainSource.kind === 'hardware' &&
      active.context.keyDomainSource.vendor === 'ledger'
    ) {
      const binding = await this.ledgerBinding(active)
      const network = binding.network === 'mainnet' ? networks.bitcoin : networks.testnet
      const original = Psbt.fromHex(parsed.psbtHex, { network })
      const owned: number[] = []
      const summary = await ledgerBitcoinPsbtSummary({
        chainId: active.context.chainAccount.scope.chainId,
        network: binding.network,
        signer: active.address,
        psbt: original,
        ownsInput: async index => {
          const owns = await this.ledgerOwnsInput(active, binding, original, index)
          if (owns) owned.push(index)
          return owns
        }
      })
      const psbtBase64 = original.toBase64()
      const payloadFingerprint = await digestLedgerPayload(base64ToBytes(psbtBase64))
      const expiresAt = Date.now() + 10 * 60_000
      const decision = await this.options.approval.requestExternalApproval(
        origin,
        'bitcoinTransaction',
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
      if (!decision.approved)
        throw new BitcoinProviderError(4001, 'User rejected the signature request.')
      const response = await requestLedgerSignature(
        { kind: 'psbt', psbtBase64, ...binding },
        {
          scope: {
            ...active.context.chainAccount.scope,
            chainId: active.context.chainAccount.scope.chainId
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: payloadFingerprint },
          expiresAt,
          origin,
          summary,
          validate: async () => {
            await this.requireUnchangedLedgerAccount(origin, active, binding)
          }
        }
      )
      if (response.kind !== 'psbt')
        throw new Error('Ledger Bitcoin signer returned the wrong response')
      const signedPsbt = Psbt.fromBase64(response.signedPsbtBase64, { network })
      const verified = verifyLedgerBitcoinPsbtResponse({
        original,
        signed: signedPsbt,
        ownedIndexes: owned,
        masterFingerprintHex: binding.masterFingerprintHex,
        accountPath: binding.accountPath
      })
      await this.requireUnchangedLedgerAccount(origin, active, binding)
      if (!parsed.autoFinalized) return verified.toHex()
      try {
        finalizeIncompletePsbtInputs(verified)
        return verified.toHex()
      } catch {
        throw new BitcoinProviderError(
          -32603,
          'Noir Wallet signed the owned inputs but could not finalize every PSBT input.'
        )
      }
    }
    this.assertSoftwareSigningAccount(active)
    const prepared = await this.options.signer.prepare(
      active.context.chainAccount.scope.keyDomainId,
      {
        kind: 'bitcoin-psbt',
        chainId: active.context.chainAccount.scope.chainId,
        addressType: active.addressType,
        accountIndex: active.context.accountIndex,
        psbt: bytesToBase64(hexToBytes(parsed.psbtHex))
      }
    )
    if (
      prepared.summary.schema !== 'bitcoin.psbt.v1' ||
      prepared.summary.fields.signer !== active.address ||
      prepared.summary.fields.signingInputIndexes.length === 0
    ) {
      await this.options.signer
        .cancel(active.context.chainAccount.scope.keyDomainId, prepared.commandId)
        .catch(() => {})
      throw new BitcoinProviderError(4100, 'The PSBT has no input owned by the active account.')
    }
    const result = await this.confirmSigning(
      origin,
      active,
      prepared,
      'bitcoinTransaction',
      tabInfo
    )
    if (result.kind !== 'signed-payload' || result.payload.encoding !== 'base64') {
      throw new Error('Bitcoin PSBT signature result is invalid')
    }
    const signedPsbtHex = bytesToHex(base64ToBytes(result.payload.value))
    if (!parsed.autoFinalized) return signedPsbtHex
    try {
      const network =
        this.options.network.networkMode === 'mainnet' ? networks.bitcoin : networks.testnet
      const signedPsbt = Psbt.fromHex(signedPsbtHex, { network })
      finalizeIncompletePsbtInputs(signedPsbt)
      return signedPsbt.toHex()
    } catch {
      throw new BitcoinProviderError(
        -32603,
        'Noir Wallet signed the owned inputs but could not finalize every PSBT input.'
      )
    }
  }

  private async signPsbts(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: BitcoinDAppTabInfo
  ): Promise<readonly string[]> {
    const requests = parseBitcoinPsbtsRequest(params)
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
    const parsed = parseBitcoinPushPsbtRequest(params)
    await this.requireAuthorizedAccount(origin)
    let transaction: Transaction
    try {
      const network =
        this.options.network.networkMode === 'mainnet' ? networks.bitcoin : networks.testnet
      const psbt = Psbt.fromHex(parsed.psbtHex, { network })
      finalizeIncompletePsbtInputs(psbt)
      transaction = psbt.extractTransaction()
    } catch {
      throw new BitcoinProviderError(-32602, 'Bitcoin PSBT is not complete and broadcastable.')
    }
    return this.broadcastTransaction(transaction)
  }

  private async pushTransaction(
    params: readonly unknown[] | undefined,
    origin: string
  ): Promise<string> {
    const rawTransactionHex = parseBitcoinPushTransactionRequest(params)
    await this.requireAuthorizedAccount(origin)
    let transaction: Transaction
    try {
      transaction = Transaction.fromHex(rawTransactionHex)
    } catch {
      throw new BitcoinProviderError(-32602, 'Bitcoin raw transaction is invalid.')
    }
    return this.broadcastTransaction(transaction)
  }

  private async broadcastTransaction(transaction: Transaction): Promise<string> {
    const transactionId = await this.options.rpc.broadcastRawTransaction(transaction.toHex())
    if (transactionId !== transaction.getId()) {
      throw new Error('Bitcoin RPC returned a mismatched transaction ID')
    }
    emitDAppEvent(this.options.analytics, 'bitcoin', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
      hasTransaction: 1,
      idempotencyKey: `dapp:bitcoin:broadcast:${transactionId}`
    })
    return transactionId
  }

  private async confirmSigning(
    origin: string,
    active: ActiveBitcoinDAppAccount,
    prepared: Awaited<ReturnType<BitcoinMultichainSigningClient['prepare']>>,
    action: 'bitcoinMessage' | 'bitcoinTransaction',
    tabInfo: BitcoinDAppTabInfo
  ): Promise<SigningResult> {
    let confirmed = false
    try {
      const decision = await this.options.approval.requestExternalApproval(origin, action, {
        chainName: this.options.network.displayName,
        review: prepared,
        ...dappApprovalMetadata(tabInfo)
      })
      if (!decision.approved) {
        throw new BitcoinProviderError(4001, 'User rejected the signature request.')
      }
      const result = await this.options.runActiveOperation(async () => {
        const current = await this.requireAuthorizedAccount(origin)
        if (!activeAccountsEqual(current, active)) {
          throw new BitcoinProviderError(
            4100,
            'The active Bitcoin account changed. Review the signature request again.'
          )
        }
        const signed = await this.options.signer.confirm(
          current.context.chainAccount.scope.keyDomainId,
          prepared.commandId
        )
        const verified = await this.requireAuthorizedAccount(origin)
        if (!activeAccountsEqual(verified, current)) {
          throw new BitcoinProviderError(
            4100,
            'The Bitcoin account authorization changed before signing completed.'
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

  private assertSoftwareSigningAccount(active: ActiveBitcoinDAppAccount): void {
    if (active.context.keyDomainSource.kind === 'hardware') {
      throw new BitcoinProviderError(
        4200,
        'Bitcoin dApp signing is not yet available for Keystone Wallets. Use Noir Wallet Send instead.'
      )
    }
  }

  private async ledgerBinding(active: ActiveBitcoinDAppAccount) {
    if (active.addressType !== 'p2wpkh')
      throw new BitcoinProviderError(
        4200,
        'Ledger Bitcoin signing requires the Native SegWit account.'
      )
    const derived = await this.options.derivation.deriveAddress(
      active.context.chainAccount.scope.keyDomainId,
      {
        chainId: active.context.chainAccount.scope.chainId,
        addressType: 'p2wpkh',
        accountIndex: active.context.accountIndex,
        change: false,
        addressIndex: 0
      }
    )
    if (
      derived.address !== active.address ||
      derived.publicKey !== active.publicKey ||
      !derived.masterFingerprint ||
      !/^0x[0-9a-f]{8}$/.test(derived.masterFingerprint)
    ) {
      throw new Error('Ledger Bitcoin account export does not match the active account')
    }
    return Object.freeze({
      accountPath: bitcoinAccountRootFromPath(
        derived.derivationPath,
        active.context.chainAccount.scope.chainId,
        'p2wpkh',
        false,
        0
      ),
      masterFingerprintHex: derived.masterFingerprint.slice(2),
      expectedAddress: active.address,
      network: this.options.network.networkMode
    })
  }

  private async requireUnchangedLedgerAccount(
    origin: string,
    active: ActiveBitcoinDAppAccount,
    binding: Awaited<ReturnType<BackgroundBitcoinDAppHandler['ledgerBinding']>>
  ) {
    const current = await this.requireAuthorizedAccount(origin, active.address)
    if (
      !activeAccountsEqual(current, active) ||
      current.context.generationId !== active.context.generationId ||
      JSON.stringify(await this.ledgerBinding(current)) !== JSON.stringify(binding)
    ) {
      throw new BitcoinProviderError(
        4100,
        'The authorized Ledger Bitcoin account changed before signing.'
      )
    }
  }

  private async ledgerOwnsInput(
    active: ActiveBitcoinDAppAccount,
    binding: Awaited<ReturnType<BackgroundBitcoinDAppHandler['ledgerBinding']>>,
    psbt: Psbt,
    index: number
  ): Promise<boolean> {
    const entries = psbt.data.inputs[index].bip32Derivation ?? []
    const matched = entries.filter(
      entry =>
        Buffer.from(entry.masterFingerprint).toString('hex') === binding.masterFingerprintHex &&
        entry.path.startsWith(`${binding.accountPath}/`)
    )
    if (matched.length === 0) return false
    if (matched.length !== 1) throw new Error('Ambiguous Ledger Bitcoin PSBT derivation')
    const match = /^\/([01])\/(0|[1-9][0-9]*)$/.exec(
      matched[0].path.slice(binding.accountPath.length)
    )
    if (!match) throw new Error('Unsupported Ledger Bitcoin PSBT child path')
    const derived = await this.options.derivation.deriveAddress(
      active.context.chainAccount.scope.keyDomainId,
      {
        chainId: active.context.chainAccount.scope.chainId,
        addressType: 'p2wpkh',
        accountIndex: active.context.accountIndex,
        change: match[1] === '1',
        addressIndex: Number(match[2])
      }
    )
    let utxo = psbt.data.inputs[index].witnessUtxo
    if (!utxo && psbt.data.inputs[index].nonWitnessUtxo) {
      const previous = Transaction.fromBuffer(psbt.data.inputs[index].nonWitnessUtxo)
      const txInput = psbt.txInputs[index]
      if (previous.getId() !== Buffer.from(txInput.hash).reverse().toString('hex')) {
        throw new Error('Ledger Bitcoin PSBT previous transaction mismatch')
      }
      utxo = previous.outs[txInput.index]
    }
    if (
      !Buffer.from(matched[0].pubkey).equals(Buffer.from(derived.publicKey.slice(2), 'hex')) ||
      !utxo?.script.equals(Buffer.from(derived.scriptPubKey?.slice(2) ?? '', 'hex'))
    ) {
      throw new Error('Ledger Bitcoin PSBT input does not match its derivation')
    }
    return true
  }
}
