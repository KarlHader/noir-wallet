import { transactionBroadcasted } from '@/core/transactions/transaction-analytics'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import { ANALYTICS_EVENTS } from '../lib/analytics/constants'
import { emitDAppEvent, observeDAppRequest, type DAppAnalyticsSink } from './dapp-analytics'
import type { PearlNetworkConfig } from '@/config/networks'
import type { AccountRef, DAppManager } from '@/core/dapp/dapp-manager'
import {
  PearlProviderError,
  parsePearlChainRequest,
  parsePearlMessageRequest,
  parsePearlNetworkRequest,
  parsePearlNoParams,
  parsePearlPsbtRequest,
  parsePearlPsbtsRequest,
  parsePearlPushPsbtRequest,
  parsePearlPushTransactionRequest,
  parsePearlSendRequest,
  type PearlDAppRuntimeMethod
} from '@/core/dapp/pearl-provider'
import type { SigningResult } from '@/core/keyring/ports'
import type {
  ActivePearlDiscoveryContext,
  IndexedDbPearlDiscoveryRepository,
  PearlOwnedBroadcastInput,
  PearlTransactionRpc
} from '@/infrastructure/chains/pearl'
import { pearlBitcoinJsNetwork } from '@/infrastructure/chains/pearl/pearl-network'
import { attachPearlOwnedInputOrigins } from '@/infrastructure/chains/pearl/pearl-psbt-key-origins'
import { PEARL_MAXIMUM_FEE_RATE_SATS_PER_VBYTE } from '@/infrastructure/chains/pearl/pearl-transaction-model'
import type { PearlMultichainDerivationClient } from '@/infrastructure/keyring/multichain/pearl-derivation-client'
import type { PearlMultichainSigningClient } from '@/infrastructure/keyring/multichain/pearl-signing-client'
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '@/lib/bytes'
import { formatLogError } from '@/lib/log-format'
import { logger } from '@/lib/logger'
import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { initEccLib, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import type { DAppChainAccountDescriptor } from './dapp-chain-account-catalog'
import type { BackgroundPearlTransferController } from './pearl-transfer-controller'
import {
  mapPearlWalletRuntimeError,
  pearlPrepareFailureMessage
} from './pearl-wallet-runtime-error'

export interface PearlDAppApprovalPort {
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
    chainId: 'pearl',
    eventName: 'accountsChanged' | 'networkChanged',
    data: unknown
  ) => Promise<void>
  readonly cancelPendingApprovals: (origin: string, chainId: 'pearl') => number
}

export interface PearlDAppBalance {
  readonly confirmed: number
  readonly unconfirmed: number
  readonly total: number
}

export interface BackgroundPearlDAppHandlerOptions {
  readonly analytics?: DAppAnalyticsSink
  readonly network: PearlNetworkConfig
  readonly manager: Pick<
    DAppManager,
    | 'getAllConnections'
    | 'getChainAuthorization'
    | 'removeChainAuthorization'
    | 'setChainAuthorizedAccounts'
  >
  readonly approval: PearlDAppApprovalPort
  readonly loadActiveContext: () => Promise<ActivePearlDiscoveryContext | null>
  readonly listAccounts?: () => Promise<readonly DAppChainAccountDescriptor[]>
  readonly hasUnlockSession: () => Promise<boolean>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
  readonly transferController: BackgroundPearlTransferController | null
  readonly derivation: Pick<PearlMultichainDerivationClient, 'deriveAddress'>
  readonly signer: Pick<PearlMultichainSigningClient, 'prepare' | 'confirm' | 'cancel'>
  readonly discoveryRepository: Pick<IndexedDbPearlDiscoveryRepository, 'get'>
  readonly rpc: Pick<PearlTransactionRpc, 'broadcastRawTransaction'>
  readonly onOwnedBroadcast?: (input: PearlOwnedBroadcastInput) => Promise<void> | void
}

export interface PearlDAppRequest {
  readonly method: PearlDAppRuntimeMethod
  readonly params?: readonly unknown[]
}

export interface PearlDAppTabInfo {
  readonly title?: string
  readonly favIconUrl?: string
  readonly pageUrl?: string
}

export interface ActivePearlWalletIdentity {
  readonly chainId: string
  readonly address: string
  readonly publicKey: string
}

