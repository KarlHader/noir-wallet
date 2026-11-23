/** The only Shield layer in this package. */
export const NEAR_CONFIDENTIAL_LAYER = 'near-confidential' as const

export type ShieldLayer = typeof NEAR_CONFIDENTIAL_LAYER

/** Decimal amount string, validated against the asset decimals. */
export type ShieldAmount = string

export type ShieldChainIdInput = string | number

/**
 * Chain-scoped asset. `symbol` is display-only and is resolved only when it
 * is unique on that chain.
 */
export interface ShieldTokenRef {
  readonly chainId: ShieldChainIdInput
  readonly assetId?: string
  readonly symbol?: string
}

/**
 * Recipient on a chain. The settled asset is the request token on that chain.
 * A destination token is not part of the request.
 */
export type ShieldTransferDestination =
  | Readonly<{
      kind: 'public'
      chainId: ShieldChainIdInput
      address: string
    }>
  | Readonly<{
      kind: 'confidential'
      accountId: string
      chainId?: ShieldChainIdInput
    }>

export type ShieldAction = 'receive' | 'transfer'

/**
 * Status returned for a stored operation. `rejected` is not a stored status.
 * A missing record is `unknown`. A deleted account or revoked session is
 * `unavailable`.
 */
export type ShieldPublicStatus =
  | 'awaiting-approval'
  | 'needs-auth'
  | 'authorized'
  | 'signing'
  | 'submitting'
  | 'processing'
  | 'awaiting-payment'
  | 'pending-refund'
  | 'ready'
  | 'partial'
  | 'refunded'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'unknown'
  | 'unavailable'

export type ShieldErrorCode =
  | 'NOT_INSTALLED'
  | 'UNSUPPORTED'
  | 'UNAUTHORIZED'
  | 'REJECTED'
  | 'INVALID_PARAMS'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'NOT_CONFIRMED'
  | 'UNAVAILABLE'
  | 'UNKNOWN'

export class ShieldError extends Error {
  readonly code: ShieldErrorCode
  readonly status?: ShieldPublicStatus

  constructor(code: ShieldErrorCode, message: string, status?: ShieldPublicStatus) {
    super(message)
    this.name = 'ShieldError'
    this.code = code
    this.status = status
  }
}

export interface ShieldWaitOptions {
  /** Aborting ends this wait. It does not cancel or resubmit the operation. */
  readonly signal?: AbortSignal
  /** Elapsing ends this wait. It does not mark the operation failed. */
  readonly timeoutMs?: number
}

export interface ShieldOperationSnapshot {
  readonly id: string
  readonly layer: ShieldLayer
  readonly action: ShieldAction
  readonly status: ShieldPublicStatus
  readonly providerStatus?: string
}

export interface ShieldOperationParty {
  readonly chainId: string
  readonly assetId: string
  readonly symbol?: string
  readonly amount?: string
}

export interface ShieldOperationReferences {
  readonly transactionHashes?: readonly string[]
  readonly orderId?: string
}

/** Status query result. wait() snapshots keep only the operation identity and status. */
export interface ShieldTransactionStatus {
  readonly id?: string
  readonly layer?: ShieldLayer
  readonly action?: ShieldAction
  readonly status?: ShieldPublicStatus
  readonly providerStatus?: string
  readonly source?: ShieldOperationParty
  readonly destination?: ShieldOperationParty
  readonly references?: ShieldOperationReferences
}

export interface ShieldOperationHandle {
  readonly id: string
  status: ShieldPublicStatus
  wait: (options?: ShieldWaitOptions) => Promise<ShieldOperationSnapshot>
}

export interface ShieldReceiveParams {
  readonly layer: ShieldLayer
  readonly source: ShieldTokenRef
  readonly amount: ShieldAmount
}

export interface ShieldTransferParams {
  readonly layer: ShieldLayer
  readonly token: ShieldTokenRef
  readonly amount: ShieldAmount
  readonly destination: ShieldTransferDestination
}

export interface ShieldQuote {
  readonly layer: ShieldLayer
  readonly action: ShieldAction
  readonly amount: ShieldAmount
  readonly fee: ShieldAmount
  readonly expectedReceive: ShieldAmount
  readonly expiresAt: number
  readonly source: Readonly<{ chainId: string; assetId: string; symbol: string }>
  readonly destination: Readonly<{ chainId: string; assetId: string; symbol: string }>
}

export interface ShieldChainInfo {
  readonly chainId: string
  readonly name: string
}

export interface ShieldTokenInfo {
  readonly chainId: string
  readonly assetId: string
  readonly symbol: string
  readonly decimals: number
}

export interface ShieldBalance {
  readonly symbol: string
  readonly chainId: string
  readonly chainName: string
  readonly assetId: string
  readonly amount: string
}
