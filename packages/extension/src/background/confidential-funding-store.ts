import type { Network } from '@/types'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { parseNearAccountId } from '@/core/chains/near/identifiers'
import { getZcashChainId } from '@/core/chains/registry'
import { externalRecipientsMatch, isValidExternalRecipient } from './confidential-funding-recipient'
import { withMetadataLock, withUndeletedWalletAccountMetadata } from '@/lib/wallet-metadata-storage'
import {
  CONFIDENTIAL_FUNDING_PURPOSES,
  type ConfidentialFundingPlan
} from '@/core/services/confidential-funding'
import type { ExternalShieldDeposit } from '@/core/services/confidential-funding'
import { getConfidentialFundingPlanId } from '@/core/services/confidential-funding/confidential-funding-graph'
import type {
  ConfidentialBalance,
  ConfidentialOrderAuthToken,
  ConfidentialSession
} from './confidential-funding-api'

export function isConfidentialEvmSigner(signerId: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(signerId)
}

function canonicalConfidentialSigner(signerId: string): string {
  return isConfidentialEvmSigner(signerId) ? signerId.toLowerCase() : signerId
}

function sameConfidentialSigner(left: string, right: string): boolean {
  return canonicalConfidentialSigner(left) === canonicalConfidentialSigner(right)
}

const PLAN_PREFIX = 'confidential_funding_plan:'
const EXTERNAL_DEPOSIT_PREFIX = 'confidential_external_deposit:'
const SESSION_PREFIX = 'confidential_funding_session:'
const HISTORY_SESSION_PREFIX = 'confidential_order_history_session:'
const BALANCE_PREFIX = 'confidential_funding_balance:'
const SHIELD_GRANT_PREFIX = 'confidential_shield_site_grant:'
export const CONFIDENTIAL_BALANCE_CACHE_TTL_MS = 5 * 60 * 1000

export interface ShieldSiteGrant {
  readonly origin: string
  readonly network: Network
  readonly keyDomainId: string
  readonly accountId: string
}

export interface ConfidentialBalanceSnapshot {
  readonly balances: readonly ConfidentialBalance[]
  readonly updatedAt: number
  readonly fresh: boolean
  readonly known: boolean
}
const PHASES = new Set<ConfidentialFundingPlan['phase']>([
  'prepared',
  'authorized',
  'deposit-signed',
  'deposit-confirming',
  'signing-withdraws',
  'submitting',
  'processing',
  'partial',
  'ready',
  'refunded',
  'failed',
  'expired',
  'cancelled',
  'needs-auth'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isShieldOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}

function parseShieldSiteGrant(value: unknown): ShieldSiteGrant {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isShieldOrigin(value.origin) ||
    (value.network !== 'mainnet' && value.network !== 'testnet') ||
    !isBoundedString(value.keyDomainId) ||
    !isBoundedString(value.accountId)
  ) {
    throw new Error('Stored Shield site grant is invalid')
  }
  return Object.freeze({
    origin: value.origin,
    network: value.network,
    keyDomainId: value.keyDomainId,
    accountId: value.accountId
  })
}

function isBoundedString(value: unknown, maximum = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
}

function isRawAmount(value: unknown, positive = false): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,77})$/.test(value) &&
    (!positive || BigInt(value) > 0n)
  )
}

function isDepositMemo(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
}

function samePayloadValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  return typeof left === 'object' && left !== null && JSON.stringify(left) === JSON.stringify(right)
}

function isSignedPayload(value: unknown): boolean {
  if (!isRecord(value) || !isBoundedString(value.signature, 512)) return false
  if (value.standard === 'erc191') return isBoundedString(value.payload, 16_384)
  if (value.standard !== 'nep413' || !isRecord(value.payload)) return false
  return (
    isBoundedString(value.payload.message, 16_384) &&
    isBoundedString(value.payload.recipient, 64) &&
    isBoundedString(value.payload.nonce, 128) &&
    isBoundedString(value.public_key, 128) &&
    value.public_key.startsWith('ed25519:')
  )
}

