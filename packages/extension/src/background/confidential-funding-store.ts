import type { Network } from '@/types'
import { withMetadataLock, withUndeletedWalletAccountMetadata } from '@/lib/wallet-metadata-storage'
import type { ConfidentialFundingPlan } from '@/core/services/confidential-funding'
import type { ExternalShieldDeposit } from '@/core/services/confidential-funding'
import type {
  ConfidentialBalance,
  ConfidentialOrderAuthToken,
  ConfidentialSession
} from './confidential-funding-api'

const PLAN_PREFIX = 'confidential_funding_plan:'
const EXTERNAL_DEPOSIT_PREFIX = 'confidential_external_deposit:'
const SESSION_PREFIX = 'confidential_funding_session:'
const HISTORY_SESSION_PREFIX = 'confidential_order_history_session:'
const BALANCE_PREFIX = 'confidential_funding_balance:'
export const CONFIDENTIAL_BALANCE_CACHE_TTL_MS = 5 * 60 * 1000

export interface ConfidentialBalanceSnapshot {
  readonly balances: readonly ConfidentialBalance[]
  readonly updatedAt: number
  readonly fresh: boolean
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

function isSignedPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.standard === 'erc191' &&
    isBoundedString(value.payload, 16_384) &&
    isBoundedString(value.signature, 512)
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
    left.payload === right.payload &&
    left.signature === right.signature
  )
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
    !/^0x[0-9a-f]{40}$/.test(plan.signerId) ||
    !/^[0-9a-f]{64}$/.test(plan.approvalFingerprint) ||
    !/^0x[0-9a-fA-F]{40}$/.test(plan.destination.address) ||
    !isRawAmount(plan.confidentialBaselineRaw) ||
    !isRawAmount(plan.source.amountRaw, true) ||
    !isRawAmount(plan.expectedOutputRaw) ||
    !isRawAmount(plan.minimumOutputRaw) ||
    !isBoundedString(plan.source.chainId) ||
    !isBoundedString(plan.source.chainName, 64) ||
    !isBoundedString(plan.source.assetId) ||
    !isBoundedString(plan.source.protocolAssetId) ||
    !/^0x[0-9a-f]{40}$/.test(plan.source.address) ||
    !isBoundedString(plan.destination.chainId) ||
    !isBoundedString(plan.destination.chainName, 64) ||
    !isBoundedString(plan.destination.assetId) ||
    !isBoundedString(plan.destination.protocolAssetId) ||
    (plan.resumePhase !== undefined && !PHASES.has(plan.resumePhase)) ||
    (plan.orderId !== undefined && !isBoundedString(plan.orderId)) ||
    (plan.batchSubmissionAttemptedAt !== undefined &&
      (!Number.isSafeInteger(plan.batchSubmissionAttemptedAt) ||
        plan.batchSubmissionAttemptedAt < plan.createdAt)) ||
    (plan.backendStatus !== undefined && !isBoundedString(plan.backendStatus, 128)) ||
    (plan.errorStatus !== undefined && !isBoundedString(plan.errorStatus, 256)) ||
    (plan.operation !== undefined &&
      plan.operation !== 'deposit' &&
      plan.operation !== 'withdraw' &&
      plan.operation !== 'cluster' &&
      plan.operation !== 'swap') ||
    (plan.externalRecipient !== undefined &&
      (plan.operation !== 'withdraw' ||
        plan.destinationDomain !== 'public' ||
        typeof plan.externalRecipient !== 'string' ||
        !/^0x[0-9a-fA-F]{40}$/.test(plan.externalRecipient) ||
        /^0x0{40}$/i.test(plan.externalRecipient) ||
        plan.externalRecipient.toLowerCase() !== plan.destination.address.toLowerCase())) ||
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
    (plan.operation !== 'swap' && plan.swapQuote !== undefined) ||
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
    plan.withdraws.some(
      (row, index) =>
        !isRecord(row) ||
        row.sequence !== index ||
        !isRawAmount(row.sourceAmountRaw, true) ||
        row.sourceAmountRaw !== plan.splitSourceAmounts[index] ||
        !isRawAmount(row.amountRaw, true) ||
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
    value.quote.quoteRequest.swapType !== 'EXACT_INPUT' ||
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
  return Object.freeze({
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt as number,
    refreshExpiresAt: value.refreshExpiresAt as number
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
    await chrome.storage.local.remove([
      this.balanceKey('mainnet', keyDomainId, accountId),
      this.balanceKey('testnet', keyDomainId, accountId)
    ])
  }

  private sessionKey(network: Network, keyDomainId: string, accountId: string): string {
    return `${SESSION_PREFIX}${network}:${encodeURIComponent(keyDomainId)}:${encodeURIComponent(accountId)}`
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

  private balanceKey(network: Network, keyDomainId: string, accountId: string): string {
    return `${BALANCE_PREFIX}${network}:${encodeURIComponent(keyDomainId)}:${encodeURIComponent(accountId)}`
  }

  async getPlan(planId: string): Promise<ConfidentialFundingPlan | null> {
    const key = this.planKey(planId)
    const value = (await chrome.storage.local.get(key))[key]
    return value === undefined ? null : parsePlan(value)
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
    accountId: string
  ): Promise<ConfidentialSession | null> {
    const key = this.sessionKey(network, keyDomainId, accountId)
    const value = (await chrome.storage.session.get(key))[key]
    if (value === undefined) return null
    try {
      return parseSession(value)
    } catch {
      await chrome.storage.session.remove(key)
      return null
    }
  }

  async putSession(
    network: Network,
    keyDomainId: string,
    accountId: string,
    session: ConfidentialSession
  ): Promise<void> {
    await withUndeletedWalletAccountMetadata(keyDomainId, accountId, network, () =>
      chrome.storage.session.set({
        [this.sessionKey(network, keyDomainId, accountId)]: parseSession(session)
      })
    )
  }

  async deleteSession(network: Network, keyDomainId: string, accountId: string): Promise<void> {
    await chrome.storage.session.remove(this.sessionKey(network, keyDomainId, accountId))
  }

  async deleteSessionsByAccountScope(keyDomainId: string, accountId: string): Promise<void> {
    await chrome.storage.session.remove(
      (['mainnet', 'testnet'] as const).flatMap(network => [
        this.sessionKey(network, keyDomainId, accountId),
        this.historySessionKey(network, keyDomainId, accountId)
      ])
    )
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
          key.startsWith(BALANCE_PREFIX)
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
    accountId: string
  ): Promise<readonly ConfidentialBalance[]> {
    const snapshot = await this.getBalanceSnapshot(network, keyDomainId, accountId)
    return snapshot.fresh ? snapshot.balances : Object.freeze([])
  }

  async getBalanceSnapshot(
    network: Network,
    keyDomainId: string,
    accountId: string
  ): Promise<ConfidentialBalanceSnapshot> {
    const key = this.balanceKey(network, keyDomainId, accountId)
    const value = (await chrome.storage.local.get(key))[key]
    if (value === undefined) {
      return Object.freeze({ balances: Object.freeze([]), updatedAt: 0, fresh: false })
    }
    try {
      const snapshot = parseBalanceSnapshot(value)
      return Object.freeze({
        ...snapshot,
        fresh:
          snapshot.updatedAt > 0 &&
          snapshot.updatedAt <= this.now() &&
          this.now() - snapshot.updatedAt <= CONFIDENTIAL_BALANCE_CACHE_TTL_MS
      })
    } catch {
      await chrome.storage.local.remove(key)
      return Object.freeze({ balances: Object.freeze([]), updatedAt: 0, fresh: false })
    }
  }

  async putBalances(
    network: Network,
    keyDomainId: string,
    accountId: string,
    balances: readonly ConfidentialBalance[]
  ): Promise<void> {
    const snapshot = Object.freeze({
      schemaVersion: 1,
      balances: parseBalances(balances),
      updatedAt: this.now()
    })
    await withUndeletedWalletAccountMetadata(keyDomainId, accountId, network, () =>
      chrome.storage.local.set({ [this.balanceKey(network, keyDomainId, accountId)]: snapshot })
    )
  }
}
