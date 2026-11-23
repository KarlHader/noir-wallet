import type { ChainId } from '@/core/chains/domain'
import type { AssetRegistry } from '@/core/chains/registry'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import {
  buildEvmTransfer,
  type EvmFeeSelection,
  type EvmTransactionRpc,
  type PreparedEvmTransfer
} from '@/infrastructure/chains/evm'
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
  readonly prepared: PreparedEvmTransfer
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
  readonly preparedTransfer: PreparedEvmTransfer
}

export interface ConfidentialDepositAdapter {
  readonly kind: 'evm'
  prepareDeposit(input: ConfidentialDepositPrepareInput): Promise<ConfidentialPreparedDeposit>
  confirmDeposit(input: ConfidentialDepositConfirmInput): Promise<ConfidentialDepositConfirmation>
  cancelDeposit(input: ConfidentialDepositCancelInput): Promise<void>
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
