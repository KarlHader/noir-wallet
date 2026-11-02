import type { AccountId, ChainAccountId } from '@/core/accounts/domain'
import type { AssetDisplayMetadata, AssetId, ChainId } from '@/core/chains/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { TransactionEventId, TransactionId, TransactionSegmentId } from './identity'
import type { TransactionProtocolBinding } from './protocol'

export const TRANSACTION_LIFECYCLE_STATUSES = Object.freeze([
  'created',
  'prepared',
  'approved',
  'signed',
  'broadcast',
  'confirming',
  'final',
  'failed'
] as const)

export type TransactionLifecycleStatus = (typeof TRANSACTION_LIFECYCLE_STATUSES)[number]
export type TransactionTerminalStatus = Extract<TransactionLifecycleStatus, 'final' | 'failed'>

export const TRANSACTION_FAILURE_CODES = Object.freeze([
  'user-rejected',
  'cancelled',
  'invalid',
  'expired',
  'dropped',
  'reverted',
  'relay-failed',
  'refunded',
  'integrity-failure',
  'unknown'
] as const)

export type TransactionFailureCode = (typeof TRANSACTION_FAILURE_CODES)[number]

export const TRANSACTION_KINDS = Object.freeze([
  'transfer',
  'receive',
  'shield',
  'swap',
  'supply',
  'withdraw',
  'claim',
  'borrow',
  'repay',
  'approve',
  'cancel',
  'contract-call'
] as const)

export type TransactionKind = (typeof TRANSACTION_KINDS)[number]

export const TRANSACTION_SEGMENT_ROLES = Object.freeze([
  'origin',
  'relay',
  'destination',
  'refund'
] as const)

export type TransactionSegmentRole = (typeof TRANSACTION_SEGMENT_ROLES)[number]

export const TRANSACTION_RELATION_KINDS = Object.freeze(['retry-of', 'replacement-of'] as const)

export type TransactionRelationKind = (typeof TRANSACTION_RELATION_KINDS)[number]

export const TRANSACTION_DIRECTIONS = Object.freeze([
  'incoming',
  'outgoing',
  'self',
  'contract'
] as const)

export type TransactionDirection = (typeof TRANSACTION_DIRECTIONS)[number]

export interface TransactionAssetAmount {
  readonly assetId: AssetId
  readonly amountRaw: string
  readonly metadata?: AssetDisplayMetadata
}

export interface TransactionAssetChange extends TransactionAssetAmount {
  readonly direction: 'incoming' | 'outgoing'
}

export interface TransactionAssetEffects {
  readonly source: 'receipt' | 'indexer'
  readonly completeness: 'partial' | 'complete'
  readonly changes: readonly TransactionAssetChange[]
}

export interface TransactionParty {
  readonly chainId: ChainId
  readonly address: string
}

export interface TransactionIntentSnapshot {
  readonly schemaVersion: 1
  readonly direction: TransactionDirection
  readonly primaryAmount?: TransactionAssetAmount
  readonly counterAmount?: TransactionAssetAmount
  readonly feeLimit?: TransactionAssetAmount
  readonly sender?: TransactionParty
  readonly recipient?: TransactionParty
  readonly protocol?: TransactionProtocolBinding
  readonly evm?: Readonly<{
    readonly schemaVersion: 1
    readonly nonce: string
    readonly maxFeePerGasWei: string
    readonly maxPriorityFeePerGasWei: string
    readonly gasLimit: string
    readonly methodSelector?: string
  }>
}

export type TransactionSegmentTarget =
  | {
      readonly kind: 'onchain'
      readonly chainId: ChainId
      readonly chainAccountId?: ChainAccountId
    }
  | {
      readonly kind: 'relay'
      readonly provider: string
    }
  | {
      readonly kind: 'protocol'
      readonly provider: string
      readonly account: string
    }

export interface TransactionFailure {
  readonly code: TransactionFailureCode
  readonly occurredAt: number
}

export interface TransactionSegmentEvidence {
  readonly transactionHash?: string
  readonly assetEffects?: TransactionAssetEffects
  readonly replacementTransactionHash?: string
  readonly externalReference?: string
  readonly blockHash?: string
  readonly blockHeight?: number
  readonly confirmations?: number
  readonly requiredConfirmations?: number
}

export interface TransactionAccountScope {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
}

export interface TransactionRootRelation {
  readonly kind: TransactionRelationKind
  readonly transactionId: TransactionId
}

export interface TransactionRoot {
  readonly id: TransactionId
  readonly scope: TransactionAccountScope
  readonly kind: TransactionKind
  readonly status: TransactionLifecycleStatus
  readonly segmentIds: readonly TransactionSegmentId[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
  readonly intent?: TransactionIntentSnapshot
  readonly lastEventId?: TransactionEventId
  readonly relation?: TransactionRootRelation
  readonly failure?: TransactionFailure
  readonly reconfirming?: true
}

export interface TransactionSegment {
  readonly id: TransactionSegmentId
  readonly transactionId: TransactionId
  readonly role: TransactionSegmentRole
  readonly target: TransactionSegmentTarget
  readonly status: TransactionLifecycleStatus
  readonly requiredForFinality: boolean
  readonly dependsOn: readonly TransactionSegmentId[]
  readonly evidence?: TransactionSegmentEvidence
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
  readonly lastEventId?: TransactionEventId
  readonly failure?: TransactionFailure
  readonly reconfirming?: true
}

export interface TransactionGraph {
  readonly root: TransactionRoot
  readonly segments: readonly TransactionSegment[]
}

export const TRANSACTION_TRANSITION_CAUSES = Object.freeze([
  'progress',
  'failure',
  'reorg',
  'reconciliation'
] as const)

export type TransactionTransitionCause = (typeof TRANSACTION_TRANSITION_CAUSES)[number]

export interface TransactionSegmentEvent {
  readonly id: TransactionEventId
  readonly status: TransactionLifecycleStatus
  readonly cause: TransactionTransitionCause
  readonly observedAt: number
  readonly evidence?: TransactionSegmentEvidence
  readonly failure?: TransactionFailure
}

export interface TransactionRootReconciliation {
  readonly id: TransactionEventId
  readonly observedAt: number
  readonly allowReorg?: boolean
}