interface ActivePearlDAppAccount {
  readonly context: ActivePearlDiscoveryContext
  readonly reference: AccountRef
  readonly address: string
  readonly publicKey: string
}

function dappApprovalMetadata(tabInfo: PearlDAppTabInfo): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
    ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
  })
}

function accountRefsEqual(left: AccountRef, right: AccountRef): boolean {
  return left.walletId === right.walletId && left.accountId === right.accountId
}

function activeAccountsEqual(left: ActivePearlDAppAccount, right: ActivePearlDAppAccount): boolean {
  return (
    accountRefsEqual(left.reference, right.reference) &&
    left.address === right.address &&
    left.publicKey === right.publicKey
  )
}

function publicKeyWithoutPrefix(publicKey: string): string {
  return publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey
}

let pearlEccReady = false

function ensurePearlEcc(): void {
  if (pearlEccReady) return
  initEccLib(secp256k1)
  pearlEccReady = true
}

/** Finalize Taproot key-path inputs that already carry tapKeySig. */
function finalizeIncompletePsbtInputs(psbt: Psbt): void {
  ensurePearlEcc()
  psbt.setMaximumFeeRate(PEARL_MAXIMUM_FEE_RATE_SATS_PER_VBYTE)
  psbt.data.inputs.forEach((input, index) => {
    if (input.finalScriptSig === undefined && input.finalScriptWitness === undefined) {
      psbt.finalizeInput(index)
    }
  })
}

export class BackgroundPearlDAppHandler {
  constructor(private readonly options: BackgroundPearlDAppHandlerOptions) {}

  async getActiveWalletIdentity(): Promise<ActivePearlWalletIdentity> {
    const active = await this.requireUnlockedActiveAccount()
    return Object.freeze({
      chainId: active.context.chainAccount.scope.chainId,
      address: active.address,
      publicKey: publicKeyWithoutPrefix(active.publicKey)
    })
  }

  async request(
    request: PearlDAppRequest,
    origin: string,
    tabInfo: PearlDAppTabInfo
  ): Promise<unknown> {
    return observeDAppRequest(this.options.analytics, 'pearl', request.method, () =>
      this.handleRequest(request, origin, tabInfo)
    )
  }