function sameQuotedAddress(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return /^0x[0-9a-fA-F]{40}$/.test(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function sameSignedPayload(left: unknown, right: unknown): boolean {
  return (
    isRecord(left) &&
    isRecord(right) &&
    left.standard === right.standard &&
    samePayloadValue(left.payload, right.payload) &&
    left.public_key === right.public_key &&
    left.signature === right.signature
  )
}

function isStoredConfidentialSigner(value: string): boolean {
  if (/^0x[0-9a-f]{40}$/.test(value)) return true
  try {
    return parseNearAccountId(value) === value
  } catch {
    return false
  }
}

function isStoredFundingAddress(address: string, chainId: string): boolean {
  if (chainId.startsWith('near:')) {
    try {
      return parseNearAccountId(address) === address
    } catch {
      return false
    }
  }
  return /^0x[0-9a-f]{40}$/.test(address)
}

function isStoredConfidentialDestination(address: string, chainId: string): boolean {
  if (chainId.startsWith('near:')) {
    try {
      return parseNearAccountId(address) === address
    } catch {
      return false
    }
  }
  return /^0x[0-9a-fA-F]{40}$/.test(address)
}

function parsePlan(value: unknown): ConfidentialFundingPlan {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.planId !== 'string' ||
    (value.network !== 'mainnet' && value.network !== 'testnet') ||
    typeof value.keyDomainId !== 'string' ||
    typeof value.accountId !== 'string' ||
    typeof value.transactionId !== 'string' ||
    typeof value.phase !== 'string' ||
    !PHASES.has(value.phase as ConfidentialFundingPlan['phase']) ||
    !isRecord(value.source) ||
    !isRecord(value.destination) ||
    typeof value.signerId !== 'string' ||
    !Number.isSafeInteger(value.addressIndex) ||
    !Number.isSafeInteger(value.slippageBps) ||
    typeof value.requiresDeposit !== 'boolean' ||
    typeof value.confidentialBaselineRaw !== 'string' ||
    typeof value.expectedOutputRaw !== 'string' ||
    typeof value.minimumOutputRaw !== 'string' ||
    typeof value.approvalFingerprint !== 'string' ||
    !Number.isSafeInteger(value.approvalExpiresAt) ||
    !Array.isArray(value.splitSourceAmounts) ||
    !Array.isArray(value.withdraws) ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.updatedAt)
  ) {
    throw new Error('Stored confidential funding plan is invalid')
  }
  const plan = value as unknown as ConfidentialFundingPlan
  if (
    !isBoundedString(plan.keyDomainId) ||
    !isBoundedString(plan.accountId) ||
    !isBoundedString(plan.transactionId) ||
    plan.addressIndex < 0 ||
    plan.slippageBps < 0 ||
    plan.slippageBps > 10_000 ||
    plan.approvalExpiresAt <= 0 ||
    !isStoredConfidentialSigner(plan.signerId) ||
    !/^[0-9a-f]{64}$/.test(plan.approvalFingerprint) ||
    (plan.externalRecipient === undefined
      ? !isStoredConfidentialDestination(plan.destination.address, plan.destination.chainId)
      : !isValidExternalRecipient(
          plan.destination.address,
          plan.destination.chainId,
          plan.network
        )) ||
    !isRawAmount(plan.confidentialBaselineRaw) ||
    !isRawAmount(plan.source.amountRaw, true) ||
    !isRawAmount(plan.expectedOutputRaw) ||
    !isRawAmount(plan.minimumOutputRaw) ||
    !isBoundedString(plan.source.chainId) ||
    !isBoundedString(plan.source.chainName, 64) ||
    !isBoundedString(plan.source.assetId) ||
    !isBoundedString(plan.source.protocolAssetId) ||
    !isStoredFundingAddress(plan.source.address, plan.source.chainId) ||
    !isBoundedString(plan.destination.chainId) ||
    !isBoundedString(plan.destination.chainName, 64) ||
    !isBoundedString(plan.destination.assetId) ||
    !isBoundedString(plan.destination.protocolAssetId) ||
    (plan.resumePhase !== undefined && !PHASES.has(plan.resumePhase)) ||
    (plan.orderId !== undefined && !isBoundedString(plan.orderId)) ||
    (plan.batchSubmissionAttemptedAt !== undefined &&
      (!Number.isSafeInteger(plan.batchSubmissionAttemptedAt) ||
        plan.batchSubmissionAttemptedAt < plan.createdAt)) ||
    (plan.settlementCheckedAt !== undefined &&
      (!Number.isSafeInteger(plan.settlementCheckedAt) || plan.settlementCheckedAt < 0)) ||
    (plan.backendStatus !== undefined && !isBoundedString(plan.backendStatus, 128)) ||
    (plan.errorStatus !== undefined && !isBoundedString(plan.errorStatus, 256)) ||
    (plan.operation !== undefined &&
      plan.operation !== 'deposit' &&
      plan.operation !== 'withdraw' &&
      plan.operation !== 'cluster' &&
      plan.operation !== 'swap' &&
      plan.operation !== 'confidential-transfer') ||
    (plan.purpose !== undefined &&
      (!CONFIDENTIAL_FUNDING_PURPOSES.includes(plan.purpose) ||
        plan.operation !== 'withdraw' ||
        plan.sourceDomain !== 'shield' ||
        plan.destinationDomain !== 'public' ||
        plan.externalRecipient === undefined ||
        (plan.purpose === 'native-zec-swap' &&
          (plan.destination.assetId !== `${getZcashChainId(plan.network)}/slip44:133` ||
            plan.destination.protocolAssetId !== ZEC_ZCASH_ASSET ||
            plan.source.protocolAssetId === ZEC_ZCASH_ASSET)))) ||
    (plan.externalRecipient !== undefined &&
      (plan.operation !== 'withdraw' ||
        plan.destinationDomain !== 'public' ||
        typeof plan.externalRecipient !== 'string' ||
        !isValidExternalRecipient(plan.externalRecipient, plan.destination.chainId, plan.network) ||
        !externalRecipientsMatch(
          plan.externalRecipient,
          plan.destination.address,
          plan.destination.chainId,
          plan.network
        ))) ||
    (plan.operation === undefined &&
      (plan.sourceDomain !== undefined || plan.destinationDomain !== undefined)) ||
    (plan.operation === 'deposit' &&
      (!['public', 'private'].includes(plan.sourceDomain ?? '') ||
        plan.destinationDomain !== 'shield' ||
        !plan.requiresDeposit ||
        plan.withdraws.length !== 0 ||
        plan.splitSourceAmounts.length !== 0 ||
        !plan.depositQuote ||
        !plan.preparedDeposit)) ||
    (plan.operation === 'withdraw' &&
      (plan.sourceDomain !== 'shield' ||
        !['public', 'private'].includes(plan.destinationDomain ?? '') ||
        plan.requiresDeposit ||
        plan.withdraws.length !== 1 ||
        plan.splitSourceAmounts[0] !== plan.source.amountRaw)) ||
    (plan.operation === 'swap' &&
      (plan.sourceDomain !== 'shield' ||
        plan.destinationDomain !== 'shield' ||
        plan.source.protocolAssetId === plan.destination.protocolAssetId ||
        plan.source.address.toLowerCase() !== plan.signerId.toLowerCase() ||
        plan.destination.address.toLowerCase() !== plan.signerId.toLowerCase() ||
        plan.requiresDeposit ||
        plan.withdraws.length !== 1 ||
        plan.splitSourceAmounts[0] !== plan.source.amountRaw ||
        !plan.swapQuote ||
        (plan.withdraws[0].signedPayload !== undefined && !plan.frozenRequest) ||
        plan.depositQuote !== undefined ||
        plan.preparedDeposit !== undefined)) ||
    (plan.operation === 'confidential-transfer' &&
      (plan.sourceDomain !== 'shield' ||
        plan.destinationDomain !== 'shield' ||
        plan.source.address.toLowerCase() !== plan.signerId.toLowerCase() ||
        plan.destination.address.toLowerCase() === plan.signerId.toLowerCase() ||
        !/^0x[0-9a-fA-F]{40}$/.test(plan.destination.address) ||
        /^0x0{40}$/i.test(plan.destination.address) ||
        plan.requiresDeposit ||
        plan.externalRecipient !== undefined ||
        plan.withdraws.length !== 1 ||
        plan.splitSourceAmounts[0] !== plan.source.amountRaw ||
        !plan.swapQuote ||
        plan.swapQuote.quoteRequest.dry !== false ||
        plan.swapQuote.quoteRequest.recipientType !== 'CONFIDENTIAL_INTENTS' ||
        plan.swapQuote.quoteRequest.depositType !== 'CONFIDENTIAL_INTENTS' ||
        plan.swapQuote.quoteRequest.refundType !== 'CONFIDENTIAL_INTENTS' ||
        String(plan.swapQuote.quoteRequest.recipient).toLowerCase() !==
          plan.destination.address.toLowerCase() ||
        plan.swapQuote.quoteRequest.originAsset !== plan.source.protocolAssetId ||
        plan.swapQuote.quoteRequest.destinationAsset !== plan.destination.protocolAssetId ||
        (plan.withdraws[0].signedPayload !== undefined && !plan.frozenRequest) ||
        plan.depositQuote !== undefined ||
        plan.preparedDeposit !== undefined)) ||
    (plan.purpose === 'native-zec-swap' &&
      (!plan.swapQuote ||
        plan.swapQuote.quoteRequest.dry !== false ||
        plan.reviewedAppFeesFingerprint !== undefined)) ||
    (plan.operation !== 'swap' &&
      plan.operation !== 'confidential-transfer' &&
      plan.purpose !== 'native-zec-swap' &&
      plan.swapQuote !== undefined) ||
    (plan.reviewedAppFeesFingerprint !== undefined &&
      ((plan.operation !== 'withdraw' && plan.operation !== 'cluster') ||
        !/^[0-9a-f]{64}$/.test(plan.reviewedAppFeesFingerprint))) ||
    (plan.operation === 'cluster' &&
      (!['public', 'private', 'shield'].includes(plan.sourceDomain ?? '') ||
        !['public', 'private'].includes(plan.destinationDomain ?? '') ||
        plan.sourceDomain === plan.destinationDomain ||
        plan.requiresDeposit !== (plan.sourceDomain !== 'shield') ||
        plan.source.chainId !== plan.destination.chainId ||
        plan.source.assetId !== plan.destination.assetId ||
        plan.source.protocolAssetId !== plan.destination.protocolAssetId ||
        plan.withdraws.length < 2 ||
        (plan.requiresDeposit && (!plan.depositQuote || !plan.preparedDeposit)) ||
        (!plan.requiresDeposit && (plan.depositQuote || plan.preparedDeposit)))) ||
    (plan.operation !== 'cluster' && plan.batchSubmissionAttemptedAt !== undefined) ||
    (plan.batchSubmissionAttemptedAt !== undefined && !plan.frozenRequest) ||
    (plan.operation === undefined && plan.withdraws.length < 2) ||
    plan.withdraws.length > 5 ||
    plan.splitSourceAmounts.length !== plan.withdraws.length ||
    plan.splitSourceAmounts.some(amount => !isRawAmount(amount, true)) ||
    (plan.settledOutputRaw !== undefined && !isRawAmount(plan.settledOutputRaw, true)) ||
    plan.withdraws.some(
      (row, index) =>
        !isRecord(row) ||
        row.sequence !== index ||
        !isRawAmount(row.sourceAmountRaw, true) ||
        row.sourceAmountRaw !== plan.splitSourceAmounts[index] ||
        !isRawAmount(row.amountRaw, true) ||
        (row.settledOutputRaw !== undefined && !isRawAmount(row.settledOutputRaw, true)) ||
        typeof row.depositAddress !== 'string' ||
        !isBoundedString(row.destinationAddress) ||
        row.destinationAddress.toLowerCase() !== plan.destination.address.toLowerCase() ||
        !isBoundedString(row.destinationChain, 64) ||
        !isBoundedString(row.token) ||
        !Number.isSafeInteger(row.deadline) ||
        !isBoundedString(row.status, 64) ||
        (row.intentHash !== undefined && !isBoundedString(row.intentHash, 256)) ||
        (row.scheduledAt !== undefined &&
          (!Number.isSafeInteger(row.scheduledAt) || row.scheduledAt < 0)) ||
        (row.signedPayload !== undefined && !isSignedPayload(row.signedPayload))
    ) ||
    (plan.requestFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(plan.requestFingerprint)) ||
    (plan.frozenRequest !== undefined &&
      (!plan.requestFingerprint ||
        plan.frozenRequest.signer_id !== plan.signerId ||
        plan.frozenRequest.from_amount !== plan.source.amountRaw ||
        plan.frozenRequest.from_chain !== plan.source.chainName ||
        plan.frozenRequest.from_token !== plan.source.protocolAssetId ||
        plan.frozenRequest.mode !==
          (plan.source.protocolAssetId === plan.destination.protocolAssetId
            ? 'TRANSFER'
            : 'SWAP') ||
        plan.frozenRequest.withdraws.length !== plan.withdraws.length ||
        plan.frozenRequest.withdraws.some(
          (row, index) =>
            row.sequence !== index ||
            row.amount !== plan.withdraws[index].amountRaw ||
            row.deposit_address !== plan.withdraws[index].depositAddress ||
            row.destination_address.toLowerCase() !== plan.destination.address.toLowerCase() ||
            row.destination_chain !== plan.destination.chainName ||
            row.execution_type !== 'CONFIDENTIAL_1CLICK' ||
            row.token !== plan.destination.protocolAssetId ||
            !isSignedPayload(row.signed_payload) ||
            !sameSignedPayload(row.signed_payload, plan.withdraws[index].signedPayload)
        )))
  ) {
    throw new Error('Stored confidential funding plan bindings are invalid')
  }
  return Object.freeze(plan)
}

