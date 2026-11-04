import { ANALYTICS_EVENTS } from '../lib/analytics/constants'
import { emitDAppEvent, observeDAppRequest, type DAppAnalyticsSink } from './dapp-analytics'
import type { KeyDomainId } from '@/core/keyring/domain'
import {
  NativeTransferProviderError,
  type NativeTransferDAppRuntimeMethod,
  type SolanaDAppRuntimeMethod
} from '@/core/dapp/native-transfer-provider'
import { parseCanonicalBase64 } from '@/infrastructure/chains/solana/solana-rpc-codecs'
import type {
  SolanaBroadcastOptions,
  SolanaBroadcastRpc,
  SolanaReadRpc,
  SolanaRpcCommitment
} from '@/infrastructure/chains/solana/solana-rpc-types'
import type { SolanaMultichainSigningClient } from '@/infrastructure/keyring/multichain/solana-signing-client'
import type {
  ActiveNativeTransferContext,
  BackgroundNativeTransferDAppHandler,
  NativeTransferDAppTabInfo
} from './native-transfer-dapp-handler'
import type {
  DAppSessionAccountProposal,
  DAppSessionAccountSelection
} from './dapp-session-accounts'

const MAXIMUM_TRANSACTION_BYTES = 1_232
const CONFIRMATION_TIMEOUT_MS = 60_000
const CONFIRMATION_POLL_MS = 500

function dappApprovalMetadata(
  tabInfo: NativeTransferDAppTabInfo
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
    ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
  })
}

interface SolanaDAppTransactionOptions extends SolanaBroadcastOptions {
  readonly commitment?: SolanaRpcCommitment
}

export interface SolanaDAppRequest {
  readonly method: SolanaDAppRuntimeMethod
  readonly params?: readonly unknown[]
}

export interface AuthorizedSolanaDAppAccount {
  readonly context: ActiveNativeTransferContext
  readonly reference: { readonly walletId: KeyDomainId; readonly accountId: string }
  readonly address: string
}

export interface BackgroundSolanaDAppHandlerOptions {
  readonly analytics?: DAppAnalyticsSink
  readonly native: Pick<
    BackgroundNativeTransferDAppHandler,
    | 'request'
    | 'notifyAccountsChanged'
    | 'prepareSessionAccountSelection'
    | 'resolveSessionAccountSelection'
    | 'getSessionAccounts'
  >
  readonly network: { readonly chainId: string; readonly displayName: string }
  readonly loadAuthorizedAccount: (origin: string) => Promise<AuthorizedSolanaDAppAccount>
  readonly requestApproval: (
    origin: string,
    action: 'solanaTransaction' | 'solanaMessage',
    data: unknown
  ) => Promise<{ readonly approved: boolean; readonly requestId: string }>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
  readonly signer: Pick<SolanaMultichainSigningClient, 'prepare' | 'confirm' | 'cancel'>
  readonly rpc: Pick<SolanaBroadcastRpc, 'broadcastSignedTransaction'> &
    Pick<SolanaReadRpc, 'getSignatureStatus'>
}

