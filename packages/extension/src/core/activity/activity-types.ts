import type { AccountId } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import type {
  TransactionFailureCode,
  TransactionIntentSnapshot,
  TransactionKind,
  TransactionLifecycleStatus,
  TransactionSegmentEvidence,
  TransactionSegmentRole,
  TransactionSegmentTarget
} from '@/core/transactions/domain'

export const ACTIVITY_SOURCES = Object.freeze(['zcash-v1', 'wallet-v2', 'rpc'] as const)

export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]
export type ActivityCompleteness = 'complete' | 'partial'

export interface ActivityScope {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
}

export interface ActivitySegment {
  readonly id: string
  readonly role: TransactionSegmentRole
  readonly target: TransactionSegmentTarget
  readonly status: TransactionLifecycleStatus
  readonly evidence?: TransactionSegmentEvidence
  readonly failureCode?: TransactionFailureCode
  readonly reconfirming?: true
}

export interface ActivityItem {
  readonly id: string
  readonly source: ActivitySource
  readonly accountMode?: 'private'
  readonly assetDomains?: readonly ('public' | 'shield')[]
  readonly scope: ActivityScope
  readonly kind: TransactionKind
  readonly status: TransactionLifecycleStatus
  readonly snapshot?: TransactionIntentSnapshot
  readonly segments: readonly ActivitySegment[]
  readonly completeness: ActivityCompleteness
  readonly createdAt: number
  readonly updatedAt: number
  readonly failureCode?: TransactionFailureCode
  readonly reconfirming?: true
}

export interface ActivityReadModel {
  readonly scope: ActivityScope
  readonly items: readonly ActivityItem[]
  readonly partialItemCount: number
  readonly hasMore?: boolean
}
