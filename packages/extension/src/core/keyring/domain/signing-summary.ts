import type { ChainId } from '@/core/chains/domain'

export const SIGNING_SUMMARY_SCHEMAS = Object.freeze([
  'zcash.transaction.v1',
  'zcash.message.v1',
  'evm.transaction.v1',
  'evm.personal-message.v1',
  'evm.typed-data.v1',
  'bitcoin.psbt.v1',
  'bitcoin.bip322-message.v1',
  'solana.transaction.v1',
  'solana.message.v1',
  'tron.transaction.v1',
  'tron.sign-message-v2.v1',
  'near.transaction.v1',
  'near.nep413-message.v1'
] as const)

export type SigningSummarySchema = (typeof SIGNING_SUMMARY_SCHEMAS)[number]
export type SigningSummaryFamily = 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'tron' | 'near'
export type SigningOperation = 'transaction' | 'message'
export type SigningReviewLevel = 'standard' | 'caution' | 'blocked'
export type SigningReviewIssueCode =
  | 'contract-creation'
  | 'external-input'
  | 'missing-chain-binding'
  | 'non-default-sighash'
  | 'unknown-output'
  | 'unrecognized-call'
  | 'unrecognized-instruction'
  | 'simulation-failed'
  | 'unrecognized-action'
  | 'active-permission'
  | 'owner-signer-mismatch'
  | 'multisign'
  | 'token-approval'
  | 'unlimited-token-approval'
  | 'opaque-message'

export interface SigningReviewIssue {
  readonly code: SigningReviewIssueCode
  readonly subjectIndex?: number
}

export interface SigningReview {
  readonly level: SigningReviewLevel
  readonly issues: readonly SigningReviewIssue[]
}

export interface CanonicalContent {
  readonly encoding: 'utf8' | 'hex' | 'base64'
  readonly value: string
  readonly byteLength: number
  readonly sha256: string
}

export interface PayloadDigest {
  readonly byteLength: number
  readonly sha256: string
}

interface SigningSummaryEnvelope<
  TSchema extends SigningSummarySchema,
  TOperation extends SigningOperation,
  TFields
> {
  readonly schema: TSchema
  readonly chainId: ChainId
  readonly operation: TOperation
  readonly review: SigningReview
  readonly fields: TFields
}

export interface ZcashRecipientSummary {
  readonly address: string
  readonly amountZats: string
  readonly memo?: CanonicalContent
}

export type ZcashTransactionSummary = SigningSummaryEnvelope<
  'zcash.transaction.v1',
  'transaction',
  {
    readonly kind: 'transfer' | 'shield'
    readonly signer: string
    readonly fundingSource: 'transparent' | 'shielded'
    readonly recipients: readonly ZcashRecipientSummary[]
    readonly feeZats: string
    readonly transparentInputZats: string
    readonly shieldedInputZats: string
    readonly transparentOutputZats: string
    readonly shieldedOutputZats: string
  }
>

export type ZcashMessageSummary = SigningSummaryEnvelope<
  'zcash.message.v1',
  'message',
  {
    readonly signer: string
    readonly message: CanonicalContent
  }
>

export interface EvmAccessListEntrySummary {
  readonly address: string
  readonly storageKeys: readonly string[]
}

export type EvmTransactionSummary = SigningSummaryEnvelope<
  'evm.transaction.v1',
  'transaction',
  {
    readonly transactionType: 'legacy' | 'eip2930' | 'eip1559'
    readonly from: string
    readonly to: string | null
    readonly nonce: string
    readonly valueWei: string
    readonly gasLimit: string
    readonly maximumFeeWei: string
    readonly gasPriceWei: string | null
    readonly maxFeePerGasWei: string | null
    readonly maxPriorityFeePerGasWei: string | null
    readonly accessList: readonly EvmAccessListEntrySummary[]
    readonly calldata: CanonicalContent
    readonly methodSelector: string | null
  }
>

export type EvmPersonalMessageSummary = SigningSummaryEnvelope<
  'evm.personal-message.v1',
  'message',
  {
    readonly signer: string
    readonly message: CanonicalContent
  }
>

export type EvmTypedDataValue =
  | {
      readonly kind: 'scalar'
      readonly solidityType: string
      readonly value: string
    }
  | {
      readonly kind: 'struct'
      readonly typeName: string
      readonly fields: readonly {
        readonly name: string
        readonly value: EvmTypedDataValue
      }[]
    }
  | {
      readonly kind: 'array'
      readonly itemType: string
      readonly items: readonly EvmTypedDataValue[]
    }

export type EvmTypedDataSummary = SigningSummaryEnvelope<
  'evm.typed-data.v1',
  'message',
  {
    readonly signer: string
    readonly primaryType: string
    readonly domain: EvmTypedDataValue
    readonly message: EvmTypedDataValue
    readonly digestHex: string
  }
