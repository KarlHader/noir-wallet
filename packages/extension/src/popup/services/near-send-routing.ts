import { NOIR_SEND_REFERRAL } from '@/config/intents'
import { parseNearAccountId } from '@/core/chains/near'
import {
  resolveNearAddressRole,
  type NearAddressRole,
  type NearAccountAddressIdentity
} from '@/core/accounts/near-address-role'

/** Protocol asset accepted by public 1Click quotes for NEAR. */
export const NEAR_PRIVATE_SEND_QUOTE_ASSET_ID = 'nep141:wrap.near'
/** Chain asset funded by the single intents-deposit transaction. */
export const NEAR_PRIVATE_SEND_CHAIN_ASSET_ID = 'near:mainnet/nep141:wrap.near'
export const NEAR_PRIVATE_SEND_DEPOSIT_MODE = 'SIMPLE'

const NEAR_MAINNET_CHAIN_ID = 'near:mainnet'
/** Wallet native NEAR is accepted as input and quoted as wNEAR. */
const NATIVE_NEAR_WALLET_ASSET_ID = 'near:mainnet/slip44:397'
const MAX_ACCOUNT_INDEX = 0x7fffffff
const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const PUBLIC_DEPOSIT_ADDRESS = /^[0-9a-f]{64}$/
const UNSIGNED_AMOUNT = /^(?:0|[1-9][0-9]*)$/

export type NearPrivateSendKeySource = 'software' | 'imported' | 'hardware'
export type NearPrivateSendSource = 'main' | 'incognito'

export interface NearPrivateSendAccount extends NearAccountAddressIdentity {
  readonly accountIndex: number
  readonly keySource: NearPrivateSendKeySource
}

export interface NearPrivateSendRouteInput {
  readonly chainId: string
  readonly source: NearPrivateSendSource
  readonly assetId: string
  readonly amountRaw: string
  readonly recipient: string
  readonly slippageTolerance: number
  readonly deadline: string
  readonly account: NearPrivateSendAccount
  readonly quote?: unknown
}

export interface NearPrivateSendQuoteRequest {
  readonly dry: false
  readonly swapType: 'EXACT_INPUT'
  readonly confidentiality: 'basic'
  readonly depositMode: typeof NEAR_PRIVATE_SEND_DEPOSIT_MODE
  readonly originAsset: typeof NEAR_PRIVATE_SEND_QUOTE_ASSET_ID
  readonly destinationAsset: typeof NEAR_PRIVATE_SEND_QUOTE_ASSET_ID
  readonly amount: string
  readonly depositType: 'ORIGIN_CHAIN'
  readonly refundType: 'ORIGIN_CHAIN'
  readonly refundTo: string
  readonly recipient: string
  readonly recipientType: 'DESTINATION_CHAIN'
  readonly slippageTolerance: number
  readonly deadline: string
  readonly referral: typeof NOIR_SEND_REFERRAL
  readonly quoteWaitingTimeMs: 0
}

export type NearPrivateSendSigning =
  | Readonly<{
      kind: 'near-transaction'
      accountIndex: number
      signerId: string
    }>
  | Readonly<{
      kind: 'pea-near-transaction'
      accountIndex: number
      signerId: string
      peaRequestJson: string
    }>

/**
 * Fields for the existing single-transaction intents deposit.
 * SIMPLE quotes have no memo, so this descriptor does not add one.
 */
export interface NearPrivateIntentsDeposit {
  readonly kind: 'intents-deposit'
  readonly chainId: typeof NEAR_MAINNET_CHAIN_ID
  readonly accountIndex: number
  readonly signerId: string
  readonly depositAddress: string
  readonly amountRaw: string
  readonly assetId: typeof NEAR_PRIVATE_SEND_CHAIN_ASSET_ID
  readonly transactionCount: 1
}