function parseExternalDeposit(value: unknown): ExternalShieldDeposit {
  if (
    !isRecord(value) ||
    !isRecord(value.source) ||
    !isRecord(value.quote) ||
    !isRecord(value.quote.quoteRequest) ||
    !isRecord(value.quote.quote) ||
    value.schemaVersion !== 1 ||
    !isBoundedString(value.depositId, 160) ||
    value.transactionId !== `tx:confidential-external:${value.depositId}` ||
    (value.network !== 'mainnet' && value.network !== 'testnet') ||
    !isBoundedString(value.keyDomainId) ||
    !isBoundedString(value.accountId) ||
    !isBoundedString(value.source.chainId) ||
    !isBoundedString(value.source.chainName, 64) ||
    !isBoundedString(value.source.assetId) ||
    !isBoundedString(value.source.protocolAssetId) ||
    !isRawAmount(value.source.amountRaw, true) ||
    value.amountRaw !== value.source.amountRaw ||
    (value.amountMode !== undefined && value.amountMode !== 'minimum') ||
    !isBoundedString(value.destinationAssetId) ||
    value.destinationAssetId !== value.source.assetId ||
    !isBoundedString(value.sourceSymbol, 32) ||
    !Number.isSafeInteger(value.sourceDecimals) ||
    (value.sourceDecimals as number) < 0 ||
    (value.sourceDecimals as number) > 255 ||
    !/^0x[0-9a-fA-F]{40}$/.test(String(value.signerId)) ||
    !isBoundedString(value.depositAddress, 512) ||
    (value.depositMemo !== undefined && !isDepositMemo(value.depositMemo)) ||
    !isBoundedString(value.refundAddress, 512) ||
    !isRawAmount(value.expectedOutputRaw, true) ||
    !isRawAmount(value.minimumOutputRaw, true) ||
    (value.settledOutputRaw !== undefined && !isRawAmount(value.settledOutputRaw, true)) ||
    (value.depositedAmountRaw !== undefined && !isRawAmount(value.depositedAmountRaw)) ||
    (value.fundingObservedAt !== undefined &&
      (!Number.isSafeInteger(value.fundingObservedAt) ||
        (value.fundingObservedAt as number) < 0)) ||
    (value.providerStatus !== undefined && !isBoundedString(value.providerStatus, 64)) ||
    (value.refundTransactionHash !== undefined &&
      !isBoundedString(value.refundTransactionHash, 100)) ||
    (value.balanceRefreshedAt !== undefined &&
      (!Number.isSafeInteger(value.balanceRefreshedAt) ||
        (value.balanceRefreshedAt as number) < 0)) ||
    !Number.isSafeInteger(value.slippageBps) ||
    (value.slippageBps as number) < 0 ||
    (value.slippageBps as number) > 10_000 ||
    !Number.isSafeInteger(value.expiresAt) ||
    Date.parse(String(value.quote.quote.deadline)) !== value.expiresAt ||
    !['awaiting-payment', 'processing', 'ready', 'refunded', 'failed'].includes(
      String(value.phase)
    ) ||
    (value.errorStatus !== undefined && !isBoundedString(value.errorStatus, 256)) ||
    (value.requestId !== undefined && !isBoundedString(value.requestId, 160)) ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.quote.quote.depositAddress !== value.depositAddress ||
    value.quote.quote.amountIn !== value.amountRaw ||
    value.quote.quote.amountOut !== value.expectedOutputRaw ||
    value.quote.quote.minAmountOut !== value.minimumOutputRaw ||
    value.quote.quote.depositMemo !== value.depositMemo ||
    value.quote.quoteRequest.swapType !==
      (value.amountMode === 'minimum' ? 'FLEX_INPUT' : 'EXACT_INPUT') ||
    (value.amountMode === 'minimum' &&
      (value.quote.quoteRequest.dry !== false ||
        !isRawAmount(value.quote.quote.minAmountIn, true) ||
        BigInt(value.quote.quote.minAmountIn as string) > BigInt(value.amountRaw))) ||
    value.quote.quoteRequest.confidentiality !== 'basic' ||
    Number(value.quote.quoteRequest.slippageTolerance) !== value.slippageBps ||
    value.quote.quoteRequest.originAsset !== value.source.protocolAssetId ||
    value.quote.quoteRequest.destinationAsset !== value.source.protocolAssetId ||
    value.quote.quoteRequest.amount !== value.amountRaw ||
    !sameQuotedAddress(value.quote.quoteRequest.refundTo, value.refundAddress) ||
    !sameQuotedAddress(value.quote.quoteRequest.recipient, value.signerId) ||
    value.quote.quoteRequest.depositType !== 'ORIGIN_CHAIN' ||
    value.quote.quoteRequest.refundType !== 'ORIGIN_CHAIN' ||
    value.quote.quoteRequest.recipientType !== 'CONFIDENTIAL_INTENTS'
  ) {
    throw new Error('Stored external Shield deposit is invalid')
  }
  return Object.freeze(value as unknown as ExternalShieldDeposit)
}

