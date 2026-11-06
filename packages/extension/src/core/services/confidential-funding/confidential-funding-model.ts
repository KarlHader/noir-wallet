import type { Network } from '@/types'
import { confidentialPrivateTokenId } from './confidential-funding-portfolio'

export const CONFIDENTIAL_WITHDRAW_MIN_COUNT = 2
export const CONFIDENTIAL_WITHDRAW_MAX_COUNT = 5
export const CONFIDENTIAL_WITHDRAW_DEFAULT_COUNT = 3

export type ConfidentialFundingPhase =
  | 'prepared'
  | 'authorized'
  | 'deposit-signed'
  | 'deposit-confirming'
  | 'signing-withdraws'
  | 'submitting'
  | 'processing'
  | 'partial'
  | 'ready'
  | 'refunded'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'needs-auth'

export type ConfidentialSignedPayload = Readonly<{
  standard: 'erc191'
  payload: string
  signature: string
}>

export interface ConfidentialQuote {
  readonly correlationId: string
  readonly quoteRequest: Readonly<Record<string, unknown>>
  readonly quote: Readonly<{
    amountIn: string
    amountOut: string
    minAmountOut: string
    depositAddress: string
    depositMemo?: string
    deadline: string
    withdrawFee?: string
    refundFee?: string
    timeEstimate?: number
  }>
}

export interface ConfidentialQuoteBinding {
  readonly originAsset: string
  readonly destinationAsset: string
  readonly amountRaw: string
  readonly signerId: string
  readonly refundTo?: string
  readonly recipient: string
  readonly depositType: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
  readonly refundType: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
  readonly recipientType: 'CONFIDENTIAL_INTENTS' | 'DESTINATION_CHAIN'
  readonly slippageBps: number
}

export interface ConfidentialWithdrawRow {
  readonly sequence: number
  readonly sourceAmountRaw: string
  readonly amountRaw: string
  readonly depositAddress: string
  readonly destinationAddress: string
  readonly destinationChain: string
  readonly token: string
  readonly deadline: number
  readonly status: string
  readonly intentHash?: string
  readonly errorStatus?: string
  readonly transactionHash?: string
  readonly scheduledAt?: number
  readonly signedPayload?: ConfidentialSignedPayload
}

export interface ConfidentialWithdrawRequest {
  readonly from_amount: string
  readonly from_chain: string
  readonly from_token: string
  readonly mode: 'TRANSFER' | 'SWAP'
  readonly signer_id: string
  readonly withdraws: readonly Readonly<{
    amount: string
    deposit_address: string
    destination_address: string
    destination_chain: string
    execution_type: 'CONFIDENTIAL_1CLICK'
    sequence: number
    signed_payload: ConfidentialSignedPayload
    token: string
  }>[]
}

export function normalizeConfidentialWithdrawRequest(
  request: ConfidentialWithdrawRequest
): ConfidentialWithdrawRequest {
  // Restore the approved wire order after storage reorders object fields.
  return Object.freeze({
    from_amount: request.from_amount,
    from_chain: request.from_chain,
    from_token: request.from_token,
    mode: request.mode,
    signer_id: request.signer_id,
    withdraws: Object.freeze(
      request.withdraws.map(row =>
        Object.freeze({
          amount: row.amount,
          deposit_address: row.deposit_address,
          destination_address: row.destination_address,
          destination_chain: row.destination_chain,
          execution_type: row.execution_type,
          sequence: row.sequence,
          signed_payload: Object.freeze({
            standard: row.signed_payload.standard,
            payload: row.signed_payload.payload,
            signature: row.signed_payload.signature
          }),
          token: row.token
        })
      )
    )
  })
}

