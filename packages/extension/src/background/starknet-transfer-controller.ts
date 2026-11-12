import type { Account, ChainAccount } from '@/core/accounts/domain'
import { parseAssetId } from '@/core/chains/registry'
import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'
import { StarknetProviderError, STARKNET_ERROR } from '@/core/dapp/starknet-provider'
import type { KeyDomainSource } from '@/core/keyring/domain'
import type { TransactionGraph, TransactionId } from '@/core/transactions/domain'
import type {
  StarknetTransferOrchestrator,
  StarknetTransferReview,
  StarknetTransferSubmission
} from '@/infrastructure/chains/starknet'
import {
  STARKNET_ARGENT_V04_CLASS_HASH,
  STARKNET_ARGENT_V05_CLASS_HASH
} from '@/infrastructure/chains/starknet/starknet-primitives'
import { StarknetUndeployedAccountError } from '@/infrastructure/chains/starknet/starknet-transfer-preparer'

export interface ActiveStarknetTransferContext {
  readonly chainAccount: ChainAccount
  readonly accountIndex: Account['accountIndex']
  readonly addressIndex: number
  readonly keyDomainSource: KeyDomainSource
  readonly publicKey: string
  readonly classHash: string
}

export class BackgroundStarknetTransferController {
  constructor(
    private readonly options: {
      readonly orchestrator: StarknetTransferOrchestrator
      readonly loadActiveContext: () => Promise<ActiveStarknetTransferContext | null>
      readonly scheduleMonitor?: () => void
    }
  ) {}

  async prepare(intent: unknown): Promise<StarknetTransferReview> {
    const parsed = parseIntent(intent)
    const account = await this.requireAccount()
    return this.options.orchestrator.prepare({
      account,
      assetId: parsed.assetId,
      tokenReference: parsed.tokenReference,
      recipient: parsed.recipient,
      amountRaw: parsed.amountRaw
    })
  }

  async quoteMaximum(intent: unknown): Promise<string | null> {
    const parsed = parseMaxIntent(intent)
    const account = await this.requireAccount()
    return this.options.orchestrator.quoteMaximum({
      account,
      tokenReference: parsed.tokenReference
    })
  }

  quoteInvoke(input: {
    readonly chainId: string
    readonly accountAddress: string
    readonly calls: readonly {
      readonly to: string
      readonly selector?: string
      readonly entrypoint?: string
      readonly calldata: readonly string[]
    }[]
  }) {
    return this.requireAccount().then(account => {
      if (account.chainAccount.scope.chainId !== input.chainId) {
        throw new Error('Starknet network changed')
      }
      if (account.chainAccount.identity.kind !== 'account-identifier') {
        throw new Error('Starknet account is invalid')
      }
      if (
        normalizeStarknetFelt(account.chainAccount.identity.value) !==
        normalizeStarknetFelt(input.accountAddress)
      ) {
        throw new Error('Starknet account changed')
      }
      const reference = {
        chainId: input.chainId,
        address: input.accountAddress,
        publicKey: account.publicKey,
        classHash: account.classHash
      }
      const ledger =
        account.keyDomainSource.kind === 'hardware' && account.keyDomainSource.vendor === 'ledger'
      const quote = ledger
        ? this.options.orchestrator
            .quoteLedgerInvoke({ account: reference, calls: input.calls })
            .then(quoted => ({
              nonce: quoted.nonce,
              resourceBounds: quoted.resourceBounds,
              ...(quoted.deploy ? { deploy: quoted.deploy } : {})
            }))
        : this.options.orchestrator
            .quoteInvoke({ account: reference, calls: input.calls })
            .then(quoted => ({
              nonce: quoted.nonce,
              resourceBounds: quoted.resourceBounds
            }))
      return quote.catch(error => {
        if (error instanceof StarknetUndeployedAccountError) {
          throw new StarknetProviderError(
            STARKNET_ERROR.unknown,
            'Starknet hardware deploy is not enabled'
          )
        }
        throw error
      })
    })
  }

  async approve(
    transactionId: string,
    payloadFingerprint: string
  ): Promise<StarknetTransferSubmission> {
    const account = await this.requireAccount()
    const submission = await this.options.orchestrator.approve({
      account,
      transactionId,
      payloadFingerprint
    })
    this.options.scheduleMonitor?.()
    return submission
  }

  async reject(transactionId: string): Promise<TransactionGraph> {
    const account = await this.requireAccount()
    return this.options.orchestrator.reject(transactionId, account)
  }

  async resumeBroadcast(transactionId: string): Promise<StarknetTransferSubmission> {
    const account = await this.requireAccount()
    const submission = await this.options.orchestrator.resume(account, transactionId)
    this.options.scheduleMonitor?.()
    return submission
  }

  getPendingApproval(transactionId: string): Promise<TransactionGraph | null> {
    return this.options.orchestrator.getReview(transactionId)
  }

  cancelAllAwaitingApprovals(): Promise<void> {
    return this.options.orchestrator.cancelAwaitingApprovals()
  }

  monitor(): Promise<void> {
    return this.options.orchestrator.monitor()
  }

  listPending() {
    return this.options.orchestrator.listPending()
  }

  private async requireAccount(): Promise<ActiveStarknetTransferContext> {
    const account = await this.options.loadActiveContext()
    if (!account) throw new Error('No Starknet account is selected')
    if (account.keyDomainSource.kind === 'software') return account
    const classHash = normalizeStarknetFelt(account.classHash)
    const ledger =
      account.keyDomainSource.kind === 'hardware' &&
      account.keyDomainSource.vendor === 'ledger' &&
      (classHash === normalizeStarknetFelt(STARKNET_ARGENT_V04_CLASS_HASH) ||
        classHash === normalizeStarknetFelt(STARKNET_ARGENT_V05_CLASS_HASH))
    if (!ledger) throw new Error('Starknet hardware send is not enabled')
    return account
  }
}

function parseIntent(value: unknown): {
  readonly assetId: string
  readonly tokenReference: string
  readonly recipient: string
  readonly amountRaw: string
} {
  const record = readIntent(value)
  if (typeof record.assetId !== 'string') throw new Error('Starknet transfer asset is invalid')
  const assetId = parseAssetId(record.assetId).id
  const reference = assetId.split('/snip2:')[1]
  if (!reference) throw new Error('Starknet transfer asset is invalid')
  if (typeof record.recipient !== 'string' || typeof record.amountRaw !== 'string') {
    throw new Error('Starknet transfer intent is invalid')
  }
  return {
    assetId,
    tokenReference: reference,
    recipient: record.recipient,
    amountRaw: record.amountRaw
  }
}

function parseMaxIntent(value: unknown): { readonly tokenReference: string } {
  const record = readIntent(value)
  if (typeof record.assetId !== 'string') throw new Error('Starknet transfer asset is invalid')
  const assetId = parseAssetId(record.assetId).id
  const reference = assetId.split('/snip2:')[1]
  if (!reference) throw new Error('Starknet transfer asset is invalid')
  return { tokenReference: reference }
}

function readIntent(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Starknet transfer intent is invalid')
  }
  return value as Record<string, unknown>
}

export type { TransactionId }
