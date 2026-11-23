import type { ChainId } from '@/core/chains/domain'
import { parseAssetId, parseChainId, type AssetRegistry } from '@/core/chains/registry'
import { nearPublicKeyFromImplicitAccountId, WRAP_NEAR_CONTRACT_ID } from '@/core/chains/near'
import {
  decodeNearContractId,
  isNearFungibleContractId,
  NEAR_MAINNET_NATIVE_ASSET_ID
} from '@/core/chains/near/near-portfolio-assets'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import {
  buildEvmTransfer,
  type EvmFeeSelection,
  type EvmTransactionRpc,
  type PreparedEvmTransfer
} from '@/infrastructure/chains/evm'
import {
  parsePreparedNearConfidentialDeposit,
  prepareNearConfidentialFungibleDeposit,
  prepareNearIntentsDeposit,
  type PreparedNearConfidentialDeposit,
  type PreparedNearConfidentialFungibleDeposit,
  type PreparedNearIntentsDeposit,
  type PrepareNearConfidentialFungibleDepositInput,
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
  readonly prepared: PreparedEvmTransfer | PreparedNearConfidentialDeposit
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
  readonly preparedTransfer: PreparedEvmTransfer | PreparedNearConfidentialDeposit
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
  readonly walletSource?:
    | Readonly<{ kind: 'software' }>
    | Readonly<{
        kind: 'private-key'
        chainFamily: 'eip155' | 'bip122' | 'solana' | 'near'
        accountIndex: number
      }>
    | Readonly<{ kind: 'hardware' }>
}

export interface NearConfidentialDepositSigning {
  prepare(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly kind: 'near-transaction' | 'pea-near-transaction'
    readonly prepared: PreparedNearConfidentialDeposit
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
    readonly prepared: PreparedNearConfidentialDeposit
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

function nearShieldDepositAsset(
  assetId: string
):
  | Readonly<{ kind: 'wrap' }>
  | Readonly<{ kind: 'fungible'; assetId: string; contractId: string }> {
  const asset = parseAssetId(assetId)
  if (asset.chainId !== 'near:mainnet') {
    throw new Error('NEAR Shield deposit asset is not supported')
  }
  if (
    asset.id === NEAR_MAINNET_NATIVE_ASSET_ID ||
    (asset.namespace === 'nep141' &&
      decodeNearContractId(asset.reference) === WRAP_NEAR_CONTRACT_ID)
  ) {
    return { kind: 'wrap' }
  }
  if (asset.namespace !== 'nep141') {
    throw new Error('NEAR Shield deposit asset is not supported')
  }
  const contractId = decodeNearContractId(asset.reference)
  if (!isNearFungibleContractId(contractId)) {
    throw new Error('NEAR Shield deposit asset is not supported')
  }
  return { kind: 'fungible', assetId: asset.id, contractId }
}

function fungibleDepositMatchesQuote(
  prepared: PreparedNearConfidentialFungibleDeposit,
  amountRaw: string,
  depositAddress: string,
  assetId: string,
  contractId: string
): boolean {
  return (
    prepared.kind === 'confidential-ft-deposit' &&
    prepared.recipientId === depositAddress &&
    prepared.amountRaw === amountRaw &&
    prepared.assetId === assetId &&
    prepared.tokenContractId === contractId &&
    prepared.transaction.receiverId === contractId &&
    prepared.transaction.actions.every(
      action => action.type === 'functionCall' && action.methodName !== 'near_deposit'
    )
  )
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
    ) => Promise<PreparedNearIntentsDeposit> = prepareNearIntentsDeposit,
    private readonly prepareFungibleDeposit: (
      input: PrepareNearConfidentialFungibleDepositInput
    ) => Promise<PreparedNearConfidentialFungibleDeposit> = prepareNearConfidentialFungibleDeposit
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
    const publicKey = privateSource
      ? nearPublicKeyFromImplicitAccountId(signerId)
      : account.publicKey
    const asset = nearShieldDepositAsset(input.assetId)
    const prepared = await this.prepareShieldDeposit(input, {
      accountIndex: account.accountIndex,
      signerId,
      publicKey,
      depositAddress,
      asset
    })
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

  private async prepareShieldDeposit(
    input: ConfidentialDepositPrepareInput,
    binding: Readonly<{
      accountIndex: number
      signerId: string
      publicKey: string
      depositAddress: string
      asset: ReturnType<typeof nearShieldDepositAsset>
    }>
  ): Promise<PreparedNearConfidentialDeposit> {
    if (binding.asset.kind === 'wrap') {
      const prepared = await this.prepareIntentsDeposit({
        chainId: 'near:mainnet',
        accountIndex: binding.accountIndex,
        signerId: binding.signerId,
        publicKey: binding.publicKey,
        depositAddress: binding.depositAddress,
        amountRaw: input.amountRaw,
        rpc: this.rpc
      })
      if (
        prepared.kind !== 'intents-deposit' ||
        prepared.recipientId !== binding.depositAddress ||
        prepared.memo !== undefined ||
        prepared.amountRaw !== input.amountRaw ||
        prepared.tokenContractId !== WRAP_NEAR_CONTRACT_ID
      ) {
        throw new Error('NEAR Shield deposit does not match its quote')
      }
      return prepared
    }
    const prepared = await this.prepareFungibleDeposit({
      chainId: 'near:mainnet',
      accountIndex: binding.accountIndex,
      assetId: binding.asset.assetId,
      signerId: binding.signerId,
      publicKey: binding.publicKey,
      depositAddress: binding.depositAddress,
      amountRaw: input.amountRaw,
      rpc: this.rpc
    })
    if (
      !fungibleDepositMatchesQuote(
        prepared,
        input.amountRaw,
        binding.depositAddress,
        binding.asset.assetId,
        binding.asset.contractId
      )
    ) {
      throw new Error('NEAR Shield deposit does not match its quote')
    }
    return prepared
  }

  async confirmDeposit(
    input: ConfidentialDepositConfirmInput
  ): Promise<ConfidentialDepositConfirmation> {
    const prepared = parsePreparedNearConfidentialDeposit(input.preparedTransfer)
    assertNearConfidentialDepositAddress(prepared.recipientId)
    if (
      prepared.chainId !== 'near:mainnet' ||
      (prepared.kind === 'intents-deposit' && prepared.memo !== undefined)
    ) {
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
