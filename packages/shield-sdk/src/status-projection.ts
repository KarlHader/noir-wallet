import type { ShieldPublicStatus } from './types'

const PROTOCOL_REFUND_IN_PROGRESS = 'PENDING_REFUND'

const SIGNING_PHASES = new Set(['deposit-signed', 'deposit-confirming', 'signing-withdraws'])

const PLAN_TERMINAL = new Set(['ready', 'partial', 'refunded', 'failed', 'expired', 'cancelled'])

const DEPOSIT_TERMINAL = new Set(['ready', 'refunded', 'failed'])

export interface ShieldPlanStatusInput {
  readonly phase: string
  readonly backendStatus?: string
  readonly errorStatus?: string
}

export interface ShieldDepositStatusInput {
  readonly phase: string
  readonly providerStatus?: string
}

export interface ShieldProjectedStatus {
  readonly status: ShieldPublicStatus
  readonly providerStatus?: string
}

function protocolStatus(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? ''
}

function withProvider(
  status: ShieldPublicStatus,
  providerStatus: string | undefined
): ShieldProjectedStatus {
  return Object.freeze(providerStatus ? { status, providerStatus } : { status })
}

/**
 * Project a stored confidential plan. Internal phase names stay inside the wallet.
 * PENDING_REFUND is pending only before a terminal phase.
 */
export function projectConfidentialPlanStatus(plan: ShieldPlanStatusInput): ShieldProjectedStatus {
  const providerStatus = plan.backendStatus ?? plan.errorStatus
  if (
    protocolStatus(plan.backendStatus) === PROTOCOL_REFUND_IN_PROGRESS &&
    !PLAN_TERMINAL.has(plan.phase)
  ) {
    return withProvider('pending-refund', providerStatus)
  }
  if (plan.phase === 'prepared') return Object.freeze({ status: 'awaiting-approval' })
  if (plan.phase === 'needs-auth') return Object.freeze({ status: 'needs-auth' })
  if (plan.phase === 'authorized') return Object.freeze({ status: 'authorized' })
  if (SIGNING_PHASES.has(plan.phase)) return withProvider('signing', providerStatus)
  switch (plan.phase) {
    case 'submitting':
    case 'processing':
    case 'partial':
    case 'ready':
    case 'refunded':
    case 'failed':
    case 'expired':
    case 'cancelled':
      return withProvider(plan.phase, providerStatus)
    default:
      return withProvider('unknown', providerStatus)
  }
}

/**
 * External deposits keep providerStatus. A protocol EXPIRED observation stays on
 * the stored awaiting-payment phase and is not reported as a plan expiry.
 */
export function projectExternalShieldDepositStatus(
  record: ShieldDepositStatusInput
): ShieldProjectedStatus {
  const providerStatus = record.providerStatus
  if (
    protocolStatus(providerStatus) === PROTOCOL_REFUND_IN_PROGRESS &&
    !DEPOSIT_TERMINAL.has(record.phase)
  ) {
    return withProvider('pending-refund', providerStatus)
  }
  switch (record.phase) {
    case 'awaiting-payment':
    case 'processing':
    case 'ready':
    case 'refunded':
    case 'failed':
      return withProvider(record.phase, providerStatus)
    default:
      return withProvider('unknown', providerStatus)
  }
}