  private async handleRequest(
    request: PearlDAppRequest,
    origin: string,
    tabInfo: PearlDAppTabInfo
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
        parsePearlNoParams(request.params)
        return this.getAccounts(origin)
      case 'getNetwork':
        parsePearlNoParams(request.params)
        return this.networkName()
      case 'getChain':
        parsePearlNoParams(request.params)
        return this.chainDescription()
      case 'getPublicKey': {
        parsePearlNoParams(request.params)
        return publicKeyWithoutPrefix((await this.requireAuthorizedAccount(origin)).publicKey)
      }
      case 'getBalance':
        parsePearlNoParams(request.params)
        return this.getBalance(origin)
      case 'sendPearl':
        return this.sendPearl(request.params, origin, tabInfo)
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
        const requested = parsePearlNetworkRequest(request.params)
        if (requested !== this.networkName()) this.throwFixedNetwork()
        return null
      }
      case 'switchChain': {
        const requested = parsePearlChainRequest(request.params)
        if (requested !== this.chainDescription().enum) this.throwFixedNetwork()
        return null
      }
      case 'disconnect':
        parsePearlNoParams(request.params)
        await this.options.runActiveOperation(async () => {
          await this.options.manager.removeChainAuthorization(origin, this.options.network.chainId)
          this.options.approval.cancelPendingApprovals(origin, 'pearl')
          await this.options.approval
            .broadcastProviderEvent(origin, 'pearl', 'accountsChanged', [])
            .catch(() => {})
        })
        emitDAppEvent(this.options.analytics, 'pearl', ANALYTICS_EVENTS.DAPP_DISCONNECTED)
        return null
    }
  }

  async notifyAccountsChanged(): Promise<void> {
    const connections = await this.options.manager.getAllConnections()
    const pearlConnections = connections.filter(connection =>
      connection.chainAuthorizations?.some(
        authorization => authorization.chainId === this.options.network.chainId
      )
    )
    if (pearlConnections.length === 0) return
    await Promise.all(
      pearlConnections.map(async connection => {
        const accounts = await this.getAccounts(connection.origin).catch(() => [])
        await this.options.approval
          .broadcastProviderEvent(connection.origin, 'pearl', 'accountsChanged', accounts)
          .catch(() => {})
      })
    )
  }

  private networkName(): 'mainnet' | 'testnet' {
    return this.options.network.networkName
  }

  private chainDescription() {
    const mainnet = this.options.network.networkMode === 'mainnet'
    return Object.freeze({
      enum: mainnet ? ('PEARL_MAINNET' as const) : ('PEARL_TESTNET' as const),
      name: this.options.network.displayName,
      network: this.networkName()
    })
  }

  private throwFixedNetwork(): never {
    throw new PearlProviderError(
      4901,
      'Noir Wallet uses a global network mode. Change it in wallet settings; the extension will restart before using the selected mode.'
    )
  }

  private async loadActiveAccount(): Promise<ActivePearlDAppAccount> {
    const context = await this.options.loadActiveContext()
    if (!context) {
      throw new PearlProviderError(4100, 'The active wallet has no Pearl account.')
    }
    const derived = await this.options.derivation.deriveAddress(
      context.chainAccount.scope.keyDomainId,
      {
        chainId: context.chainAccount.scope.chainId,
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
      publicKey: derived.publicKey
    })
  }

  private async requireUnlockedActiveAccount(): Promise<ActivePearlDAppAccount> {
    if (!(await this.options.hasUnlockSession())) {
      throw new PearlProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
    }
    return this.loadActiveAccount()
  }

  private async listAvailableAccounts(
    active: ActivePearlDAppAccount
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
  ): Promise<ActivePearlDAppAccount> {
    const active = await this.requireUnlockedActiveAccount()
    const authorization = await this.options.manager.getChainAuthorization(
      origin,
      this.options.network.chainId
    )
    if (
      !authorization ||
      !authorization.accounts.some(account => accountRefsEqual(account, active.reference))
    ) {
      throw new PearlProviderError(
        4100,
        'This site is not authorized for the active Pearl account.'
      )
    }
    if (requestedAddress !== undefined && requestedAddress !== active.address) {
      throw new PearlProviderError(4100, 'The requested Pearl account is not authorized.')
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
    tabInfo: PearlDAppTabInfo,
    params?: readonly unknown[],
    forceReview = false
  ): Promise<readonly string[]> {
    parsePearlNoParams(params)
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
    const decision = await this.options.approval.requestExternalApproval(origin, 'pearlConnect', {
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
      throw new PearlProviderError(4001, 'User rejected the connection request.')
    }
    return this.options.runActiveOperation(async () => {
      const current = await this.requireUnlockedActiveAccount()
      if (!activeAccountsEqual(current, active)) {
        throw new PearlProviderError(
          4100,
          'The active Pearl account changed. Review the connection request again.'
        )
      }
      const selectedIds = decision.selectedIds ?? preselectedIds
      const chosen = available.filter(item => selectedIds.includes(item.id))
      if (!chosen.some(item => accountRefsEqual(item.reference, current.reference))) {
        throw new PearlProviderError(4100, 'The active Pearl account must remain authorized.')
      }
      await this.options.manager.setChainAuthorizedAccounts(
        origin,
        tabInfo,
        this.options.network.chainId,
        chosen.map(item => item.reference),
        current.reference
      )
      emitDAppEvent(this.options.analytics, 'pearl', ANALYTICS_EVENTS.DAPP_CONNECTED, {
        extra: { account_count: chosen.length, source: 'approval' }
      })
      return Object.freeze([...new Set(chosen.map(item => item.address))])
    })
  }

  private async getBalance(origin: string): Promise<PearlDAppBalance> {
    const active = await this.requireAuthorizedAccount(origin)
    const state = await this.options.discoveryRepository.get({
      chainAccount: active.context.chainAccount,
      accountIndex: active.context.accountIndex
    })
    let confirmed = 0
    let unconfirmed = 0
    for (const observation of state?.observations ?? []) {
      for (const utxo of observation.utxos) {
        const value = Number(utxo.valueSats)
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new PearlProviderError(-32603, 'Noir Wallet read an invalid Pearl balance.')
        }
        if (utxo.status.confirmed) confirmed += value
        else unconfirmed += value
      }
    }
    const total = confirmed + unconfirmed
    if (
      !Number.isSafeInteger(confirmed) ||
      !Number.isSafeInteger(unconfirmed) ||
      !Number.isSafeInteger(total)
    ) {
      throw new PearlProviderError(-32603, 'The Pearl balance exceeds the provider range.')
    }
    return Object.freeze({ confirmed, unconfirmed, total })
  }

  private async sendPearl(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: PearlDAppTabInfo
  ): Promise<string> {
    if (!this.options.transferController) {
      throw new PearlProviderError(4200, 'Pearl transfers are unavailable in this wallet build.')
    }
    const transferController = this.options.transferController
    const parsed = parsePearlSendRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    this.assertSoftwareSigningAccount(active)
    let prepared: Awaited<ReturnType<BackgroundPearlTransferController['prepare']>>
    try {
      prepared = await transferController.prepare(
        parsed.intent,
        undefined,
        undefined,
        'pearl_p2tr',
        parsed.feeRateSatsPerVbyte
      )
    } catch (error) {
      logger.warn(`Pearl sendPearl prepare failed: ${formatLogError(error)}`)
      const mapped = mapPearlWalletRuntimeError(error)
      throw new PearlProviderError(
        mapped.code === 'invalid-request'
          ? -32602
          : mapped.code === 'account-unavailable'
            ? 4100
            : -32603,
        pearlPrepareFailureMessage(error, mapped)
      )
    }
    let submitted = false
    let approvalActive = true
    try {
      let decision: Awaited<ReturnType<typeof this.options.approval.requestExternalApproval>>
      try {
        decision = await this.options.approval.requestExternalApproval(
          origin,
          'pearlTransaction',
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
                    'pearl_p2tr'
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
        throw new PearlProviderError(4001, 'User rejected the transaction request.')
      }
      const submission = await transferController.approveForDApp(
        prepared.graph.root.id,
        prepared.review.payloadFingerprint.digestHex,
        async context => {
          const current = await this.requireAuthorizedAccount(origin)
          if (
            !activeAccountsEqual(current, active) ||
            current.context.generationId !== context.generationId ||
            current.context.chainAccount.id !== context.chainAccount.id
          ) {
            throw new PearlProviderError(
              4100,
              'The active Pearl account changed. Review the transaction request again.'
            )
          }
        }
      )
      submitted = true
      if (submission.status === 'external-signature-required') {
        throw new PearlProviderError(4200, 'Pearl hardware transfers are unsupported.')
      }
      if (submission.status !== 'broadcast') {
        throw new PearlProviderError(
          4900,
          'The signed Pearl transaction is pending automatic broadcast recovery.'
        )
      }
      const transactionHash = submission.graph.segments.find(segment => segment.role === 'origin')
        ?.evidence?.transactionHash
      if (!transactionHash || !/^[0-9a-f]{64}$/.test(transactionHash)) {
        throw new Error('Approved Pearl transfer is missing its transaction hash')
      }
      if (transactionBroadcasted(submission.graph)) {
        emitDAppEvent(this.options.analytics, 'pearl', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
          hasTransaction: 1,
          idempotencyKey: `dapp:pearl:broadcast:${prepared.graph.root.id}`
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
                'pearl',
                ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED,
                {
                  hasTransaction: 0,
                  idempotencyKey: `dapp:pearl:failed:${prepared.graph.root.id}`
                }
              )
            }
          })
          .catch(() => {})
      }
      throw error
    } finally {
      if (!submitted) {
        await transferController.reject(prepared.graph.root.id).catch(() => {})
      }
    }
  }

  private async signMessage(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: PearlDAppTabInfo
  ): Promise<string> {
    const parsed = parsePearlMessageRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    this.assertSoftwareSigningAccount(active)
    const prepared = await this.options.signer.prepare(
      active.context.chainAccount.scope.keyDomainId,
      {
        kind: 'pearl-bip322-message',
        chainId: active.context.chainAccount.scope.chainId,
        accountIndex: active.context.accountIndex,
        change: false,
        addressIndex: 0,
        message: parsed.message
      }
    )
    if (
      prepared.summary.schema !== 'pearl.bip322-message.v1' ||
      prepared.summary.fields.address !== active.address
    ) {
      await this.options.signer
        .cancel(active.context.chainAccount.scope.keyDomainId, prepared.commandId)
        .catch(() => {})
      throw new PearlProviderError(4100, 'The signing request does not match the active account.')
    }
    const result = await this.confirmSigning(origin, active, prepared, 'pearlMessage', tabInfo)
    return this.readSignature(result, active)
  }

  private async signPsbt(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: PearlDAppTabInfo
  ): Promise<string> {
    const parsed = parsePearlPsbtRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    this.assertSoftwareSigningAccount(active)
    const derived = await this.options.derivation.deriveAddress(
      active.context.chainAccount.scope.keyDomainId,
      {
        chainId: active.context.chainAccount.scope.chainId,
        accountIndex: active.context.accountIndex,
        change: false,
        addressIndex: 0
      }
    )
    if (derived.address !== active.address) {
      throw new PearlProviderError(4100, 'The Pearl signer does not match the active account.')
    }
    let psbtHex = parsed.psbtHex
    try {
      psbtHex = attachPearlOwnedInputOrigins(
        parsed.psbtHex,
        derived,
        active.context.chainAccount.scope.chainId
      )
      const enriched = Psbt.fromHex(psbtHex, {
        network: pearlBitcoinJsNetwork(active.context.chainAccount.scope.chainId)
      })
      const expectedScript = Buffer.from(
        derived.scriptPubKey.startsWith('0x')
          ? derived.scriptPubKey.slice(2)
          : derived.scriptPubKey,
        'hex'
      )
      const ownedInputReady = enriched.data.inputs.some(input => {
        const script = input.witnessUtxo?.script
        return (
          !!script &&
          Buffer.from(script).equals(expectedScript) &&
          (input.tapBip32Derivation?.length ?? 0) > 0 &&
          !!input.tapInternalKey
        )
      })
      if (!ownedInputReady) {
        throw new PearlProviderError(
          -32602,
          'Pearl PSBT input is missing BIP-86 key origin for the active account.'
        )
      }
    } catch (error) {
      if (error instanceof PearlProviderError) throw error
      throw new PearlProviderError(-32602, 'Pearl PSBT could not be prepared for signing.')
    }
    let prepared
    try {
      prepared = await this.options.signer.prepare(active.context.chainAccount.scope.keyDomainId, {
        kind: 'pearl-psbt',
        chainId: active.context.chainAccount.scope.chainId,
        accountIndex: active.context.accountIndex,
        psbt: bytesToBase64(hexToBytes(psbtHex))
      })
    } catch (error) {
      const mapped = mapPearlWalletRuntimeError(error)
      throw new PearlProviderError(-32603, pearlPrepareFailureMessage(error, mapped))
    }
    if (
      prepared.summary.schema !== 'pearl.psbt.v1' ||
      prepared.summary.fields.signer !== active.address ||
      prepared.summary.fields.signingInputIndexes.length === 0
    ) {
      await this.options.signer
        .cancel(active.context.chainAccount.scope.keyDomainId, prepared.commandId)
        .catch(() => {})
      throw new PearlProviderError(4100, 'The PSBT has no input owned by the active account.')
    }
    const result = await this.confirmSigning(origin, active, prepared, 'pearlTransaction', tabInfo)
    if (result.kind !== 'signed-payload' || result.payload.encoding !== 'base64') {
      throw new Error('Pearl PSBT signature result is invalid')
    }
    const signedPsbtHex = bytesToHex(base64ToBytes(result.payload.value))
    if (!parsed.autoFinalized) return signedPsbtHex
    try {
      const signedPsbt = Psbt.fromHex(signedPsbtHex, {
        network: pearlBitcoinJsNetwork(active.context.chainAccount.scope.chainId)
      })
      finalizeIncompletePsbtInputs(signedPsbt)
      return signedPsbt.toHex()
    } catch {
      throw new PearlProviderError(
        -32603,
        'Noir Wallet signed the owned inputs but could not finalize every PSBT input.'
      )
    }
  }

  private async signPsbts(
    params: readonly unknown[] | undefined,
    origin: string,
    tabInfo: PearlDAppTabInfo
  ): Promise<readonly string[]> {
    const requests = parsePearlPsbtsRequest(params)
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
    const parsed = parsePearlPushPsbtRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    let transaction: Transaction
    try {
      const psbt = Psbt.fromHex(parsed.psbtHex, {
        network: pearlBitcoinJsNetwork(active.context.chainAccount.scope.chainId)
      })
      finalizeIncompletePsbtInputs(psbt)
      transaction = psbt.extractTransaction()
    } catch {
      throw new PearlProviderError(-32602, 'Pearl PSBT is not complete and broadcastable.')
    }
    return this.broadcastTransaction(transaction, active)
  }

  private async pushTransaction(
    params: readonly unknown[] | undefined,
    origin: string
  ): Promise<string> {
    const rawTransactionHex = parsePearlPushTransactionRequest(params)
    const active = await this.requireAuthorizedAccount(origin)
    let transaction: Transaction
    try {
      transaction = Transaction.fromHex(rawTransactionHex)
    } catch {
      throw new PearlProviderError(-32602, 'Pearl raw transaction is invalid.')
    }
    return this.broadcastTransaction(transaction, active)
  }

  private async broadcastTransaction(
    transaction: Transaction,
    active: ActivePearlDAppAccount
  ): Promise<string> {
    const rawTransactionHex = transaction.toHex()
    const transactionId = await this.options.rpc.broadcastRawTransaction(rawTransactionHex)
    if (transactionId !== transaction.getId()) {
      throw new Error('Pearl RPC returned a mismatched transaction ID')
    }
    emitDAppEvent(this.options.analytics, 'pearl', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
      hasTransaction: 1,
      idempotencyKey: `dapp:pearl:broadcast:${transactionId}`
    })
    if (this.options.onOwnedBroadcast) {
      await Promise.resolve(
        this.options.onOwnedBroadcast({
          scope: active.context.chainAccount.scope,
          transactionId,
          rawTransactionHex,
          spentOutpoints: Object.freeze(
            transaction.ins.map(input =>
              Object.freeze({
                transactionId: Buffer.from(input.hash).reverse().toString('hex'),
                outputIndex: input.index
              })
            )
          )
        })
      ).catch(error => {
        logger.warn(`Pearl dApp broadcast balance update failed: ${formatLogError(error)}`)
      })
    }
    return transactionId
  }

  private async confirmSigning(
    origin: string,
    active: ActivePearlDAppAccount,
    prepared: Awaited<ReturnType<PearlMultichainSigningClient['prepare']>>,
    action: 'pearlMessage' | 'pearlTransaction',
    tabInfo: PearlDAppTabInfo
  ): Promise<SigningResult> {
    let confirmed = false
    try {
      const decision = await this.options.approval.requestExternalApproval(origin, action, {
        chainName: this.options.network.displayName,
        review: prepared,
        ...dappApprovalMetadata(tabInfo)
      })
      if (!decision.approved) {
        throw new PearlProviderError(4001, 'User rejected the signature request.')
      }
      const result = await this.options.runActiveOperation(async () => {
        const current = await this.requireAuthorizedAccount(origin)
        if (!activeAccountsEqual(current, active)) {
          throw new PearlProviderError(
            4100,
            'The active Pearl account changed. Review the signature request again.'
          )
        }
        const signed = await this.options.signer.confirm(
          current.context.chainAccount.scope.keyDomainId,
          prepared.commandId
        )
        const verified = await this.requireAuthorizedAccount(origin)
        if (!activeAccountsEqual(verified, current)) {
          throw new PearlProviderError(
            4100,
            'The Pearl account authorization changed before signing completed.'
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

  private readSignature(result: SigningResult, active: ActivePearlDAppAccount): string {
    if (
      result.kind !== 'signature' ||
      result.signature.encoding !== 'base64' ||
      result.address !== active.address ||
      result.publicKey !== active.publicKey
    ) {
      throw new PearlProviderError(-32603, 'The Pearl signature does not match the account.')
    }
    return result.signature.value
  }

  private assertSoftwareSigningAccount(active: ActivePearlDAppAccount): void {
    if (active.context.keyDomainSource.kind === 'hardware') {
      throw new PearlProviderError(
        4200,
        'Pearl dApp signing is not available for hardware wallets. Use Noir Wallet Send instead.'
      )
    }
  }
}