>

export interface BitcoinInputSummary {
  readonly index: number
  readonly transactionId: string
  readonly outputIndex: number
  readonly amountSats: string
  readonly sequence: number
  readonly scriptType: 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr'
  readonly sighashType: string
  readonly ownership: 'signing-account' | 'external'
}

export interface BitcoinOutputSummary {
  readonly index: number
  readonly address: string | null
  readonly scriptPubKeyHex: string
  readonly amountSats: string
  readonly classification: 'recipient' | 'change' | 'unknown'
}

export type BitcoinPsbtSummary = SigningSummaryEnvelope<
  'bitcoin.psbt.v1',
  'transaction',
  {
    readonly psbtVersion: 0
    readonly signer: string
    readonly inputs: readonly BitcoinInputSummary[]
    readonly outputs: readonly BitcoinOutputSummary[]
    readonly signingInputIndexes: readonly number[]
    readonly totalInputSats: string
    readonly totalOutputSats: string
    readonly feeSats: string
  }
>

export type BitcoinBip322MessageSummary = SigningSummaryEnvelope<
  'bitcoin.bip322-message.v1',
  'message',
  {
    readonly address: string
    readonly message: CanonicalContent
  }
>

export interface SolanaInstructionAccountSummary {
  readonly address: string
  readonly signer: boolean
  readonly writable: boolean
  readonly source: 'static' | 'lookup'
}

export type SolanaInstructionInterpretation =
  | {
      readonly kind: 'system-transfer'
      readonly from: string
      readonly to: string
      readonly lamports: string
    }
  | {
      readonly kind: 'spl-token-transfer'
      readonly source: string
      readonly destination: string
      readonly authority: string
      readonly amountRaw: string
      readonly mint: string | null
      readonly decimals: number | null
    }
  | {
      readonly kind: 'associated-token-create-idempotent'
      readonly payer: string
      readonly associatedAccount: string
      readonly owner: string
      readonly mint: string
      readonly tokenProgram: string
    }
  | {
      readonly kind: 'compute-unit-limit'
      readonly units: string
    }
  | {
      readonly kind: 'compute-unit-price'
      readonly microLamports: string
    }
  | {
      readonly kind: 'compute-request-heap-frame'
      readonly bytes: string
    }
  | {
      readonly kind: 'compute-loaded-accounts-data-size-limit'
      readonly bytes: string
    }
  | {
      readonly kind: 'compute-request-units-deprecated'
      readonly units: string
      readonly additionalFeeLamports: string
    }
  | {
      readonly kind: 'unrecognized'
    }

export interface SolanaInstructionSummary {
  readonly index: number
  readonly programId: string
  readonly accounts: readonly SolanaInstructionAccountSummary[]
  readonly data: CanonicalContent
  readonly interpretation: SolanaInstructionInterpretation
}

export interface SolanaAddressTableLookupSummary {
  readonly accountKey: string
  readonly writableAddresses: readonly string[]
  readonly readonlyAddresses: readonly string[]
}

export type SolanaTransactionSummary = SigningSummaryEnvelope<
  'solana.transaction.v1',
  'transaction',
  {
    readonly messageVersion: 'legacy' | 'v0'
    readonly feePayer: string
    readonly recentBlockhash: string
    readonly requiredSigners: readonly string[]
    readonly staticAccountKeys: readonly string[]
    readonly addressTableLookups: readonly SolanaAddressTableLookupSummary[]
    readonly feeLamports: string | null
    readonly computeUnitLimit: string | null
    readonly computeUnitPriceMicroLamports: string | null
    readonly maximumPriorityFeeLamports: string | null
    readonly simulationStatus: 'not-run' | 'succeeded' | 'failed'
    readonly simulationUnitsConsumed: string | null
    readonly instructions: readonly SolanaInstructionSummary[]
  }
>

export type SolanaMessageSummary = SigningSummaryEnvelope<
  'solana.message.v1',
  'message',
  {
    readonly signer: string
    readonly domain: string
    readonly message: CanonicalContent
  }
>

export type TronResource = 'bandwidth' | 'energy'

export interface TronVoteSummary {
  readonly voteAddress: string
  readonly voteCount: string
}

export type TronSmartContractInterpretation =
  | {
      readonly kind: 'trc20-transfer'
      readonly to: string
      readonly amountRaw: string
    }
  | {
      readonly kind: 'trc20-approve'
      readonly spender: string
      readonly amountRaw: string
    }
  | {
      readonly kind: 'trc20-transfer-from'
      readonly from: string
      readonly to: string
      readonly amountRaw: string
    }
  | {
      readonly kind: 'unrecognized'
    }