function parseTransactionOptions(
  value: unknown,
  allowSendOptions: boolean
): SolanaDAppTransactionOptions | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NativeTransferProviderError(-32602, 'Solana transaction options are invalid.')
  }
  const allowedKeys = allowSendOptions
    ? ['preflightCommitment', 'minContextSlot', 'commitment', 'skipPreflight', 'maxRetries']
    : ['preflightCommitment', 'minContextSlot']
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new NativeTransferProviderError(-32602, 'Solana transaction options are invalid.')
  }
  const readCommitment = (key: 'preflightCommitment' | 'commitment') => {
    const commitment = Reflect.get(value, key)
    if (
      commitment !== undefined &&
      commitment !== 'processed' &&
      commitment !== 'confirmed' &&
      commitment !== 'finalized'
    ) {
      throw new NativeTransferProviderError(-32602, 'Solana transaction commitment is invalid.')
    }
    return commitment as SolanaRpcCommitment | undefined
  }
  const readInteger = (key: 'minContextSlot' | 'maxRetries') => {
    const number = Reflect.get(value, key)
    if (number !== undefined && (!Number.isSafeInteger(number) || (number as number) < 0)) {
      throw new NativeTransferProviderError(-32602, `Solana ${key} is invalid.`)
    }
    return number as number | undefined
  }
  const preflightCommitment = readCommitment('preflightCommitment')
  const minContextSlot = readInteger('minContextSlot')
  const commitment = allowSendOptions ? readCommitment('commitment') : undefined
  const skipPreflight = Reflect.get(value, 'skipPreflight')
  if (skipPreflight !== undefined && typeof skipPreflight !== 'boolean') {
    throw new NativeTransferProviderError(-32602, 'Solana skipPreflight is invalid.')
  }
  const maxRetries = allowSendOptions ? readInteger('maxRetries') : undefined
  return Object.freeze({
    ...(preflightCommitment === undefined ? {} : { preflightCommitment }),
    ...(minContextSlot === undefined ? {} : { minContextSlot }),
    ...(commitment === undefined ? {} : { commitment }),
    ...(allowSendOptions && skipPreflight !== undefined ? { skipPreflight } : {}),
    ...(maxRetries === undefined ? {} : { maxRetries })
  })
}

function parseTransactionParameter(
  params: readonly unknown[] | undefined,
  allowSendOptions = false
): { readonly transaction: string; readonly options?: SolanaDAppTransactionOptions } {
  if (
    !Array.isArray(params) ||
    params.length < 1 ||
    params.length > 2 ||
    typeof params[0] !== 'string'
  ) {
    throw new NativeTransferProviderError(
      -32602,
      'Solana transaction signing requires one canonical base64 transaction.'
    )
  }
  try {
    parseCanonicalBase64(params[0], MAXIMUM_TRANSACTION_BYTES, 'Solana transaction')
  } catch {
    throw new NativeTransferProviderError(-32602, 'Solana transaction is invalid.')
  }
  const options = parseTransactionOptions(params[1], allowSendOptions)
  return Object.freeze({ transaction: params[0], ...(options === undefined ? {} : { options }) })
}

function parseTransactionListParameter(params: readonly unknown[] | undefined): readonly string[] {
  if (!Array.isArray(params) || params.length !== 1 || !Array.isArray(params[0])) {
    throw new NativeTransferProviderError(
      -32602,
      'Solana batch signing requires one transaction array.'
    )
  }
  if (params[0].length === 0 || params[0].length > 16) {
    throw new NativeTransferProviderError(-32602, 'Solana batch size must be between 1 and 16.')
  }
  return Object.freeze(
    params[0].map(transaction => parseTransactionParameter([transaction]).transaction)
  )
}

function parseMessageParameter(params: readonly unknown[] | undefined): Uint8Array {
  if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== 'string') {
    throw new NativeTransferProviderError(-32602, 'Solana message signing requires base64 bytes.')
  }
  try {
    return parseCanonicalBase64(params[0], 256 * 1024, 'Solana message')
  } catch {
    throw new NativeTransferProviderError(-32602, 'Solana message is invalid.')
  }
}

export class BackgroundSolanaDAppHandler {
  constructor(private readonly options: BackgroundSolanaDAppHandlerOptions) {}

  async request(
    request: SolanaDAppRequest,
    origin: string,
    tabInfo: NativeTransferDAppTabInfo
  ): Promise<unknown> {
    if (
      ![
        'signMessage',
        'signTransaction',
        'signAllTransactions',
        'requestSignTransactions',
        'signAndSendTransaction',
        'signAndSendTransactions'
      ].includes(request.method)
    )
      return this.handleRequest(request, origin, tabInfo)
    return observeDAppRequest(this.options.analytics, 'solana', request.method, () =>
      this.handleRequest(request, origin, tabInfo)
    )
  }

