import { ANALYTICS_EVENTS } from '../lib/analytics/constants'
import { emitDAppEvent, observeDAppRequest, type DAppAnalyticsSink } from './dapp-analytics'
import type { KeyDomainId } from '@/core/keyring/domain'
import {
  NativeTransferProviderError,
  type NativeTransferDAppRuntimeMethod,
  type NearDAppRuntimeMethod
} from '@/core/dapp/native-transfer-provider'
import type {
  NearCommitBroadcastRpc,
  NearReadRpc
} from '@/infrastructure/chains/near/near-rpc-types'
import type { NearMultichainSigningClient } from '@/infrastructure/keyring/multichain/near-signing-client'
import type {
  BackgroundNativeTransferDAppHandler,
  NativeTransferDAppTabInfo
} from './native-transfer-dapp-handler'
import type { ActiveNearTransferContext } from './near-transfer-controller'
import type {
  DAppSessionAccountProposal,
  DAppSessionAccountSelection
} from './dapp-session-accounts'
import {
  encodeNearDAppFunctionArgs,
  parseNearDAppMessage,
  parseNearDAppTransaction,
  parseNearDAppTransactionBatch,
  type NearMessageRequest,
  type NearTransactionRequest
} from './near-dapp-codecs'

const MAXIMUM_U64 = 18_446_744_073_709_551_615n

function dappApprovalMetadata(
  tabInfo: NativeTransferDAppTabInfo
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
    ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
  })
}

export interface NearDAppRequest {
  readonly method: NearDAppRuntimeMethod
  readonly params?: readonly unknown[]
}

export interface AuthorizedNearDAppAccount {
  readonly context: ActiveNearTransferContext
  readonly reference: { readonly walletId: KeyDomainId; readonly accountId: string }
  readonly address: string
}

export interface BackgroundNearDAppHandlerOptions {
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
  readonly loadAuthorizedAccount: (origin: string) => Promise<AuthorizedNearDAppAccount>
  readonly requestApproval: (
    origin: string,
    action: 'nearTransaction' | 'nearMessage',
    data: unknown
  ) => Promise<{ readonly approved: boolean; readonly requestId: string }>
  readonly runActiveOperation: <T>(operation: () => Promise<T>) => Promise<T>
  readonly signer: Pick<NearMultichainSigningClient, 'prepare' | 'confirm' | 'cancel'>
  readonly rpc: Pick<NearReadRpc, 'assertExpectedChain' | 'getAccessKey'> & NearCommitBroadcastRpc
}

function sameAccount(left: AuthorizedNearDAppAccount, right: AuthorizedNearDAppAccount): boolean {
  return (
    left.reference.walletId === right.reference.walletId &&
    left.reference.accountId === right.reference.accountId &&
    left.context.chainAccount.id === right.context.chainAccount.id &&
    left.context.publicKey === right.context.publicKey &&
    left.address === right.address
  )
}

export class BackgroundNearDAppHandler {
  constructor(private readonly options: BackgroundNearDAppHandlerOptions) {}

  async request(
    request: NearDAppRequest,
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
    return observeDAppRequest(this.options.analytics, 'near', request.method, () =>
      this.handleRequest(request, origin, tabInfo)
    )
  }