interface NearPrivateSendRouteBase {
  readonly ok: true
  readonly confidentiality: 'basic'
  readonly depositMode: typeof NEAR_PRIVATE_SEND_DEPOSIT_MODE
  readonly recipientRole: NearAddressRole
  readonly signing: NearPrivateSendSigning
  readonly quoteRequest: NearPrivateSendQuoteRequest
}

export interface NearPrivateSendQuoteRoute extends NearPrivateSendRouteBase {
  readonly phase: 'quote'
}

export interface NearPrivateSendDepositRoute extends NearPrivateSendRouteBase {
  readonly phase: 'intents-deposit'
  readonly intentsDeposit: NearPrivateIntentsDeposit
}

export type NearPrivateSendRoute = NearPrivateSendQuoteRoute | NearPrivateSendDepositRoute

export type NearPrivateSendFailureCode =
  | 'invalid-request'
  | 'unsupported-asset'
  | 'unsupported-signer'
  | 'invalid-quote'
  | 'unfundable-destination'

export interface NearPrivateSendFailure {
  readonly ok: false
  readonly code: NearPrivateSendFailureCode
  readonly message: string
}

export type NearPrivateSendRouteResult = NearPrivateSendRoute | NearPrivateSendFailure

export interface NearPublicOneClickDeposit {
  readonly ok: true
  readonly depositAddress: string
}

interface DepositExpectation {
  readonly amountRaw: string
  readonly recipient: string
  readonly refundTo: string
}

function failure(code: NearPrivateSendFailureCode, message: string): NearPrivateSendFailure {
  return Object.freeze({ ok: false, code, message })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => hasOwn(value, key))
}

function canonicalNearAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const accountId = parseNearAccountId(value)
    return accountId === value ? accountId : null
  } catch {
    return null
  }
}

function implicitAccountId(value: unknown): string | null {
  const accountId = canonicalNearAccountId(value)
  return accountId !== null && PUBLIC_DEPOSIT_ADDRESS.test(accountId) ? accountId : null
}

function readAccountIndex(value: unknown): number | null {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_ACCOUNT_INDEX
  ) {
    return null
  }
  return value as number
}

function readKeySource(value: unknown): NearPrivateSendKeySource | null {
  if (value === 'software' || value === 'imported' || value === 'hardware') return value
  return null
}

function hasMemo(value: Record<string, unknown>): boolean {
  return hasOwn(value, 'memo') || hasOwn(value, 'depositMemo')
}

/**
 * Global NEAR PEA request. The parent account index is the signing index.
 * An appId or chainId would select a different KDF key.
 */
export function createNearPrivateSendPeaRequest(accountIndex: number): string | null {
  const index = readAccountIndex(accountIndex)
  if (index === null) return null
  const json = JSON.stringify({ version: 2, family: 'near', parent: { accountIndex: index } })
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!isPlainRecord(parsed) || !exactKeys(parsed, ['version', 'family', 'parent'])) return null
  if (parsed.version !== 2 || parsed.family !== 'near' || !isPlainRecord(parsed.parent)) return null
  if (!exactKeys(parsed.parent, ['accountIndex']) || parsed.parent.accountIndex !== index) {
    return null
  }
  return json
}

export function parseNearPrivateSendPeaRequest(value: unknown, accountIndex: number): boolean {
  const expected = createNearPrivateSendPeaRequest(accountIndex)
  return expected !== null && value === expected
}

function quoteAssetFor(assetId: unknown): typeof NEAR_PRIVATE_SEND_QUOTE_ASSET_ID | null {
  if (
    assetId === NEAR_PRIVATE_SEND_QUOTE_ASSET_ID ||
    assetId === NEAR_PRIVATE_SEND_CHAIN_ASSET_ID ||
    assetId === NATIVE_NEAR_WALLET_ASSET_ID
  ) {
    return NEAR_PRIVATE_SEND_QUOTE_ASSET_ID
  }
  return null
}