export type TronContractSummary =
  | {
      readonly type: 'transfer'
      readonly owner: string
      readonly to: string
      readonly amountSun: string
    }
  | {
      readonly type: 'transfer-asset'
      readonly owner: string
      readonly to: string
      readonly assetName: CanonicalContent
      readonly amountRaw: string
    }
  | {
      readonly type: 'vote-witness'
      readonly owner: string
      readonly votes: readonly TronVoteSummary[]
    }
  | {
      readonly type: 'trigger-smart-contract'
      readonly owner: string
      readonly contractAddress: string
      readonly callValueSun: string
      readonly callTokenValue: string
      readonly tokenId: string
      readonly calldata: CanonicalContent
      readonly methodSelector: string | null
      readonly interpretation: TronSmartContractInterpretation
    }
  | {
      readonly type: 'freeze-balance-v2' | 'unfreeze-balance-v2'
      readonly owner: string
      readonly resource: TronResource
      readonly amountSun: string
    }
  | {
      readonly type: 'withdraw-expire-unfreeze' | 'cancel-all-unfreeze-v2'
      readonly owner: string
    }
  | {
      readonly type: 'delegate-resource'
      readonly owner: string
      readonly receiver: string
      readonly resource: TronResource
      readonly amountSun: string
      readonly locked: boolean
      readonly lockPeriod: string
    }
  | {
      readonly type: 'undelegate-resource'
      readonly owner: string
      readonly receiver: string
      readonly resource: TronResource
      readonly amountSun: string
    }

export type TronTransactionSummary = SigningSummaryEnvelope<
  'tron.transaction.v1',
  'transaction',
  {
    readonly signer: string
    readonly owner: string
    readonly ownerMatchesSigner: boolean
    readonly permissionId: number
    readonly transactionId: string
    readonly rawData: PayloadDigest
    readonly refBlockBytes: string
    readonly refBlockNum: string
    readonly refBlockHash: string
    readonly expirationMs: string
    readonly timestampMs: string
    readonly feeLimitSun: string
    readonly memo: CanonicalContent
    readonly existingSigners: readonly string[]
    readonly contract: TronContractSummary
  }
>

export type TronSignMessageV2Summary = SigningSummaryEnvelope<
  'tron.sign-message-v2.v1',
  'message',
  {
    readonly signer: string
    readonly prefix: '\u0019TRON Signed Message:\n'
    readonly message: CanonicalContent
    readonly signingHash: string
  }
>

export type NearAccessKeyPermissionSummary =
  | {
      readonly kind: 'full-access'
    }
  | {
      readonly kind: 'function-call'
      readonly allowanceYocto: string | null
      readonly receiverId: string
      readonly methodNames: readonly string[]
    }

export type NearActionSummary =
  | {
      readonly kind: 'create-account'
    }
  | {
      readonly kind: 'deploy-contract'
      readonly code: PayloadDigest
    }
  | {
      readonly kind: 'function-call'
      readonly methodName: string
      readonly args: CanonicalContent
      readonly gas: string
      readonly depositYocto: string
    }
  | {
      readonly kind: 'transfer'
      readonly depositYocto: string
    }
  | {
      readonly kind: 'stake'
      readonly stakeYocto: string
      readonly publicKey: string
    }
  | {
      readonly kind: 'add-key'
      readonly publicKey: string
      readonly nonce: string
      readonly permission: NearAccessKeyPermissionSummary
    }
  | {
      readonly kind: 'delete-key'
      readonly publicKey: string
    }
  | {
      readonly kind: 'delete-account'
      readonly beneficiaryId: string
    }
  | {
      readonly kind: 'unrecognized'
      readonly actionTag: number
      readonly payload: PayloadDigest
    }

export type NearTransactionSummary = SigningSummaryEnvelope<
  'near.transaction.v1',
  'transaction',
  {
    readonly signerId: string
    readonly publicKey: string
    readonly nonce: string
    readonly receiverId: string
    readonly blockHash: string
    readonly actions: readonly NearActionSummary[]
  }
>

export type NearNep413MessageSummary = SigningSummaryEnvelope<
  'near.nep413-message.v1',
  'message',
  {
    readonly signerId: string
    readonly publicKey: string
    readonly message: CanonicalContent
    readonly nonceBase64: string
    readonly recipient: string
    readonly callbackUrl: string | null
  }
>

export type SigningSummary =
  | ZcashTransactionSummary
  | ZcashMessageSummary
  | EvmTransactionSummary
  | EvmPersonalMessageSummary
  | EvmTypedDataSummary
  | BitcoinPsbtSummary
  | BitcoinBip322MessageSummary
  | SolanaTransactionSummary
  | SolanaMessageSummary
  | TronTransactionSummary
  | TronSignMessageV2Summary
  | NearTransactionSummary
  | NearNep413MessageSummary

export interface SigningSummaryExpectation {
  readonly chainId: ChainId
  readonly family: SigningSummaryFamily
  readonly operation: SigningOperation
}