function parseSession(value: unknown): ConfidentialSession {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== 'string' ||
    !value.accessToken ||
    typeof value.refreshToken !== 'string' ||
    !value.refreshToken ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(value.refreshExpiresAt)
  ) {
    throw new Error('Stored confidential session is invalid')
  }
  const signerId = value.signerId
  if (signerId !== undefined && !isBoundedString(signerId, 128)) {
    throw new Error('Stored confidential session is invalid')
  }
  return Object.freeze({
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt as number,
    refreshExpiresAt: value.refreshExpiresAt as number,
    ...(typeof signerId === 'string' ? { signerId: canonicalConfidentialSigner(signerId) } : {})
  })
}

function parseBalances(value: unknown): readonly ConfidentialBalance[] {
  if (!Array.isArray(value)) throw new Error('Stored confidential balances are invalid')
  return Object.freeze(
    value.map(item => {
      if (
        !isRecord(item) ||
        typeof item.tokenId !== 'string' ||
        !item.tokenId ||
        typeof item.available !== 'string' ||
        !/^\d+$/.test(item.available) ||
        typeof item.source !== 'string'
      ) {
        throw new Error('Stored confidential balance is invalid')
      }
      return Object.freeze({
        tokenId: item.tokenId,
        available: item.available,
        source: item.source
      })
    })
  )
}