  private async handleRequest(
    request: NearDAppRequest,
    origin: string,
    tabInfo: NativeTransferDAppTabInfo
  ): Promise<unknown> {
    if (request.method === 'signTransaction') {
      const [signedTx] = await this.signTransactions(
        [parseNearDAppTransaction(request.params)],
        origin,
        tabInfo
      )
      return signedTx
    }
    if (request.method === 'requestSignTransactions') {
      const signed = await this.signTransactions(
        parseNearDAppTransactionBatch(request.params),
        origin,
        tabInfo
      )
      return Object.freeze({
        txs: Object.freeze(signed.map(signedTx => Object.freeze({ signedTx })))
      })
    }
    if (request.method === 'signAndSendTransaction') {
      const [result] = await this.signAndSendTransactions(
        [parseNearDAppTransaction(request.params)],
        origin,
        tabInfo
      )
      return result
    }
    if (request.method === 'signAndSendTransactions') {
      return this.signAndSendTransactions(
        parseNearDAppTransactionBatch(request.params),
        origin,
        tabInfo
      )
    }
    if (request.method === 'signMessage') {
      return this.signMessage(parseNearDAppMessage(request.params), origin, tabInfo)
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

  private async signTransactions(
    requests: readonly NearTransactionRequest[],
    origin: string,
    tabInfo: NativeTransferDAppTabInfo,
    broadcast = false
  ): Promise<readonly string[]> {
    return this.options.runActiveOperation(async () => {
      const active = await this.options.loadAuthorizedAccount(origin)
      if (
        active.context.keyDomainSource.kind === 'hardware' &&
        (active.context.keyDomainSource.vendor !== 'ledger' ||
          !active.context.keyDomainSource.capabilities.includes('near'))
      ) {
        throw new NativeTransferProviderError(
          4200,
          'NEAR dApp signing is not available for Keystone Wallets.'
        )
      }
      const publicKey = active.context.publicKey
      await this.options.rpc.assertExpectedChain()
      const accessKey = await this.options.rpc.getAccessKey(active.address, publicKey)
      if (!accessKey) {
        throw new NativeTransferProviderError(4100, 'The active NEAR access key is not registered.')
      }
      if (accessKey.permission.kind !== 'full-access') {
        throw new NativeTransferProviderError(
          4200,
          'NEAR dApp transactions require a full-access key.'
        )
      }
      const baseNonce = BigInt(accessKey.nonce)
      if (baseNonce + BigInt(requests.length) > MAXIMUM_U64) {
        throw new NativeTransferProviderError(
          4200,
          'The active NEAR access-key nonce is exhausted.'
        )
      }
      const signed: string[] = []
      for (const [index, request] of requests.entries()) {
        if (request.signerId !== undefined && request.signerId !== active.address) {
          throw new NativeTransferProviderError(4100, 'The requested NEAR signer is not active.')
        }
        const transaction = Object.freeze({
          chainId: active.context.chainAccount.scope.chainId,
          accountIndex: active.context.accountIndex,
          signerId: active.address,
          receiverId: request.receiverId,
          nonce: (baseNonce + BigInt(index) + 1n).toString(),
          blockHash: accessKey.blockHash,
          actions: Object.freeze(
            request.actions.map(action =>
              action.type === 'transfer'
                ? Object.freeze({ type: 'transfer' as const, depositYocto: action.deposit })
                : Object.freeze({
                    type: 'functionCall' as const,
                    methodName: action.methodName,
                    args: encodeNearDAppFunctionArgs(action.args),
                    gas: action.gas,
                    depositYocto: action.deposit
                  })
            )
          )
        })
        const prepared = await this.options.signer.prepare(active.reference.walletId, {
          kind: 'near-transaction',
          chainId: active.context.chainAccount.scope.chainId,
          accountIndex: active.context.accountIndex,
          transaction
        })
        let confirmed = false
        let approved = false
        try {
          if (
            prepared.summary.schema !== 'near.transaction.v1' ||
            prepared.summary.fields.signerId !== active.address
          ) {
            throw new NativeTransferProviderError(4100, 'The NEAR transaction signer is invalid.')
          }
          const decision = await this.options.requestApproval(origin, 'nearTransaction', {
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
          const current = await this.options.loadAuthorizedAccount(origin)
          if (!sameAccount(current, active)) {
            throw new NativeTransferProviderError(
              4100,
              'The active NEAR account changed. Review the transaction again.'
            )
          }
          const result = await this.options.signer.confirm(
            active.reference.walletId,
            prepared.commandId,
            undefined,
            origin
          )
          confirmed = true
          if (result.kind !== 'signed-payload' || result.payload.encoding !== 'base64') {
            throw new Error('NEAR signer returned an invalid transaction result')
          }
          signed.push(result.payload.value)
        } catch (error) {
          if (
            broadcast &&
            approved &&
            !(error && typeof error === 'object' && Reflect.get(error, 'code') === 4001)
          ) {
            emitDAppEvent(this.options.analytics, 'near', ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED)
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
      return Object.freeze(signed)
    })
  }

  private async signAndSendTransactions(
    requests: readonly NearTransactionRequest[],
    origin: string,
    tabInfo: NativeTransferDAppTabInfo
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const signed = await this.signTransactions(requests, origin, tabInfo, true)
    const results: Readonly<Record<string, unknown>>[] = []
    for (const transaction of signed) {
      let result: Readonly<Record<string, unknown>>
      try {
        result = await this.options.rpc.broadcastSignedTransactionAndWait(transaction)
      } catch (error) {
        emitDAppEvent(this.options.analytics, 'near', ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED)
        throw error
      }
      results.push(result)
      emitDAppEvent(this.options.analytics, 'near', ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
        hasTransaction: 1,
        idempotencyKey: `dapp:near:broadcast:${String((result.transaction as { hash?: unknown } | undefined)?.hash ?? (await signedPayloadDigest(transaction)))}`
      })
    }
    return Object.freeze(results)
  }

  private async signMessage(
    request: NearMessageRequest,
    origin: string,
    tabInfo: NativeTransferDAppTabInfo
  ): Promise<Readonly<Record<string, string>>> {
    const active = await this.options.loadAuthorizedAccount(origin)
    if (
      active.context.keyDomainSource.kind === 'hardware' &&
      (active.context.keyDomainSource.vendor !== 'ledger' ||
        !active.context.keyDomainSource.capabilities.includes('near'))
    ) {
      throw new NativeTransferProviderError(
        4200,
        'NEAR dApp signing is not available for Keystone Wallets.'
      )
    }
    const prepared = await this.options.signer.prepare(active.reference.walletId, {
      kind: 'near-nep413-message',
      chainId: active.context.chainAccount.scope.chainId,
      accountIndex: active.context.accountIndex,
      request: Object.freeze({
        chainId: active.context.chainAccount.scope.chainId,
        accountIndex: active.context.accountIndex,
        accountId: active.address,
        ...request
      })
    })
    let confirmed = false
    try {
      if (
        prepared.summary.schema !== 'near.nep413-message.v1' ||
        prepared.summary.fields.signerId !== active.address
      ) {
        throw new NativeTransferProviderError(4100, 'The NEAR message signer is invalid.')
      }
      const decision = await this.options.requestApproval(origin, 'nearMessage', {
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
      const result = await this.options.runActiveOperation(async () => {
        const current = await this.options.loadAuthorizedAccount(origin)
        if (!sameAccount(current, active)) {
          throw new NativeTransferProviderError(
            4100,
            'The active NEAR account changed. Review the message again.'
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
      if (
        result.kind !== 'signature' ||
        result.signature.encoding !== 'base64' ||
        result.address !== active.address
      ) {
        throw new Error('NEAR signer returned an invalid message result')
      }
      return Object.freeze({
        accountId: active.address,
        publicKey: result.publicKey,
        signature: result.signature.value,
        ...(request.state === null ? {} : { state: request.state })
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

async function signedPayloadDigest(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}
