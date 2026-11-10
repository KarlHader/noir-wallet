import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  dashScopeKey,
  hasExactKeys,
  isRecord,
  parseDashDiscoveryScope,
  parseDashTimestamp,
  type DashDiscoveryScope
} from './dash-discovery-model'

export const DASH_INPUT_RESERVATION_STATES = Object.freeze(['reserved', 'committed'] as const)
export type DashInputReservationState = (typeof DASH_INPUT_RESERVATION_STATES)[number]

export interface DashInputOutpoint {
  readonly transactionId: string
  readonly outputIndex: number
}

export interface DashInputReservation extends DashDiscoveryScope {
  readonly transactionId: TransactionId
  readonly state: DashInputReservationState
  readonly outpoints: readonly DashInputOutpoint[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ReserveDashInputsInput extends DashDiscoveryScope {
  readonly transactionId: TransactionId
  readonly outpoints: readonly DashInputOutpoint[]
  readonly now: number
}

export interface CommitDashInputsInput extends DashDiscoveryScope {
  readonly transactionId: TransactionId
  readonly now: number
}

export interface DashInputReservationRepository {
  list(
    scope: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>
  ): Promise<readonly DashInputReservation[]>
  reserve(input: ReserveDashInputsInput): Promise<DashInputReservation>
  commit(input: CommitDashInputsInput): Promise<DashInputReservation>
  release(
    scope: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>,
    transactionId: TransactionId
  ): Promise<void>
  deleteByAccountScope(scope: {
    readonly chainId: string
    readonly keyDomainId: string
    readonly accountId: string
  }): Promise<number>
}

const TXID = /^[0-9a-f]{64}$/

export function dashInputReservationKey(scope: DashDiscoveryScope, transactionId: string): string {
  return JSON.stringify([dashScopeKey(scope), transactionId])
}

export function dashInputOutpointKey(
  scope: DashDiscoveryScope,
  outpoint: DashInputOutpoint
): string {
  return JSON.stringify([dashScopeKey(scope), outpoint.transactionId, outpoint.outputIndex])
}

export function parseDashInputOutpoints(value: unknown): readonly DashInputOutpoint[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new Error('Invalid Dash input outpoints')
  }
  const seen = new Set<string>()
  const outpoints = value.map(candidate => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['transactionId', 'outputIndex'])) {
      throw new Error('Invalid Dash input outpoint')
    }
    const transactionId = candidate.transactionId
    const outputIndex = candidate.outputIndex
    if (
      typeof transactionId !== 'string' ||
      !TXID.test(transactionId) ||
      typeof outputIndex !== 'number' ||
      !Number.isSafeInteger(outputIndex) ||
      outputIndex < 0 ||
      outputIndex > 0xffffffff
    ) {
      throw new Error('Invalid Dash input outpoint')
    }
    const key = `${transactionId}:${outputIndex}`
    if (seen.has(key)) throw new Error('Duplicate Dash input outpoint')
    seen.add(key)
    return Object.freeze({ transactionId, outputIndex })
  })
  outpoints.sort((left, right) =>
    left.transactionId === right.transactionId
      ? left.outputIndex - right.outputIndex
      : left.transactionId.localeCompare(right.transactionId)
  )
  return Object.freeze(outpoints)
}

export function parseDashInputReservation(
  value: unknown,
  scope: DashDiscoveryScope
): DashInputReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'chainAccount',
      'accountIndex',
      'network',
      'imported',
      'transactionId',
      'state',
      'outpoints',
      'createdAt',
      'updatedAt'
    ]) ||
    (value.state !== 'reserved' && value.state !== 'committed') ||
    value.network !== scope.network ||
    value.imported !== scope.imported
  ) {
    throw new Error('Invalid Dash input reservation')
  }
  const parsedScope = parseDashDiscoveryScope({
    chainAccount: value.chainAccount as DashDiscoveryScope['chainAccount'],
    accountIndex: value.accountIndex as DashDiscoveryScope['accountIndex']
  })
  if (dashScopeKey(parsedScope) !== dashScopeKey(scope)) {
    throw new Error('Dash input reservation belongs to another account')
  }
  return Object.freeze({
    ...parsedScope,
    transactionId: parseTransactionId(value.transactionId),
    state: value.state,
    outpoints: parseDashInputOutpoints(value.outpoints),
    createdAt: parseDashTimestamp(value.createdAt),
    updatedAt: parseDashTimestamp(value.updatedAt)
  })
}
