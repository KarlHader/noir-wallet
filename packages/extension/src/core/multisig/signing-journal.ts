import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import type { SigningReviewBinding } from './signing-coordinator'
import type { MultisigThreshold } from './types'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseAccountId } from '@/core/accounts/domain'

export type SigningIntentPhase =
  | 'review_ready'
  | 'signing'
  | 'signed'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'interrupted'
export type SigningNoncePhase = 'none' | 'created' | 'committed' | 'consumed'
export interface SigningIntentBinding extends Readonly<SigningReviewBinding> {
  readonly threshold: MultisigThreshold
  readonly transport: 'qr' | 'ble'
  readonly createdAt: number
}
export interface SigningIntent extends SigningIntentBinding {
  readonly version: 1
  readonly updatedAt: number
  readonly phase: SigningIntentPhase
  readonly noncePhase: SigningNoncePhase
}
export interface SigningIntentTransition {
  expectedPhase: SigningIntentPhase
  expectedNoncePhase: SigningNoncePhase
  nextPhase: SigningIntentPhase
  nextNoncePhase: SigningNoncePhase
}
const BINDING_KEYS = [
  'walletId',
  'accountId',
  'network',
  'groupId',
  'rosterVersion',
  'reviewId',
  'pcztDigest',
  'sessionId',
  'threshold',
  'selectedSlots',
  'expiresAt',
  'transport',
  'createdAt'
] as const
const NONCES: readonly SigningNoncePhase[] = ['none', 'created', 'committed', 'consumed']
const PHASES: readonly SigningIntentPhase[] = [
  'review_ready',
  'signing',
  'signed',
  'confirmed',
  'cancelled',
  'expired',
  'interrupted'
]
const FAIL = 'Signing intent is unavailable'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(FAIL)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some(key => !keys.includes(key))
  )
    throw new Error(FAIL)
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
  )
}
export interface SigningJournalScope {
  network: 'mainnet' | 'testnet'
  walletId: string
  accountId: string
}
export function signingJournalScopeKey(scope: {
  network: string
  walletId: string
  accountId: string
}): string {
  if (scope.network !== 'mainnet' && scope.network !== 'testnet') throw new Error(FAIL)
  return JSON.stringify([
    scope.network,
    parseKeyDomainId(scope.walletId),
    parseAccountId(scope.accountId)
  ])
}
export function parseSigningJournalScopeKey(key: string): SigningJournalScope | null {
  try {
    const parts: unknown = JSON.parse(key)
    if (!Array.isArray(parts) || parts.length !== 3) return null
    const scope = { network: parts[0], walletId: parts[1], accountId: parts[2] }
    if (signingJournalScopeKey(scope) !== key) return null
    return scope as SigningJournalScope
  } catch {
    return null
  }
}
export function parseSigningSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24) throw new Error(FAIL)
  try {
    const bytes = base64ToBytes(value)
    if (bytes.length !== 16 || bytesToBase64(bytes) !== value) throw new Error(FAIL)
    return value
  } catch {
    throw new Error(FAIL)
  }
}
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export function parseSigningIntentBinding(value: unknown): Readonly<SigningIntentBinding> {
  const input = record(value)
  exact(input, BINDING_KEYS)
  const walletId = parseKeyDomainId(input.walletId)
  const accountId = parseAccountId(input.accountId)
  if (
    !identifier(input.groupId) ||
    !identifier(input.reviewId) ||
    (input.network !== 'mainnet' && input.network !== 'testnet') ||
    !Number.isSafeInteger(input.rosterVersion) ||
    (input.rosterVersion as number) < 1 ||
    typeof input.pcztDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.pcztDigest) ||
    typeof input.sessionId !== 'string' ||
    input.sessionId.length !== 24 ||
    !time(input.createdAt) ||
    !time(input.expiresAt) ||
    input.expiresAt <= input.createdAt ||
    (input.transport !== 'qr' && input.transport !== 'ble') ||
    !['2-of-2', '2-of-3', '3-of-3'].includes(input.threshold as string) ||
    !Array.isArray(input.selectedSlots)
  )
    throw new Error(FAIL)
  parseSigningSessionId(input.sessionId)
  const count = input.threshold === '3-of-3' ? 3 : 2
  const total = input.threshold === '2-of-2' ? 2 : 3
  const slots: unknown[] = input.selectedSlots
  if (
    slots.length !== count ||
    slots[0] !== 0 ||
    new Set(slots).size !== count ||
    slots.some(
      slot => typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= total
    ) ||
    slots.some((slot, index) => index > 0 && (slot as number) <= (slots[index - 1] as number))
  )
    throw new Error(FAIL)
  return Object.freeze({
    walletId,
    accountId,
    network: input.network,
    groupId: input.groupId,
    rosterVersion: input.rosterVersion as number,
    reviewId: input.reviewId,
    pcztDigest: input.pcztDigest,
    sessionId: input.sessionId,
    threshold: input.threshold as MultisigThreshold,
    selectedSlots: Object.freeze([...slots] as number[]),
    expiresAt: input.expiresAt,
    transport: input.transport,
    createdAt: input.createdAt
  })
}
export function signingIntentBinding(intent: SigningIntent): Readonly<SigningIntentBinding> {
  return parseSigningIntentBinding(Object.fromEntries(BINDING_KEYS.map(key => [key, intent[key]])))
}
export function parseSigningIntent(value: unknown): Readonly<SigningIntent> {
  const input = record(value)
  exact(input, [...BINDING_KEYS, 'version', 'updatedAt', 'phase', 'noncePhase'])
  const binding = parseSigningIntentBinding(
    Object.fromEntries(BINDING_KEYS.map(key => [key, input[key]]))
  )
  if (
    input.version !== 1 ||
    !time(input.updatedAt) ||
    input.updatedAt < binding.createdAt ||
    !PHASES.includes(input.phase as SigningIntentPhase) ||
    !NONCES.includes(input.noncePhase as SigningNoncePhase) ||
    (input.phase === 'review_ready' && input.noncePhase !== 'none') ||
    ((input.phase === 'signed' || input.phase === 'confirmed') && input.noncePhase !== 'consumed')
  )
    throw new Error(FAIL)
  return Object.freeze({
    ...binding,
    version: 1,
    updatedAt: input.updatedAt,
    phase: input.phase as SigningIntentPhase,
    noncePhase: input.noncePhase as SigningNoncePhase
  })
}
export function isSigningIntentTerminal(phase: SigningIntentPhase): boolean {
  return (
    phase === 'cancelled' || phase === 'expired' || phase === 'interrupted' || phase === 'confirmed'
  )
}
export function transitionSigningIntent(
  current: SigningIntent,
  edge: SigningIntentTransition,
  now: number
): Readonly<SigningIntent> {
  exact(record(edge), ['expectedPhase', 'expectedNoncePhase', 'nextPhase', 'nextNoncePhase'])
  if (
    !time(now) ||
    now < current.updatedAt ||
    !PHASES.includes(edge.expectedPhase) ||
    !PHASES.includes(edge.nextPhase) ||
    !NONCES.includes(edge.expectedNoncePhase) ||
    !NONCES.includes(edge.nextNoncePhase) ||
    isSigningIntentTerminal(edge.expectedPhase)
  )
    throw new Error(FAIL)
  const sameNonce = edge.expectedNoncePhase === edge.nextNoncePhase
  const terminating =
    (edge.nextPhase === 'cancelled' ||
      edge.nextPhase === 'expired' ||
      edge.nextPhase === 'interrupted') &&
    edge.expectedPhase !== 'signed' &&
    sameNonce &&
    (edge.nextPhase !== 'expired' || now >= current.expiresAt)
  const starting =
    edge.expectedPhase === 'review_ready' &&
    edge.expectedNoncePhase === 'none' &&
    edge.nextPhase === 'signing' &&
    sameNonce
  const nonce =
    edge.expectedPhase === 'signing' &&
    edge.nextPhase === 'signing' &&
    NONCES.indexOf(edge.nextNoncePhase) === NONCES.indexOf(edge.expectedNoncePhase) + 1
  const signed =
    edge.expectedPhase === 'signing' &&
    edge.nextPhase === 'signed' &&
    edge.expectedNoncePhase === 'consumed' &&
    sameNonce
  if (!(terminating || starting || nonce || signed) || (!terminating && now >= current.expiresAt))
    throw new Error(FAIL)
  // A lost acknowledgement may repeat one exact edge, never a stale earlier nonce stage.
  if (current.phase === edge.nextPhase && current.noncePhase === edge.nextNoncePhase) return current
  if (current.phase !== edge.expectedPhase || current.noncePhase !== edge.expectedNoncePhase)
    throw new Error(FAIL)
  return parseSigningIntent({
    ...current,
    phase: edge.nextPhase,
    noncePhase: edge.nextNoncePhase,
    updatedAt: now
  })
}
