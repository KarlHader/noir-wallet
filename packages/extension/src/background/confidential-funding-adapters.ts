import type { ChainId } from '@/core/chains/domain'
import { parseChainId, type AssetRegistry } from '@/core/chains/registry'
import { nearPublicKeyFromImplicitAccountId } from '@/core/chains/near'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import {
  buildEvmTransfer,
  type EvmFeeSelection,
  type EvmTransactionRpc,
  type PreparedEvmTransfer
} from '@/infrastructure/chains/evm'
import {
  parsePreparedNearIntentsDeposit,
  prepareNearIntentsDeposit,
  type PreparedNearIntentsDeposit,
  type PrepareNearIntentsDepositInput
} from '@/infrastructure/chains/near'
import { assertNearConfidentialDepositAddress } from './confidential-near-quote'
import type { ConfidentialSigningIdentity } from './confidential-funding-signer'

export interface ConfidentialDepositPrepareInput {
  readonly identity: ConfidentialSigningIdentity
  readonly chainId: ChainId
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
  readonly feeTier?: NetworkFeeTier
  readonly feeSelection?: EvmFeeSelection
  // Absent for legacy private funding, which signs from the Main address.
  readonly sourceDomain?: 'public' | 'private'
}

export interface ConfidentialDepositConfirmation {
  readonly prepared: PreparedEvmTransfer | PreparedNearIntentsDeposit
  readonly rawTransaction: string
  readonly transactionHash: string
}

export interface ConfidentialDepositConfirmInput {
  readonly identity: ConfidentialSigningIdentity
  readonly commandId: string
  readonly preparedTransfer: unknown
  readonly sourceDomain?: 'public' | 'private'
}

export interface ConfidentialDepositCancelInput {
  readonly identity: ConfidentialSigningIdentity
  readonly commandId: string
}

export interface ConfidentialPreparedDeposit {
  readonly commandId: string
  readonly payloadFingerprint: string
  readonly expiresAt: number
  readonly preparedTransfer: PreparedEvmTransfer | PreparedNearIntentsDeposit
}

export interface ConfidentialDepositAdapter {
  readonly kind: 'evm' | 'near'
  prepareDeposit(input: ConfidentialDepositPrepareInput): Promise<ConfidentialPreparedDeposit>
  confirmDeposit(input: ConfidentialDepositConfirmInput): Promise<ConfidentialDepositConfirmation>
  cancelDeposit(input: ConfidentialDepositCancelInput): Promise<void>
}

export interface NearConfidentialAccount {
  readonly accountIndex: number
  readonly mainAccountId: string
  readonly publicKey: string
  readonly peaAccountId: string | null
}

export interface NearConfidentialDepositSigning {
  prepare(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly kind: 'near-transaction' | 'pea-near-transaction'
    readonly prepared: PreparedNearIntentsDeposit
  }): Promise<
    Readonly<{
      commandId: string
      payloadFingerprint: string
      expiresAt: number
    }>
  >
  confirm(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly commandId: string
    readonly prepared: PreparedNearIntentsDeposit
  }): Promise<Readonly<{ rawTransaction: string; transactionHash: string }>>
  cancel(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly commandId: string
  }): Promise<void>
}

interface ConfidentialDepositTransactions {
  prepareTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly prepared: PreparedEvmTransfer
    readonly sourceDomain?: 'public' | 'private'
  }): Promise<
    Readonly<{
      commandId: string
      payloadFingerprint: string
      expiresAt: number
    }>
  >
  confirmTransaction(
    input: ConfidentialDepositConfirmInput
  ): Promise<ConfidentialDepositConfirmation>
  cancelTransaction(input: ConfidentialDepositCancelInput): Promise<void>
}

// Production identities use kind 'evm'. Earlier EVM identities omit kind.
export function isEvmConfidentialDepositIdentity(identity: { readonly kind?: string }): boolean {
  return identity.kind === undefined || identity.kind === 'evm'
}

export class EvmConfidentialDepositAdapter implements ConfidentialDepositAdapter {
  readonly kind = 'evm' as const

  constructor(
    private readonly transactions: ConfidentialDepositTransactions,
    private readonly assets: AssetRegistry,
    private readonly rpc: (chainId: ChainId) => EvmTransactionRpc
  ) {}