function parseBalanceSnapshot(value: unknown): {
  readonly balances: readonly ConfidentialBalance[]
  readonly updatedAt: number
} {
  // Legacy caches were plain arrays. Keep them readable, but mark them stale so
  // they can never authorize a funding decision after an upgrade.
  if (Array.isArray(value)) return Object.freeze({ balances: parseBalances(value), updatedAt: 0 })
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.updatedAt as number) < 0
  ) {
    throw new Error('Stored confidential balance snapshot is invalid')
  }
  return Object.freeze({
    balances: parseBalances(value.balances),
    updatedAt: value.updatedAt as number
  })
}

export function serializeConfidentialFundingPlan(
  plan: ConfidentialFundingPlan
): ConfidentialFundingPlan {
  // Omit cleared optional fields before crossing Chrome's JSON storage boundary.
  return parsePlan(JSON.parse(JSON.stringify(plan)))
}

export class ChromeConfidentialFundingStore {
  constructor(private readonly now: () => number = Date.now) {}

  private planKey(planId: string): string {
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(planId)) throw new Error('Confidential plan ID is invalid')
    return `${PLAN_PREFIX}${planId}`
  }

  private externalDepositKey(depositId: string): string {
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(depositId))
      throw new Error('External deposit ID is invalid')
    return `${EXTERNAL_DEPOSIT_PREFIX}${depositId}`
  }

  async getExternalDeposit(depositId: string): Promise<ExternalShieldDeposit | null> {
    const key = this.externalDepositKey(depositId)
    const value = (await chrome.storage.local.get(key))[key]
    return value === undefined ? null : parseExternalDeposit(value)
  }

  async listExternalDeposits(): Promise<readonly ExternalShieldDeposit[]> {
    const values = await chrome.storage.local.get(null)
    return Object.freeze(
      Object.entries(values).flatMap(([key, value]) => {
        if (!key.startsWith(EXTERNAL_DEPOSIT_PREFIX)) return []
        try {
          return [parseExternalDeposit(value)]
        } catch {
          return []
        }
      })
    )
  }

  async putExternalDeposit(record: ExternalShieldDeposit): Promise<void> {
    const parsed = parseExternalDeposit(JSON.parse(JSON.stringify(record)))
    await this.withExternalDepositScope(parsed, () =>
      chrome.storage.local.set({ [this.externalDepositKey(parsed.depositId)]: parsed })
    )
  }

  withExternalDepositScope<T>(
    scope: Pick<ExternalShieldDeposit, 'network' | 'keyDomainId' | 'accountId'>,
    operation: () => Promise<T>
  ): Promise<T> {
    return withUndeletedWalletAccountMetadata(
      scope.keyDomainId,
      scope.accountId,
      scope.network,
      operation
    )
  }

  async deleteExternalDepositsByAccountScope(
    keyDomainId: string,
    accountId: string
  ): Promise<void> {
    const values = await chrome.storage.local.get(null)
    const keys = Object.entries(values).flatMap(([key, value]) =>
      key.startsWith(EXTERNAL_DEPOSIT_PREFIX) &&
      isRecord(value) &&
      value.keyDomainId === keyDomainId &&
      value.accountId === accountId
        ? [key]
        : []
    )
    if (keys.length > 0) await chrome.storage.local.remove(keys)
  }

  async deleteBalancesByAccountScope(keyDomainId: string, accountId: string): Promise<void> {
    const stored = await chrome.storage.local.get(null)
    const keys = (['mainnet', 'testnet'] as const).flatMap(network => {
      const prefix = this.balanceKey(network, keyDomainId, accountId)
      return Object.keys(stored).filter(key => key === prefix || key.startsWith(`${prefix}:`))
    })
    if (keys.length > 0) await chrome.storage.local.remove(keys)
  }

  private sessionKey(
    network: Network,
    keyDomainId: string,
    accountId: string,
    signerId?: string
  ): string {
    const base = `${SESSION_PREFIX}${network}:${encodeURIComponent(keyDomainId)}:${encodeURIComponent(accountId)}`
    return signerId ? `${base}:${encodeURIComponent(canonicalConfidentialSigner(signerId))}` : base
  }

  private historySessionKey(network: Network, keyDomainId: string, accountId: string): string {
    return `${HISTORY_SESSION_PREFIX}${network}:${encodeURIComponent(keyDomainId)}:${encodeURIComponent(accountId)}`
  }

  async getHistorySession(
    network: Network,
    keyDomainId: string,
    accountId: string
  ): Promise<ConfidentialOrderAuthToken | null> {
    const key = this.historySessionKey(network, keyDomainId, accountId)
    const value = (await chrome.storage.session.get(key))[key]
    if (
      !isRecord(value) ||
      !isBoundedString(value.token, 8192) ||
      !isBoundedString(value.expiresAt) ||
      !Number.isSafeInteger(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= this.now() ||
      !isBoundedString(value.queryAddress) ||
      (value.principalType !== 'wallet' && value.principalType !== 'mca') ||
      (value.mcaAccountId !== null && !isBoundedString(value.mcaAccountId))
    ) {
      if (value !== undefined) await chrome.storage.session.remove(key)
      return null
    }
    return value as unknown as ConfidentialOrderAuthToken
  }

  async putHistorySession(
    network: Network,
    keyDomainId: string,
    accountId: string,
    token: ConfidentialOrderAuthToken
  ): Promise<void> {
    if (
      !isBoundedString(token.token, 8192) ||
      !isBoundedString(token.expiresAt) ||
      !Number.isSafeInteger(Date.parse(token.expiresAt)) ||
      Date.parse(token.expiresAt) <= this.now() ||
      !isBoundedString(token.queryAddress)
    )
      throw new Error('Wallet history session is invalid')
    await withUndeletedWalletAccountMetadata(keyDomainId, accountId, network, () =>
      chrome.storage.session.set({
        [this.historySessionKey(network, keyDomainId, accountId)]: token
      })
    )
  }

  async deleteHistorySession(
    network: Network,
    keyDomainId: string,
    accountId: string
  ): Promise<void> {
    await chrome.storage.session.remove(this.historySessionKey(network, keyDomainId, accountId))
  }

  private balanceKey(
    network: Network,
    keyDomainId: string,
    accountId: string,
    signerId?: string
  ): string {
    const base = `${BALANCE_PREFIX}${network}:${encodeURIComponent(keyDomainId)}:${encodeURIComponent(accountId)}`
    return signerId ? `${base}:${encodeURIComponent(canonicalConfidentialSigner(signerId))}` : base
  }

  async getPlan(planId: string): Promise<ConfidentialFundingPlan | null> {
    const key = this.planKey(planId)
    const value = (await chrome.storage.local.get(key))[key]
    return value === undefined ? null : parsePlan(value)
  }

  async getPlansForTransactions(
    transactionIds: readonly string[]
  ): Promise<ReadonlyMap<string, ConfidentialFundingPlan>> {
    const keys = transactionIds.flatMap(transactionId => {
      const planId = getConfidentialFundingPlanId(transactionId)
      return planId ? [this.planKey(planId)] : []
    })
    if (keys.length === 0) return new Map()
    const values = await chrome.storage.local.get(keys)
    const plans = new Map<string, ConfidentialFundingPlan>()
    for (const [key, value] of Object.entries(values)) {
      try {
        const plan = parsePlan(value)
        if (
          key === this.planKey(plan.planId) &&
          getConfidentialFundingPlanId(plan.transactionId) === plan.planId
        ) {
          plans.set(plan.transactionId, plan)
        }
      } catch {
        continue
      }
    }
    return plans
  }

  async listPlans(): Promise<readonly ConfidentialFundingPlan[]> {
    const values = await chrome.storage.local.get(null)
    return Object.freeze(
      Object.entries(values).flatMap(([key, value]) => {
        if (!key.startsWith(PLAN_PREFIX)) return []
        try {
          return [parsePlan(value)]
        } catch {
          return []
        }
      })
    )
  }

  async putPlan(plan: ConfidentialFundingPlan): Promise<void> {
    const parsed = serializeConfidentialFundingPlan(plan)
    await withUndeletedWalletAccountMetadata(
      parsed.keyDomainId,
      parsed.accountId,
      parsed.network,
      () => chrome.storage.local.set({ [this.planKey(parsed.planId)]: parsed })
    )
  }

  async deletePlan(planId: string): Promise<void> {
    await chrome.storage.local.remove(this.planKey(planId))
  }

  async getSession(
    network: Network,
    keyDomainId: string,
    accountId: string,
    signerId?: string
  ): Promise<ConfidentialSession | null> {
    if (!signerId) return this.readSession(this.sessionKey(network, keyDomainId, accountId))
    const signer = canonicalConfidentialSigner(signerId)
    if (!isConfidentialEvmSigner(signer)) {
      return this.readSession(this.sessionKey(network, keyDomainId, accountId, signer))
    }
    const scoped = await this.readSession(this.sessionKey(network, keyDomainId, accountId, signer))
    if (scoped && (!scoped.signerId || sameConfidentialSigner(scoped.signerId, signer)))
      return scoped
    const legacy = await this.readSession(this.sessionKey(network, keyDomainId, accountId))
    if (legacy && (!legacy.signerId || sameConfidentialSigner(legacy.signerId, signer)))
      return legacy
    return null
  }

  async putSession(
    network: Network,
    keyDomainId: string,
    accountId: string,
    session: ConfidentialSession
  ): Promise<void> {
    const parsed = parseSession(session)
    const legacyKey = this.sessionKey(network, keyDomainId, accountId)
    const entries: Record<string, ConfidentialSession> =
      parsed.signerId && !isConfidentialEvmSigner(parsed.signerId)
        ? { [this.sessionKey(network, keyDomainId, accountId, parsed.signerId)]: parsed }
        : {
            [legacyKey]: parsed,
            ...(parsed.signerId
              ? { [this.sessionKey(network, keyDomainId, accountId, parsed.signerId)]: parsed }
              : {})
          }
    await withUndeletedWalletAccountMetadata(keyDomainId, accountId, network, () =>
      chrome.storage.session.set(entries)
    )
  }

  async deleteSession(
    network: Network,
    keyDomainId: string,
    accountId: string,
    signerId?: string
  ): Promise<void> {
    const legacyKey = this.sessionKey(network, keyDomainId, accountId)
    const keys = []
    if (!signerId || isConfidentialEvmSigner(signerId)) {
      const legacy = await this.readSession(legacyKey)
      if (!signerId || !legacy?.signerId || sameConfidentialSigner(legacy.signerId, signerId)) {
        keys.push(legacyKey)
      }
    }
    if (signerId) keys.push(this.sessionKey(network, keyDomainId, accountId, signerId))
    if (keys.length > 0) await chrome.storage.session.remove(keys)
  }

  private shieldGrantKey(grant: ShieldSiteGrant): string {
    return `${SHIELD_GRANT_PREFIX}${encodeURIComponent(grant.origin)}:${grant.network}:${encodeURIComponent(grant.keyDomainId)}:${encodeURIComponent(grant.accountId)}`
  }

  async hasShieldSiteGrant(
    origin: string,
    network: Network,
    keyDomainId: string,
    accountId: string
  ): Promise<boolean> {
    let grant: ShieldSiteGrant
    try {
      grant = parseShieldSiteGrant({ schemaVersion: 1, origin, network, keyDomainId, accountId })
    } catch {
      return false
    }
    const key = this.shieldGrantKey(grant)
    const value = (await chrome.storage.local.get(key))[key]
    if (value === undefined) return false
    try {
      const stored = parseShieldSiteGrant(value)
      return (
        stored.origin === grant.origin &&
        stored.network === grant.network &&
        stored.keyDomainId === grant.keyDomainId &&
        stored.accountId === grant.accountId
      )
    } catch {
      await chrome.storage.local.remove(key)
      return false
    }
  }

  async putShieldSiteGrant(grant: ShieldSiteGrant): Promise<void> {
    const parsed = parseShieldSiteGrant({ schemaVersion: 1, ...grant })
    await withUndeletedWalletAccountMetadata(
      parsed.keyDomainId,
      parsed.accountId,
      parsed.network,
      () =>
        chrome.storage.local.set({
          [this.shieldGrantKey(parsed)]: { schemaVersion: 1, ...parsed }
        })
    )
  }

  async deleteShieldSiteGrant(
    origin: string,
    network: Network,
    keyDomainId: string,
    accountId: string
  ): Promise<void> {
    let grant: ShieldSiteGrant
    try {
      grant = parseShieldSiteGrant({ schemaVersion: 1, origin, network, keyDomainId, accountId })
    } catch {
      return
    }
    await chrome.storage.local.remove(this.shieldGrantKey(grant))
  }

  async listShieldSiteGrants(network: Network): Promise<readonly ShieldSiteGrant[]> {
    const values = await chrome.storage.local.get(null)
    return Object.entries(values).flatMap(([key, value]) => {
      if (!key.startsWith(SHIELD_GRANT_PREFIX)) return []
      try {
        const grant = parseShieldSiteGrant(value)
        return grant.network === network && key === this.shieldGrantKey(grant) ? [grant] : []
      } catch {
        return []
      }
    })
  }

  async deleteShieldSiteGrantsByAccountScope(
    keyDomainId: string,
    accountId: string
  ): Promise<void> {
    const values = await chrome.storage.local.get(null)
    const keys = Object.entries(values).flatMap(([key, value]) => {
      if (!key.startsWith(SHIELD_GRANT_PREFIX)) return []
      try {
        const grant = parseShieldSiteGrant(value)
        return grant.keyDomainId === keyDomainId && grant.accountId === accountId ? [key] : []
      } catch {
        return []
      }
    })
    if (keys.length > 0) await chrome.storage.local.remove(keys)
  }

  async deleteShieldSiteGrantsByOrigin(origin: string): Promise<void> {
    const values = await chrome.storage.local.get(null)
    const keys = Object.entries(values).flatMap(([key, value]) => {
      if (!key.startsWith(SHIELD_GRANT_PREFIX)) return []
      try {
        return parseShieldSiteGrant(value).origin === origin ? [key] : []
      } catch {
        return []
      }
    })
    if (keys.length > 0) await chrome.storage.local.remove(keys)
  }

  async clearShieldSiteGrants(): Promise<void> {
    const keys = Object.keys(await chrome.storage.local.get(null)).filter(key =>
      key.startsWith(SHIELD_GRANT_PREFIX)
    )
    if (keys.length > 0) await chrome.storage.local.remove(keys)
  }

  async deleteSessionsByAccountScope(keyDomainId: string, accountId: string): Promise<void> {
    const stored = await chrome.storage.session.get(null)
    const keys = (['mainnet', 'testnet'] as const).flatMap(network => {
      const sessionPrefix = this.sessionKey(network, keyDomainId, accountId)
      const historyKey = this.historySessionKey(network, keyDomainId, accountId)
      return Object.keys(stored).filter(
        key => key === sessionPrefix || key.startsWith(`${sessionPrefix}:`) || key === historyKey
      )
    })
    if (keys.length > 0) await chrome.storage.session.remove(keys)
  }

  private async readSession(key: string): Promise<ConfidentialSession | null> {
    const value = (await chrome.storage.session.get(key))[key]
    if (value === undefined) return null
    try {
      return parseSession(value)
    } catch {
      await chrome.storage.session.remove(key)
      return null
    }
  }

  async clearAllSessions(): Promise<void> {
    const keys = Object.keys(await chrome.storage.session.get(null)).filter(
      key => key.startsWith(SESSION_PREFIX) || key.startsWith(HISTORY_SESSION_PREFIX)
    )
    if (keys.length > 0) await chrome.storage.session.remove(keys)
  }

  async clearAllWalletData(): Promise<void> {
    await withMetadataLock(async () => {
      const [local, session] = await Promise.all([
        chrome.storage.local.get(null),
        chrome.storage.session.get(null)
      ])
      const localKeys = Object.keys(local).filter(
        key =>
          key.startsWith(PLAN_PREFIX) ||
          key.startsWith(EXTERNAL_DEPOSIT_PREFIX) ||
          key.startsWith(BALANCE_PREFIX) ||
          key.startsWith(SHIELD_GRANT_PREFIX)
      )
      const sessionKeys = Object.keys(session).filter(
        key => key.startsWith(SESSION_PREFIX) || key.startsWith(HISTORY_SESSION_PREFIX)
      )
      await Promise.all([
        ...(localKeys.length > 0 ? [chrome.storage.local.remove(localKeys)] : []),
        ...(sessionKeys.length > 0 ? [chrome.storage.session.remove(sessionKeys)] : [])
      ])
    })
  }

  async getBalances(
    network: Network,
    keyDomainId: string,
    accountId: string,
    signerId?: string
  ): Promise<readonly ConfidentialBalance[]> {
    const snapshot = await this.getBalanceSnapshot(network, keyDomainId, accountId, signerId)
    return snapshot.fresh ? snapshot.balances : Object.freeze([])
  }

  async getBalanceSnapshot(
    network: Network,
    keyDomainId: string,
    accountId: string,
    signerId?: string
  ): Promise<ConfidentialBalanceSnapshot> {
    const empty = Object.freeze({
      balances: Object.freeze([]),
      updatedAt: 0,
      fresh: false,
      known: false
    })
    if (signerId && !isConfidentialEvmSigner(signerId)) {
      return (
        (await this.readBalanceSnapshot(
          this.balanceKey(network, keyDomainId, accountId, signerId)
        )) ?? empty
      )
    }
    return (
      (await this.readBalanceSnapshot(this.balanceKey(network, keyDomainId, accountId))) ?? empty
    )
  }

  async listSignerBalanceSnapshots(
    network: Network,
    keyDomainId: string,
    accountId: string
  ): Promise<readonly Readonly<{ signerId: string; snapshot: ConfidentialBalanceSnapshot }>[]> {
    const prefix = `${this.balanceKey(network, keyDomainId, accountId)}:`
    const stored = await chrome.storage.local.get(null)
    const rows: { signerId: string; snapshot: ConfidentialBalanceSnapshot }[] = []
    for (const key of Object.keys(stored)) {
      if (!key.startsWith(prefix)) continue
      let signerId: string
      try {
        signerId = decodeURIComponent(key.slice(prefix.length))
      } catch {
        continue
      }
      if (!signerId || isConfidentialEvmSigner(signerId)) continue
      const snapshot = await this.readBalanceSnapshot(key)
      if (!snapshot?.known) continue
      rows.push(Object.freeze({ signerId, snapshot }))
    }
    return Object.freeze(rows)
  }

  async putBalances(
    network: Network,
    keyDomainId: string,
    accountId: string,
    balances: readonly ConfidentialBalance[],
    requestedAt = this.now(),
    signerId?: string
  ): Promise<void> {
    if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) {
      throw new Error('Confidential balance request time is invalid')
    }
    const snapshot = Object.freeze({
      schemaVersion: 1,
      balances: parseBalances(balances),
      updatedAt: requestedAt
    })
    const key = this.balanceKey(
      network,
      keyDomainId,
      accountId,
      signerId && !isConfidentialEvmSigner(signerId) ? signerId : undefined
    )
    await withUndeletedWalletAccountMetadata(keyDomainId, accountId, network, async () => {
      const current = (await chrome.storage.local.get(key))[key]
      if (current !== undefined) {
        try {
          if (parseBalanceSnapshot(current).updatedAt >= requestedAt) return
        } catch {
          // Replace malformed cached data with a valid response.
        }
      }
      await chrome.storage.local.set({ [key]: snapshot })
    })
  }

  private async readBalanceSnapshot(key: string): Promise<ConfidentialBalanceSnapshot | null> {
    const value = (await chrome.storage.local.get(key))[key]
    if (value === undefined) return null
    try {
      const snapshot = parseBalanceSnapshot(value)
      return Object.freeze({
        ...snapshot,
        known: true,
        fresh:
          snapshot.updatedAt > 0 &&
          snapshot.updatedAt <= this.now() &&
          this.now() - snapshot.updatedAt <= CONFIDENTIAL_BALANCE_CACHE_TTL_MS
      })
    } catch {
      await chrome.storage.local.remove(key)
      return Object.freeze({
        balances: Object.freeze([]),
        updatedAt: 0,
        fresh: false,
        known: false
      })
    }
  }
}