function readAmount(
  value: unknown
): Readonly<{ ok: true; amountRaw: string }> | NearPrivateSendFailure {
  if (typeof value !== 'string' || !UNSIGNED_AMOUNT.test(value)) {
    return failure('invalid-request', 'The amount is invalid.')
  }
  const amount = BigInt(value)
  if (amount === 0n) return failure('invalid-request', 'Enter an amount greater than zero.')
  if (amount > MAXIMUM_U128) {
    return failure('invalid-request', 'The amount exceeds the NEAR transfer limit.')
  }
  return Object.freeze({ ok: true, amountRaw: value })
}

function readSlippage(value: unknown): number | null {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    return null
  }
  return value as number
}

function readDeadline(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString() === value ? value : null
}

function resolveSigning(
  source: NearPrivateSendSource,
  keySource: NearPrivateSendKeySource,
  accountIndex: number,
  mainAccountId: string,
  peaImplicitAccountId: unknown
): NearPrivateSendSigning | NearPrivateSendFailure {
  if (source === 'main') {
    return Object.freeze({
      kind: 'near-transaction',
      accountIndex,
      signerId: mainAccountId
    })
  }
  if (keySource === 'hardware') {
    return failure(
      'unsupported-signer',
      'This hardware account cannot sign an Incognito NEAR transfer.'
    )
  }
  const pea = implicitAccountId(peaImplicitAccountId)
  if (pea === null || pea === mainAccountId) {
    return failure('unfundable-destination', 'This account has no Incognito NEAR address.')
  }
  const peaRequestJson = createNearPrivateSendPeaRequest(accountIndex)
  if (peaRequestJson === null || !parseNearPrivateSendPeaRequest(peaRequestJson, accountIndex)) {
    return failure('unsupported-signer', 'The Incognito signer does not match its parent account.')
  }
  return Object.freeze({
    kind: 'pea-near-transaction',
    accountIndex,
    signerId: pea,
    peaRequestJson
  })
}

function rejectDepositMode(value: Record<string, unknown>): NearPrivateSendFailure | null {
  if (!hasOwn(value, 'depositMode') || value.depositMode === NEAR_PRIVATE_SEND_DEPOSIT_MODE) {
    return null
  }
  return failure('invalid-quote', 'The quote used an unsupported deposit mode.')
}

function rejectWrongAssets(value: Record<string, unknown>): NearPrivateSendFailure | null {
  for (const key of ['originAsset', 'destinationAsset']) {
    if (!hasOwn(value, key) || value[key] === NEAR_PRIVATE_SEND_QUOTE_ASSET_ID) continue
    return failure('unsupported-asset', 'Private NEAR sends use wNEAR.')
  }
  return null
}

function readQuoteEcho(
  value: unknown,
  expected: DepositExpectation
): NearPrivateSendFailure | null {
  if (!isPlainRecord(value)) {
    return failure('invalid-quote', 'The quote did not include a usable NEAR deposit address.')
  }
  if (hasOwn(value, 'dry') && value.dry !== false) {
    return failure('invalid-quote', 'A preview quote cannot fund this transfer.')
  }
  if (hasMemo(value)) {
    return failure('invalid-quote', 'The quote included a memo and cannot fund this transfer.')
  }
  const mode = rejectDepositMode(value)
  if (mode) return mode
  const assets = rejectWrongAssets(value)
  if (assets) return assets
  if (hasOwn(value, 'confidentiality') && value.confidentiality !== 'basic') {
    return failure('invalid-quote', 'The quote cannot fund this transfer.')
  }
  if (hasOwn(value, 'amount') && value.amount !== expected.amountRaw) {
    return failure('invalid-quote', 'The quote amount does not match this transfer.')
  }
  if (hasOwn(value, 'refundTo') && value.refundTo !== expected.refundTo) {
    return failure('invalid-quote', 'The quote refund account does not match this transfer.')
  }
  if (hasOwn(value, 'recipient') && value.recipient !== expected.recipient) {
    return failure('invalid-quote', 'The quote recipient does not match this transfer.')
  }
  return null
}