  async prepareDeposit(
    input: ConfidentialDepositPrepareInput
  ): Promise<ConfidentialPreparedDeposit> {
    const prepared = await buildEvmTransfer({
      chainId: input.chainId,
      chainAccount: input.identity.context.chainAccount,
      ...(input.sourceDomain === 'private'
        ? {
            executionAccount: {
              kind: 'pea' as const,
              address: input.identity.peaAddress,
              addressIndex: input.identity.addressIndex
            }
          }
        : {}),
      assets: this.assets,
      intent: {
        assetId: input.assetId,
        recipient: input.recipient,
        amountRaw: input.amountRaw
      },
      rpc: this.rpc(input.chainId),
      ...(input.feeSelection ? { feeSelection: input.feeSelection } : { feeTier: input.feeTier })
    })
    const signing = await this.transactions.prepareTransaction({
      identity: input.identity,
      prepared,
      ...(input.sourceDomain === undefined ? {} : { sourceDomain: input.sourceDomain })
    })
    return Object.freeze({
      ...signing,
      preparedTransfer: prepared
    })
  }

  confirmDeposit(input: ConfidentialDepositConfirmInput): Promise<ConfidentialDepositConfirmation> {
    return this.transactions.confirmTransaction(input)
  }

  cancelDeposit(input: ConfidentialDepositCancelInput): Promise<void> {
    return this.transactions.cancelTransaction(input)
  }
}

export class NearConfidentialDepositAdapter implements ConfidentialDepositAdapter {
  readonly kind = 'near' as const

  constructor(
    private readonly accounts: {
      resolve(identity: ConfidentialSigningIdentity): Promise<NearConfidentialAccount>
    },
    private readonly signing: NearConfidentialDepositSigning,
    private readonly rpc: PrepareNearIntentsDepositInput['rpc'],
    private readonly prepareIntentsDeposit: (
      input: PrepareNearIntentsDepositInput
    ) => Promise<PreparedNearIntentsDeposit> = prepareNearIntentsDeposit
  ) {}

  async prepareDeposit(
    input: ConfidentialDepositPrepareInput
  ): Promise<ConfidentialPreparedDeposit> {
    if (parseChainId(input.chainId).id !== 'near:mainnet') {
      throw new Error('NEAR Shield deposit requires NEAR mainnet')
    }
    const depositAddress = assertNearConfidentialDepositAddress(input.recipient)
    const account = await this.accounts.resolve(input.identity)
    const privateSource = input.sourceDomain === 'private'
    const signerId = privateSource ? account.peaAccountId : account.mainAccountId
    if (
      !signerId ||
      (privateSource && signerId === account.mainAccountId) ||
      (!privateSource && signerId !== account.mainAccountId)
    ) {
      throw new Error(
        privateSource
          ? 'NEAR Shield deposit requires an Incognito account'
          : 'NEAR Shield deposit signer does not match the Main account'
      )
    }
    const prepared = await this.prepareIntentsDeposit({
      chainId: 'near:mainnet',
      accountIndex: account.accountIndex,
      signerId,
      publicKey: privateSource ? nearPublicKeyFromImplicitAccountId(signerId) : account.publicKey,
      depositAddress,
      amountRaw: input.amountRaw,
      rpc: this.rpc
    })
    if (prepared.recipientId !== depositAddress || prepared.memo !== undefined) {
      throw new Error('NEAR Shield deposit does not match its quote')
    }
    const signing = await this.signing.prepare({
      identity: input.identity,
      kind: privateSource ? 'pea-near-transaction' : 'near-transaction',
      prepared
    })
    return Object.freeze({
      ...signing,
      preparedTransfer: prepared
    })
  }

  async confirmDeposit(
    input: ConfidentialDepositConfirmInput
  ): Promise<ConfidentialDepositConfirmation> {
    const prepared = parsePreparedNearIntentsDeposit(input.preparedTransfer)
    assertNearConfidentialDepositAddress(prepared.recipientId)
    if (prepared.memo !== undefined || prepared.chainId !== 'near:mainnet') {
      throw new Error('NEAR Shield deposit does not match its quote')
    }
    const account = await this.accounts.resolve(input.identity)
    const privateSource = input.sourceDomain === 'private'
    const signerId = privateSource ? account.peaAccountId : account.mainAccountId
    if (!signerId || prepared.signerId !== signerId) {
      throw new Error('NEAR Shield deposit signer does not match the account')
    }
    const signed = await this.signing.confirm({
      identity: input.identity,
      commandId: input.commandId,
      prepared
    })
    return Object.freeze({
      prepared,
      rawTransaction: signed.rawTransaction,
      transactionHash: signed.transactionHash
    })
  }

  cancelDeposit(input: ConfidentialDepositCancelInput): Promise<void> {
    return this.signing.cancel(input)
  }
}