  private async handleRequest(
    request: SolanaDAppRequest,
    origin: string,
    tabInfo: NativeTransferDAppTabInfo
  ): Promise<unknown> {
    if (request.method === 'signTransaction' || request.method === 'signAndSendTransaction') {
      const parsed = parseTransactionParameter(
        request.params,
        request.method === 'signAndSendTransaction'
      )
      return this.signTransaction(
        parsed.transaction,
        origin,
        request.method === 'signAndSendTransaction',
        parsed.options,
        tabInfo
      )
    }
    if (request.method === 'signAllTransactions') {
      const transactions = parseTransactionListParameter(request.params)
      const signed: string[] = []
      for (const transaction of transactions) {
        signed.push(await this.signTransaction(transaction, origin, false, undefined, tabInfo))
      }
      return Object.freeze(signed)
    }
    if (request.method === 'signMessage') {
      return this.signMessage(parseMessageParameter(request.params), origin, tabInfo)
    }
    return this.options.native.request(
      { ...request, method: request.method as NativeTransferDAppRuntimeMethod },
      origin,
      tabInfo
    )
  }

  notifyAccountsChanged(origin?: string): Promise<void> {
    return this.options.native.notifyAccountsChanged(origin)
  }

  prepareSessionAccountSelection(origin: string): Promise<DAppSessionAccountProposal> {
    return this.options.native.prepareSessionAccountSelection(origin)
  }

  resolveSessionAccountSelection(
    proposal: DAppSessionAccountProposal,
    selectedIds: readonly string[]
  ): Promise<DAppSessionAccountSelection> {
    return this.options.native.resolveSessionAccountSelection(proposal, selectedIds)
  }

  getSessionAccounts(origin: string): Promise<readonly string[]> {
    return this.options.native.getSessionAccounts(origin)
  }