/**
 * Accepts a non-dry public 1Click quote whose deposit address is 64 lowercase
 * hex and which has no memo. Confidential quote bodies are rejected.
 */
export function parseNearPublicOneClickDeposit(
  value: unknown,
  expected: DepositExpectation
): NearPublicOneClickDeposit | NearPrivateSendFailure {
  if (!isPlainRecord(value)) {
    return failure('invalid-quote', 'The quote did not include a usable NEAR deposit address.')
  }
  if (hasOwn(value, 'dry') && value.dry !== false) {
    return failure('invalid-quote', 'A preview quote cannot fund this transfer.')
  }
  const quote = hasOwn(value, 'quote') ? value.quote : value
  if (!isPlainRecord(quote)) {
    return failure('invalid-quote', 'The quote did not include a usable NEAR deposit address.')
  }
  if (hasOwn(quote, 'dry') && quote.dry !== false) {
    return failure('invalid-quote', 'A preview quote cannot fund this transfer.')
  }
  if (hasMemo(value) || hasMemo(quote)) {
    return failure('invalid-quote', 'The quote included a memo and cannot fund this transfer.')
  }
  if (hasOwn(value, 'quoteRequest')) {
    const echoed = readQuoteEcho(value.quoteRequest, expected)
    if (echoed) return echoed
  }
  const mode = rejectDepositMode(value) ?? rejectDepositMode(quote)
  if (mode) return mode
  const assets = rejectWrongAssets(value) ?? rejectWrongAssets(quote)
  if (assets) return assets
  if (hasOwn(quote, 'confidentiality')) {
    return failure('invalid-quote', 'The quote cannot fund this transfer.')
  }
  const depositAddress = quote.depositAddress
  if (typeof depositAddress !== 'string' || !PUBLIC_DEPOSIT_ADDRESS.test(depositAddress)) {
    return failure('invalid-quote', 'The quote did not include a usable NEAR deposit address.')
  }
  if (canonicalNearAccountId(depositAddress) !== depositAddress) {
    return failure('invalid-quote', 'The quote did not include a usable NEAR deposit address.')
  }
  if (quote.amountIn !== expected.amountRaw) {
    return failure('invalid-quote', 'The quote amount does not match this transfer.')
  }
  if (depositAddress === expected.recipient || depositAddress === expected.refundTo) {
    return failure('unfundable-destination', 'This quote cannot fund the destination.')
  }
  return Object.freeze({ ok: true, depositAddress })
}

function buildQuoteRequest(input: {
  readonly amountRaw: string
  readonly slippageTolerance: number
  readonly refundTo: string
  readonly recipient: string
  readonly deadline: string
}): NearPrivateSendQuoteRequest {
  return Object.freeze({
    dry: false,
    swapType: 'EXACT_INPUT',
    confidentiality: 'basic',
    depositMode: NEAR_PRIVATE_SEND_DEPOSIT_MODE,
    originAsset: NEAR_PRIVATE_SEND_QUOTE_ASSET_ID,
    destinationAsset: NEAR_PRIVATE_SEND_QUOTE_ASSET_ID,
    amount: input.amountRaw,
    depositType: 'ORIGIN_CHAIN',
    refundType: 'ORIGIN_CHAIN',
    refundTo: input.refundTo,
    recipient: input.recipient,
    recipientType: 'DESTINATION_CHAIN',
    slippageTolerance: input.slippageTolerance,
    deadline: input.deadline,
    referral: NOIR_SEND_REFERRAL,
    quoteWaitingTimeMs: 0
  })
}

function isSigningFailure(
  value: NearPrivateSendSigning | NearPrivateSendFailure
): value is NearPrivateSendFailure {
  return 'ok' in value && value.ok === false
}