export interface ConfidentialFundingPlan {
  readonly schemaVersion: 1
  readonly operation?: 'deposit' | 'withdraw' | 'cluster' | 'swap'
  readonly sourceDomain?: 'public' | 'private' | 'shield'
  readonly destinationDomain?: 'public' | 'private' | 'shield'
  readonly planId: string
  readonly network: Network
  readonly keyDomainId: string
  readonly accountId: string
  readonly transactionId: string
  readonly phase: ConfidentialFundingPhase
  readonly resumePhase?: Exclude<ConfidentialFundingPhase, 'needs-auth'>
  readonly source: Readonly<{
    chainId: string
    chainName: string
    assetId: string
    protocolAssetId: string
    amountRaw: string
    address: string
  }>
  readonly destination: Readonly<{
    chainId: string
    chainName: string
    assetId: string
    protocolAssetId: string
    address: string
  }>
  readonly signerId: string
  readonly externalRecipient?: string
  readonly addressIndex: number
  readonly slippageBps: number
  readonly requiresDeposit: boolean
  readonly confidentialBaselineRaw: string
  readonly depositQuote?: ConfidentialQuote
  readonly swapQuote?: ConfidentialQuote
  readonly reviewedAppFeesFingerprint?: string
  readonly preparedDeposit?: Readonly<{
    commandId: string
    payloadFingerprint: string
    expiresAt: number
    preparedTransfer: unknown
    rawTransaction?: string
    transactionHash?: string
  }>
  readonly approvalFingerprint: string
  readonly approvalExpiresAt: number
  readonly expectedOutputRaw: string
  readonly minimumOutputRaw: string
  readonly splitSourceAmounts: readonly string[]
  readonly withdraws: readonly ConfidentialWithdrawRow[]
  readonly frozenRequest?: ConfidentialWithdrawRequest
  readonly requestFingerprint?: string
  readonly orderId?: string
  readonly batchSubmissionAttemptedAt?: number
  readonly backendStatus?: string
  readonly errorStatus?: string
  readonly dedupKey?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export function needsConfidentialSubmissionCheck(
  plan: Pick<ConfidentialFundingPlan, 'operation' | 'phase' | 'errorStatus'>
): boolean {
  return (
    plan.operation === 'withdraw' &&
    plan.phase === 'submitting' &&
    /^SERVICE_4\d\d$/.test(plan.errorStatus ?? '')
  )
}

export function canRetryConfidentialSubmission(
  plan: Pick<ConfidentialFundingPlan, 'operation' | 'phase' | 'errorStatus' | 'withdraws'>,
  now = Date.now()
): boolean {
  return (
    needsConfidentialSubmissionCheck(plan) &&
    plan.withdraws.some(row => row.status.trim().toUpperCase() === 'SIGNED' && row.deadline > now)
  )
}

export interface ConfidentialFundingReview {
  readonly planId: string
  readonly operation?: 'deposit' | 'withdraw' | 'cluster' | 'swap'
  readonly sourceDomain?: 'public' | 'private' | 'shield'
  readonly destinationDomain?: 'public' | 'private' | 'shield'
  readonly network?: Network
  readonly keyDomainId?: string
  readonly accountId?: string
  readonly transactionId: string
  readonly phase: ConfidentialFundingPhase
  readonly payloadFingerprint: string
  readonly expiresAt: number
  readonly requiresDeposit: boolean
  readonly depositAddress?: string
  readonly sourceAmountRaw: string
  readonly expectedOutputRaw: string
  readonly minimumOutputRaw: string
  readonly sourceAddress: string
  readonly destinationAddress: string
  readonly externalRecipient?: string
  readonly withdrawCount: number
  readonly quoteWithdrawFeeRaw?: string
  readonly quoteRefundFeeRaw?: string
  readonly quoteTimeEstimateSeconds?: number
  readonly quoteAppFeeBps?: number
  readonly slippageBps?: number
  readonly sourceNetworkFee?: Readonly<{
    raw: string
    symbol: string
    decimals: number
  }>
}

export interface ConfidentialFundingProgress {
  readonly stage: 'preparing' | 'adding' | 'processing' | 'ready' | 'failed'
  readonly completed: number
  readonly total: number
  readonly message: string
}

export type ConfidentialChildSettlement =
  | 'pending'
  | 'success'
  | 'refunded'
  | 'failed'
  | 'expired'
  | 'cancelled'

export type ConfidentialBatchSettlement =
  | 'confirming'
  | 'success'
  | 'partial'
  | 'refunded'
  | 'failed'
  | 'expired'
  | 'cancelled'

function requirePositiveRaw(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${field} must be a positive raw amount`)
  return BigInt(value)
}

function randomFraction(index: number, values?: readonly number[]): number {
  if (values?.length) {
    const value = values[index % values.length]
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5
  }
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  return random[0] / 0xffffffff
}

function between(low: bigint, high: bigint, fraction: number): bigint {
  if (high <= low) return low
  const precision = 1_000_000n
  const scaled = BigInt(Math.floor(fraction * Number(precision)))
  return low + ((high - low) * scaled) / precision
}

export function splitConfidentialFundingAmount(
  totalRaw: string,
  count: number,
  randomValues?: readonly number[]
): readonly string[] {
  if (
    !Number.isInteger(count) ||
    count < CONFIDENTIAL_WITHDRAW_MIN_COUNT ||
    count > CONFIDENTIAL_WITHDRAW_MAX_COUNT
  ) {
    throw new Error('A confidential batch requires two to five withdraws')
  }
  const total = requirePositiveRaw(totalRaw, 'Confidential amount')
  if (total < BigInt(count)) throw new Error('Confidential amount is too small to split')

  const denominator = 100n * BigInt(count)
  const minimum = (total * 80n) / denominator || 1n
  const maximum = (total * 120n) / denominator
  const shares: bigint[] = []
  let remaining = total
  for (let index = 0; index < count - 1; index += 1) {
    const remainingCount = BigInt(count - index - 1)
    const low = [minimum, remaining - maximum * remainingCount].reduce((a, b) => (a > b ? a : b))
    const high = [maximum, remaining - minimum * remainingCount].reduce((a, b) => (a < b ? a : b))
    if (low > high) throw new Error('Confidential amount cannot be split safely')
    const share = between(low, high, randomFraction(index, randomValues))
    shares.push(share)
    remaining -= share
  }
  if (remaining < minimum || remaining > maximum) {
    throw new Error('Confidential amount cannot be split safely')
  }
  shares.push(remaining)
  return Object.freeze(shares.map(String))
}

function normalizeChildStatus(value: unknown): ConfidentialChildSettlement {
  const status = String(value ?? '')
    .trim()
    .toUpperCase()
  if (status === 'SUCCESS' || status === 'COMPLETED') return 'success'
  if (status === 'REFUNDED') return 'refunded'
  if (status === 'FAILED') return 'failed'
  if (status === 'EXPIRED') return 'expired'
  if (status === 'CANCELLED') return 'cancelled'
  return 'pending'
}

export function mergeConfidentialWithdrawObservation(
  row: ConfidentialWithdrawRow,
  observation: Readonly<{
    status: string
    transactionHash?: string
    errorStatus?: string
  }> | null
): ConfidentialWithdrawRow {
  if (!observation) return row
  const current = normalizeChildStatus(row.status)
  if (current !== 'pending') {
    // A stale poll must not change a settled child while its siblings are pending.
    if (normalizeChildStatus(observation.status) !== current) return row
    return Object.freeze({
      ...row,
      ...(!row.transactionHash && observation.transactionHash
        ? { transactionHash: observation.transactionHash }
        : {}),
      ...(!row.errorStatus && observation.errorStatus
        ? { errorStatus: observation.errorStatus }
        : {})
    })
  }
  return Object.freeze({
    ...row,
    status: observation.status,
    ...(observation.transactionHash ? { transactionHash: observation.transactionHash } : {}),
    ...(observation.errorStatus ? { errorStatus: observation.errorStatus } : {})
  })
}

export function aggregateConfidentialSettlement(
  statuses: readonly unknown[]
): ConfidentialBatchSettlement {
  if (statuses.length === 0) {
    throw new Error('A confidential settlement requires a child status')
  }
  const normalized = statuses.map(normalizeChildStatus)
  const successes = normalized.filter(status => status === 'success').length
  if (successes === normalized.length) return 'success'
  const terminal = normalized.every(status => status !== 'pending')
  if (successes > 0 && terminal) return 'partial'
  if (!terminal) return 'confirming'
  if (normalized.every(status => status === 'refunded')) return 'refunded'
  if (normalized.some(status => status === 'failed')) return 'failed'
  if (normalized.some(status => status === 'expired')) return 'expired'
  return 'cancelled'
}

export function getConfidentialFundingProgress(
  plan: Pick<ConfidentialFundingPlan, 'phase' | 'withdraws'>
): ConfidentialFundingProgress {
  const total = plan.withdraws.length
  const completed = plan.withdraws.filter(row => {
    const status = normalizeChildStatus(row.status)
    return status !== 'pending'
  }).length
  if (plan.phase === 'needs-auth') {
    return Object.freeze({
      stage: 'preparing',
      completed,
      total,
      message: 'Authorization required'
    })
  }
  if (plan.phase === 'ready') {
    return Object.freeze({ stage: 'ready', completed: total, total, message: 'Ready' })
  }
  if (['partial', 'refunded', 'failed', 'expired', 'cancelled'].includes(plan.phase)) {
    return Object.freeze({
      stage: 'failed',
      completed,
      total,
      message: plan.phase === 'partial' ? 'Partially completed' : 'Confidential funding failed'
    })
  }
  if (plan.phase === 'processing') {
    return Object.freeze({
      stage: 'processing',
      completed,
      total,
      message: `Processing ${completed} of ${total}`
    })
  }
  if (
    plan.phase === 'deposit-signed' ||
    plan.phase === 'deposit-confirming' ||
    plan.phase === 'signing-withdraws' ||
    plan.phase === 'submitting'
  ) {
    return Object.freeze({ stage: 'adding', completed, total, message: 'Adding privately' })
  }
  return Object.freeze({ stage: 'preparing', completed, total, message: 'Preparing' })
}

function collectScalarStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string' || typeof value === 'number') {
    output.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectScalarStrings(item, output))
    return
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectScalarStrings(item, output))
  }
}

function equalAddress(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase()
}

export function assertConfidentialQuoteBinding(
  quote: ConfidentialQuote,
  expected: ConfidentialQuoteBinding,
  now = Date.now()
): void {
  const request = quote.quoteRequest
  const deadline = Date.parse(quote.quote.deadline)
  if (
    request.swapType !== 'EXACT_INPUT' ||
    request.confidentiality !== 'basic' ||
    request.originAsset !== expected.originAsset ||
    request.destinationAsset !== expected.destinationAsset ||
    request.amount !== expected.amountRaw ||
    quote.quote.amountIn !== expected.amountRaw ||
    !equalAddress(request.refundTo, expected.refundTo ?? expected.signerId) ||
    request.depositType !== expected.depositType ||
    request.refundType !== expected.refundType ||
    !equalAddress(request.recipient, expected.recipient) ||
    request.recipientType !== expected.recipientType ||
    Number(request.slippageTolerance) !== expected.slippageBps ||
    !Number.isSafeInteger(deadline) ||
    deadline <= now
  ) {
    throw new Error('Confidential quote does not match the requested funding route')
  }
}

export function assertConfidentialIntentBinding(input: {
  readonly intent: unknown
  readonly quote: ConfidentialQuote
  readonly signerId: string
  readonly sourceAsset: string
  readonly sourceAmountRaw: string
  readonly destinationAsset: string
  readonly destinationAddress: string
  readonly now?: number
}): Readonly<{ standard: 'erc191'; payload: string; deadline: number }> {
  if (!input.intent || typeof input.intent !== 'object' || Array.isArray(input.intent)) {
    throw new Error('Confidential intent is invalid')
  }
  const record = input.intent as Record<string, unknown>
  if (record.standard !== 'erc191' || typeof record.payload !== 'string') {
    throw new Error('Confidential intent must use ERC-191')
  }
  let payload: unknown
  try {
    payload = JSON.parse(record.payload)
  } catch {
    throw new Error('Confidential intent payload is invalid')
  }
  const scalars: string[] = []
  collectScalarStrings(payload, scalars)
  const lower = new Set(scalars.map(value => value.toLowerCase()))
  const required = [input.signerId, input.quote.quote.depositAddress]
  for (const value of required) {
    if (!lower.has(value.toLowerCase())) {
      throw new Error('Confidential intent does not match the approved signer or quote')
    }
  }
  const requestScalars: string[] = []
  collectScalarStrings(input.quote.quoteRequest, requestScalars)
  const quoteValues = new Set(requestScalars.map(value => value.toLowerCase()))
  for (const value of [
    input.sourceAsset,
    input.sourceAmountRaw,
    input.destinationAsset,
    input.destinationAddress
  ]) {
    if (!quoteValues.has(value.toLowerCase())) {
      throw new Error('Confidential quote does not match the approved funding plan')
    }
  }
  const payloadRecord = payload as Record<string, unknown>
  const deadline = Date.parse(String(payloadRecord.deadline ?? ''))
  const quoteDeadline = Date.parse(input.quote.quote.deadline)
  if (
    !Number.isSafeInteger(deadline) ||
    !Number.isSafeInteger(quoteDeadline) ||
    deadline !== quoteDeadline ||
    deadline <= (input.now ?? Date.now())
  ) {
    throw new Error('Confidential intent deadline is invalid or expired')
  }
  return Object.freeze({ standard: 'erc191' as const, payload: record.payload, deadline })
}

export function assertDirectConfidentialWithdrawIntentBinding(input: {
  readonly intent: unknown
  readonly quote: ConfidentialQuote
  readonly signerId: string
  readonly sourceAsset: string
  readonly sourceAmountRaw: string
  readonly destinationAsset: string
  readonly destinationAddress: string
  readonly now?: number
}): Readonly<{ standard: 'erc191'; payload: string; deadline: number }> {
  if (!input.intent || typeof input.intent !== 'object' || Array.isArray(input.intent)) {
    throw new Error('Shield withdraw intent is invalid')
  }
  const generated = input.intent as Record<string, unknown>
  if (generated.standard !== 'erc191' || typeof generated.payload !== 'string') {
    throw new Error('Shield withdraw intent signing standard is invalid')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(generated.payload)
  } catch {
    throw new Error('Shield withdraw intent payload is invalid')
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Shield withdraw intent payload is invalid')
  }
  const payload = decoded as Record<string, unknown>
  const keys = Object.keys(payload).sort()
  if (
    keys.join(',') !== 'deadline,intents,nonce,signer_id,verifying_contract' ||
    payload.verifying_contract !== 'intents.far' ||
    !equalAddress(payload.signer_id, input.signerId) ||
    payload.deadline !== input.quote.quote.deadline ||
    typeof payload.nonce !== 'string' ||
    !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=?$/.test(payload.nonce) ||
    !Array.isArray(payload.intents) ||
    payload.intents.length !== 1
  ) {
    throw new Error('Shield withdraw intent does not match the approved quote')
  }
  let nonce: Uint8Array
  try {
    nonce = Uint8Array.from(atob(payload.nonce), value => value.charCodeAt(0))
  } catch {
    throw new Error('Shield withdraw intent nonce is invalid')
  }
  if (nonce.length !== 32) throw new Error('Shield withdraw intent nonce is invalid')
  const action = payload.intents[0]
  if (
    !action ||
    typeof action !== 'object' ||
    Array.isArray(action) ||
    Object.keys(action).sort().join(',') !== 'intent,receiver_id,tokens'
  ) {
    throw new Error('Shield withdraw intent action is invalid')
  }
  const transfer = action as Record<string, unknown>
  const tokens = transfer.tokens
  const tokenId = confidentialPrivateTokenId(input.sourceAsset)
  if (
    transfer.intent !== 'transfer' ||
    !equalAddress(transfer.receiver_id, input.quote.quote.depositAddress) ||
    !tokens ||
    typeof tokens !== 'object' ||
    Array.isArray(tokens) ||
    Object.keys(tokens).length !== 1 ||
    (tokens as Record<string, unknown>)[tokenId] !== input.sourceAmountRaw ||
    input.quote.quote.amountIn !== input.sourceAmountRaw ||
    input.quote.quoteRequest.originAsset !== input.sourceAsset ||
    input.quote.quoteRequest.destinationAsset !== input.destinationAsset ||
    !equalAddress(input.quote.quoteRequest.recipient, input.destinationAddress)
  ) {
    throw new Error('Shield withdraw intent transfer does not match the approved quote')
  }
  const deadline = Date.parse(input.quote.quote.deadline)
  if (!Number.isSafeInteger(deadline) || deadline <= (input.now ?? Date.now())) {
    throw new Error('Shield withdraw intent deadline is invalid or expired')
  }
  return Object.freeze({ standard: 'erc191' as const, payload: generated.payload, deadline })
}

export async function fingerprintConfidentialValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

function canonicalConfidentialValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConfidentialValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalConfidentialValue(child)])
    )
  }
  return value
}

export function fingerprintDirectConfidentialApproval(value: unknown): Promise<string> {
  return fingerprintConfidentialValue(canonicalConfidentialValue(value))
}
