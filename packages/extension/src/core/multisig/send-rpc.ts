import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import { parseKeyDomainId } from '@/core/keyring/domain/key-domain'
import { parseAccountId } from '@/core/accounts/domain/account'
import { isValidMarginalFeeZats } from '@/config/fee'
import { isDkgSessionIdText } from './dkg-protocol'
import { isVaultGroupId } from './vault-record'
import { parseEnvelope, type MultisigEnvelope } from './messages'
import type { SigningIntentPhase, SigningNoncePhase } from './signing-journal'
import type { SigningReviewBinding, SigningStatus } from './signing-coordinator'
import type { RosterManifest } from './roster'
import type { MultisigTransactionPhase } from './transaction-journal'

export interface VaultSendPrepareRequest {
  scope: MultisigGroupScope
  groupId: string
  rosterVersion: 1
  to: string
  amountZats: string
  memo?: string
  marginalFeeZats: number
  feeQuoteId: string
  selectedSlots: number[]
  transport: 'qr' | 'ble'
}
export interface VaultSendAuthority {
  walletId: string
  reviewId: string
  sessionId: string
}
export interface VaultSendReview {
  available: true
  binding: SigningReviewBinding
  summary: { recipient: string; amount: string; memo: string; fee: string }
}
export type VaultSendPrepareResponse =
  | VaultSendReview
  | {
      available: false
      reason: 'pczt_review_unavailable' | 'fee_quote_unavailable'
    }
export interface VaultSendProgress {
  binding: SigningReviewBinding
  phase: SigningIntentPhase
  noncePhase: SigningNoncePhase
  status: SigningStatus | null
  outbound: MultisigEnvelope[]
}
export interface VaultSendTransaction {
  binding: SigningReviewBinding
  phase: MultisigTransactionPhase
  txId: string
  outbound: MultisigEnvelope[]
  summary?: { recipient: string; amount: string; memo: string; fee: string }
}
export interface VaultSendSchema {
  'vault.send.prepare': { request: VaultSendPrepareRequest; response: VaultSendPrepareResponse }
  'vault.send.start': { request: VaultSendAuthority; response: VaultSendProgress }
  'vault.send.ingest': {
    request: VaultSendAuthority & { envelope: MultisigEnvelope }
    response: VaultSendProgress
  }
  'vault.send.status': { request: VaultSendAuthority; response: VaultSendProgress }
  'vault.send.roster': { request: VaultSendAuthority; response: RosterManifest }
  'vault.send.cancel': { request: VaultSendAuthority; response: true }
  'vault.send.close': { request: VaultSendAuthority; response: true }
  'vault.send.finalize': { request: VaultSendAuthority; response: VaultSendTransaction }
  'vault.send.submit': { request: VaultSendAuthority; response: VaultSendTransaction }
  'vault.send.execute': { request: VaultSendAuthority; response: VaultSendTransaction }
  'vault.send.transactions': {
    request: { scope: MultisigGroupScope }
    response: VaultSendTransaction[]
  }
  'vault.send.recovery': {
    request: { scope: MultisigGroupScope }
    response: { signedWithoutTransaction: boolean }
  }
}
export type VaultSendMethod = keyof VaultSendSchema
export function isVaultSendMethod(method: string): method is VaultSendMethod {
  return [
    'vault.send.prepare',
    'vault.send.start',
    'vault.send.ingest',
    'vault.send.status',
    'vault.send.roster',
    'vault.send.cancel',
    'vault.send.close',
    'vault.send.finalize',
    'vault.send.submit',
    'vault.send.execute',
    'vault.send.transactions',
    'vault.send.recovery'
  ].includes(method)
}
const FAIL = 'Invalid multisig send request'
function exact(
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(FAIL)
  const record = value as Record<string, unknown>
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))
  )
    throw new Error(FAIL)
  return record
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value)
}
export function parseVaultSendPrepare(value: unknown): VaultSendPrepareRequest {
  const input = exact(
    value,
    [
      'scope',
      'groupId',
      'rosterVersion',
      'to',
      'amountZats',
      'marginalFeeZats',
      'feeQuoteId',
      'selectedSlots',
      'transport'
    ],
    ['memo']
  )
  if (
    !isVaultGroupId(input.groupId) ||
    input.rosterVersion !== 1 ||
    typeof input.to !== 'string' ||
    input.to.length < 1 ||
    input.to.length > 2048 ||
    input.to.trim() !== input.to ||
    typeof input.amountZats !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(input.amountZats) ||
    BigInt(input.amountZats) > 2_100_000_000_000_000n ||
    (input.memo !== undefined &&
      (typeof input.memo !== 'string' || new TextEncoder().encode(input.memo).length > 512)) ||
    !isValidMarginalFeeZats(input.marginalFeeZats) ||
    !id(input.feeQuoteId) ||
    !Array.isArray(input.selectedSlots) ||
    input.selectedSlots.length < 2 ||
    input.selectedSlots.length > 3 ||
    input.selectedSlots[0] !== 0 ||
    input.selectedSlots.some(
      (slot, index, slots) =>
        !Number.isInteger(slot) || slot < 0 || slot > 2 || (index > 0 && slot <= slots[index - 1])
    ) ||
    (input.transport !== 'qr' && input.transport !== 'ble')
  )
    throw new Error(FAIL)
  const scope = exact(input.scope, ['network', 'walletId', 'accountId'])
  if (scope.network !== 'mainnet' && scope.network !== 'testnet') throw new Error(FAIL)
  return {
    scope: {
      network: scope.network,
      walletId: parseKeyDomainId(scope.walletId),
      accountId: parseAccountId(scope.accountId)
    },
    groupId: input.groupId,
    rosterVersion: 1,
    to: input.to,
    amountZats: input.amountZats,
    ...(input.memo === undefined ? {} : { memo: input.memo as string }),
    marginalFeeZats: input.marginalFeeZats,
    feeQuoteId: input.feeQuoteId,
    selectedSlots: [...input.selectedSlots] as number[],
    transport: input.transport
  }
}
export function parseVaultSendAuthority(
  value: unknown,
  ingest = false
): VaultSendAuthority & { envelope?: MultisigEnvelope } {
  const input = exact(value, ['walletId', 'reviewId', 'sessionId', ...(ingest ? ['envelope'] : [])])
  const walletId = parseKeyDomainId(input.walletId)
  if (!id(input.reviewId) || !isDkgSessionIdText(input.sessionId)) throw new Error(FAIL)
  const envelope = ingest ? parseEnvelope(input.envelope) : undefined
  if (ingest && !envelope) throw new Error(FAIL)
  return {
    walletId,
    reviewId: input.reviewId,
    sessionId: input.sessionId,
    ...(envelope ? { envelope } : {})
  }
}