/**
 * Describes a private NEAR send. Public sends stay on the existing transfer path.
 * A funded route is one intents-deposit transaction. The quote uses wNEAR,
 * confidentiality basic, and SIMPLE deposit mode, and it does not attach a memo.
 */
export function describeNearPrivateSendRoute(
  input: NearPrivateSendRouteInput
): NearPrivateSendRouteResult {
  if (!isPlainRecord(input) || !isPlainRecord(input.account)) {
    return failure('invalid-request', 'The private transfer could not be prepared.')
  }
  if (input.chainId !== NEAR_MAINNET_CHAIN_ID) {
    return failure('invalid-request', 'Private NEAR sends are available on NEAR mainnet.')
  }
  if (input.source !== 'main' && input.source !== 'incognito') {
    return failure('invalid-request', 'The private transfer could not be prepared.')
  }
  const accountIndex = readAccountIndex(input.account.accountIndex)
  if (accountIndex === null) {
    return failure('invalid-request', 'The NEAR account index is invalid.')
  }
  const keySource = readKeySource(input.account.keySource)
  if (keySource === null) {
    return failure('unsupported-signer', 'This account cannot sign a private NEAR transfer.')
  }
  if (keySource === 'imported' && accountIndex !== 0) {
    return failure('unsupported-signer', 'Imported NEAR keys can only sign from account index 0.')
  }
  const mainAccountId = canonicalNearAccountId(input.account.mainAccountId)
  if (mainAccountId === null) {
    return failure('invalid-request', 'The NEAR account ID is unavailable.')
  }
  const signing = resolveSigning(
    input.source,
    keySource,
    accountIndex,
    mainAccountId,
    input.account.peaImplicitAccountId
  )
  if (isSigningFailure(signing)) return signing
  const recipient = canonicalNearAccountId(input.recipient)
  if (recipient === null) {
    return failure('invalid-request', 'Enter a NEAR account ID.')
  }
  if (quoteAssetFor(input.assetId) !== NEAR_PRIVATE_SEND_QUOTE_ASSET_ID) {
    return failure('unsupported-asset', 'Private NEAR sends use wNEAR.')
  }
  const amount = readAmount(input.amountRaw)
  if (!amount.ok) return amount
  const slippageTolerance = readSlippage(input.slippageTolerance)
  if (slippageTolerance === null) {
    return failure('invalid-request', 'The slippage setting is invalid.')
  }
  const deadline = readDeadline(input.deadline)
  if (deadline === null) return failure('invalid-request', 'The quote deadline is invalid.')
  const quoteRequest = buildQuoteRequest({
    amountRaw: amount.amountRaw,
    slippageTolerance,
    refundTo: signing.signerId,
    recipient,
    deadline
  })
  const recipientRole = resolveNearAddressRole(recipient, {
    mainAccountId,
    peaImplicitAccountId: input.account.peaImplicitAccountId
  })
  const described = Object.freeze({
    confidentiality: 'basic' as const,
    depositMode: NEAR_PRIVATE_SEND_DEPOSIT_MODE,
    recipientRole,
    signing,
    quoteRequest
  })
  if (input.quote === undefined) {
    return Object.freeze({ ok: true, phase: 'quote', ...described })
  }
  const deposit = parseNearPublicOneClickDeposit(input.quote, {
    amountRaw: amount.amountRaw,
    recipient,
    refundTo: signing.signerId
  })
  if (!deposit.ok) return deposit
  return Object.freeze({
    ok: true,
    phase: 'intents-deposit',
    ...described,
    intentsDeposit: Object.freeze({
      kind: 'intents-deposit' as const,
      chainId: NEAR_MAINNET_CHAIN_ID,
      accountIndex,
      signerId: signing.signerId,
      depositAddress: deposit.depositAddress,
      amountRaw: amount.amountRaw,
      assetId: NEAR_PRIVATE_SEND_CHAIN_ASSET_ID,
      transactionCount: 1 as const
    })
  })
}
