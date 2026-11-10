import type {
  PendingPearlSigningTransfer,
  PendingPearlTransfer,
  SigningPearlTransfer
} from './pearl-pending-transfer-store'

/**
 * A signing claim is only abandoned after this grace period, because a lost
 * Worker response may have produced a signature that is not yet observable on
 * chain.
 */
export const PEARL_INTERRUPTED_SIGNING_GRACE_MS = 10 * 60 * 1000

export function startsPearlSigning(
  pending: PendingPearlSigningTransfer,
  startedAt: number
): SigningPearlTransfer {
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new Error('Invalid Pearl signing start time')
  }
  if (pending.phase === 'signing') return pending
  if (pending.phase !== 'awaiting-approval' && pending.phase !== 'awaiting-external-signature') {
    throw new Error('Pearl signing can only start from an approved request')
  }
  return Object.freeze({ ...pending, phase: 'signing' as const, signingStartedAt: startedAt })
}

/**
 * Rejection frees the reservations of a request that was never signed. Once a
 * signing claim exists a signature may already have been produced, so the
 * claim must be reconciled instead.
 */
export function assertPearlTransferRejectable(pending: PendingPearlTransfer): void {
  if (pending.phase === 'signing') {
    throw new Error('Pearl transfer is signing and cannot be rejected')
  }
}

/**
 * Reservations may only be released while no signature can exist yet. Signed
 * records own a broadcast, and signing claims are reconciled separately.
 */
export function pearlTransferHoldsReservations(pending: PendingPearlTransfer): boolean {
  return pending.phase === 'signing' || pending.phase === 'signed'
}

export function isPearlSigningInterrupted(
  pending: PendingPearlTransfer,
  now: number,
  graceMs = PEARL_INTERRUPTED_SIGNING_GRACE_MS
): pending is SigningPearlTransfer {
  return pending.phase === 'signing' && now - pending.signingStartedAt >= graceMs
}

/**
 * The reviewed transfer must be signed by the address the selected ChainAccount
 * advertises; discovery data alone is not an identity proof.
 */
export function assertPearlDiscoverySigner(
  signer: string | undefined,
  accountIdentity: string
): asserts signer is string {
  if (signer === undefined) {
    throw new Error('Pearl signer address is missing from discovery')
  }
  if (signer !== accountIdentity) {
    throw new Error('Pearl signer address does not match the selected ChainAccount')
  }
}