  private async signTransaction(
    transaction: string,
    origin: string,
    broadcast: boolean,
    transactionOptions: SolanaDAppTransactionOptions | undefined,
    tabInfo: NativeTransferDAppTabInfo
  ): Promise<string> {
    const active = await this.options.loadAuthorizedAccount(origin)
    if (
      active.context.keyDomainSource.kind === 'hardware' &&
      (active.context.keyDomainSource.vendor !== 'ledger' ||
        !active.context.keyDomainSource.capabilities.includes('solana'))
    ) {
      throw new NativeTransferProviderError(
        4200,
        'Solana dApp signing is not available for Keystone Wallets.'
      )
    }
    const prepared = await this.options.signer.prepare(active.reference.walletId, {
      kind: 'solana-transaction',
      chainId: active.context.chainAccount.scope.chainId,
      accountIndex: active.context.accountIndex,
      transaction
    })
    let confirmed = false
    let approved = false
    let broadcasted = false
    try {
      if (
        prepared.summary.schema !== 'solana.transaction.v1' ||
        !prepared.summary.fields.requiredSigners.includes(active.address)
      ) {
        throw new NativeTransferProviderError(
          4100,
          'The transaction does not require the active Solana account signature.'
        )
      }
      const decision = await this.options.requestApproval(origin, 'solanaTransaction', {
        chainName: this.options.network.displayName,
        review: {
          chainId: prepared.chainId,
          operation: prepared.operation,
          summary: prepared.summary,
          payloadFingerprint: prepared.payloadFingerprint,
          expiresAt: prepared.expiresAt
        },
        ...dappApprovalMetadata(tabInfo)
      })
      if (!decision.approved) {
        throw new NativeTransferProviderError(4001, 'User rejected the transaction request.')
      }
      approved = true
      const signed = await this.options.runActiveOperation(async () => {
        const current = await this.options.loadAuthorizedAccount(origin)
        if (
          current.reference.walletId !== active.reference.walletId ||
          current.reference.accountId !== active.reference.accountId ||
          current.context.chainAccount.id !== active.context.chainAccount.id ||
          current.address !== active.address
        ) {
          throw new NativeTransferProviderError(
            4100,
            'The active Solana account changed. Review the transaction again.'
          )
        }
        return this.options.signer.confirm(
          active.reference.walletId,
          prepared.commandId,
          undefined,
          origin
        )
      })
      confirmed = true
      if (signed.kind !== 'signed-payload' || signed.payload.encoding !== 'base64') {
        throw new Error('Solana signer returned an invalid transaction result')
      }
      if (!broadcast) return signed.payload.value
      const { commitment, ...broadcastOptions } = transactionOptions ?? {}
      const signature = await this.options.rpc.broadcastSignedTransaction(
        signed.payload.value,
        undefined,
        broadcastOptions
      )
      broadcasted = true
      emitDAppEvent(this.options.analytics, 'solana', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
        hasTransaction: 1,
        idempotencyKey: `dapp:solana:broadcast:${signature}`
      })
      if (commitment) await this.waitForCommitment(signature, commitment)
      return signature
    } catch (error) {
      if (
        broadcast &&
        approved &&
        !broadcasted &&
        !(error && typeof error === 'object' && Reflect.get(error, 'code') === 4001)
      ) {
        emitDAppEvent(this.options.analytics, 'solana', ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED)
      }
      throw error
    } finally {
      if (!confirmed) {
        await this.options.signer
          .cancel(active.reference.walletId, prepared.commandId)
          .catch(() => {})
      }
    }
  }

  private async waitForCommitment(
    signature: string,
    commitment: SolanaRpcCommitment
  ): Promise<void> {
    const requiredRank = commitment === 'processed' ? 0 : commitment === 'confirmed' ? 1 : 2
    const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS
    while (Date.now() < deadline) {
      const status = await this.options.rpc.getSignatureStatus(signature)
      if (status.status === 'failed') {
        throw new NativeTransferProviderError(-32603, 'The Solana transaction failed on-chain.')
      }
      if (status.status !== 'unknown') {
        const rank = status.status === 'processed' ? 0 : status.status === 'confirmed' ? 1 : 2
        if (rank >= requiredRank) return
      }
      await new Promise<void>(resolve => setTimeout(resolve, CONFIRMATION_POLL_MS))
    }
    throw new NativeTransferProviderError(
      -32603,
      `Solana transaction did not reach ${commitment} before the confirmation timeout.`
    )
  }

  private async signMessage(
    message: Uint8Array,
    origin: string,
    tabInfo: NativeTransferDAppTabInfo
  ): Promise<Readonly<Record<string, string>>> {
    const active = await this.options.loadAuthorizedAccount(origin)
    if (active.context.keyDomainSource.kind === 'hardware') {
      throw new NativeTransferProviderError(
        4200,
        'Solana message signing is not available for this hardware wallet.'
      )
    }
    const prepared = await this.options.signer.prepare(active.reference.walletId, {
      kind: 'solana-message',
      chainId: active.context.chainAccount.scope.chainId,
      accountIndex: active.context.accountIndex,
      message
    })
    let confirmed = false
    try {
      if (
        prepared.summary.schema !== 'solana.message.v1' ||
        prepared.summary.fields.signer !== active.address
      ) {
        throw new NativeTransferProviderError(
          4100,
          'The message signer does not match the active Solana account.'
        )
      }
      const decision = await this.options.requestApproval(origin, 'solanaMessage', {
        chainName: this.options.network.displayName,
        review: {
          chainId: prepared.chainId,
          operation: prepared.operation,
          summary: prepared.summary,
          payloadFingerprint: prepared.payloadFingerprint,
          expiresAt: prepared.expiresAt
        },
        ...dappApprovalMetadata(tabInfo)
      })
      if (!decision.approved) {
        throw new NativeTransferProviderError(4001, 'User rejected the message request.')
      }
      const signed = await this.options.runActiveOperation(async () => {
        const current = await this.options.loadAuthorizedAccount(origin)
        if (
          current.reference.walletId !== active.reference.walletId ||
          current.reference.accountId !== active.reference.accountId ||
          current.context.chainAccount.id !== active.context.chainAccount.id ||
          current.address !== active.address
        ) {
          throw new NativeTransferProviderError(
            4100,
            'The active Solana account changed. Review the message again.'
          )
        }
        return this.options.signer.confirm(active.reference.walletId, prepared.commandId)
      })
      confirmed = true
      if (
        signed.kind !== 'signature' ||
        signed.signature.encoding !== 'utf8' ||
        signed.address !== active.address
      ) {
        throw new Error('Solana signer returned an invalid message result')
      }
      return Object.freeze({
        signature: signed.signature.value,
        publicKey: signed.publicKey,
        address: active.address
      })
    } finally {
      if (!confirmed) {
        await this.options.signer
          .cancel(active.reference.walletId, prepared.commandId)
          .catch(() => {})
      }
    }
  }
}
