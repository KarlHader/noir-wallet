import type { Network } from '@/types'
import {
  NOIR_RECEIVE_REFERRAL,
  NOIR_SEND_REFERRAL,
  NOIR_SWAP_REFERRAL,
  type NoirIntentsReferral
} from '@/config/intents'
import { trackEvent } from '@/background/analytics/reporter'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import { withMetadataLock } from '@/lib/wallet-metadata-storage'
import {
  projectConfidentialPlanResult,
  projectExternalDepositResult
} from '@/lib/analytics/operations'
import {
  externalShieldQuoteAmountRaw,
  hasExternalShieldDepositFunding,
  isExternalShieldDepositExpired,
  shouldAutoRefreshExternalShieldDeposit,
  ExternalShieldDepositError,
  type ExternalShieldDepositFailureStage
} from '@/core/services/confidential-funding/confidential-external-deposit'
import { isAddress } from 'viem'
import {
  acceptNearDirectDeposit,
  planNearIncognitoCluster,
  NEAR_MOVE_UNAVAILABLE,
  type NearIncognitoClusterPlan
} from '@/core/chains/near/near-incognito-move'
import { getEvmNetworkConfig, getNearNetworkConfig } from '@/config/networks'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { isValidExternalRecipient } from './confidential-funding-recipient'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { SwapToken } from '@/core/services/intents-api'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import {
  isDeprecatedIntentsToken,
  resolveIntentsEvmAssets,
  resolveIntentsEvmChainId
} from '@/core/services/intents-evm-assets'
import { resolveManagedIntentsAssets } from '@/core/services/intents-managed-assets'
import type { ChainId } from '@/core/chains/domain'
import { parseAccountId } from '@/core/accounts/domain'
import { resolveConfidentialIdentity } from '@/core/accounts/confidential-identity'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  getZcashChainId,
  parseAssetId,
  parseChainId,
  type AssetDefinitionInput,
  type AssetRegistry
} from '@/core/chains/registry'
import {
  CONFIDENTIAL_WITHDRAW_DEFAULT_COUNT,
  CONFIDENTIAL_SESSION_REQUIRED_ERROR,
  buildConfidentialPortfolioView,
  aggregateConfidentialSettlement,
  assertDirectConfidentialWithdrawIntentBinding,
  assertConfidentialIntentBinding,
  assertConfidentialQuoteBinding,
  assertFlexibleExternalDepositQuoteBinding,
  createConfidentialFundingGraph,
  createExternalShieldDepositGraph,
  fingerprintConfidentialValue,
  fingerprintDirectConfidentialApproval,
  combineConfidentialSignerBalances,
  confidentialAvailableByProtocolAsset,
  filterConfidentialPortfolioMappings,
  getConfidentialAvailableForAsset,
  mergeConfidentialBalancesIntoPortfolio,
  projectConfidentialOnlyEvmAssets,
  mergeConfidentialWithdrawObservation,
  needsConfidentialSubmissionCheck,
  normalizeConfidentialWithdrawRequest,
  splitConfidentialFundingAmount,
  type ConfidentialFundingPlan,
  type ConfidentialFundingPreview,
  type ConfidentialFundingReview,
  type ConfidentialPortfolioAssetMapping,
  type ConfidentialQuote,
  type ConfidentialWithdrawRequest,
  type ConfidentialWithdrawRow,
  type CreateExternalShieldDepositInput,
  type ExternalShieldDeposit,
  type ExternalShieldDepositScope
} from '@/core/services/confidential-funding'
import {
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionSegmentEvidence,
  type TransactionFailureCode,
  type TransactionLifecycleStatus,
  type TransactionGraph
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'
import {
  broadcastSignedEvmTransaction,
  createConfiguredEvmRpcClient,
  createEvmTransactionSegmentEvent,
  estimateEvmTransferFee,
  EvmTransactionError,
  isEvmSpeedUpReplacement,
  observeEvmTransaction,
  parseEvmFeeSelection,
  parsePreparedEvmTransfer,
  type EvmBroadcastRpc,
  type EvmFeeSelection,
  type EvmTransactionRpc
} from '@/infrastructure/chains/evm'
import type { EvmNetworkConfig } from '@/config/networks'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import {
  ConfidentialFundingApi,
  ConfidentialFundingApiError,
  CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR,
  confidentialQuoteAppFeeUnrepresentable,
  readConfidentialQuoteAppFees,
  type ConfidentialBalance,
  type ConfidentialPrivateOrder,
  type ConfidentialSession,
  type ConfidentialStatus
} from './confidential-funding-api'
import {
  EvmConfidentialDepositAdapter,
  isEvmConfidentialDepositIdentity,
  type ConfidentialDepositAdapter,
  type NearConfidentialAccount
} from './confidential-funding-adapters'
import { NEAR_CHAIN_FEATURE_FLAG } from '@/config/multichain-feature-flags'
import { readEnabledChainFeatureFlags } from '@/config/enabled-chain-feature-flags'
import {
  isNearWrappedProtocolAsset,
  nearConfidentialPortfolioAssetId
} from '@/core/chains/near/near-portfolio-assets'
import {
  assertNearConfidentialDepositAddress,
  isNearChainConfidentialProtocolAsset,
  NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID,
  normalizeNearConfidentialQuote
} from './confidential-near-quote'
import { parseNearAccountId } from '@/core/chains/near/identifiers'
import {
  parsePreparedNearConfidentialDeposit,
  type NearTransactionStatus
} from '@/infrastructure/chains/near'
import {
  ConfidentialFundingSigner,
  type ConfidentialSigningIdentity
} from './confidential-funding-signer'
import {
  ChromeConfidentialFundingStore,
  isConfidentialEvmSigner
} from './confidential-funding-store'
import {
  NativeZecIntentsSwapCoordinator,
  type NativeZecActiveAccountSnapshot
} from './native-zec-intents-swap'
import { ShieldDappCoordinator } from './shield-dapp-coordinator'
import type { PrepareNativeZecIntentsSwapInput } from '@/core/services/native-zec-intents-swap'
import type { QuoteBinding } from '@/types/wallet'

const assertStoredConfidentialQuoteBinding = assertConfidentialQuoteBinding
const SESSION_REFRESH_BUFFER_MS = 60_000
// Every EVM signer shares the unsuffixed balance record.
const CONFIDENTIAL_EVM_BALANCE_SIGNER = `0x${'0'.repeat(40)}`
const CLUSTER_DEPOSIT_PREFETCH_MS = 60_000
const MAX_CLUSTER_DEPOSIT_PREFETCHES = 32
export const CONFIDENTIAL_FUNDING_MONITOR_ALARM = 'confidential-funding-monitor'

const EXTERNAL_DEPOSIT_STATUS_BACKOFF_INITIAL_MS = 10_000
const EXTERNAL_DEPOSIT_STATUS_BACKOFF_MAX_MS = 120_000
const EXTERNAL_DEPOSIT_STATUS_FRESH_MS = 20_000
const CONFIDENTIAL_FUNDING_MONITOR_DELAY_MINUTES = 20 / 60
export type ClusterRejectionReason = 'APP_FEE_REJECTED_2002' | 'BACKEND_CONFIRMED_REJECTION'
const TERMINAL_PHASES = new Set<ConfidentialFundingPlan['phase']>([
  'ready',
  'partial',
  'refunded',
  'failed',
  'expired',
  'cancelled'
])

function isTerminalPhase(phase: ConfidentialFundingPlan['phase']): boolean {
  return TERMINAL_PHASES.has(phase)
}

function isClusterRejectionReason(value: unknown): value is ClusterRejectionReason {
  return value === 'APP_FEE_REJECTED_2002' || value === 'BACKEND_CONFIRMED_REJECTION'
}

function isExplicitAppFeeRejection(error: unknown): boolean {
  return (
    error instanceof ConfidentialFundingApiError &&
    !error.ambiguous &&
    error.status === 200 &&
    error.businessCode === 2002
  )
}

const confidentialMonitoringQueue = new SerialTaskQueue()
const REFUND_STATUS_CHECK_INTERVAL_MS = 60_000

function refundStatusCheckInterval(plan: ConfidentialFundingPlan, now: number): number {
  const days = Math.max(0, Math.floor((now - plan.createdAt) / 86_400_000))
  return Math.min(3_600_000, REFUND_STATUS_CHECK_INTERVAL_MS * 2 ** Math.min(days, 6))
}

// Execution failure does not prove that the protocol has finished returning funds.
function needsRefundObservation(plan: ConfidentialFundingPlan): boolean {
  if (
    !['failed', 'expired', 'cancelled', 'partial'].includes(plan.phase) ||
    isRecoverableLocalFailure(plan)
  )
    return false
  if (plan.orderId || plan.withdraws.some(row => row.intentHash)) {
    return plan.withdraws.some(
      row => !['SUCCESS', 'COMPLETED', 'REFUNDED'].includes(normalizeStatus(row.status))
    )
  }
  return Boolean(
    plan.requiresDeposit &&
    plan.preparedDeposit?.transactionHash &&
    plan.depositQuote &&
    !['DEPOSIT_REVERTED', 'DEPOSIT_CANCELLED', 'DEPOSIT_REPLACED'].includes(plan.errorStatus ?? '')
  )
}

function isRecoverableLocalFailure(plan: ConfidentialFundingPlan): boolean {
  return (
    plan.phase === 'failed' &&
    plan.errorStatus === 'LOCAL_PROCESSING_FAILED' &&
    plan.requiresDeposit &&
    Boolean(plan.preparedDeposit?.transactionHash)
  )
}

function isUnsignedDirectWithdraw(plan: ConfidentialFundingPlan): boolean {
  return (
    (plan.operation === 'withdraw' ||
      plan.operation === 'swap' ||
      plan.operation === 'confidential-transfer') &&
    (plan.phase === 'authorized' ||
      plan.phase === 'signing-withdraws' ||
      (plan.phase === 'needs-auth' &&
        (plan.resumePhase === 'authorized' || plan.resumePhase === 'signing-withdraws'))) &&
    !plan.frozenRequest &&
    !plan.withdraws.some(row => row.signedPayload)
  )
}

interface ConfidentialFundingRouteInput {
  readonly source: Readonly<{
    chainId: string
    chainName: string
    assetId: string
    protocolAssetId: string
    amountRaw: string
  }>
  readonly destination: Readonly<{
    chainId: string
    chainName: string
    assetId: string
    protocolAssetId: string
  }>
  readonly slippageBps: number
  readonly feeTier?: NetworkFeeTier
  readonly feeSelection?: EvmFeeSelection
  readonly dedupKey?: string
  readonly externalRecipient?: string
  readonly confidentialRecipient?: string
  readonly purpose?: 'move' | 'native-zec-swap'
}

export type PrepareConfidentialFundingInput = ConfidentialFundingRouteInput &
  (
    | Readonly<{
        network: Network
        keyDomainId: string
        accountId: string
        operation: 'deposit' | 'withdraw' | 'swap' | 'confidential-transfer'
        sourceDomain: 'public' | 'private' | 'shield'
        destinationDomain: 'public' | 'private' | 'shield'
      }>
    | Readonly<{
        network: Network
        keyDomainId: string
        accountId: string
        operation: 'cluster'
        sourceDomain: 'public' | 'private' | 'shield'
        destinationDomain: 'public' | 'private'
      }>
    | Readonly<{
        operation?: never
        network?: never
        keyDomainId?: never
        accountId?: never
        sourceDomain?: never
        destinationDomain?: never
      }>
  )

function withdrawalReferral(
  input: Pick<ConfidentialFundingPlan, 'operation' | 'purpose'>
): NoirIntentsReferral {
  return input.operation === 'swap' || input.purpose === 'native-zec-swap'
    ? NOIR_SWAP_REFERRAL
    : NOIR_SEND_REFERRAL
}

function directConfidentialRecipientType(
  operation: string | undefined
): 'CONFIDENTIAL_INTENTS' | 'DESTINATION_CHAIN' {
  return operation === 'swap' || operation === 'confidential-transfer'
    ? 'CONFIDENTIAL_INTENTS'
    : 'DESTINATION_CHAIN'
}

function keepsFrozenConfidentialQuote(plan: {
  readonly operation?: string
  readonly purpose?: string
}): boolean {
  return (
    plan.operation === 'swap' ||
    plan.operation === 'confidential-transfer' ||
    plan.purpose === 'native-zec-swap'
  )
}

type ClusterFundingInput = Extract<PrepareConfidentialFundingInput, { operation: 'cluster' }>

function clusterDepositBinding(
  input: ClusterFundingInput,
  identity: ConfidentialSigningIdentity,
  near: NearIncognitoClusterPlan | null
) {
  // The NEAR plan carries the confidential principal as signerId and the NEAR
  // sender as refundTo. A failed deposit therefore refunds on NEAR.
  return {
    originAsset: input.source.protocolAssetId,
    destinationAsset: input.source.protocolAssetId,
    amountRaw: input.source.amountRaw,
    signerId: near?.signerId ?? identity.address,
    refundTo:
      near?.refundTo ??
      (input.sourceDomain === 'private' ? identity.peaAddress.toLowerCase() : identity.address),
    recipient: near?.signerId ?? identity.address,
    depositType: 'ORIGIN_CHAIN' as const,
    refundType: 'ORIGIN_CHAIN' as const,
    recipientType: 'CONFIDENTIAL_INTENTS' as const,
    slippageBps: input.slippageBps
  }
}

export interface ConfidentialFundingCoordinatorOptions {
  readonly network: Network
  readonly api: ConfidentialFundingApi
  readonly store: ChromeConfidentialFundingStore
  readonly signer: ConfidentialFundingSigner
  readonly repository: TransactionRepository
  readonly assets: AssetRegistry
  readonly evmNetworks: readonly EvmNetworkConfig[]
  readonly assetMappings: readonly ConfidentialPortfolioAssetMapping[]
  readonly protocolTokens?: readonly SwapToken[]
  readonly getProtocolTokens?: () => readonly SwapToken[]
  readonly getNativeZecActiveAccount?: () => NativeZecActiveAccountSnapshot
  readonly scheduleMonitoring?: (delayInMinutes?: number) => Promise<void>
  readonly refreshPortfolio?: (
    target: Readonly<{
      keyDomainId: string
      accountId: string
      chainIds: readonly string[]
      domain?: 'chain' | 'confidential'
      balanceUpdated?: true
    }>
  ) => Promise<void>
  readonly onActivityChanged?: (
    scope: Readonly<{
      network: Network
      keyDomainId: string
      accountId: string
    }>
  ) => Promise<void>
  readonly now?: () => number
  readonly createId?: () => string
  readonly nearDeposit?: Readonly<{
    resolveAccount(identity: ConfidentialSigningIdentity): Promise<NearConfidentialAccount>
    adapter: ConfidentialDepositAdapter
    broadcastSignedTransaction(rawTransaction: string): Promise<string>
    getTransactionStatus(transactionHash: string, signerId: string): Promise<NearTransactionStatus>
  }>
}

function isPositiveRaw(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value)
}

function isRawAmount(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value)
}

/**
 * A Shield receive is settled only by this deposit address's provider amount.
 * An account-wide balance change can belong to another transfer of the same asset.
 */
function shieldDepositHasArrived(input: {
  readonly protocolStatus: string
  readonly settledAmountOutRaw: string | undefined
  readonly minimumOutputRaw: string
}): boolean {
  const normalized = normalizeStatus(input.protocolStatus)
  return (
    (normalized === 'SUCCESS' || normalized === 'COMPLETED') &&
    input.settledAmountOutRaw !== undefined &&
    isPositiveRaw(input.settledAmountOutRaw) &&
    isRawAmount(input.minimumOutputRaw) &&
    BigInt(input.settledAmountOutRaw) >= BigInt(input.minimumOutputRaw)
  )
}

function quotedPrivacyFeeBps(quote: ConfidentialQuote | undefined): number | undefined {
  if (!quote) return undefined
  try {
    const bps = readConfidentialQuoteAppFees(quote).reduce((sum, fee) => sum + fee.fee, 0)
    return bps <= 10_000 ? bps : undefined
  } catch {
    return undefined
  }
}

function externalDepositSettlementError(
  settledAmountRaw: string | undefined,
  minimumOutputRaw: string
): string | undefined {
  return settledAmountRaw !== undefined &&
    isPositiveRaw(settledAmountRaw) &&
    BigInt(settledAmountRaw) < BigInt(minimumOutputRaw)
    ? 'DEPOSIT_AMOUNT_TOO_LOW'
    : undefined
}

function isBoundedLabel(value: string, maximumLength = 64): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
}

function quoteDeadline(quote: ConfidentialQuote): number {
  const value = Date.parse(quote.quote.deadline)
  if (!Number.isSafeInteger(value)) throw new Error('Confidential quote deadline is invalid')
  return value
}

function minimumAmountError(error: unknown): boolean {
  return (
    error instanceof ConfidentialFundingApiError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    /minimum|min(?:imum)? amount|too small|below/i.test(error.message)
  )
}

function quotedFeeTooSmall(error: unknown): boolean {
  return error instanceof Error && error.message === CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR
}

function authenticationError(error: unknown): boolean {
  if (error instanceof ConfidentialFundingApiError && [401, 403].includes(error.status ?? -1)) {
    return true
  }
  return (
    error instanceof Error &&
    /active software evm account|wallet account changed|locked|unlock|credential|authorization|session/i.test(
      error.message
    )
  )
}

function retryableFundingError(error: unknown): boolean {
  return (
    error instanceof ConfidentialFundingApiError &&
    (error.ambiguous ||
      error.status === null ||
      error.status >= 500 ||
      [408, 409, 425, 429].includes(error.status))
  )
}

function definitiveHistoryAuthRejection(error: unknown): boolean {
  return (
    error instanceof ConfidentialFundingApiError &&
    !error.ambiguous &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 408, 409, 425, 429].includes(error.status)
  )
}

function normalizeStatus(value: string): string {
  return value.trim().toUpperCase()
}

function shieldWithdrawStillReserves(row: ConfidentialFundingPlan['withdraws'][number]): boolean {
  const status = normalizeStatus(row.status)
  if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'REFUNDED') return false
  return (
    status === 'SIGNED' ||
    status === 'PROCESSING' ||
    row.signedPayload !== undefined ||
    row.intentHash !== undefined ||
    row.depositAddress.length > 0
  )
}

function failureCode(status: string): TransactionFailureCode {
  const normalized = normalizeStatus(status)
  if (normalized === 'REFUNDED') return 'refunded'
  if (normalized === 'EXPIRED') return 'expired'
  if (normalized === 'CANCELLED') return 'cancelled'
  return 'relay-failed'
}

function phaseForSettlement(
  settlement: ReturnType<typeof aggregateConfidentialSettlement>
): ConfidentialFundingPlan['phase'] {
  switch (settlement) {
    case 'success':
      return 'ready'
    case 'partial':
      return 'partial'
    case 'refunded':
      return 'refunded'
    case 'expired':
      return 'expired'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    default:
      return 'processing'
  }
}

function validQuoteTimeEstimateSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNearConfidentialDeposit(transfer: unknown): boolean {
  if (!transfer || typeof transfer !== 'object') return false
  const kind = (transfer as { kind?: unknown }).kind
  return kind === 'intents-deposit' || kind === 'confidential-ft-deposit'
}

function reviewNearPreparedDeposit(plan: ConfidentialFundingPlan) {
  const transfer = plan.preparedDeposit?.preparedTransfer
  if (!isNearConfidentialDeposit(transfer)) return null
  try {
    return parsePreparedNearConfidentialDeposit(transfer)
  } catch {
    return null
  }
}

function reviewFromPlan(
  plan: ConfidentialFundingPlan,
  assets: AssetRegistry
): ConfidentialFundingReview {
  const nearKind =
    reviewNearPreparedDeposit(plan) !== null ||
    isNearConfidentialDeposit(plan.preparedDeposit?.preparedTransfer)
  const nearPrepared = nearKind ? reviewNearPreparedDeposit(plan) : null
  const prepared =
    nearKind || !plan.preparedDeposit
      ? null
      : parsePreparedEvmTransfer(plan.preparedDeposit.preparedTransfer)
  const sourceFeeAsset = nearPrepared
    ? assets.list(parseChainId('near:mainnet').id).find(entry => entry.asset.kind === 'native')
    : prepared
      ? assets
          .list(parseChainId(plan.source.chainId).id)
          .find(entry => entry.asset.kind === 'native')
      : undefined
  const quoteTimeEstimateSeconds =
    plan.operation === 'deposit'
      ? plan.depositQuote?.quote.timeEstimate
      : plan.operation === 'swap' ||
          plan.operation === 'confidential-transfer' ||
          plan.purpose === 'native-zec-swap'
        ? plan.swapQuote?.quote.timeEstimate
        : plan.operation === 'withdraw'
          ? plan.quoteTimeEstimateSeconds
          : undefined
  return Object.freeze({
    planId: plan.planId,
    ...(plan.purpose ? { purpose: plan.purpose } : {}),
    ...(plan.operation ? { operation: plan.operation } : {}),
    ...(plan.sourceDomain ? { sourceDomain: plan.sourceDomain } : {}),
    ...(plan.destinationDomain ? { destinationDomain: plan.destinationDomain } : {}),
    network: plan.network,
    keyDomainId: plan.keyDomainId,
    accountId: plan.accountId,
    transactionId: plan.transactionId,
    phase: plan.phase,
    payloadFingerprint: plan.approvalFingerprint,
    expiresAt: plan.approvalExpiresAt,
    requiresDeposit: plan.requiresDeposit,
    ...(plan.depositQuote?.quote.depositAddress
      ? { depositAddress: plan.depositQuote.quote.depositAddress }
      : {}),
    sourceAmountRaw: plan.source.amountRaw,
    expectedOutputRaw: plan.expectedOutputRaw,
    minimumOutputRaw: plan.minimumOutputRaw,
    sourceAddress: plan.source.address,
    destinationAddress: plan.destination.address,
    ...(plan.externalRecipient ? { externalRecipient: plan.externalRecipient } : {}),
    withdrawCount: plan.withdraws.length,
    ...(validQuoteTimeEstimateSeconds(quoteTimeEstimateSeconds)
      ? { quoteTimeEstimateSeconds }
      : {}),
    ...(plan.operation === 'swap' || plan.purpose === 'native-zec-swap'
      ? {
          slippageBps: plan.slippageBps,
          ...(plan.swapQuote?.quote.withdrawFee !== undefined
            ? { quoteWithdrawFeeRaw: plan.swapQuote.quote.withdrawFee }
            : {}),
          ...(plan.swapQuote?.quote.refundFee !== undefined
            ? { quoteRefundFeeRaw: plan.swapQuote.quote.refundFee }
            : {}),
          quoteAppFeeBps: Array.isArray(plan.swapQuote?.quoteRequest.appFees)
            ? plan.swapQuote.quoteRequest.appFees.reduce(
                (total: number, fee: unknown) =>
                  total +
                  (fee &&
                  typeof fee === 'object' &&
                  typeof (fee as { fee?: unknown }).fee === 'number'
                    ? (fee as { fee: number }).fee
                    : 0),
                0
              )
            : 0
        }
      : {}),
    ...(nearPrepared && sourceFeeAsset
      ? {
          sourceNetworkFee: Object.freeze({
            raw: nearPrepared.maximumFeeYocto,
            symbol: sourceFeeAsset.metadata.symbol,
            decimals: sourceFeeAsset.metadata.decimals
          })
        }
      : {}),
    ...(prepared && sourceFeeAsset
      ? {
          sourceNetworkFee: Object.freeze({
            raw: (
              BigInt(prepared.transaction.gasLimit) *
              BigInt(
                prepared.transaction.type === 'legacy'
                  ? prepared.transaction.gasPrice
                  : prepared.transaction.maxFeePerGas
              )
            ).toString(),
            symbol: sourceFeeAsset.metadata.symbol,
            decimals: sourceFeeAsset.metadata.decimals
          }),
          sourceEvmFee: Object.freeze({
            transactionType: prepared.transaction.type,
            gasLimit: prepared.transaction.gasLimit,
            ...(prepared.transaction.type === 'legacy'
              ? { gasPriceWei: prepared.transaction.gasPrice }
              : {
                  maxFeePerGasWei: prepared.transaction.maxFeePerGas,
                  maxPriorityFeePerGasWei: prepared.transaction.maxPriorityFeePerGas
                })
          })
        }
      : {})
  })
}

export function confidentialSigningChainId(
  sourceChainId: string,
  destinationChainId: string,
  network?: Network
): ChainId {
  const destination = parseChainId(destinationChainId)
  if (destination.namespace === 'eip155') return destination.id
  const source = parseChainId(sourceChainId)
  if (source.namespace === 'eip155') return source.id
  if (destination.namespace === 'near') return destination.id
  if (source.namespace === 'near') return source.id
  if (!network) throw new Error('Confidential funding requires an EVM signing chain')
  return parseChainId(getEvmNetworkConfig(network).chainId).id
}

function confidentialSignerFamily(chainId: string | undefined): 'evm' | 'near' {
  if (!chainId) return 'evm'
  try {
    return parseChainId(chainId).namespace === 'near' ? 'near' : 'evm'
  } catch {
    return 'evm'
  }
}

function confidentialIntentStandard(chainId: string | undefined): 'erc191' | 'nep413' {
  return confidentialSignerFamily(chainId) === 'near' ? 'nep413' : 'erc191'
}

function directApprovalIntent(plan: ConfidentialFundingPlan): unknown {
  return {
    network: plan.network,
    keyDomainId: plan.keyDomainId,
    accountId: plan.accountId,
    operation: plan.operation,
    sourceDomain: plan.sourceDomain,
    destinationDomain: plan.destinationDomain,
    source: plan.source,
    destination: plan.destination,
    signerId: plan.signerId,
    externalRecipient: plan.externalRecipient,
    purpose: plan.purpose,
    addressIndex: plan.addressIndex,
    slippageBps: plan.slippageBps,
    expectedOutputRaw: plan.expectedOutputRaw,
    minimumOutputRaw: plan.minimumOutputRaw,
    expiresAt: plan.approvalExpiresAt,
    depositQuote: plan.depositQuote,
    swapQuote: plan.swapQuote,
    reviewedAppFeesFingerprint: plan.reviewedAppFeesFingerprint,
    preparedDeposit: plan.preparedDeposit,
    withdraws: plan.withdraws
  }
}

function nearCatalogProtocolMapped(assetId: string, protocolAssetId: string): boolean {
  return (
    readEnabledChainFeatureFlags().includes(NEAR_CHAIN_FEATURE_FLAG) &&
    protocolAssetId !== NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID &&
    nearConfidentialPortfolioAssetId(protocolAssetId) === assetId
  )
}

function nearConfidentialProtocolAccepted(
  assetId: string,
  protocolAssetId: string,
  operation?: string
): boolean {
  if (protocolAssetId === NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID) {
    // Native NEAR and wNEAR share nep141:wrap.near. wNEAR is a cluster move only.
    return (
      nearConfidentialPortfolioAssetId(protocolAssetId) === assetId ||
      (operation === 'cluster' && isNearWrappedProtocolAsset(assetId, protocolAssetId))
    )
  }
  return nearCatalogProtocolMapped(assetId, protocolAssetId)
}

export class ConfidentialFundingCoordinator {
  private readonly balanceRefreshes = new Map<
    string,
    DedupPromise<readonly ConfidentialBalance[]>
  >()
  private readonly rpcByChain = new Map<string, EvmTransactionRpc & EvmBroadcastRpc>()
  private readonly evmDepositAdapter: ConfidentialDepositAdapter
  private readonly clusterDepositPrefetches = new Map<
    string,
    { expiresAt: number; quote: Promise<ConfidentialQuote> }
  >()
  private readonly continuingByPlan = new Map<string, Promise<ConfidentialFundingPlan>>()
  private readonly confirmingByPlan = new Map<
    string,
    Readonly<{
      fingerprint: string
      promise: Promise<ConfidentialFundingPlan>
    }>
  >()
  private readonly cancellingPlans = new Set<string>()
  private readonly refreshingExternalDeposits = new Map<
    string,
    Readonly<{ promise: Promise<ExternalShieldDeposit>; force: boolean }>
  >()
  private readonly oneClickStatusQueries = new Map<string, Promise<ConfidentialStatus>>()
  private readonly oneClickStatusState = new Map<
    string,
    | { kind: 'fresh'; until: number; status: ConfidentialStatus }
    | { kind: 'backoff'; until: number; backoffMs: number }
  >()
  private readonly externalBalanceRefreshQueues = new Map<string, Promise<void>>()
  private readonly reconciledTerminalExternalDeposits = new Set<string>()
  private readonly prepareQueue = new SerialTaskQueue()
  private readonly reservationQueue = new SerialTaskQueue()
  private readonly nativeZecIntents: NativeZecIntentsSwapCoordinator
  private readonly shieldDapp: ShieldDappCoordinator
  private readonly now: () => number
  private readonly createId: () => string

  constructor(private readonly options: ConfidentialFundingCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
    const nativeIdentity = async (scope: { walletId: string; accountId: string }) => {
      const chainId = options.evmNetworks[0]?.chainId
      if (!chainId) throw new Error('Native ZEC Confidential identity is unavailable')
      const identity = await options.signer.resolveIdentity(parseChainId(chainId).id)
      if (
        identity.context.chainAccount.scope.keyDomainId !== scope.walletId ||
        identity.context.chainAccount.scope.accountId !== scope.accountId
      )
        throw new Error('Native ZEC Confidential account changed')
      return identity
    }
    this.nativeZecIntents = new NativeZecIntentsSwapCoordinator({
      ...options,
      getActiveAccount: options.getNativeZecActiveAccount,
      resolveConfidentialIdentity: async scope => (await nativeIdentity(scope)).address,
      authorizeConfidentialIdentity: async scope => {
        const identity = await nativeIdentity(scope)
        if (identity.address !== scope.recipient)
          throw new Error('Native ZEC Confidential account changed')
        await this.ensureSession(identity, true)
      },
      quoteConfidential: input =>
        options.api.quote({
          referral: NOIR_SWAP_REFERRAL,
          ...input,
          recipient: input.signerId,
          depositType: 'ORIGIN_CHAIN',
          refundType: 'ORIGIN_CHAIN',
          recipientType: 'CONFIDENTIAL_INTENTS',
          dry: false
        })
    })
    for (const network of options.evmNetworks) {
      this.rpcByChain.set(network.chainId, createConfiguredEvmRpcClient(options.network, network))
    }
    this.evmDepositAdapter = new EvmConfidentialDepositAdapter(
      options.signer,
      options.assets,
      chainId => this.requireRpc(chainId)
    )
    this.shieldDapp = new ShieldDappCoordinator({
      network: options.network,
      api: options.api,
      store: options.store,
      signer: options.signer,
      assets: options.assets,
      evmNetworks: options.evmNetworks,
      assetMappings: options.assetMappings,
      protocolTokens: options.protocolTokens,
      getProtocolTokens: options.getProtocolTokens,
      now: this.now,
      prepare: value => this.prepare(value),
      refreshBalances: (scope, authorize) => this.refreshBalances(scope, authorize),
      requireConfidentialSession: scope => this.requireConfidentialSession(scope, true),
      refreshExternalDeposit: depositId => this.refreshExternalDeposit(depositId),
      continuePlan: planId => this.continuePlan(planId),
      updatePlan: (plan, changes) => this.updatePlan(plan, changes),
      readUsableSessionForPlan: plan => this.readUsableSessionForPlan(plan),
      finishArrivedShieldDeposit: plan => this.finishArrivedShieldDeposit(plan),
      isIdleShieldPlan: plan =>
        plan.phase === 'prepared' ||
        needsConfidentialSubmissionCheck(plan) ||
        (isTerminalPhase(plan.phase) && !isRecoverableLocalFailure(plan))
    })
  }

  private depositAdapter(
    identity: ConfidentialSigningIdentity,
    route: { readonly sourceChainId: string; readonly destinationChainId: string }
  ): ConfidentialDepositAdapter {
    if (
      parseChainId(route.sourceChainId).namespace === 'near' ||
      parseChainId(route.destinationChainId).namespace === 'near'
    ) {
      const adapter = this.options.nearDeposit?.adapter
      if (!adapter || adapter.kind !== 'near') {
        throw new Error('NEAR Shield deposit is unavailable')
      }
      return adapter
    }
    if (!isEvmConfidentialDepositIdentity(identity)) {
      throw new Error('Confidential funding requires an EVM signing chain')
    }
    return this.evmDepositAdapter
  }

  private async quoteBound(
    input: Parameters<ConfidentialFundingApi['quote']>[0]
  ): Promise<ConfidentialQuote> {
    const normalized = normalizeNearConfidentialQuote(input)
    const quote = await this.options.api.quote(normalized)
    if (isNearChainConfidentialProtocolAsset(normalized.originAsset) && quote.quote.depositMemo) {
      throw new Error('NEAR Shield quote must not include a memo')
    }
    return quote
  }

  private assertQuoteBinding(
    quote: ConfidentialQuote,
    binding: Parameters<typeof assertConfidentialQuoteBinding>[1],
    _now?: number
  ): void {
    assertStoredConfidentialQuoteBinding(quote, normalizeNearConfidentialQuote(binding), this.now())
  }

  private async requireNearAccount(
    identity: ConfidentialSigningIdentity
  ): Promise<NearConfidentialAccount> {
    const resolve = this.options.nearDeposit?.resolveAccount
    if (!resolve) throw new Error('NEAR Shield deposit is unavailable')
    const account = await resolve(identity)
    try {
      if (parseNearAccountId(account.mainAccountId) !== account.mainAccountId) {
        throw new Error('invalid')
      }
    } catch {
      throw new Error('NEAR Shield deposit requires the active NEAR account')
    }
    return account
  }

  private async nearDepositRefundAccount(
    identity: ConfidentialSigningIdentity,
    sourceDomain: 'public' | 'private' | 'shield'
  ): Promise<string> {
    const account = await this.requireNearAccount(identity)
    if (sourceDomain === 'private') {
      if (!account.peaAccountId || account.peaAccountId === account.mainAccountId) {
        throw new Error('NEAR Shield deposit requires an Incognito account')
      }
      return account.peaAccountId
    }
    return account.mainAccountId
  }

  private async fundingDestinationAddress(
    input: {
      readonly destination: { readonly chainId: string }
      readonly destinationDomain?: 'public' | 'private' | 'shield'
      readonly externalRecipient?: string
    },
    identity: ConfidentialSigningIdentity
  ): Promise<string> {
    if (input.externalRecipient) return input.externalRecipient
    if (
      parseChainId(input.destination.chainId).namespace === 'near' &&
      (input.destinationDomain === 'public' || input.destinationDomain === 'private')
    ) {
      const account = await this.requireNearAccount(identity)
      if (input.destinationDomain === 'private') {
        if (!account.peaAccountId || account.peaAccountId === account.mainAccountId) {
          throw new Error('NEAR Shield withdraw requires an Incognito account')
        }
        return account.peaAccountId
      }
      return account.mainAccountId
    }
    return input.destinationDomain === 'private' ? identity.peaAddress : identity.address
  }

  getPortfolioAssetDefinitions(model: PortfolioReadModel | null): readonly AssetDefinitionInput[] {
    if (!model) return []
    return Object.freeze(
      model.assets.flatMap(asset => {
        if (asset.source !== 'protocol' || !asset.asset.chainId.startsWith('eip155:')) return []
        const entry = this.options.assets.get(asset.asset.id)
        if (!entry || entry.source !== 'protocol' || entry.verification !== 'trusted') return []
        return [
          Object.freeze({
            chainId: entry.asset.chainId,
            namespace: entry.asset.namespace,
            reference: entry.asset.reference,
            kind: entry.asset.kind,
            metadata: entry.metadata,
            source: entry.source,
            verification: entry.verification
          })
        ]
      })
    )
  }

  prepareNativeZecIntentsSwap(input: PrepareNativeZecIntentsSwapInput) {
    return this.nativeZecIntents.prepare(input)
  }

  getNativeZecIntentsSwap(quoteId: string) {
    return this.nativeZecIntents.get(quoteId)
  }

  cancelNativeZecIntentsSwap(quoteId: string) {
    return this.nativeZecIntents.cancel(quoteId)
  }

  claimNativeZecIntentsSpend(
    input: Readonly<{
      walletId: string
      accountId: string
      transactionId: string
      binding: QuoteBinding
      to: string
      amount: string
      fundingSource: string
    }>
  ) {
    return this.nativeZecIntents.claimSpend(input)
  }

  async createExternalDeposit(
    input: CreateExternalShieldDepositInput
  ): Promise<ExternalShieldDeposit> {
    return this.prepareQueue.run(async () => {
      let stage: ExternalShieldDepositFailureStage = 'request'
      try {
        return await this.createExternalDepositExclusive(input, next => {
          stage = next
        })
      } catch (error) {
        throw new ExternalShieldDepositError(stage, error)
      }
    })
  }

  hasExternalDepositAsset(source: CreateExternalShieldDepositInput['source']): boolean {
    const asset = this.options.assets.get(source.assetId)
    if (!asset) return false
    const catalog = this.options.getProtocolTokens?.() ?? this.options.protocolTokens
    if (catalog && asset.asset.namespace === 'erc20') {
      // A contract may have multiple protocol representations. Bind the selected one
      // independently of the portfolio's single default mapping for that contract.
      const token = catalog.find(item => item.assetId === source.protocolAssetId)
      const resolved = token ? resolveIntentsEvmAssets([token], this.options.evmNetworks)[0] : null
      return Boolean(
        resolved &&
        resolved.assetId === source.assetId &&
        resolved.chainId === source.chainId &&
        resolved.decimals === asset.metadata.decimals
      )
    }
    if (catalog && asset.asset.namespace === 'nep141') {
      // A NEAR fungible token is bound from the selected catalog row. Native NEAR stays
      // on the wrap.near mapping because its wallet asset is not an NEP-141 id.
      const token = catalog.find(item => item.assetId === source.protocolAssetId)
      return Boolean(
        token &&
        !isDeprecatedIntentsToken(token) &&
        token.blockchain.trim().toLowerCase() === 'near' &&
        token.decimals === asset.metadata.decimals &&
        source.chainId === 'near:mainnet' &&
        nearConfidentialPortfolioAssetId(token.assetId) === source.assetId
      )
    }
    return this.options.assetMappings.some(
      mapping =>
        mapping.assetId === source.assetId && mapping.protocolAssetId === source.protocolAssetId
    )
  }

  private hasConfidentialProtocolMapping(
    assetId: string,
    protocolAssetId: string,
    operation?: string
  ): boolean {
    return (
      this.options.assetMappings.some(
        mapping => mapping.assetId === assetId && mapping.protocolAssetId === protocolAssetId
      ) ||
      nearCatalogProtocolMapped(assetId, protocolAssetId) ||
      (operation === 'cluster' &&
        readEnabledChainFeatureFlags().includes(NEAR_CHAIN_FEATURE_FLAG) &&
        isNearWrappedProtocolAsset(assetId, protocolAssetId))
    )
  }

  hasCurrentFundingAssets(input: PrepareConfidentialFundingInput): boolean {
    const catalog = this.options.getProtocolTokens?.() ?? this.options.protocolTokens
    if (!catalog) return true
    return [input.source, input.destination].every(route => {
      const token = catalog.find(item => item.assetId === route.protocolAssetId)
      const registered = this.options.assets.get(route.assetId)
      return (
        token !== undefined &&
        registered !== undefined &&
        token.blockchain === route.chainName &&
        token.decimals === registered.metadata.decimals &&
        this.hasConfidentialProtocolMapping(route.assetId, route.protocolAssetId, input.operation)
      )
    })
  }

  private async createExternalDepositExclusive(
    input: CreateExternalShieldDepositInput,
    setStage: (stage: ExternalShieldDepositFailureStage) => void
  ): Promise<ExternalShieldDeposit> {
    const chain = parseChainId(input.source.chainId)
    const isZcash = chain.id === getZcashChainId(this.options.network)
    const isNear = chain.id === 'near:mainnet'
    const asset = this.options.assets.get(input.source.assetId)
    const minimumMode = input.source.amountRaw === undefined
    const slippageBps = input.slippageBps === undefined ? (minimumMode ? 0 : 50) : input.slippageBps
    if (
      input.network !== this.options.network ||
      (!isZcash && !isNear && chain.namespace !== 'eip155') ||
      (isNear && !isNearChainConfidentialProtocolAsset(input.source.protocolAssetId)) ||
      parseAssetId(input.source.assetId).chainId !== chain.id ||
      !asset ||
      !this.hasExternalDepositAsset(input.source) ||
      (input.source.amountRaw !== undefined && !isPositiveRaw(input.source.amountRaw)) ||
      !Number.isSafeInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps > 10_000 ||
      !isBoundedLabel(input.source.chainName) ||
      !isBoundedLabel(input.keyDomainId, 512) ||
      !isBoundedLabel(input.accountId, 512) ||
      (input.requestId !== undefined && !isBoundedLabel(input.requestId, 160))
    )
      throw new Error('External Shield deposit request is invalid')
    const catalog = this.options.getProtocolTokens?.() ?? this.options.protocolTokens
    const token = catalog?.find(item => item.assetId === input.source.protocolAssetId)
    if (catalog) {
      if (!token) throw new Error('External Shield deposit asset catalog changed')
      const blockchain = token.blockchain.trim().toLowerCase()
      const tokenChainId =
        blockchain === 'zec' || blockchain === 'zcash'
          ? getZcashChainId(this.options.network)
          : blockchain === 'near'
            ? this.options.network === 'mainnet'
              ? 'near:mainnet'
              : null
            : resolveIntentsEvmChainId(token.blockchain, this.options.evmNetworks)
      if (tokenChainId !== chain.id || token?.decimals !== asset.metadata.decimals) {
        throw new Error('External Shield deposit asset catalog changed')
      }
    }
    const refundAddress = isNear ? input.refundAddress.trim().toLowerCase() : input.refundAddress
    if (isZcash) {
      if (
        !parseZcashAddress(refundAddress, input.network).scheme.startsWith('zcash-transparent-')
      ) {
        throw new Error('External Shield deposit requires a transparent Zcash refund address')
      }
    } else if (!isAddress(refundAddress) || /^0x0{40}$/i.test(refundAddress)) {
      throw new Error('External Shield deposit refund address is invalid')
    }
    setStage('account')
    const identityChain = isZcash || isNear ? this.options.evmNetworks[0]?.chainId : chain.id
    if (!identityChain) throw new Error('External Shield deposit Account has no EVM identity')
    const identity = await this.options.signer.resolveIdentity(parseChainId(identityChain).id)
    if (
      identity.context.chainAccount.scope.keyDomainId !== input.keyDomainId ||
      identity.context.chainAccount.scope.accountId !== input.accountId
    ) {
      throw new Error('External Shield deposit Account changed')
    }
    const existing = input.requestId
      ? (await this.options.store.listExternalDeposits()).find(
          record =>
            record.network === input.network &&
            record.keyDomainId === input.keyDomainId &&
            record.accountId === input.accountId &&
            record.requestId === input.requestId
        )
      : undefined
    if (existing) {
      if (
        existing.phase === 'awaiting-payment' &&
        isExternalShieldDepositExpired(existing, this.now())
      ) {
        throw new Error('External Shield deposit quote has expired; create a new request')
      }
      if (
        existing.source.chainId !== input.source.chainId ||
        existing.source.chainName !== input.source.chainName ||
        existing.source.assetId !== input.source.assetId ||
        existing.source.protocolAssetId !== input.source.protocolAssetId ||
        (input.source.amountRaw === undefined
          ? existing.amountMode !== 'minimum'
          : existing.amountMode === 'minimum' ||
            existing.source.amountRaw !== input.source.amountRaw) ||
        existing.refundAddress !== refundAddress ||
        existing.slippageBps !== slippageBps ||
        existing.signerId !== identity.address
      ) {
        throw new Error('External Shield deposit request ID was reused with different details')
      }
      return existing
    }
    setStage('quote')
    const quote = minimumMode
      ? await this.options.api.quoteFlexibleDeposit({
          originAsset: input.source.protocolAssetId,
          quoteAmountRaw: externalShieldQuoteAmountRaw(asset.metadata.decimals, token?.price),
          signerId: identity.address,
          refundTo: refundAddress,
          slippageBps
        })
      : await this.quoteBound({
          referral: NOIR_RECEIVE_REFERRAL,
          originAsset: input.source.protocolAssetId,
          destinationAsset: input.source.protocolAssetId,
          amountRaw: input.source.amountRaw!,
          signerId: identity.address,
          refundTo: refundAddress,
          recipient: identity.address,
          depositType: 'ORIGIN_CHAIN',
          refundType: 'ORIGIN_CHAIN',
          recipientType: 'CONFIDENTIAL_INTENTS',
          slippageBps,
          dry: false
        })
    const amountRaw = minimumMode ? quote.quote.amountIn : input.source.amountRaw!
    const binding = {
      originAsset: input.source.protocolAssetId,
      destinationAsset: input.source.protocolAssetId,
      amountRaw,
      signerId: identity.address,
      refundTo: refundAddress,
      recipient: identity.address,
      depositType: 'ORIGIN_CHAIN' as const,
      refundType: 'ORIGIN_CHAIN' as const,
      recipientType: 'CONFIDENTIAL_INTENTS' as const,
      slippageBps
    }
    if (minimumMode) assertFlexibleExternalDepositQuoteBinding(quote, binding, this.now())
    else this.assertQuoteBinding(quote, binding)
    if (isZcash && quote.quoteRequest.refundTo !== refundAddress) {
      throw new Error('External Shield quote changed its Zcash refund address')
    }
    if (isNear) {
      if (quote.quote.depositMemo) throw new Error('NEAR Shield quote must not include a memo')
      assertNearConfidentialDepositAddress(quote.quote.depositAddress)
    } else if (isZcash) {
      parseZcashAddress(quote.quote.depositAddress, input.network)
    } else if (
      !isAddress(quote.quote.depositAddress) ||
      /^0x0{40}$/i.test(quote.quote.depositAddress)
    ) {
      throw new Error('External Shield quote has an invalid deposit address')
    }
    if (
      (await this.options.store.listExternalDeposits()).some(
        record =>
          record.network === input.network &&
          record.source.chainId === input.source.chainId &&
          (isZcash
            ? record.depositAddress === quote.quote.depositAddress
            : record.depositAddress.toLowerCase() === quote.quote.depositAddress.toLowerCase()) &&
          record.depositMemo === quote.quote.depositMemo
      )
    )
      throw new Error('External Shield service reused a deposit address')
    setStage('account')
    const currentIdentity = await this.options.signer.resolveIdentity(
      parseChainId(identityChain).id
    )
    if (
      currentIdentity.context.chainAccount.scope.keyDomainId !== input.keyDomainId ||
      currentIdentity.context.chainAccount.scope.accountId !== input.accountId ||
      currentIdentity.address !== identity.address ||
      currentIdentity.addressIndex !== identity.addressIndex
    ) {
      throw new Error('External Shield deposit Account changed after quoting')
    }
    setStage('authorization')
    await this.ensureSession(currentIdentity, true)
    setStage('account')
    const activeIdentity = await this.options.signer.resolveIdentity(parseChainId(identityChain).id)
    if (
      activeIdentity.context.chainAccount.scope.keyDomainId !== input.keyDomainId ||
      activeIdentity.context.chainAccount.scope.accountId !== input.accountId ||
      activeIdentity.address !== identity.address ||
      activeIdentity.addressIndex !== identity.addressIndex
    ) {
      throw new Error('External Shield deposit Account changed after authorization')
    }
    const depositId = this.createId()
    const createdAt = this.now()
    const record: ExternalShieldDeposit = Object.freeze({
      schemaVersion: 1,
      depositId,
      transactionId: `tx:confidential-external:${depositId}`,
      network: input.network,
      keyDomainId: input.keyDomainId,
      accountId: input.accountId,
      source: Object.freeze({ ...input.source, amountRaw }),
      destinationAssetId: input.source.assetId,
      sourceSymbol: token?.symbol ?? asset.metadata.symbol,
      sourceDecimals: asset.metadata.decimals,
      signerId: identity.address,
      depositAddress: quote.quote.depositAddress,
      ...(!isNear && quote.quote.depositMemo ? { depositMemo: quote.quote.depositMemo } : {}),
      refundAddress,
      amountRaw,
      ...(minimumMode ? { amountMode: 'minimum' as const } : {}),
      expectedOutputRaw: quote.quote.amountOut,
      minimumOutputRaw: quote.quote.minAmountOut,
      slippageBps: binding.slippageBps,
      expiresAt: quoteDeadline(quote),
      phase: 'awaiting-payment',
      ...(input.requestId ? { requestId: input.requestId } : {}),
      quote,
      createdAt,
      updatedAt: createdAt
    })
    setStage('storage')
    await this.options.store.putExternalDeposit(record)
    await this.scheduleMonitoring()
    return record
  }

  async getExternalDeposit(depositId: string): Promise<ExternalShieldDeposit> {
    const record = await this.options.store.getExternalDeposit(depositId)
    if (!record || record.network !== this.options.network)
      throw new Error('External Shield deposit is unavailable')
    return record
  }

  async listExternalDeposits(
    scope: ExternalShieldDepositScope
  ): Promise<readonly ExternalShieldDeposit[]> {
    if (
      scope.network !== this.options.network ||
      !isBoundedLabel(scope.keyDomainId, 512) ||
      !isBoundedLabel(scope.accountId, 512)
    )
      throw new Error('External Shield deposit scope is invalid')
    return Object.freeze(
      (await this.options.store.listExternalDeposits())
        .filter(
          record =>
            record.network === scope.network &&
            record.keyDomainId === scope.keyDomainId &&
            record.accountId === scope.accountId
        )
        .sort((left, right) => right.createdAt - left.createdAt)
    )
  }

  private oneClickStatusKey(depositAddress: string, depositMemo?: string): string {
    return `${depositAddress}\0${depositMemo ?? ''}`
  }

  private async fetchOneClickDepositStatus(
    depositAddress: string,
    depositMemo?: string,
    force = false
  ): Promise<ConfidentialStatus> {
    const key = this.oneClickStatusKey(depositAddress, depositMemo)
    const pending = this.oneClickStatusQueries.get(key)
    if (pending) return pending
    const state = this.oneClickStatusState.get(key)
    if (state && this.now() < state.until) {
      if (state.kind === 'backoff')
        throw new ConfidentialFundingApiError('Deposit status polling is in backoff', 429, true)
      if (!force) return state.status
    }

    const operation = this.options.api
      .getOneClickStatus(depositAddress, depositMemo)
      .then(status => {
        this.oneClickStatusState.set(key, {
          kind: 'fresh',
          until: this.now() + EXTERNAL_DEPOSIT_STATUS_FRESH_MS,
          status
        })
        return status
      })
      .catch(error => {
        if (retryableFundingError(error)) {
          const previous = this.oneClickStatusState.get(key)
          const backoffMs = Math.min(
            Math.max(
              (previous?.kind === 'backoff'
                ? previous.backoffMs
                : EXTERNAL_DEPOSIT_STATUS_BACKOFF_INITIAL_MS / 2) * 2,
              EXTERNAL_DEPOSIT_STATUS_BACKOFF_INITIAL_MS
            ),
            EXTERNAL_DEPOSIT_STATUS_BACKOFF_MAX_MS
          )
          this.oneClickStatusState.set(key, {
            kind: 'backoff',
            until: this.now() + backoffMs,
            backoffMs
          })
        }
        throw error
      })
      .finally(() => {
        if (this.oneClickStatusQueries.get(key) === operation) {
          this.oneClickStatusQueries.delete(key)
        }
      })
    this.oneClickStatusQueries.set(key, operation)
    return operation
  }

  private async readExternalDepositProviderStatus(
    record: ExternalShieldDeposit,
    force = false
  ): Promise<ConfidentialStatus | null> {
    try {
      return await this.fetchOneClickDepositStatus(record.depositAddress, record.depositMemo, force)
    } catch (error) {
      if (
        error instanceof ConfidentialFundingApiError &&
        (error.ambiguous || error.status === 429)
      ) {
        return null
      }
      if (retryableFundingError(error)) return null
      throw error
    }
  }

  async refreshExternalDeposit(depositId: string, force = true): Promise<ExternalShieldDeposit> {
    const pending = this.refreshingExternalDeposits.get(depositId)
    if (pending) {
      return force && !pending.force
        ? pending.promise.then(
            () => this.refreshExternalDeposit(depositId, true),
            () => this.refreshExternalDeposit(depositId, true)
          )
        : pending.promise
    }
    const operation = this.refreshExternalDepositExclusive(depositId, force).finally(() => {
      if (this.refreshingExternalDeposits.get(depositId)?.promise === operation) {
        this.refreshingExternalDeposits.delete(depositId)
      }
    })
    this.refreshingExternalDeposits.set(depositId, { promise: operation, force })
    return operation
  }

  private async refreshExternalDepositExclusive(
    depositId: string,
    force: boolean
  ): Promise<ExternalShieldDeposit> {
    let record = await this.getExternalDeposit(depositId)
    if (record.phase === 'ready') {
      if (record.settledOutputRaw === undefined) {
        const status = await this.readExternalDepositProviderStatus(record, force)
        if (!status) {
          await this.scheduleMonitoring()
          return record
        }
        const normalized = normalizeStatus(status.status)
        if (
          (normalized === 'SUCCESS' || normalized === 'COMPLETED') &&
          status.settledAmountOutRaw &&
          isPositiveRaw(status.settledAmountOutRaw)
        ) {
          const previous = record
          record = Object.freeze({
            ...record,
            settledOutputRaw: status.settledAmountOutRaw,
            errorStatus:
              status.errorStatus ??
              record.errorStatus ??
              externalDepositSettlementError(status.settledAmountOutRaw, record.minimumOutputRaw),
            updatedAt: this.now()
          })
          await this.options.store.putExternalDeposit(record)
          const event = projectExternalDepositResult(
            previous,
            record,
            this.options.assets,
            quotedPrivacyFeeBps(record.quote)
          )
          if (event) trackEvent(event.name, event.options)
        } else {
          await this.scheduleMonitoring()
        }
      }
      await this.updateExternalDepositGraph(record)
      record = await this.refreshExternalDepositBalance(record)
      await this.markExternalDepositGraphReconciled(record)
      return record
    }
    if (record.phase === 'refunded') {
      await this.updateExternalDepositGraph(record)
      await this.markExternalDepositGraphReconciled(record)
      return record
    }
    const status = await this.readExternalDepositProviderStatus(record, force)
    if (!status) {
      await this.scheduleMonitoring()
      return record
    }
    const normalized = normalizeStatus(status.status)
    if (
      ![
        'PENDING_DEPOSIT',
        'INCOMPLETE_DEPOSIT',
        'KNOWN_DEPOSIT_TX',
        'PROCESSING',
        'PENDING',
        'SUCCESS',
        'COMPLETED',
        'REFUNDED',
        'FAILED',
        'CANCELLED',
        'EXPIRED'
      ].includes(normalized)
    )
      return record
    const observedPhase: ExternalShieldDeposit['phase'] =
      normalized === 'SUCCESS' || normalized === 'COMPLETED'
        ? 'ready'
        : normalized === 'REFUNDED'
          ? 'refunded'
          : ['FAILED', 'CANCELLED'].includes(normalized)
            ? 'failed'
            : ['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'EXPIRED'].includes(normalized)
              ? 'awaiting-payment'
              : 'processing'
    const nextPhase =
      record.phase === 'processing' && observedPhase === 'awaiting-payment'
        ? 'processing'
        : observedPhase
    if (record.phase === 'failed' && nextPhase !== 'refunded') {
      await this.updateExternalDepositGraph(record)
      return record
    }
    const depositedAmountRaw =
      status.depositedAmountRaw !== undefined &&
      (record.depositedAmountRaw === undefined ||
        BigInt(status.depositedAmountRaw) > BigInt(record.depositedAmountRaw))
        ? status.depositedAmountRaw
        : record.depositedAmountRaw
    const newlySettled =
      nextPhase === 'ready' &&
      status.settledAmountOutRaw !== undefined &&
      isPositiveRaw(status.settledAmountOutRaw) &&
      record.settledOutputRaw === undefined
    const errorStatus =
      status.errorStatus ??
      (nextPhase === 'ready'
        ? externalDepositSettlementError(status.settledAmountOutRaw, record.minimumOutputRaw)
        : undefined)
    const fundingObservedAt =
      record.fundingObservedAt ??
      (hasExternalShieldDepositFunding(record) ||
      hasExternalShieldDepositFunding({
        ...record,
        phase: nextPhase,
        providerStatus: normalized,
        depositedAmountRaw
      })
        ? this.now()
        : undefined)
    if (
      nextPhase !== record.phase ||
      errorStatus !== record.errorStatus ||
      depositedAmountRaw !== record.depositedAmountRaw ||
      normalized !== record.providerStatus ||
      fundingObservedAt !== record.fundingObservedAt ||
      newlySettled
    ) {
      const previous = record
      record = Object.freeze({
        ...record,
        phase: nextPhase,
        providerStatus: normalized,
        ...(fundingObservedAt !== undefined ? { fundingObservedAt } : {}),
        ...(depositedAmountRaw !== undefined ? { depositedAmountRaw } : {}),
        errorStatus,
        ...(nextPhase === 'ready' &&
        status.settledAmountOutRaw &&
        isPositiveRaw(status.settledAmountOutRaw)
          ? { settledOutputRaw: status.settledAmountOutRaw }
          : {}),
        updatedAt: this.now()
      })
      await this.options.store.putExternalDeposit(record)
      const event = projectExternalDepositResult(
        previous,
        record,
        this.options.assets,
        quotedPrivacyFeeBps(record.quote)
      )
      if (event) trackEvent(event.name, event.options)
    }
    await this.updateExternalDepositGraph(record)
    if (record.phase === 'ready') record = await this.refreshExternalDepositBalance(record)
    await this.markExternalDepositGraphReconciled(record)
    if (shouldAutoRefreshExternalShieldDeposit(record, this.now())) await this.scheduleMonitoring()
    if (hasExternalShieldDepositFunding(record))
      void this.options.onActivityChanged?.(record).catch(() => {})
    return record
  }

  private async refreshExternalDepositBalance(
    record: ExternalShieldDeposit
  ): Promise<ExternalShieldDeposit> {
    const key = JSON.stringify([record.network, record.keyDomainId, record.accountId])
    const previous = this.externalBalanceRefreshQueues.get(key) ?? Promise.resolve()
    const result = previous.then(() => this.refreshExternalDepositBalanceExclusive(record))
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    this.externalBalanceRefreshQueues.set(key, settled)
    try {
      return await result
    } finally {
      if (this.externalBalanceRefreshQueues.get(key) === settled) {
        this.externalBalanceRefreshQueues.delete(key)
      }
    }
  }

  private async refreshExternalDepositBalanceExclusive(
    record: ExternalShieldDeposit
  ): Promise<ExternalShieldDeposit> {
    if (record.balanceRefreshedAt !== undefined) return record
    try {
      let session = await this.readUsableSessionForScope(record.keyDomainId, record.accountId)
      if (!session) {
        const identityChain =
          parseChainId(record.source.chainId).namespace === 'eip155'
            ? record.source.chainId
            : this.options.evmNetworks[0]?.chainId
        if (!identityChain) return record
        const identity = await this.options.signer.resolveIdentity(parseChainId(identityChain).id)
        if (
          identity.context.chainAccount.scope.keyDomainId !== record.keyDomainId ||
          identity.context.chainAccount.scope.accountId !== record.accountId ||
          identity.address !== record.signerId
        )
          return record
        session = await this.ensureSession(identity, true)
      }
      if (!session) return record
      const requestedAt = this.now()
      const balances = await this.options.api.getBalances(session.accessToken)
      await this.options.store.putBalances(
        record.network,
        record.keyDomainId,
        record.accountId,
        balances,
        requestedAt,
        record.signerId
      )
      const updated: ExternalShieldDeposit = Object.freeze({
        ...record,
        balanceRefreshedAt: this.now(),
        updatedAt: this.now()
      })
      await this.options.store.putExternalDeposit(updated)
      await this.options
        .refreshPortfolio?.({
          keyDomainId: record.keyDomainId,
          accountId: record.accountId,
          chainIds: [record.source.chainId],
          domain: 'confidential',
          balanceUpdated: true
        })
        .catch(() => {})
      return updated
    } catch {
      await this.scheduleMonitoring()
      return record
    }
  }

  private async updateExternalDepositGraph(record: ExternalShieldDeposit): Promise<void> {
    if (!hasExternalShieldDepositFunding(record)) return
    const scope = {
      keyDomainId: parseKeyDomainId(record.keyDomainId),
      accountId: parseAccountId(record.accountId)
    }
    const transactionId = parseTransactionId(record.transactionId)
    if (!(await this.options.repository.get(scope, transactionId))) {
      const result = await this.options.store.withExternalDepositScope(record, () =>
        this.options.repository.create(createExternalShieldDepositGraph(record))
      )
      if (result.status === 'id-conflict')
        throw new Error('External Shield deposit transaction ID conflicts')
    }
    for (const suffix of ['origin', 'relay', 'destination']) {
      const targetStatus =
        record.phase === 'ready' || (record.phase === 'refunded' && suffix === 'origin')
          ? 'final'
          : record.phase === 'refunded' || record.phase === 'failed'
            ? 'failed'
            : record.phase === 'processing'
              ? 'confirming'
              : 'created'
      if (targetStatus === 'created') continue
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const graph = await this.options.repository.get(scope, transactionId)
        const segment = graph?.segments.find(item => item.id.endsWith(`:${suffix}`))
        const settledAmount =
          suffix === 'destination' && record.phase === 'ready' && record.settledOutputRaw
            ? {
                assetId: parseAssetId(record.destinationAssetId).id,
                amountRaw: record.settledOutputRaw
              }
            : undefined
        if (
          !graph ||
          !segment ||
          (segment.status === targetStatus &&
            (settledAmount === undefined || segment.evidence?.settledAmount !== undefined)) ||
          (segment.status === 'final' && targetStatus !== 'final') ||
          segment.status === 'failed'
        )
          break
        // Release the metadata lock before applying: the committed event awaits observers that reacquire it.
        await this.options.store.withExternalDepositScope(record, async () => {})
        const result = await this.options.repository.applySegmentEvent({
          scope,
          transactionId,
          segmentId: segment.id,
          event: {
            id: parseTransactionEventId(`event:confidential-external:${crypto.randomUUID()}`),
            status: targetStatus,
            cause: targetStatus === 'failed' ? 'failure' : 'progress',
            observedAt: this.now(),
            ...(settledAmount ? { evidence: { settledAmount } } : {}),
            ...(targetStatus === 'failed'
              ? {
                  failure: {
                    code:
                      record.phase === 'refunded'
                        ? ('refunded' as const)
                        : ('relay-failed' as const),
                    occurredAt: this.now()
                  }
                }
              : {})
          },
          expectedRootRevision: graph.root.revision,
          expectedSegmentRevision: segment.revision
        })
        if (result.status !== 'revision-conflict') break
      }
    }
  }

  private async markExternalDepositGraphReconciled(record: ExternalShieldDeposit): Promise<void> {
    if (
      record.phase !== 'refunded' &&
      (record.phase !== 'ready' ||
        record.balanceRefreshedAt === undefined ||
        record.settledOutputRaw === undefined)
    )
      return
    const graph = await this.options.repository.get(
      {
        keyDomainId: parseKeyDomainId(record.keyDomainId),
        accountId: parseAccountId(record.accountId)
      },
      parseTransactionId(record.transactionId)
    )
    const destination = graph?.segments.find(segment => segment.role === 'destination')
    const reconciled =
      record.phase === 'ready'
        ? graph?.root.status === 'final' &&
          graph.segments.every(segment => segment.status === 'final') &&
          destination?.evidence?.settledAmount?.amountRaw === record.settledOutputRaw
        : graph?.root.status === 'failed' &&
          destination?.status === 'failed' &&
          graph.segments.every(segment => segment.status === 'final' || segment.status === 'failed')
    if (reconciled) this.reconciledTerminalExternalDeposits.add(record.depositId)
    else await this.scheduleMonitoring()
  }

  async preview(value: PrepareConfidentialFundingInput): Promise<ConfidentialFundingPreview>
  async preview(
    value: PrepareConfidentialFundingInput,
    clusterFeeOnly: true
  ): Promise<NonNullable<ConfidentialFundingReview['sourceNetworkFee']> | null>
  async preview(value: PrepareConfidentialFundingInput, clusterFeeOnly = false) {
    const input = this.parseInput(value)
    if (
      input.operation !== 'cluster' &&
      (clusterFeeOnly || (input.operation !== 'withdraw' && input.operation !== 'swap'))
    ) {
      throw new Error('Confidential preview route is invalid')
    }
    const sourceSigningChain =
      parseChainId(input.source.chainId).namespace === 'eip155'
        ? input.source.chainId
        : confidentialSigningChainId(input.source.chainId, input.destination.chainId, input.network)
    const destinationSigningChain = confidentialSigningChainId(
      input.source.chainId,
      input.destination.chainId,
      input.network
    )
    const sourceIdentity = await this.options.signer.resolveIdentity(sourceSigningChain)
    const destinationIdentity = await this.options.signer.resolveIdentity(destinationSigningChain)
    this.assertSameAccount(sourceIdentity, destinationIdentity)
    if (
      input.network !== this.options.network ||
      input.keyDomainId !== sourceIdentity.context.chainAccount.scope.keyDomainId ||
      input.accountId !== sourceIdentity.context.chainAccount.scope.accountId
    ) {
      throw new Error('Confidential funding account or network changed')
    }
    const nearShieldPrincipal = await this.nearDirectShieldPrincipal(sourceIdentity, input)
    if (input.operation !== 'cluster' || input.sourceDomain === 'shield') {
      const sessionIdentity =
        input.operation === 'cluster' && this.isNearIncognitoCluster(input)
          ? await this.nearClusterPrincipal(
              sourceIdentity,
              await this.requireNearAccount(sourceIdentity)
            )
          : (nearShieldPrincipal ?? sourceIdentity)
      const session = await this.options.store.getSession(
        input.network,
        input.keyDomainId,
        input.accountId,
        sessionIdentity.address
      )
      if (!session || session.expiresAt <= this.now() + SESSION_REFRESH_BUFFER_MS) {
        throw new Error(CONFIDENTIAL_SESSION_REQUIRED_ERROR)
      }
    }
    if (input.operation === 'cluster') {
      if (clusterFeeOnly)
        return this.previewClusterNetworkFee(input, sourceIdentity, sourceSigningChain)
      return this.previewCluster(input, sourceIdentity, destinationIdentity, sourceSigningChain)
    }
    const recipient = await this.fundingDestinationAddress(input, destinationIdentity)
    const shieldSpend =
      input.operation === 'withdraw' && input.sourceDomain === 'shield'
        ? await this.selectShieldConfidentialSpend({
            preferred: nearShieldPrincipal ?? sourceIdentity,
            near: () => this.nearExecutionIdentity(sourceIdentity),
            protocolAssetId: input.source.protocolAssetId,
            amountRaw: input.source.amountRaw,
            plans: (await this.options.store.listPlans()).filter(
              plan =>
                plan.network === input.network &&
                plan.keyDomainId === input.keyDomainId &&
                plan.accountId === input.accountId
            )
          })
        : null
    const binding = {
      originAsset: input.source.protocolAssetId,
      destinationAsset: input.destination.protocolAssetId,
      amountRaw: input.source.amountRaw,
      signerId: shieldSpend?.identity.address ?? sourceIdentity.address,
      recipient,
      depositType: 'CONFIDENTIAL_INTENTS' as const,
      refundType: 'CONFIDENTIAL_INTENTS' as const,
      recipientType:
        input.operation === 'swap'
          ? ('CONFIDENTIAL_INTENTS' as const)
          : ('DESTINATION_CHAIN' as const),
      slippageBps: input.slippageBps
    }
    const quote = await this.quoteBound({
      ...binding,
      referral: withdrawalReferral(input),
      dry: true
    })
    this.assertQuoteBinding(quote, binding, this.now())
    const currentIdentity = await this.options.signer.resolveIdentity(sourceSigningChain)
    this.assertSameAccount(sourceIdentity, currentIdentity)
    const requestDeadline = Date.parse(String(quote.quoteRequest.deadline ?? ''))
    const expiresAt = Number.isSafeInteger(requestDeadline)
      ? Math.min(quoteDeadline(quote), requestDeadline)
      : quoteDeadline(quote)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
      throw new Error('Confidential quote has expired')
    }
    const appFeeBps = readConfidentialQuoteAppFees(quote).reduce((sum, fee) => sum + fee.fee, 0)
    return Object.freeze({
      amountOutRaw: quote.quote.amountOut,
      minimumOutputRaw: quote.quote.minAmountOut,
      expiresAt,
      ...(appFeeBps === 0 ? {} : { appFeeBps }),
      ...(validQuoteTimeEstimateSeconds(quote.quote.timeEstimate)
        ? { timeEstimateSeconds: quote.quote.timeEstimate }
        : {})
    })
  }

  private async nearClusterPlan(
    input: ClusterFundingInput,
    identity: ConfidentialSigningIdentity
  ): Promise<NearIncognitoClusterPlan | null> {
    if (parseChainId(input.source.chainId).namespace !== 'near') return null
    if (input.source.chainId !== input.destination.chainId) throw new Error(NEAR_MOVE_UNAVAILABLE)
    let account: NearConfidentialAccount
    try {
      account = await this.requireNearAccount(identity)
    } catch (error) {
      if (error instanceof Error && error.message === 'NEAR Shield deposit is unavailable') {
        throw new Error(NEAR_MOVE_UNAVAILABLE)
      }
      throw error
    }
    const principal = await this.nearClusterPrincipal(identity, account)
    const planned = planNearIncognitoCluster({
      network: input.network,
      enabledFlags: readEnabledChainFeatureFlags(),
      from: input.sourceDomain,
      to: input.destinationDomain,
      mainAccountId: account.mainAccountId,
      peaAccountId: account.peaAccountId,
      accountIndex: account.accountIndex,
      walletSource: account.walletSource ?? null,
      confidentialPrincipal: principal.address,
      originAsset: input.source.protocolAssetId,
      destinationAsset: input.destination.protocolAssetId,
      amountRaw: input.source.amountRaw,
      slippageBps: input.slippageBps,
      implicitAccountOnChain: false
    })
    if (!planned.ok) throw new Error(planned.error)
    if (
      planned.signerId !== principal.address ||
      (principal.kind === 'evm'
        ? planned.intentStandard !== 'erc191' || planned.signerChainFamily !== 'evm'
        : planned.intentStandard !== 'nep413' || planned.signerChainFamily !== 'near')
    ) {
      throw new Error('Confidential funding account or network changed')
    }
    return planned
  }

  private async previewCluster(
    input: ClusterFundingInput,
    sourceIdentity: ConfidentialSigningIdentity,
    destinationIdentity: ConfidentialSigningIdentity,
    sourceSigningChain: ChainId
  ): Promise<ConfidentialFundingPreview> {
    const near = await this.nearClusterPlan(input, sourceIdentity)
    const destinationAddress =
      near?.withdrawRecipient ??
      (input.destinationDomain === 'private'
        ? destinationIdentity.peaAddress
        : destinationIdentity.address)
    const depositBinding = clusterDepositBinding(input, sourceIdentity, near)
    const depositQuote =
      input.sourceDomain === 'shield'
        ? undefined
        : await this.quoteBound({
            ...depositBinding,
            referral: NOIR_RECEIVE_REFERRAL,
            dry: true
          })
    if (depositQuote) this.assertQuoteBinding(depositQuote, depositBinding)
    let withdrawSigner = near?.signerId ?? sourceIdentity.address
    if (input.sourceDomain === 'shield') {
      const preferred = this.isNearIncognitoCluster(input)
        ? await this.nearClusterPrincipal(
            sourceIdentity,
            await this.requireNearAccount(sourceIdentity)
          )
        : sourceIdentity
      const selected = await this.selectShieldConfidentialSpend({
        preferred,
        near: () => this.nearExecutionIdentity(sourceIdentity),
        protocolAssetId: input.source.protocolAssetId,
        amountRaw: input.source.amountRaw,
        plans: (await this.options.store.listPlans()).filter(
          plan =>
            plan.network === input.network &&
            plan.keyDomainId === input.keyDomainId &&
            plan.accountId === input.accountId
        )
      })
      withdrawSigner = selected.identity.address
    }
    const previews = await this.prepareWithdrawPreviews({
      sourceAsset: input.source.protocolAssetId,
      destinationAsset: input.destination.protocolAssetId,
      spendRaw: depositQuote?.quote.amountOut ?? input.source.amountRaw,
      signerId: withdrawSigner,
      recipient: destinationAddress,
      slippageBps: input.slippageBps
    })
    const currentIdentity = await this.options.signer.resolveIdentity(sourceSigningChain)
    this.assertSameAccount(sourceIdentity, currentIdentity)
    const expiresAt = Math.min(
      ...(depositQuote ? [quoteDeadline(depositQuote)] : []),
      ...previews.quotes.map(quoteDeadline)
    )
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
      throw new Error('Confidential quote has expired')
    }
    const quoteTimes = previews.quotes.map(quote => quote.quote.timeEstimate)
    const validWithdrawTimes = quoteTimes.filter(validQuoteTimeEstimateSeconds)
    const depositTime = depositQuote?.quote.timeEstimate
    const timeEstimateSeconds =
      validWithdrawTimes.length === previews.quotes.length &&
      (!depositQuote || validQuoteTimeEstimateSeconds(depositTime))
        ? (depositTime ?? 0) + Math.max(...validWithdrawTimes)
        : undefined
    return Object.freeze({
      amountOutRaw: previews.quotes
        .reduce((sum, quote) => sum + BigInt(quote.quote.amountOut), 0n)
        .toString(),
      minimumOutputRaw: previews.quotes
        .reduce((sum, quote) => sum + BigInt(quote.quote.minAmountOut), 0n)
        .toString(),
      expiresAt,
      ...(timeEstimateSeconds !== undefined && validQuoteTimeEstimateSeconds(timeEstimateSeconds)
        ? { timeEstimateSeconds }
        : {})
    })
  }

  private async previewClusterNetworkFee(
    input: ClusterFundingInput,
    identity: ConfidentialSigningIdentity,
    chainId: ChainId
  ): Promise<NonNullable<ConfidentialFundingReview['sourceNetworkFee']> | null> {
    if (input.sourceDomain === 'shield') return null
    if (parseChainId(input.source.chainId).namespace === 'near') return null
    const feeAsset = this.options.assets.list(chainId).find(entry => entry.asset.kind === 'native')
    if (!feeAsset) return null
    try {
      const rpc = this.requireRpc(chainId)
      const quote = await this.clusterDepositQuote(input, identity, 'prefetch')
      const fee = await estimateEvmTransferFee({
        chainId,
        chainAccount: identity.context.chainAccount,
        ...(input.sourceDomain === 'private'
          ? {
              executionAccount: {
                kind: 'pea' as const,
                address: identity.peaAddress,
                addressIndex: identity.addressIndex
              }
            }
          : {}),
        assets: this.options.assets,
        intent: {
          assetId: input.source.assetId,
          recipient: quote.quote.depositAddress,
          amountRaw: input.source.amountRaw
        },
        rpc,
        ...(input.feeSelection ? { feeSelection: input.feeSelection } : { feeTier: input.feeTier })
      })
      this.assertSameAccount(identity, await this.options.signer.resolveIdentity(chainId))
      if (quoteDeadline(quote) <= this.now()) return null
      return Object.freeze({
        raw: fee.maximumFeeWei,
        symbol: feeAsset.metadata.symbol,
        decimals: feeAsset.metadata.decimals
      })
    } catch {
      return null
    }
  }

  private async clusterDepositQuote(
    input: ClusterFundingInput,
    identity: ConfidentialSigningIdentity,
    mode: 'prefetch' | 'review'
  ): Promise<ConfidentialQuote> {
    const near = await this.nearClusterPlan(input, identity)
    const binding = clusterDepositBinding(input, identity, near)
    const referral = NOIR_RECEIVE_REFERRAL
    const key = await fingerprintConfidentialValue({
      network: input.network,
      keyDomainId: input.keyDomainId,
      accountId: input.accountId,
      chainId: input.source.chainId,
      assetId: input.source.assetId,
      sourceDomain: input.sourceDomain,
      destinationDomain: input.destinationDomain,
      addressIndex: identity.addressIndex,
      binding,
      referral
    })
    const validate = (quote: ConfidentialQuote) => {
      this.assertQuoteBinding(quote, binding)
      if (quote.quoteRequest.dry !== false) {
        throw new Error('Confidential deposit quote has no destination')
      }
      if (parseChainId(input.source.chainId).namespace === 'near') {
        const accepted = acceptNearDirectDeposit({
          depositAddress: quote.quote.depositAddress,
          depositMemo: quote.quote.depositMemo
        })
        if (!accepted.ok) throw new Error(accepted.error)
      } else if (
        !isAddress(quote.quote.depositAddress) ||
        /^0x0{40}$/i.test(quote.quote.depositAddress)
      ) {
        throw new Error('Confidential deposit quote has no destination')
      }
      return quote
    }
    const fetchQuote = () => this.quoteBound({ ...binding, referral, dry: false }).then(validate)
    const cache = this.clusterDepositPrefetches
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= this.now()) cache.delete(key)
    }
    const existing = cache.get(key)
    if (existing) {
      try {
        const quote = validate(await existing.quote)
        if (mode === 'review' && cache.get(key) === existing) cache.delete(key)
        return quote
      } catch (error) {
        if (cache.get(key) === existing) cache.delete(key)
        if (mode === 'prefetch') throw error
      }
    }
    if (mode === 'review') return fetchQuote()
    if (cache.size >= MAX_CLUSTER_DEPOSIT_PREFETCHES)
      throw new Error('Cluster deposit prefetch is busy')
    const entry = { expiresAt: this.now() + CLUSTER_DEPOSIT_PREFETCH_MS, quote: fetchQuote() }
    cache.set(key, entry)
    try {
      const quote = await entry.quote
      entry.expiresAt = Math.min(entry.expiresAt, quoteDeadline(quote))
      return quote
    } catch (error) {
      if (cache.get(key) === entry) cache.delete(key)
      throw error
    }
  }

  async prepare(value: PrepareConfidentialFundingInput): Promise<ConfidentialFundingReview> {
    return this.prepareQueue.run(() => this.prepareExclusive(value))
  }

  private async prepareExclusive(
    value: PrepareConfidentialFundingInput
  ): Promise<ConfidentialFundingReview> {
    const input = this.parseInput(value)
    const sourceSigningChain =
      parseChainId(input.source.chainId).namespace === 'eip155'
        ? input.source.chainId
        : confidentialSigningChainId(input.source.chainId, input.destination.chainId, input.network)
    const destinationSigningChain = confidentialSigningChainId(
      input.source.chainId,
      input.destination.chainId,
      input.network
    )
    const sourceIdentity = await this.options.signer.resolveIdentity(sourceSigningChain)
    const destinationIdentity = await this.options.signer.resolveIdentity(destinationSigningChain)
    this.assertSameAccount(sourceIdentity, destinationIdentity)
    if (input.operation !== undefined) {
      if (
        input.network !== this.options.network ||
        input.keyDomainId !== sourceIdentity.context.chainAccount.scope.keyDomainId ||
        input.accountId !== sourceIdentity.context.chainAccount.scope.accountId
      )
        throw new Error('Confidential funding account or network changed')
      return this.reservationQueue.run(() =>
        input.operation === 'cluster'
          ? this.prepareCluster(input, sourceIdentity, destinationIdentity)
          : this.prepareDirect(input, sourceIdentity, destinationIdentity)
      )
    }

    const accountPlans = (await this.options.store.listPlans()).filter(
      plan =>
        plan.network === this.options.network &&
        plan.keyDomainId === sourceIdentity.context.chainAccount.scope.keyDomainId &&
        plan.accountId === sourceIdentity.context.chainAccount.scope.accountId
    )
    for (const expired of accountPlans.filter(
      plan => plan.phase === 'prepared' && plan.approvalExpiresAt <= this.now()
    )) {
      if (expired.preparedDeposit) {
        await this.depositAdapter(sourceIdentity, {
          sourceChainId: expired.source.chainId,
          destinationChainId: expired.destination.chainId
        })
          .cancelDeposit({
            identity: sourceIdentity,
            commandId: expired.preparedDeposit.commandId
          })
          .catch(() => {})
      }
      await this.options.store.deletePlan(expired.planId)
    }
    const activePlans = accountPlans.filter(
      plan =>
        !(plan.phase === 'prepared' && plan.approvalExpiresAt <= this.now()) &&
        (!isTerminalPhase(plan.phase) || isRecoverableLocalFailure(plan))
    )
    const dedupKey =
      input.dedupKey ??
      `private-funding:${await fingerprintConfidentialValue({
        source: input.source,
        destination: input.destination,
        slippageBps: input.slippageBps,
        feeTier: input.feeTier,
        feeSelection: input.feeSelection
      })}`
    const sourcePlans = activePlans
      .filter(
        plan =>
          plan.operation === undefined &&
          plan.source.protocolAssetId === input.source.protocolAssetId
      )
      .sort((left, right) => left.createdAt - right.createdAt)
    const duplicate = sourcePlans.find(plan => plan.dedupKey === dedupKey)
    if (duplicate) {
      if (duplicate.phase === 'prepared' || duplicate.phase === 'needs-auth') {
        return reviewFromPlan(duplicate, this.options.assets)
      }
      if (duplicate.phase === 'authorized' && !duplicate.preparedDeposit?.transactionHash) {
        if (duplicate.preparedDeposit) {
          return reviewFromPlan(
            await this.updatePlan(duplicate, { phase: 'prepared' }),
            this.options.assets
          )
        }
        await this.options.store.deletePlan(duplicate.planId)
      } else {
        return reviewFromPlan(await this.continuePlan(duplicate.planId), this.options.assets)
      }
    }

    for (const unsigned of sourcePlans.filter(plan => plan.phase === 'prepared')) {
      if (unsigned.preparedDeposit) {
        await this.depositAdapter(sourceIdentity, {
          sourceChainId: unsigned.source.chainId,
          destinationChainId: unsigned.destination.chainId
        })
          .cancelDeposit({
            identity: sourceIdentity,
            commandId: unsigned.preparedDeposit.commandId
          })
          .catch(() => {})
      }
      await this.options.store.deletePlan(unsigned.planId)
    }
    let existing = sourcePlans.find(plan => plan.phase !== 'prepared')
    if (existing?.phase === 'authorized' && !existing.preparedDeposit?.transactionHash) {
      if (!existing.preparedDeposit) {
        await this.options.store.deletePlan(existing.planId)
        existing = undefined
      } else {
        existing = await this.updatePlan(existing, { phase: 'prepared' })
      }
    } else if (existing) {
      existing = await this.continuePlan(existing.planId)
    }
    if (existing) {
      console.info('[Confidential Funding] Resuming active source plan', {
        planId: existing.planId,
        phase: existing.phase
      })
      return reviewFromPlan(existing, this.options.assets)
    }

    const session = await this.readUsableSession(sourceIdentity)
    // The approved source is the Main account. Existing Confidential funds are
    // tracked as the baseline and must never replace this transfer's deposit.
    const balances = session
      ? await this.readAndCacheBalances(sourceIdentity, session.accessToken)
      : Object.freeze([])
    const baseline = getConfidentialAvailableForAsset(balances, input.source.protocolAssetId) ?? '0'
    const requiresDeposit = true
    const depositQuote = await this.quoteBound({
      referral: NOIR_RECEIVE_REFERRAL,
      originAsset: input.source.protocolAssetId,
      destinationAsset: input.source.protocolAssetId,
      amountRaw: input.source.amountRaw,
      signerId: sourceIdentity.address,
      recipient: sourceIdentity.address,
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      recipientType: 'CONFIDENTIAL_INTENTS',
      slippageBps: input.slippageBps,
      dry: false
    })
    if (!depositQuote.quote.depositAddress) {
      throw new Error('Confidential deposit quote has no destination')
    }
    this.assertQuoteBinding(
      depositQuote,
      {
        originAsset: input.source.protocolAssetId,
        destinationAsset: input.source.protocolAssetId,
        amountRaw: input.source.amountRaw,
        signerId: sourceIdentity.address,
        recipient: sourceIdentity.address,
        depositType: 'ORIGIN_CHAIN',
        refundType: 'ORIGIN_CHAIN',
        recipientType: 'CONFIDENTIAL_INTENTS',
        slippageBps: input.slippageBps
      },
      this.now()
    )
    const spendRaw = depositQuote.quote.amountOut
    const previews = await this.prepareWithdrawPreviews({
      sourceAsset: input.source.protocolAssetId,
      destinationAsset: input.destination.protocolAssetId,
      spendRaw,
      signerId: sourceIdentity.address,
      recipient: destinationIdentity.peaAddress,
      slippageBps: input.slippageBps
    })

    const preparedDeposit: ConfidentialFundingPlan['preparedDeposit'] = await this.depositAdapter(
      sourceIdentity,
      {
        sourceChainId: input.source.chainId,
        destinationChainId: input.destination.chainId
      }
    ).prepareDeposit({
      identity: sourceIdentity,
      chainId: input.source.chainId,
      assetId: input.source.assetId,
      recipient: depositQuote.quote.depositAddress,
      amountRaw: input.source.amountRaw,
      ...(input.feeSelection ? { feeSelection: input.feeSelection } : { feeTier: input.feeTier })
    })

    const planId = this.createId()
    const createdAt = this.now()
    const expectedOutputRaw = previews.quotes
      .reduce((sum, quote) => sum + BigInt(quote.quote.amountOut), 0n)
      .toString()
    const minimumOutputRaw = previews.quotes
      .reduce((sum, quote) => sum + BigInt(quote.quote.minAmountOut), 0n)
      .toString()
    const approvalExpiresAt = Math.min(
      preparedDeposit?.expiresAt ?? Number.MAX_SAFE_INTEGER,
      quoteDeadline(depositQuote),
      ...previews.quotes.map(quoteDeadline)
    )
    const approvalFingerprint = await fingerprintConfidentialValue({
      network: this.options.network,
      source: input.source,
      destination: { ...input.destination, address: destinationIdentity.peaAddress },
      signerId: sourceIdentity.address,
      splitSourceAmounts: previews.amounts,
      expectedOutputRaw,
      minimumOutputRaw,
      depositAddress: depositQuote.quote.depositAddress,
      depositFingerprint: preparedDeposit.payloadFingerprint,
      expiresAt: approvalExpiresAt
    })
    const plan: ConfidentialFundingPlan = Object.freeze({
      schemaVersion: 1,
      planId,
      network: this.options.network,
      keyDomainId: sourceIdentity.context.chainAccount.scope.keyDomainId,
      accountId: sourceIdentity.context.chainAccount.scope.accountId,
      transactionId: `tx:confidential:${planId}`,
      phase: 'prepared',
      source: Object.freeze({ ...input.source, address: sourceIdentity.address }),
      destination: Object.freeze({ ...input.destination, address: destinationIdentity.peaAddress }),
      signerId: sourceIdentity.address,
      addressIndex: sourceIdentity.addressIndex,
      slippageBps: input.slippageBps,
      requiresDeposit,
      confidentialBaselineRaw: baseline,
      depositQuote,
      preparedDeposit,
      approvalFingerprint,
      approvalExpiresAt,
      expectedOutputRaw,
      minimumOutputRaw,
      splitSourceAmounts: previews.amounts,
      withdraws: Object.freeze(
        previews.quotes.map((quote, sequence) =>
          Object.freeze({
            sequence,
            sourceAmountRaw: previews.amounts[sequence],
            amountRaw: quote.quote.amountOut,
            depositAddress: '',
            destinationAddress: destinationIdentity.peaAddress,
            destinationChain: input.destination.chainName,
            token: input.destination.protocolAssetId,
            deadline: quoteDeadline(quote),
            status: 'PREPARED'
          })
        )
      ),
      dedupKey,
      createdAt,
      updatedAt: createdAt
    })
    await this.options.store.putPlan(plan)
    return reviewFromPlan(plan, this.options.assets)
  }

  private async prepareDirect(
    input: Extract<
      PrepareConfidentialFundingInput,
      { operation: 'deposit' | 'withdraw' | 'swap' | 'confidential-transfer' }
    >,
    sourceIdentity: ConfidentialSigningIdentity,
    destinationIdentity: ConfidentialSigningIdentity
  ): Promise<ConfidentialFundingReview> {
    const allPlans = (await this.options.store.listPlans()).filter(
      plan =>
        plan.network === input.network &&
        plan.keyDomainId === input.keyDomainId &&
        plan.accountId === input.accountId
    )
    for (const expired of allPlans.filter(
      plan =>
        plan.phase === 'prepared' &&
        plan.approvalExpiresAt <= this.now() &&
        !this.confirmingByPlan.has(plan.planId)
    )) {
      if (expired.preparedDeposit) {
        await this.depositAdapter(sourceIdentity, {
          sourceChainId: expired.source.chainId,
          destinationChainId: expired.destination.chainId
        })
          .cancelDeposit({
            identity: sourceIdentity,
            commandId: expired.preparedDeposit.commandId
          })
          .catch(() => {})
      }
      await this.options.store.deletePlan(expired.planId)
    }
    for (const orphan of allPlans.filter(
      plan => isUnsignedDirectWithdraw(plan) && !this.confirmingByPlan.has(plan.planId)
    ))
      await this.continuePlan(orphan.planId)
    const plans = (await this.options.store.listPlans()).filter(
      plan =>
        plan.network === input.network &&
        plan.keyDomainId === input.keyDomainId &&
        plan.accountId === input.accountId &&
        !(plan.phase === 'prepared' && plan.approvalExpiresAt <= this.now())
    )
    const dedupKey = `shield:${await fingerprintConfidentialValue(input)}`
    const duplicate = plans.find(
      plan => plan.operation === input.operation && plan.dedupKey === dedupKey
    )
    if (duplicate && duplicate.phase === 'prepared' && duplicate.approvalExpiresAt > this.now()) {
      return reviewFromPlan(duplicate, this.options.assets)
    }
    if (duplicate && !isTerminalPhase(duplicate.phase) && duplicate.phase !== 'prepared') {
      return reviewFromPlan(duplicate, this.options.assets)
    }

    const shieldWithdraw = input.operation === 'withdraw' && input.sourceDomain === 'shield'
    // The confidential principal owns the Shield balance and quote recipient.
    // The NEAR account only sends the deposit and receives a refund.
    const confidentialIdentity =
      input.operation === 'deposit' && parseChainId(input.source.chainId).namespace === 'near'
        ? await this.nearClusterPrincipal(
            sourceIdentity,
            await this.requireNearAccount(sourceIdentity)
          )
        : sourceIdentity
    // A same-chain NEAR unshield is signed by that principal. The route identity
    // is only the NEAR account that receives the withdrawal.
    const nearShieldPrincipal = await this.nearDirectShieldPrincipal(sourceIdentity, input)
    const selected = shieldWithdraw
      ? await this.selectShieldConfidentialSpend({
          preferred: nearShieldPrincipal ?? sourceIdentity,
          near: () => this.nearExecutionIdentity(sourceIdentity),
          protocolAssetId: input.source.protocolAssetId,
          amountRaw: input.source.amountRaw,
          plans
        })
      : null
    const sessionIdentity = selected?.identity ?? confidentialIdentity
    const session = selected?.session ?? (await this.readUsableSession(sessionIdentity))
    if (!session) throw new Error(CONFIDENTIAL_SESSION_REQUIRED_ERROR)
    const balances =
      selected?.balances ?? (await this.readAndCacheBalances(sessionIdentity, session.accessToken))
    const baseline = getConfidentialAvailableForAsset(balances, input.source.protocolAssetId) ?? '0'
    const spendIdentity = selected?.identity ?? confidentialIdentity
    const sourceAddress =
      input.sourceDomain === 'private'
        ? sourceIdentity.peaAddress.toLowerCase()
        : sourceIdentity.address
    const isConfidentialTransfer = input.operation === 'confidential-transfer'
    if (
      isConfidentialTransfer &&
      input.confidentialRecipient?.toLowerCase() === sourceIdentity.address.toLowerCase()
    ) {
      throw new Error('Shield recipient account is invalid.')
    }
    const destinationAddress = isConfidentialTransfer
      ? input.confidentialRecipient!
      : await this.fundingDestinationAddress(input, destinationIdentity)
    const isDeposit = input.operation === 'deposit'
    const depositRefundTo =
      isDeposit && parseChainId(input.source.chainId).namespace === 'near'
        ? await this.nearDepositRefundAccount(sourceIdentity, input.sourceDomain)
        : sourceAddress
    const isSwap = input.operation === 'swap'
    const isFrozenSwap = isSwap || input.purpose === 'native-zec-swap'
    const isFrozenQuote = isFrozenSwap || isConfidentialTransfer
    if (!isDeposit) {
      this.assertUnreservedBalance(
        plans,
        input.source.protocolAssetId,
        input.source.amountRaw,
        baseline,
        undefined,
        spendIdentity.address
      )
    }
    const quote = await this.quoteBound({
      originAsset: input.source.protocolAssetId,
      referral: input.operation === 'deposit' ? NOIR_RECEIVE_REFERRAL : withdrawalReferral(input),
      destinationAsset: isDeposit
        ? input.source.protocolAssetId
        : input.destination.protocolAssetId,
      amountRaw: input.source.amountRaw,
      signerId: spendIdentity.address,
      ...(isDeposit ? { refundTo: depositRefundTo } : {}),
      recipient: isDeposit ? spendIdentity.address : destinationAddress,
      depositType: isDeposit ? 'ORIGIN_CHAIN' : 'CONFIDENTIAL_INTENTS',
      refundType: isDeposit ? 'ORIGIN_CHAIN' : 'CONFIDENTIAL_INTENTS',
      recipientType:
        isDeposit || isSwap || isConfidentialTransfer
          ? 'CONFIDENTIAL_INTENTS'
          : 'DESTINATION_CHAIN',
      slippageBps: input.slippageBps,
      dry: !isDeposit && !isFrozenQuote
    })
    this.assertQuoteBinding(
      quote,
      {
        originAsset: input.source.protocolAssetId,
        destinationAsset: isDeposit
          ? input.source.protocolAssetId
          : input.destination.protocolAssetId,
        amountRaw: input.source.amountRaw,
        signerId: spendIdentity.address,
        ...(isDeposit ? { refundTo: depositRefundTo } : {}),
        recipient: isDeposit ? spendIdentity.address : destinationAddress,
        depositType: isDeposit ? 'ORIGIN_CHAIN' : 'CONFIDENTIAL_INTENTS',
        refundType: isDeposit ? 'ORIGIN_CHAIN' : 'CONFIDENTIAL_INTENTS',
        recipientType:
          isDeposit || isSwap || isConfidentialTransfer
            ? 'CONFIDENTIAL_INTENTS'
            : 'DESTINATION_CHAIN',
        slippageBps: input.slippageBps
      },
      this.now()
    )
    if (isDeposit && parseChainId(input.source.chainId).namespace === 'near') {
      if (quote.quote.depositMemo) throw new Error('NEAR Shield quote must not include a memo')
      assertNearConfidentialDepositAddress(quote.quote.depositAddress)
    } else if (isDeposit && !quote.quote.depositAddress) {
      throw new Error('Confidential deposit quote has no destination')
    }
    if (isFrozenQuote && (quote.quoteRequest.dry !== false || !quote.quote.depositAddress)) {
      throw new Error(
        isConfidentialTransfer
          ? 'Shield transfer quote has no active destination'
          : 'Shield swap quote has no active destination'
      )
    }

    const preparedDeposit = isDeposit
      ? await this.depositAdapter(sourceIdentity, {
          sourceChainId: input.source.chainId,
          destinationChainId: input.destination.chainId
        }).prepareDeposit({
          identity: sourceIdentity,
          chainId: parseChainId(input.source.chainId).id,
          assetId: input.source.assetId,
          recipient: quote.quote.depositAddress,
          amountRaw: input.source.amountRaw,
          sourceDomain: input.sourceDomain === 'private' ? 'private' : 'public',
          ...(input.feeSelection
            ? { feeSelection: input.feeSelection }
            : { feeTier: input.feeTier })
        })
      : undefined
    const createdAt = this.now()
    const planId = this.createId()
    const approvalExpiresAt = Math.min(
      quoteDeadline(quote),
      ...(isFrozenQuote ? [Date.parse(String(quote.quoteRequest.deadline ?? ''))] : []),
      preparedDeposit?.expiresAt ?? Number.MAX_SAFE_INTEGER
    )
    if (!Number.isSafeInteger(approvalExpiresAt) || approvalExpiresAt <= this.now()) {
      throw new Error('Shield quote has expired')
    }
    const draft: ConfidentialFundingPlan = Object.freeze({
      schemaVersion: 1,
      planId,
      network: input.network,
      keyDomainId: input.keyDomainId,
      accountId: input.accountId,
      operation: input.operation,
      sourceDomain: input.sourceDomain,
      destinationDomain: input.destinationDomain,
      transactionId: `tx:confidential:${planId}`,
      phase: 'prepared',
      source: Object.freeze({
        ...input.source,
        address: isDeposit ? sourceAddress : sourceIdentity.address
      }),
      destination: Object.freeze({ ...input.destination, address: destinationAddress }),
      signerId: spendIdentity.address,
      ...(input.externalRecipient ? { externalRecipient: input.externalRecipient } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      addressIndex: spendIdentity.addressIndex,
      slippageBps: input.slippageBps,
      requiresDeposit: isDeposit,
      confidentialBaselineRaw: baseline,
      ...(isDeposit ? { depositQuote: quote, preparedDeposit } : {}),
      ...(isFrozenQuote ? { swapQuote: quote } : {}),
      ...(!isDeposit && !isFrozenQuote && validQuoteTimeEstimateSeconds(quote.quote.timeEstimate)
        ? { quoteTimeEstimateSeconds: quote.quote.timeEstimate }
        : {}),
      ...(!isDeposit && !isFrozenQuote
        ? {
            reviewedAppFeesFingerprint: await fingerprintDirectConfidentialApproval([
              readConfidentialQuoteAppFees(quote)
            ])
          }
        : {}),
      approvalFingerprint: '0'.repeat(64),
      approvalExpiresAt,
      expectedOutputRaw: quote.quote.amountOut,
      minimumOutputRaw: quote.quote.minAmountOut,
      splitSourceAmounts: Object.freeze(isDeposit ? [] : [input.source.amountRaw]),
      withdraws: Object.freeze(
        isDeposit
          ? []
          : [
              {
                sequence: 0,
                sourceAmountRaw: input.source.amountRaw,
                amountRaw: quote.quote.amountOut,
                depositAddress: '',
                destinationAddress,
                destinationChain: input.destination.chainName,
                token: input.destination.protocolAssetId,
                deadline: quoteDeadline(quote),
                status: 'PREPARED'
              }
            ]
      ),
      dedupKey,
      createdAt,
      updatedAt: createdAt
    })
    const plan: ConfidentialFundingPlan = Object.freeze({
      ...draft,
      approvalFingerprint: await fingerprintDirectConfidentialApproval(directApprovalIntent(draft))
    })
    await this.options.store.putPlan(plan)
    return reviewFromPlan(plan, this.options.assets)
  }

  private async prepareCluster(
    input: ClusterFundingInput,
    sourceIdentity: ConfidentialSigningIdentity,
    destinationIdentity: ConfidentialSigningIdentity
  ): Promise<ConfidentialFundingReview> {
    const accountPlans = (await this.options.store.listPlans()).filter(
      plan =>
        plan.network === input.network &&
        plan.keyDomainId === input.keyDomainId &&
        plan.accountId === input.accountId
    )
    const dedupKey = `cluster:${await fingerprintConfidentialValue(input)}`
    const duplicate = accountPlans.find(
      plan =>
        plan.operation === 'cluster' &&
        plan.dedupKey === dedupKey &&
        (!isTerminalPhase(plan.phase) || plan.phase === 'prepared')
    )
    if (duplicate && (duplicate.phase !== 'prepared' || duplicate.approvalExpiresAt > this.now()))
      return reviewFromPlan(duplicate, this.options.assets)

    const requiresDeposit = input.sourceDomain !== 'shield'
    // On-chain funding reads the baseline at confirmation, before broadcasting the deposit.
    let baseline = '0'
    let spendIdentity: ConfidentialSigningIdentity | null = null
    if (!requiresDeposit) {
      const preferred = this.isNearIncognitoCluster(input)
        ? await this.nearClusterPrincipal(
            sourceIdentity,
            await this.requireNearAccount(sourceIdentity)
          )
        : sourceIdentity
      const selected = await this.selectShieldConfidentialSpend({
        preferred,
        near: () => this.nearExecutionIdentity(sourceIdentity),
        protocolAssetId: input.source.protocolAssetId,
        amountRaw: input.source.amountRaw,
        plans: accountPlans
      })
      spendIdentity = selected.identity
      baseline =
        getConfidentialAvailableForAsset(selected.balances, input.source.protocolAssetId) ?? '0'
      this.assertUnreservedBalance(
        accountPlans,
        input.source.protocolAssetId,
        input.source.amountRaw,
        baseline,
        undefined,
        spendIdentity.address
      )
    }
    const near = await this.nearClusterPlan(input, sourceIdentity)
    const sourceAddress =
      near?.sourceAddress ??
      (input.sourceDomain === 'private'
        ? sourceIdentity.peaAddress.toLowerCase()
        : sourceIdentity.address)
    const destinationAddress =
      near?.destinationAddress ??
      (input.destinationDomain === 'private'
        ? destinationIdentity.peaAddress
        : destinationIdentity.address)
    const depositQuote = requiresDeposit
      ? await this.clusterDepositQuote(input, sourceIdentity, 'review')
      : undefined
    const spendRaw = depositQuote?.quote.amountOut ?? input.source.amountRaw
    const withdrawSigner = spendIdentity?.address ?? near?.signerId ?? sourceIdentity.address
    const previews = await this.prepareWithdrawPreviews({
      sourceAsset: input.source.protocolAssetId,
      destinationAsset: input.destination.protocolAssetId,
      spendRaw,
      signerId: withdrawSigner,
      recipient: destinationAddress,
      slippageBps: input.slippageBps
    })
    const preparedDeposit = depositQuote
      ? await this.depositAdapter(sourceIdentity, {
          sourceChainId: input.source.chainId,
          destinationChainId: input.destination.chainId
        }).prepareDeposit({
          identity: sourceIdentity,
          chainId: parseChainId(input.source.chainId).id,
          assetId: input.source.assetId,
          recipient: depositQuote.quote.depositAddress,
          amountRaw: input.source.amountRaw,
          sourceDomain: input.sourceDomain as 'public' | 'private',
          ...(input.feeSelection
            ? { feeSelection: input.feeSelection }
            : { feeTier: input.feeTier })
        })
      : undefined
    const createdAt = this.now()
    const planId = this.createId()
    const expectedOutputRaw = previews.quotes
      .reduce((sum, quote) => sum + BigInt(quote.quote.amountOut), 0n)
      .toString()
    const minimumOutputRaw = previews.quotes
      .reduce((sum, quote) => sum + BigInt(quote.quote.minAmountOut), 0n)
      .toString()
    const approvalExpiresAt = Math.min(
      preparedDeposit?.expiresAt ?? Number.MAX_SAFE_INTEGER,
      depositQuote ? quoteDeadline(depositQuote) : Number.MAX_SAFE_INTEGER,
      ...previews.quotes.map(quoteDeadline)
    )
    const draft: ConfidentialFundingPlan = Object.freeze({
      schemaVersion: 1,
      operation: 'cluster',
      sourceDomain: input.sourceDomain,
      destinationDomain: input.destinationDomain,
      planId,
      network: input.network,
      keyDomainId: input.keyDomainId,
      accountId: input.accountId,
      transactionId: `tx:confidential:${planId}`,
      phase: 'prepared',
      source: Object.freeze({ ...input.source, address: sourceAddress }),
      destination: Object.freeze({ ...input.destination, address: destinationAddress }),
      signerId: withdrawSigner,
      addressIndex: spendIdentity?.addressIndex ?? sourceIdentity.addressIndex,
      slippageBps: input.slippageBps,
      requiresDeposit,
      confidentialBaselineRaw: baseline,
      ...(depositQuote && preparedDeposit ? { depositQuote, preparedDeposit } : {}),
      reviewedAppFeesFingerprint: await fingerprintDirectConfidentialApproval(
        previews.quotes.map(readConfidentialQuoteAppFees)
      ),
      approvalFingerprint: '0'.repeat(64),
      approvalExpiresAt,
      expectedOutputRaw,
      minimumOutputRaw,
      splitSourceAmounts: previews.amounts,
      withdraws: Object.freeze(
        previews.quotes.map((quote, sequence) =>
          Object.freeze({
            sequence,
            sourceAmountRaw: previews.amounts[sequence],
            amountRaw: quote.quote.amountOut,
            depositAddress: '',
            destinationAddress,
            destinationChain: input.destination.chainName,
            token: input.destination.protocolAssetId,
            deadline: quoteDeadline(quote),
            status: 'PREPARED'
          })
        )
      ),
      dedupKey,
      createdAt,
      updatedAt: createdAt
    })
    const plan: ConfidentialFundingPlan = Object.freeze({
      ...draft,
      approvalFingerprint: await fingerprintDirectConfidentialApproval(directApprovalIntent(draft))
    })
    await this.options.store.putPlan(plan)
    return reviewFromPlan(plan, this.options.assets)
  }

  private assertUnreservedBalance(
    plans: readonly ConfidentialFundingPlan[],
    protocolAssetId: string,
    amountRaw: string,
    availableRaw: string,
    excludingPlanId?: string,
    signerId?: string
  ): void {
    const reserved =
      this.reservedShieldBalances(plans, excludingPlanId, signerId).get(protocolAssetId) ?? 0n
    if (BigInt(amountRaw) + reserved > BigInt(availableRaw)) {
      throw new Error('Shield balance is insufficient for this transfer')
    }
  }

  private reservationMatchesSigner(plan: ConfidentialFundingPlan, signerId: string): boolean {
    if (isConfidentialEvmSigner(signerId)) return isConfidentialEvmSigner(plan.signerId)
    return plan.signerId === signerId
  }

  private reservedShieldBalances(
    plans: readonly ConfidentialFundingPlan[],
    excludingPlanId?: string,
    signerId?: string
  ): ReadonlyMap<string, bigint> {
    const reserved = new Map<string, bigint>()
    const now = this.now()
    for (const plan of plans) {
      if (
        plan.planId === excludingPlanId ||
        isTerminalPhase(plan.phase) ||
        (plan.phase === 'prepared' && plan.approvalExpiresAt <= now) ||
        (signerId !== undefined && !this.reservationMatchesSigner(plan, signerId))
      )
        continue
      const phase = plan.phase === 'needs-auth' ? plan.resumePhase : plan.phase
      const withdrawsInFlight = plan.withdraws.some(shieldWithdrawStillReserves)
      if (
        plan.requiresDeposit &&
        !withdrawsInFlight &&
        (plan.operation !== 'cluster' ||
          (phase !== 'signing-withdraws' && phase !== 'submitting' && phase !== 'processing'))
      )
        continue
      const assetId = plan.source.protocolAssetId
      const amount = plan.requiresDeposit
        ? plan.splitSourceAmounts.reduce((sum, amount) => sum + BigInt(amount), 0n)
        : BigInt(plan.source.amountRaw)
      reserved.set(assetId, (reserved.get(assetId) ?? 0n) + amount)
    }
    return reserved
  }

  async confirm(planId: string, approvalFingerprint: string): Promise<ConfidentialFundingPlan> {
    if (this.cancellingPlans.has(planId)) {
      throw new Error('Confidential funding plan is being cancelled')
    }
    const existing = this.confirmingByPlan.get(planId)
    if (existing) {
      if (existing.fingerprint !== approvalFingerprint) {
        throw new Error('Confidential funding approval does not match the prepared plan')
      }
      return existing.promise
    }
    const operation = this.confirmExclusive(planId, approvalFingerprint)
    this.confirmingByPlan.set(planId, { fingerprint: approvalFingerprint, promise: operation })
    void operation.then(
      plan => {
        if (this.confirmingByPlan.get(planId)?.promise === operation)
          this.confirmingByPlan.delete(planId)
        if (
          (plan.operation === 'withdraw' ||
            plan.operation === 'cluster' ||
            plan.operation === 'swap' ||
            plan.operation === 'confidential-transfer') &&
          plan.phase === 'authorized' &&
          !plan.requiresDeposit
        ) {
          void this.continuePlan(planId)
        }
      },
      () => {
        if (this.confirmingByPlan.get(planId)?.promise === operation)
          this.confirmingByPlan.delete(planId)
      }
    )
    return operation
  }

  private async confirmExclusive(
    planId: string,
    approvalFingerprint: string
  ): Promise<ConfidentialFundingPlan> {
    let plan = await this.requirePlan(planId)
    if (
      plan.approvalFingerprint !== approvalFingerprint ||
      !/^[0-9a-f]{64}$/.test(approvalFingerprint)
    ) {
      throw new Error('Confidential funding approval does not match the prepared plan')
    }
    if (
      plan.operation &&
      plan.phase === 'prepared' &&
      (await fingerprintDirectConfidentialApproval(directApprovalIntent(plan))) !==
        approvalFingerprint
    ) {
      throw new Error('Confidential funding approval content changed')
    }
    if (
      (plan.phase !== 'prepared' && plan.phase !== 'needs-auth') ||
      (plan.phase === 'prepared' && plan.approvalExpiresAt <= this.now())
    ) {
      throw new Error('Confidential funding approval is unavailable or expired')
    }
    const identity = await this.requirePlanIdentity(plan)
    const depositIdentity =
      parseChainId(plan.source.chainId).namespace === 'near' && identity.kind !== 'near'
        ? await this.options.signer.resolveIdentity(
            confidentialSigningChainId(plan.source.chainId, plan.destination.chainId, plan.network)
          )
        : identity
    if (keepsFrozenConfidentialQuote(plan) && plan.phase === 'prepared') {
      if (!plan.swapQuote) throw new Error('Shield swap quote is unavailable')
      if (Date.parse(String(plan.swapQuote.quoteRequest.deadline ?? '')) <= this.now()) {
        throw new Error('Shield swap quote has expired')
      }
      this.assertQuoteBinding(
        plan.swapQuote,
        {
          originAsset: plan.source.protocolAssetId,
          destinationAsset: plan.destination.protocolAssetId,
          amountRaw: plan.source.amountRaw,
          signerId: plan.signerId,
          recipient: plan.destination.address,
          depositType: 'CONFIDENTIAL_INTENTS',
          refundType: 'CONFIDENTIAL_INTENTS',
          recipientType: directConfidentialRecipientType(
            plan.purpose === 'native-zec-swap' ? 'withdraw' : plan.operation
          ),
          slippageBps: plan.slippageBps
        },
        this.now()
      )
    }
    await this.ensureSession(identity, true)
    await this.requirePlanIdentity(plan)
    if (plan.operation === 'cluster' && plan.phase === 'prepared') {
      const signerFamily = this.confidentialPlanSignerFamily(plan)
      if (signerFamily === 'evm') {
        try {
          await this.ensureOrderHistoryToken(plan)
        } catch (error) {
          if (definitiveHistoryAuthRejection(error)) {
            if (plan.preparedDeposit) {
              await this.depositAdapter(depositIdentity, {
                sourceChainId: plan.source.chainId,
                destinationChainId: plan.destination.chainId
              })
                .cancelDeposit({
                  identity: depositIdentity,
                  commandId: plan.preparedDeposit.commandId
                })
                .catch(() => {})
            }
            await this.updatePlan(plan, { phase: 'failed', errorStatus: 'HISTORY_AUTH_REJECTED' })
          }
          throw error
        }
      }
    }
    if (plan.phase === 'needs-auth') {
      plan = await this.updatePlan(plan, {
        phase: plan.resumePhase ?? 'authorized',
        resumePhase: undefined
      })
      void this.continuePlan(plan.planId)
      return plan
    }

    plan = await this.reconcileDepositRequirement(plan, identity)
    await this.requirePlanIdentity(plan)
    plan = await this.updatePlan(plan, { phase: 'authorized' })

    if (!plan.requiresDeposit) {
      if (
        plan.operation === 'withdraw' ||
        plan.operation === 'cluster' ||
        plan.operation === 'swap' ||
        plan.operation === 'confidential-transfer'
      ) {
        plan = await this.updatePlan(plan, { phase: 'signing-withdraws' })
        try {
          plan = await this.signAndFreezeWithdraws(plan)
        } catch (error) {
          const current = await this.requirePlan(planId)
          if (!current.frozenRequest && !current.withdraws.some(row => row.signedPayload)) {
            await this.updatePlan(current, {
              phase: 'failed',
              errorStatus: 'WITHDRAW_PREPARATION_FAILED'
            })
          } else {
            await this.scheduleMonitoring()
          }
          throw error
        }
        await this.scheduleMonitoring()
        void this.continuePlan(plan.planId)
        return plan
      }
      await this.ensureGraph(plan)
      void this.continuePlan(plan.planId)
      return plan
    }
    if (!plan.preparedDeposit) throw new Error('Confidential funding deposit was not prepared')
    let signed: Awaited<ReturnType<ConfidentialDepositAdapter['confirmDeposit']>>
    try {
      signed = await this.depositAdapter(depositIdentity, {
        sourceChainId: plan.source.chainId,
        destinationChainId: plan.destination.chainId
      }).confirmDeposit({
        identity: depositIdentity,
        commandId: plan.preparedDeposit.commandId,
        preparedTransfer: plan.preparedDeposit.preparedTransfer,
        ...(plan.operation === 'deposit' || plan.operation === 'cluster'
          ? { sourceDomain: plan.sourceDomain as 'public' | 'private' }
          : {})
      })
    } catch (error) {
      await this.updatePlan(plan, { phase: 'failed', errorStatus: 'DEPOSIT_SIGNING_INTERRUPTED' })
      throw error
    }
    plan = await this.updatePlan(plan, {
      phase: 'deposit-signed',
      preparedDeposit: Object.freeze({
        ...plan.preparedDeposit,
        rawTransaction: signed.rawTransaction,
        transactionHash: signed.transactionHash
      })
    })
    await this.ensureGraph(plan)
    if (parseChainId(plan.source.chainId).namespace === 'near') {
      const broadcast = await this.broadcastNearDeposit(plan)
      if (broadcast.phase !== 'deposit-confirming') {
        throw new Error('Confidential funding deposit is signed and will retry broadcasting')
      }
      plan = broadcast
    } else {
      try {
        await broadcastSignedEvmTransaction({
          rawTransaction: signed.rawTransaction,
          expectedTransactionHash: signed.transactionHash,
          rpc: this.requireRpc(plan.source.chainId)
        })
        plan = await this.updatePlan(plan, { phase: 'deposit-confirming' })
        await this.applyGraphStatus(plan, 'origin', 'broadcast', {
          transactionHash: signed.transactionHash
        })
      } catch {
        await this.scheduleMonitoring()
        throw new Error('Confidential funding deposit is signed and will retry broadcasting')
      }
    }
    await this.scheduleMonitoring()
    void this.continuePlan(plan.planId)
    return plan
  }

  async getPlan(planId: string): Promise<ConfidentialFundingPlan> {
    const plan = await this.requirePlan(planId)
    if (needsRefundObservation(plan)) return this.continuePlan(planId, true)
    return plan
  }

  async assertSpeedUpAllowed(graph: TransactionGraph): Promise<void> {
    const match = /^tx:confidential:([^:]+)$/.exec(graph.root.id)
    const plan = match ? await this.options.store.getPlan(match[1]) : null
    const origin = graph.segments.find(segment => segment.role === 'origin')
    const intent = graph.root.intent
    const quote = plan?.depositQuote
    const preparedDeposit = plan?.preparedDeposit
    const denied = (): never => {
      throw new EvmTransactionError('stale-nonce', 'Shield deposit can no longer be sped up')
    }
    if (
      !plan ||
      plan.network !== this.options.network ||
      graph.root.id !== plan.transactionId ||
      graph.root.scope.keyDomainId !== plan.keyDomainId ||
      graph.root.scope.accountId !== plan.accountId ||
      !plan.requiresDeposit ||
      !['deposit', 'cluster'].includes(plan.operation ?? '') ||
      !['public', 'private'].includes(plan.sourceDomain ?? '') ||
      !(
        ['deposit-confirming', 'deposit-signed'].includes(plan.phase) ||
        (plan.phase === 'needs-auth' &&
          ['deposit-confirming', 'deposit-signed'].includes(plan.resumePhase ?? ''))
      ) ||
      !quote ||
      !preparedDeposit?.transactionHash ||
      origin?.evidence?.transactionHash !== preparedDeposit.transactionHash ||
      !intent?.shield ||
      intent.shield.operation !== plan.operation ||
      intent.shield.sourceDomain !== plan.sourceDomain ||
      !intent.sender ||
      intent.sender.chainId !== plan.source.chainId ||
      !intent.primaryAmount ||
      intent.primaryAmount.assetId !== plan.source.assetId ||
      intent.primaryAmount.amountRaw !== plan.source.amountRaw ||
      !intent.evm?.unsignedTransaction
    ) {
      throw new EvmTransactionError('stale-nonce', 'Shield deposit can no longer be sped up')
    }
    const prepared = parsePreparedEvmTransfer(preparedDeposit.preparedTransfer)
    if (
      prepared.chainId !== plan.source.chainId ||
      prepared.assetId !== plan.source.assetId ||
      prepared.amountRaw !== plan.source.amountRaw ||
      prepared.recipient.toLowerCase() !== quote.quote.depositAddress.toLowerCase() ||
      prepared.from.toLowerCase() !== intent.sender.address.toLowerCase() ||
      prepared.transaction.nonce !== intent.evm.nonce ||
      JSON.stringify(prepared.transaction) !== JSON.stringify(intent.evm.unsignedTransaction) ||
      quoteDeadline(quote) <= this.now()
    ) {
      denied()
    }
  }

  async finalizeRejectedCluster(
    planId: string,
    reason: ClusterRejectionReason
  ): Promise<ConfidentialFundingPlan> {
    if (!isClusterRejectionReason(reason)) throw new Error('Cluster rejection reason is invalid')
    const inFlight = this.continuingByPlan.get(planId)
    if (inFlight) await inFlight
    let plan = await this.requirePlan(planId)
    if (plan.phase === 'failed' && plan.errorStatus === reason) return plan
    this.assertRejectedClusterCanFinalize(plan)
    if (isClusterRejectionReason(plan.errorStatus) && plan.errorStatus !== reason) {
      throw new Error('Cluster rejection reason cannot be changed')
    }
    if (plan.errorStatus !== reason) plan = await this.updatePlan(plan, { errorStatus: reason })
    return this.continuePlan(planId)
  }

  async checkSubmission(planId: string): Promise<ConfidentialFundingPlan> {
    const plan = await this.requirePlan(planId)
    if (!needsConfidentialSubmissionCheck(plan)) {
      throw new Error('This transfer does not need a submission check')
    }
    await this.requirePlanIdentity(plan)
    const signed = plan.withdraws.find(row => normalizeStatus(row.status) === 'SIGNED')
    if (
      signed &&
      !(await this.readStatus(plan, signed.depositAddress, 'before-submit', signed.sequence))
    ) {
      throw new Error('Transfer status is unavailable. Try again later.')
    }
    return this.continuePlan(planId)
  }

  private async nearExecutionIdentity(
    account: ConfidentialSigningIdentity
  ): Promise<ConfidentialSigningIdentity | null> {
    if (account.kind === 'near' && !isConfidentialEvmSigner(account.address)) return account
    if (this.options.network !== 'mainnet' && this.options.network !== 'testnet') return null
    const near = await this.options.signer
      .resolveIdentity(parseChainId(getNearNetworkConfig(this.options.network).chainId).id)
      .catch(() => null)
    if (
      !near ||
      near.kind !== 'near' ||
      isConfidentialEvmSigner(near.address) ||
      near.context.chainAccount.scope.keyDomainId !==
        account.context.chainAccount.scope.keyDomainId ||
      near.context.chainAccount.scope.accountId !== account.context.chainAccount.scope.accountId
    ) {
      return null
    }
    return near
  }

  private shieldBalanceCovers(
    plans: readonly ConfidentialFundingPlan[],
    protocolAssetId: string,
    amountRaw: string,
    balances: readonly ConfidentialBalance[],
    signerId: string,
    excludingPlanId?: string
  ): boolean {
    const available = getConfidentialAvailableForAsset(balances, protocolAssetId) ?? '0'
    const reserved =
      this.reservedShieldBalances(plans, excludingPlanId, signerId).get(protocolAssetId) ?? 0n
    return BigInt(amountRaw) + reserved <= BigInt(available)
  }

  // Shield spends one signer. An EVM identity spends its own snapshot even when
  // that snapshot is short. A NEAR-only identity spends its NEAR snapshot.
  private async selectShieldConfidentialSpend(input: {
    readonly preferred: ConfidentialSigningIdentity
    readonly near: () => Promise<ConfidentialSigningIdentity | null>
    readonly protocolAssetId: string
    readonly amountRaw: string
    readonly plans: readonly ConfidentialFundingPlan[]
    readonly excludingPlanId?: string
  }): Promise<
    Readonly<{
      identity: ConfidentialSigningIdentity
      balances: readonly ConfidentialBalance[]
      session: ConfidentialSession
    }>
  > {
    const preferredSession = await this.readUsableSession(input.preferred)
    if (!preferredSession) throw new Error(CONFIDENTIAL_SESSION_REQUIRED_ERROR)
    const preferredBalances = await this.readAndCacheBalances(
      input.preferred,
      preferredSession.accessToken
    )
    const preferredIsEvm =
      input.preferred.kind === 'evm' || isConfidentialEvmSigner(input.preferred.address)
    if (
      preferredIsEvm ||
      this.shieldBalanceCovers(
        input.plans,
        input.protocolAssetId,
        input.amountRaw,
        preferredBalances,
        input.preferred.address,
        input.excludingPlanId
      )
    ) {
      return {
        identity: input.preferred,
        balances: preferredBalances,
        session: preferredSession
      }
    }
    const near = await input.near().catch(() => null)
    if (near && near.address !== input.preferred.address) {
      const nearSession = await this.readUsableSession(near)
      if (nearSession) {
        const nearBalances = await this.readAndCacheBalances(near, nearSession.accessToken)
        if (
          this.shieldBalanceCovers(
            input.plans,
            input.protocolAssetId,
            input.amountRaw,
            nearBalances,
            near.address,
            input.excludingPlanId
          )
        ) {
          return { identity: near, balances: nearBalances, session: nearSession }
        }
      }
    }
    return {
      identity: input.preferred,
      balances: preferredBalances,
      session: preferredSession
    }
  }

  private shieldSpendableByProtocol(
    groups: readonly Readonly<{
      signerId: string
      balances: readonly ConfidentialBalance[]
    }>[],
    plans: readonly ConfidentialFundingPlan[]
  ): ReadonlyMap<string, bigint> {
    const availableBySigner = groups.map(group => ({
      reserved: this.reservedShieldBalances(plans, undefined, group.signerId),
      available: confidentialAvailableByProtocolAsset(group.balances)
    }))
    const protocolIds = new Set<string>()
    for (const group of availableBySigner) {
      for (const protocolAssetId of group.available.keys()) protocolIds.add(protocolAssetId)
    }
    const spendable = new Map<string, bigint>()
    for (const protocolAssetId of protocolIds) {
      let best = 0n
      for (const group of availableBySigner) {
        const amount = group.available.get(protocolAssetId) ?? 0n
        const reserved = group.reserved.get(protocolAssetId) ?? 0n
        const remaining = amount > reserved ? amount - reserved : 0n
        if (remaining > best) best = remaining
      }
      spendable.set(protocolAssetId, best)
    }
    return spendable
  }

  private directSpendSigningChainId(plan: ConfidentialFundingPlan): ChainId {
    if (
      !isConfidentialEvmSigner(plan.signerId) &&
      (plan.network === 'mainnet' || plan.network === 'testnet')
    ) {
      return parseChainId(getNearNetworkConfig(plan.network).chainId).id
    }
    const routeChain = confidentialSigningChainId(
      plan.source.chainId,
      plan.destination.chainId,
      plan.network
    )
    // The route id is NEAR, but an EVM principal signs an ERC-191 intent on its own chain.
    if (isConfidentialEvmSigner(plan.signerId) && parseChainId(routeChain).namespace === 'near') {
      return parseChainId(getEvmNetworkConfig(plan.network).chainId).id
    }
    return routeChain
  }

  // evmNetworks only selects the chain to ask about. An EVM key exists when that
  // chain resolves an identity of kind "evm" for this account. A NEAR-only key
  // cannot, and resolves the NEAR signer instead.
  private async confidentialPortfolioIdentity(scope: {
    readonly keyDomainId: string
    readonly accountId: string
  }): Promise<
    | { readonly kind: 'evm'; readonly identity: ConfidentialSigningIdentity }
    | { readonly kind: 'near'; readonly identity: ConfidentialSigningIdentity }
    | { readonly kind: 'none' }
  > {
    const sameAccount = (identity: ConfidentialSigningIdentity): boolean =>
      identity.context.chainAccount.scope.keyDomainId === scope.keyDomainId &&
      identity.context.chainAccount.scope.accountId === scope.accountId
    const firstEvm = this.options.evmNetworks[0]
    if (firstEvm) {
      const identity = await this.options.signer
        .resolveIdentity(parseChainId(firstEvm.chainId).id)
        .catch(() => null)
      if (identity && identity.kind === 'evm' && sameAccount(identity)) {
        return { kind: 'evm', identity }
      }
    }
    const near = await this.options.signer
      .resolveIdentity(parseChainId(getNearNetworkConfig(this.options.network).chainId).id)
      .catch(() => null)
    if (
      near &&
      near.kind === 'near' &&
      !isConfidentialEvmSigner(near.address) &&
      sameAccount(near)
    ) {
      return { kind: 'near', identity: near }
    }
    return { kind: 'none' }
  }

  async enrichPortfolio(
    model: PortfolioReadModel,
    refresh: boolean | 'if-stale' = true
  ): Promise<PortfolioReadModel> {
    const readEvmSnapshot = () =>
      this.options.store.getBalanceSnapshot(
        this.options.network,
        model.scope.keyDomainId,
        model.scope.accountId
      )
    const readSignerSnapshots = async () => {
      const listed = await this.options.store
        .listSignerBalanceSnapshots?.(
          this.options.network,
          model.scope.keyDomainId,
          model.scope.accountId
        )
        ?.catch(() => [])
      return (listed ?? []).filter(entry => !isConfidentialEvmSigner(entry.signerId))
    }
    const snapshot = await readEvmSnapshot()
    const signerSnapshots = await readSignerSnapshots()
    const project = async (
      current: typeof snapshot,
      signers: typeof signerSnapshots
    ): Promise<PortfolioReadModel> => {
      const evmKnown = current.known ?? current.fresh ?? current.updatedAt > 0
      const nearGroups = signers.filter(
        entry => entry.snapshot.known ?? entry.snapshot.fresh ?? entry.snapshot.updatedAt > 0
      )
      const included = [...(evmKnown ? [current] : []), ...nearGroups.map(entry => entry.snapshot)]
      const balancesKnown = included.length > 0
      const groups = [
        ...(evmKnown
          ? [{ signerId: CONFIDENTIAL_EVM_BALANCE_SIGNER, balances: current.balances }]
          : []),
        ...nearGroups.map(entry => ({
          signerId: entry.signerId,
          balances: entry.snapshot.balances
        }))
      ]
      const balances = balancesKnown ? combineConfidentialSignerBalances(groups) : null
      const fresh = balancesKnown && included.every(item => item.fresh)
      const updatedAt = balancesKnown ? Math.min(...included.map(item => item.updatedAt)) : 0
      const tokens = this.options.getProtocolTokens?.() ?? this.options.protocolTokens ?? []
      const managedAssets = (() => {
        if (balances === null) return []
        try {
          return resolveManagedIntentsAssets(tokens, this.options.network, this.options.evmNetworks)
        } catch {
          // A catalog conflict must not hide authenticated balances.
          return []
        }
      })()
      const portfolioMappings = filterConfidentialPortfolioMappings(
        this.options.assetMappings,
        this.options.network
      )
      const merged =
        balances === null
          ? model
          : mergeConfidentialBalancesIntoPortfolio(model, portfolioMappings, balances, {
              freshness: fresh ? 'fresh' : 'stale',
              updatedAt
            })
      const holdings =
        balances === null
          ? Object.freeze({
              status: 'unavailable' as const,
              freshness: 'unavailable' as const,
              updatedAt: 0,
              assets: Object.freeze([])
            })
          : Object.freeze({
              ...buildConfidentialPortfolioView(
                balances,
                tokens,
                managedAssets,
                portfolioMappings,
                this.options.assets
              ),
              freshness: fresh ? ('fresh' as const) : ('stale' as const),
              updatedAt
            })
      const accountPlans = holdings.assets.length
        ? (await this.options.store.listPlans()).filter(
            plan =>
              plan.network === this.options.network &&
              plan.keyDomainId === model.scope.keyDomainId &&
              plan.accountId === model.scope.accountId
          )
        : []
      const spendable = holdings.assets.length
        ? this.shieldSpendableByProtocol(groups, accountPlans)
        : new Map<string, bigint>()
      const confidential = Object.freeze({
        ...holdings,
        assets: Object.freeze(
          holdings.assets.map(asset =>
            Object.freeze({
              ...asset,
              spendableRaw: (spendable.get(asset.protocolAssetId) ?? 0n).toString()
            })
          )
        )
      })
      const projected = projectConfidentialOnlyEvmAssets(
        merged,
        confidential,
        portfolioMappings,
        this.options.assets
      )
      return Object.freeze({ ...projected, confidential })
    }
    const hiddenEvmSnapshot = {
      balances: [],
      fresh: false,
      known: false,
      updatedAt: 0
    }
    const knownRows = (rows: typeof signerSnapshots) =>
      rows.filter(
        entry => entry.snapshot.known ?? entry.snapshot.fresh ?? entry.snapshot.updatedAt > 0
      )
    // A cached default snapshot has no NEAR rows to classify, so it does not ask the signer.
    if (!refresh && signerSnapshots.length === 0) return project(snapshot, [])
    const firstEvm = this.options.evmNetworks[0]
    if (refresh && signerSnapshots.length === 0) {
      if (refresh === 'if-stale' && snapshot.fresh) return project(snapshot, [])
      if (!firstEvm) return project(snapshot, [])
      const session = await this.readUsableSessionForScope(
        model.scope.keyDomainId,
        model.scope.accountId
      )
      if (!session) return project(snapshot, [])
    }
    const source = await this.confidentialPortfolioIdentity(model.scope)
    if (source.kind === 'near') {
      const matching = (rows: typeof signerSnapshots) =>
        rows.filter(entry => entry.signerId === source.identity.address)
      const selected = matching(signerSnapshots)
      const selectedKnown = knownRows(selected)
      if (
        !refresh ||
        (refresh === 'if-stale' &&
          selectedKnown.length > 0 &&
          selectedKnown.every(entry => entry.snapshot.fresh))
      ) {
        return project(hiddenEvmSnapshot, selected)
      }
      const nearSession = await this.readUsableSession(source.identity)
      if (nearSession) {
        await this.refreshPortfolioBalances(source.identity, nearSession.accessToken).catch(
          () => null
        )
        const refreshed = await readSignerSnapshots().catch(() => signerSnapshots)
        return project(hiddenEvmSnapshot, matching(refreshed))
      }
      return project(hiddenEvmSnapshot, selected)
    }
    if (source.kind === 'evm') {
      if (!refresh || (refresh === 'if-stale' && snapshot.fresh)) return project(snapshot, [])
      const session = await this.readUsableSessionForScope(
        model.scope.keyDomainId,
        model.scope.accountId
      )
      if (!session) return project(snapshot, [])
      await this.refreshPortfolioBalances(source.identity, session.accessToken).catch(() => null)
      return project(await readEvmSnapshot().catch(() => snapshot), [])
    }
    return project(snapshot, [])
  }

  private async requireConfidentialSession(
    scope: Readonly<{ network: Network; keyDomainId: string; accountId: string }>,
    authorize: boolean
  ): Promise<Readonly<{ identity: ConfidentialSigningIdentity; session: ConfidentialSession }>> {
    if (scope.network !== this.options.network) throw new Error('Confidential network changed')
    const firstEvm = this.options.evmNetworks[0]
    if (!firstEvm) throw new Error('Confidential EVM network is unavailable')
    const existingSession = authorize
      ? null
      : await this.readUsableSessionForScope(scope.keyDomainId, scope.accountId)
    if (!authorize && !existingSession) throw new Error('Confidential authorization is required')
    const identity = await this.options.signer.resolveIdentity(parseChainId(firstEvm.chainId).id)
    if (
      identity.context.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
      identity.context.chainAccount.scope.accountId !== scope.accountId
    )
      throw new Error('Active Wallet Account changed')
    const session = existingSession ?? (await this.ensureSession(identity, authorize))
    if (!session) throw new Error('Confidential authorization is required')
    return Object.freeze({ identity, session })
  }

  async refreshBalances(
    scope: Readonly<{ network: Network; keyDomainId: string; accountId: string }>,
    authorize: boolean
  ): Promise<readonly Readonly<{ tokenId: string; available: string; source: string }>[]> {
    const { identity, session } = await this.requireConfidentialSession(scope, authorize)
    try {
      return await this.refreshPortfolioBalances(identity, session.accessToken)
    } catch (error) {
      if (error instanceof ConfidentialFundingApiError && error.status === 401) {
        await withMetadataLock(async () => {
          const current = await this.options.store.getSession(
            scope.network,
            scope.keyDomainId,
            scope.accountId
          )
          if (
            current?.accessToken === session.accessToken &&
            current.refreshToken === session.refreshToken &&
            current.expiresAt === session.expiresAt &&
            current.refreshExpiresAt === session.refreshExpiresAt
          )
            await this.options.store.deleteSession(
              scope.network,
              scope.keyDomainId,
              scope.accountId,
              identity.address
            )
        })
      }
      throw error
    }
  }

  shieldDappAuthorized(
    origin: string,
    scope: Readonly<{ network: Network; keyDomainId: string; accountId: string }>
  ): Promise<boolean> {
    return this.shieldDapp.shieldDappAuthorized(origin, scope)
  }

  grantShieldDapp(
    origin: string,
    scope: Readonly<{ network: Network; keyDomainId: string; accountId: string }>
  ): Promise<void> {
    return this.shieldDapp.grantShieldDapp(origin, scope)
  }

  revokeShieldDapp(
    origin: string,
    scope: Readonly<{ network: Network; keyDomainId: string; accountId: string }>
  ): Promise<void> {
    return this.shieldDapp.revokeShieldDapp(origin, scope)
  }

  listShieldDappCatalog(): ReturnType<ShieldDappCoordinator['listShieldDappCatalog']> {
    return this.shieldDapp.listShieldDappCatalog()
  }

  quoteShieldDapp(
    ...args: Parameters<ShieldDappCoordinator['quoteShieldDapp']>
  ): ReturnType<ShieldDappCoordinator['quoteShieldDapp']> {
    return this.shieldDapp.quoteShieldDapp(...args)
  }

  prepareShieldDappReceive(
    ...args: Parameters<ShieldDappCoordinator['prepareShieldDappReceive']>
  ): ReturnType<ShieldDappCoordinator['prepareShieldDappReceive']> {
    return this.shieldDapp.prepareShieldDappReceive(...args)
  }

  prepareShieldDappTransfer(
    ...args: Parameters<ShieldDappCoordinator['prepareShieldDappTransfer']>
  ): ReturnType<ShieldDappCoordinator['prepareShieldDappTransfer']> {
    return this.shieldDapp.prepareShieldDappTransfer(...args)
  }

  refreshShieldDappBalances(
    ...args: Parameters<ShieldDappCoordinator['refreshShieldDappBalances']>
  ): ReturnType<ShieldDappCoordinator['refreshShieldDappBalances']> {
    return this.shieldDapp.refreshShieldDappBalances(...args)
  }

  reportStoredShieldDappPlan(
    plan: ConfidentialFundingPlan
  ): ReturnType<ShieldDappCoordinator['reportStoredShieldDappPlan']> {
    return this.shieldDapp.reportStoredShieldDappPlan(plan)
  }

  readShieldDappStatus(
    ...args: Parameters<ShieldDappCoordinator['readShieldDappStatus']>
  ): ReturnType<ShieldDappCoordinator['readShieldDappStatus']> {
    return this.shieldDapp.readShieldDappStatus(...args)
  }

  private async shieldDepositSourceIsFinal(plan: ConfidentialFundingPlan): Promise<boolean> {
    const graph = await this.options.repository.get(
      {
        keyDomainId: parseKeyDomainId(plan.keyDomainId),
        accountId: parseAccountId(plan.accountId)
      },
      parseTransactionId(plan.transactionId)
    )
    const origin = graph?.segments.find(segment => segment.role === 'origin')
    if (origin?.status !== 'final' || !graph) return false
    const replacementHash = origin.evidence?.replacementTransactionHash
    if (!replacementHash) return true
    const replacements = await this.options.repository.list({
      scope: graph.root.scope,
      chainId: parseChainId(plan.source.chainId).id,
      statuses: ['final'],
      limit: 200
    })
    return replacements.some(
      candidate =>
        candidate.segments.some(segment => segment.evidence?.transactionHash === replacementHash) &&
        isEvmSpeedUpReplacement(graph, candidate)
    )
  }

  private shieldDepositObservationPhase(
    plan: ConfidentialFundingPlan
  ): 'deposit-confirming' | 'deposit-signed' | undefined {
    if (plan.operation !== 'deposit' || !plan.requiresDeposit || !plan.depositQuote)
      return undefined
    const phase = plan.phase === 'needs-auth' ? plan.resumePhase : plan.phase
    return phase === 'deposit-confirming' || phase === 'deposit-signed' ? phase : undefined
  }

  /**
   * Complete a Shield receive from this deposit's provider receipt.
   * The source transaction must already be final, and the balance cache must
   * refresh first so the activity never reports arrival beside a stale balance.
   */
  private async finishArrivedShieldDeposit(
    plan: ConfidentialFundingPlan
  ): Promise<ConfidentialFundingPlan | null> {
    if (!this.shieldDepositObservationPhase(plan) || !plan.depositQuote) return null
    const status = await this.readStatus(plan, plan.depositQuote.quote.depositAddress, 'deposit')
    const session = await this.readUsableSessionForPlan(plan).catch(() => null)
    const balances = session
      ? await this.readAndCacheBalancesForPlan(plan, session.accessToken).catch(() => null)
      : null
    const settledOutputRaw = status?.settledAmountOutRaw
    if (
      balances === null ||
      typeof settledOutputRaw !== 'string' ||
      !shieldDepositHasArrived({
        protocolStatus: status?.status ?? '',
        settledAmountOutRaw: settledOutputRaw,
        minimumOutputRaw: plan.minimumOutputRaw
      }) ||
      !(await this.shieldDepositSourceIsFinal(plan))
    ) {
      return null
    }
    await this.ensureGraph(plan)
    await this.applyGraphStatus(plan, 'relay', 'final')
    const ready = await this.updatePlan(plan, {
      phase: 'ready',
      resumePhase: undefined,
      settledOutputRaw
    })
    await this.options
      .refreshPortfolio?.({
        keyDomainId: ready.keyDomainId,
        accountId: ready.accountId,
        chainIds: [ready.source.chainId],
        domain: 'confidential',
        balanceUpdated: true
      })
      .catch(() => {})
    void this.options
      .refreshPortfolio?.({
        keyDomainId: ready.keyDomainId,
        accountId: ready.accountId,
        chainIds: [ready.source.chainId],
        domain: 'chain'
      })
      .catch(() => {})
    return ready
  }

  async cancel(planId: string): Promise<void> {
    if (this.confirmingByPlan.has(planId) || this.cancellingPlans.has(planId)) {
      throw new Error('Confidential funding confirmation or cancellation is in progress')
    }
    this.cancellingPlans.add(planId)
    try {
      const plan = await this.requirePlan(planId)
      if (plan.phase !== 'prepared') {
        throw new Error('Confidential funding can no longer be cancelled')
      }
      if (plan.preparedDeposit) {
        const identity = await this.requirePlanIdentity(plan)
        await this.depositAdapter(identity, {
          sourceChainId: plan.source.chainId,
          destinationChainId: plan.destination.chainId
        })
          .cancelDeposit({ identity, commandId: plan.preparedDeposit.commandId })
          .catch(() => {})
      }
      await this.options.store.deletePlan(planId)
    } finally {
      this.cancellingPlans.delete(planId)
    }
  }

  async resumeAll(): Promise<number> {
    const plans = (await this.options.store.listPlans()).filter(
      plan =>
        plan.network === this.options.network &&
        plan.phase !== 'prepared' &&
        !needsConfidentialSubmissionCheck(plan) &&
        (!isTerminalPhase(plan.phase) ||
          isRecoverableLocalFailure(plan) ||
          needsRefundObservation(plan))
    )
    const results = await Promise.allSettled(plans.map(plan => this.continuePlan(plan.planId)))
    const external = (await this.options.store.listExternalDeposits()).filter(
      record =>
        record.network === this.options.network &&
        (shouldAutoRefreshExternalShieldDeposit(record, this.now()) ||
          (record.phase === 'ready' &&
            (record.balanceRefreshedAt === undefined || record.settledOutputRaw === undefined)) ||
          ((record.phase === 'ready' || record.phase === 'refunded') &&
            !this.reconciledTerminalExternalDeposits.has(record.depositId)))
    )
    const externalResults = await Promise.allSettled(
      external.map(record => this.refreshExternalDeposit(record.depositId, false))
    )
    if (
      plans.some((_, index) => results[index].status === 'rejected') ||
      external.some((_, index) => externalResults[index].status === 'rejected')
    )
      await this.scheduleMonitoring()
    if (
      externalResults.some(
        result =>
          result.status === 'fulfilled' &&
          (shouldAutoRefreshExternalShieldDeposit(result.value, this.now()) ||
            (result.value.phase === 'ready' &&
              (result.value.balanceRefreshedAt === undefined ||
                result.value.settledOutputRaw === undefined)))
      )
    ) {
      await this.scheduleMonitoring()
    }
    return [...results, ...externalResults].filter(result => result.status === 'fulfilled').length
  }

  async continuePlan(planId: string, refreshRefund = false): Promise<ConfidentialFundingPlan> {
    const existing = this.continuingByPlan.get(planId)
    if (existing) return existing
    const operation = this.continuePlanExclusive(planId, refreshRefund)
      .catch(error => this.handleContinuationError(planId, error))
      .then(async plan => {
        if (needsRefundObservation(plan)) {
          const due =
            (plan.settlementCheckedAt ?? this.now()) + refundStatusCheckInterval(plan, this.now())
          await this.scheduleMonitoring(Math.max(0.1, (due - this.now()) / 60_000))
        }
        return plan
      })
      .finally(() => {
        if (this.continuingByPlan.get(planId) === operation) {
          this.continuingByPlan.delete(planId)
        }
      })
    this.continuingByPlan.set(planId, operation)
    return operation
  }

  private async continuePlanExclusive(
    planId: string,
    refreshRefund: boolean
  ): Promise<ConfidentialFundingPlan> {
    let plan = await this.requirePlan(planId)
    if (isRecoverableLocalFailure(plan)) {
      plan = await this.updatePlan(plan, {
        phase: 'deposit-confirming',
        errorStatus: undefined
      })
    } else if (isTerminalPhase(plan.phase)) {
      return needsRefundObservation(plan) ? this.observeRefund(plan, refreshRefund) : plan
    }
    if (
      plan.requiresDeposit &&
      (plan.phase === 'deposit-signed' ||
        plan.phase === 'deposit-confirming' ||
        (plan.phase === 'needs-auth' &&
          (plan.resumePhase === 'deposit-signed' || plan.resumePhase === 'deposit-confirming')))
    ) {
      await this.ensureGraph(plan)
      const graph = await this.options.repository.get(
        {
          keyDomainId: parseKeyDomainId(plan.keyDomainId),
          accountId: parseAccountId(plan.accountId)
        },
        parseTransactionId(plan.transactionId)
      )
      const origin = graph?.segments.find(segment => segment.role === 'origin')
      if (origin?.status === 'failed' && graph?.root.status === 'failed') {
        const cancelled = origin.failure?.code === 'cancelled'
        if (cancelled || origin.failure?.code === 'dropped') {
          return this.updatePlan(plan, {
            phase: cancelled ? 'cancelled' : 'failed',
            errorStatus: cancelled ? 'DEPOSIT_CANCELLED' : 'DEPOSIT_REPLACED'
          })
        }
      }
    }
    if (isClusterRejectionReason(plan.errorStatus)) return this.finishRejectedCluster(plan)
    if (isUnsignedDirectWithdraw(plan) && !this.confirmingByPlan.has(planId)) {
      return this.updatePlan(plan, {
        phase: 'failed',
        resumePhase: undefined,
        errorStatus: 'WITHDRAW_SIGNING_INTERRUPTED'
      })
    }
    if (
      plan.phase === 'authorized' &&
      plan.requiresDeposit &&
      !plan.preparedDeposit?.transactionHash
    ) {
      if (this.confirmingByPlan.has(planId)) return plan
      const identity = await this.requirePlanIdentity(plan).catch(() => null)
      if (identity && plan.preparedDeposit) {
        await this.depositAdapter(identity, {
          sourceChainId: plan.source.chainId,
          destinationChainId: plan.destination.chainId
        })
          .cancelDeposit({
            identity,
            commandId: plan.preparedDeposit.commandId
          })
          .catch(() => {})
      }
      return this.updatePlan(plan, {
        phase: 'failed',
        errorStatus: 'DEPOSIT_SIGNING_INTERRUPTED'
      })
    }
    if (
      (plan.operation === 'withdraw' ||
        plan.operation === 'cluster' ||
        plan.operation === 'swap' ||
        plan.operation === 'confidential-transfer') &&
      plan.phase === 'signing-withdraws' &&
      this.confirmingByPlan.has(planId)
    )
      return plan
    if (plan.phase === 'needs-auth') return plan
    const session = await this.readUsableSessionForPlan(plan)
    if (!session) {
      const settled = await this.finishArrivedShieldDeposit(plan)
      if (settled) return settled
      return this.updatePlan(plan, {
        phase: 'needs-auth',
        resumePhase: plan.phase
      })
    }
    if (plan.phase === 'submitting' || plan.phase === 'processing') {
      await this.ensureGraph(plan)
      // A previous attempt can record this after the signed plan was stored but
      // before its activity graph was accepted. Retrying past that point retires it.
      if (plan.errorStatus === 'LOCAL_PROCESSING_FAILED') {
        plan = await this.updatePlan(plan, { errorStatus: undefined })
      }
    }

    if (
      plan.phase === 'deposit-signed' &&
      plan.preparedDeposit?.rawTransaction &&
      plan.preparedDeposit.transactionHash
    ) {
      const replacements = await this.options.repository.list({
        scope: {
          keyDomainId: parseKeyDomainId(plan.keyDomainId),
          accountId: parseAccountId(plan.accountId)
        },
        chainId: parseChainId(plan.source.chainId).id,
        statuses: ['signed', 'broadcast', 'confirming', 'final'],
        limit: 200
      })
      if (
        replacements.some(
          graph =>
            graph.root.relation?.kind === 'replacement-of' &&
            graph.root.relation.transactionId === plan.transactionId
        )
      ) {
        plan = await this.updatePlan(plan, { phase: 'deposit-confirming' })
      }
    }
    if (
      plan.phase === 'deposit-signed' &&
      plan.preparedDeposit?.rawTransaction &&
      plan.preparedDeposit.transactionHash
    ) {
      if (parseChainId(plan.source.chainId).namespace === 'near') {
        const broadcast = await this.broadcastNearDeposit(plan)
        if (broadcast.phase !== 'deposit-confirming') return broadcast
        plan = broadcast
      } else {
        try {
          await broadcastSignedEvmTransaction({
            rawTransaction: plan.preparedDeposit.rawTransaction,
            expectedTransactionHash: plan.preparedDeposit.transactionHash,
            rpc: this.requireRpc(plan.source.chainId)
          })
        } catch (error) {
          if (!(error instanceof Error && /already known|known transaction/i.test(error.message))) {
            await this.scheduleMonitoring()
            return plan
          }
        }
        const transactionHash = plan.preparedDeposit.transactionHash
        plan = await this.updatePlan(plan, { phase: 'deposit-confirming' })
        await this.applyGraphStatus(plan, 'origin', 'broadcast', {
          transactionHash
        })
      }
    }

    if (plan.requiresDeposit && plan.phase === 'deposit-confirming') {
      const sourceGraph = await this.options.repository.get(
        {
          keyDomainId: parseKeyDomainId(plan.keyDomainId),
          accountId: parseAccountId(plan.accountId)
        },
        parseTransactionId(plan.transactionId)
      )
      const sourceOrigin = sourceGraph?.segments.find(segment => segment.role === 'origin')
      const replacementHash = sourceOrigin?.evidence?.replacementTransactionHash
      const transactionHash = replacementHash ?? plan.preparedDeposit?.transactionHash
      if (transactionHash && !replacementHash && sourceOrigin?.status !== 'final') {
        if (parseChainId(plan.source.chainId).namespace === 'near') {
          const status = await this.observeNearDeposit(plan, transactionHash)
          if (status === 'failed') {
            return this.updatePlan(plan, { phase: 'failed', errorStatus: 'DEPOSIT_REVERTED' })
          }
        } else {
          const observation = await observeEvmTransaction(
            transactionHash,
            this.requireRpc(plan.source.chainId)
          ).catch(() => null)
          if (observation) {
            await this.applyEvmObservation(plan, observation)
            if (observation.status === 'failed') {
              return this.updatePlan(plan, { phase: 'failed', errorStatus: 'DEPOSIT_REVERTED' })
            }
          }
        }
      }
      const status = await this.readStatus(plan, plan.depositQuote!.quote.depositAddress, 'deposit')
      if (status?.transactionHash) {
        await this.applyGraphStatus(plan, 'relay', 'confirming', {
          transactionHash: status.transactionHash
        })
      }
      const balances = await this.readAndCacheBalancesForPlan(plan, session.accessToken).catch(
        () => null
      )
      const available =
        getConfidentialAvailableForAsset(balances ?? [], plan.source.protocolAssetId) ?? '0'
      const expectedCredit =
        plan.operation === 'deposit'
          ? BigInt(plan.depositQuote!.quote.amountOut)
          : plan.splitSourceAmounts.reduce((sum, amountRaw) => sum + BigInt(amountRaw), 0n)
      const expectedAvailable = BigInt(plan.confidentialBaselineRaw) + expectedCredit
      const credited = balances !== null && BigInt(available) >= expectedAvailable
      const normalizedStatus = normalizeStatus(status?.status ?? '')
      if (['FAILED', 'REFUNDED', 'EXPIRED', 'CANCELLED'].includes(normalizedStatus)) {
        const phase = phaseForSettlement(
          normalizedStatus === 'REFUNDED'
            ? 'refunded'
            : normalizedStatus === 'EXPIRED'
              ? 'expired'
              : normalizedStatus === 'CANCELLED'
                ? 'cancelled'
                : 'failed'
        )
        await this.applyGraphStatus(
          plan,
          plan.operation === 'deposit' ? 'relay' : 'origin',
          'failed',
          undefined,
          failureCode(normalizedStatus)
        )
        return this.updatePlan(plan, {
          phase,
          ...(status?.errorStatus ? { errorStatus: status.errorStatus } : {})
        })
      }
      if (!(await this.shieldDepositSourceIsFinal(plan))) {
        await this.scheduleMonitoring()
        return plan
      }
      if (plan.operation === 'deposit') {
        if (
          balances === null ||
          !shieldDepositHasArrived({
            protocolStatus: status?.status ?? '',
            settledAmountOutRaw: status?.settledAmountOutRaw,
            minimumOutputRaw: plan.minimumOutputRaw
          })
        ) {
          await this.scheduleMonitoring()
          return plan
        }
        await this.applyGraphStatus(plan, 'relay', 'final')
        const settledOutputRaw =
          status?.settledAmountOutRaw !== undefined &&
          isPositiveRaw(status.settledAmountOutRaw) &&
          isRawAmount(plan.minimumOutputRaw) &&
          BigInt(status.settledAmountOutRaw) >= BigInt(plan.minimumOutputRaw)
            ? status.settledAmountOutRaw
            : undefined
        const ready = await this.updatePlan(plan, {
          phase: 'ready',
          ...(settledOutputRaw === undefined ? {} : { settledOutputRaw })
        })
        await this.options
          .refreshPortfolio?.({
            keyDomainId: ready.keyDomainId,
            accountId: ready.accountId,
            chainIds: [ready.source.chainId],
            domain: 'confidential',
            balanceUpdated: true
          })
          .catch(() => {})
        void this.options
          .refreshPortfolio?.({
            keyDomainId: ready.keyDomainId,
            accountId: ready.accountId,
            chainIds: [ready.source.chainId],
            domain: 'chain'
          })
          .catch(() => {})
        return ready
      }
      const reportedTooLittle =
        status?.amountOutRaw !== undefined && BigInt(status.amountOutRaw) < expectedCredit
      const depositExpired = quoteDeadline(plan.depositQuote!) <= this.now()
      if (
        normalizedStatus === 'SUCCESS' &&
        !credited &&
        (reportedTooLittle || (balances !== null && depositExpired))
      ) {
        await this.applyGraphStatus(plan, 'origin', 'failed', undefined, 'relay-failed')
        return this.updatePlan(plan, {
          phase: 'failed',
          errorStatus: 'DEPOSIT_AMOUNT_TOO_LOW'
        })
      }
      if (!credited || normalizedStatus !== 'SUCCESS') {
        await this.scheduleMonitoring()
        return plan
      }
      if (plan.operation === 'cluster') {
        plan = await this.reservationQueue.run(async () => {
          const active = (await this.options.store.listPlans()).filter(
            other =>
              other.network === plan.network &&
              other.keyDomainId === plan.keyDomainId &&
              other.accountId === plan.accountId
          )
          const spendRaw = plan.splitSourceAmounts
            .reduce((sum, amountRaw) => sum + BigInt(amountRaw), 0n)
            .toString()
          this.assertUnreservedBalance(
            active,
            plan.source.protocolAssetId,
            spendRaw,
            available,
            plan.planId,
            plan.signerId
          )
          return this.updatePlan(plan, { phase: 'signing-withdraws' })
        })
      } else {
        plan = await this.updatePlan(plan, { phase: 'signing-withdraws' })
      }
      await this.applyGraphStatus(plan, 'origin', 'final', { transactionHash })
      await this.applyGraphStatus(plan, 'relay', 'confirming')
    }

    if (!plan.requiresDeposit && plan.phase === 'authorized') {
      await this.ensureGraph(plan)
      await this.applyGraphStatus(plan, 'relay', 'confirming')
      plan = await this.updatePlan(plan, { phase: 'signing-withdraws' })
    }

    if (plan.phase === 'signing-withdraws') {
      await this.requirePlanIdentity(plan)
      plan = await this.signAndFreezeWithdraws(plan)
    }
    if (plan.phase === 'submitting')
      plan =
        plan.operation === 'cluster'
          ? await this.recoverOrSubmitCluster(plan)
          : await this.recoverOrSubmit(plan, session.accessToken)
    if (plan.phase === 'processing' || plan.phase === 'partial') {
      plan = await this.refreshSettlement(plan, session.accessToken)
    }
    if (!isTerminalPhase(plan.phase) && !needsConfidentialSubmissionCheck(plan)) {
      await this.scheduleMonitoring()
    }
    return plan
  }

  private parseInput(value: PrepareConfidentialFundingInput): PrepareConfidentialFundingInput & {
    readonly source: PrepareConfidentialFundingInput['source'] & {
      readonly chainId: ChainId
    }
    readonly destination: PrepareConfidentialFundingInput['destination'] & {
      readonly chainId: ChainId
    }
  } {
    this.assertOwnZcashMoveRecipient(value)
    const sourceChain = parseChainId(value.source.chainId)
    const destinationChain = parseChainId(value.destination.chainId)
    const zcashChainId = getZcashChainId(this.options.network)
    const shieldSpend =
      value.sourceDomain === 'shield' &&
      (value.operation === 'withdraw' ||
        value.operation === 'swap' ||
        value.operation === 'confidential-transfer')
    const sourceIsEvm = sourceChain.namespace === 'eip155'
    const destinationIsEvm = destinationChain.namespace === 'eip155'
    const sourceIsNear = sourceChain.id === 'near:mainnet'
    const destinationIsNear = destinationChain.id === 'near:mainnet'
    const nearRoute =
      value.operation !== undefined &&
      value.operation !== 'cluster' &&
      (sourceIsNear || destinationIsNear)
    // Cluster stays off nearRoute so deposit, withdraw, and swap rules do not change.
    const clusterEvm =
      value.operation === 'cluster' &&
      sourceChain.namespace === 'eip155' &&
      destinationChain.namespace === 'eip155'
    const clusterNear = value.operation === 'cluster' && sourceIsNear && destinationIsNear
    const sourceAllowed =
      sourceIsEvm ||
      (nearRoute && sourceIsNear) ||
      clusterNear ||
      (shieldSpend && sourceChain.id === zcashChainId)
    const destinationAllowed =
      destinationIsEvm ||
      (nearRoute && destinationIsNear) ||
      clusterNear ||
      (shieldSpend &&
        value.operation === 'withdraw' &&
        value.destinationDomain === 'public' &&
        destinationChain.id === zcashChainId) ||
      ((value.operation === 'swap' || value.operation === 'confidential-transfer') &&
        value.destinationDomain === 'shield' &&
        destinationChain.id === zcashChainId)
    if (
      !sourceAllowed ||
      !destinationAllowed ||
      (!sourceIsEvm &&
        !destinationIsEvm &&
        !nearRoute &&
        !clusterNear &&
        !(shieldSpend && destinationChain.id === zcashChainId))
    ) {
      throw new Error('Confidential funding requires an EVM signing chain')
    }
    if (
      value.operation !== undefined &&
      (!['deposit', 'withdraw', 'cluster', 'swap', 'confidential-transfer'].includes(
        value.operation
      ) ||
        (value.operation === 'deposit' &&
          (!['public', 'private'].includes(value.sourceDomain ?? '') ||
            value.destinationDomain !== 'shield' ||
            value.source.protocolAssetId !== value.destination.protocolAssetId)) ||
        (value.operation === 'withdraw' &&
          (value.sourceDomain !== 'shield' ||
            !['public', 'private'].includes(value.destinationDomain ?? '') ||
            (value.externalRecipient !== undefined && value.destinationDomain !== 'public'))) ||
        (value.operation === 'swap' &&
          (value.sourceDomain !== 'shield' ||
            value.destinationDomain !== 'shield' ||
            value.source.protocolAssetId === value.destination.protocolAssetId ||
            value.externalRecipient !== undefined)) ||
        (value.operation === 'confidential-transfer' &&
          (value.sourceDomain !== 'shield' ||
            value.destinationDomain !== 'shield' ||
            value.externalRecipient !== undefined ||
            value.purpose !== undefined ||
            typeof value.confidentialRecipient !== 'string' ||
            !isAddress(value.confidentialRecipient) ||
            /^0x0{40}$/i.test(value.confidentialRecipient))) ||
        (value.confidentialRecipient !== undefined &&
          value.operation !== 'confidential-transfer') ||
        (value.operation === 'cluster' &&
          (!(clusterEvm || clusterNear) ||
            !['public', 'private', 'shield'].includes(value.sourceDomain ?? '') ||
            !['public', 'private'].includes(value.destinationDomain ?? '') ||
            value.sourceDomain === value.destinationDomain ||
            sourceChain.id !== destinationChain.id ||
            value.source.assetId !== value.destination.assetId ||
            value.source.protocolAssetId !== value.destination.protocolAssetId)) ||
        (value.network !== 'mainnet' && value.network !== 'testnet') ||
        !isBoundedLabel(value.keyDomainId ?? '', 512) ||
        !isBoundedLabel(value.accountId ?? '', 512))
    )
      throw new Error('Confidential funding route is invalid')
    if (
      parseAssetId(value.source.assetId).chainId !== sourceChain.id ||
      parseAssetId(value.destination.assetId).chainId !== destinationChain.id ||
      !this.options.assets.get(value.source.assetId) ||
      !this.options.assets.get(value.destination.assetId) ||
      !this.hasConfidentialProtocolMapping(
        value.source.assetId,
        value.source.protocolAssetId,
        value.operation
      ) ||
      !this.hasConfidentialProtocolMapping(
        value.destination.assetId,
        value.destination.protocolAssetId,
        value.operation
      ) ||
      !isPositiveRaw(value.source.amountRaw) ||
      !value.source.protocolAssetId ||
      !value.destination.protocolAssetId ||
      !isBoundedLabel(value.source.chainName) ||
      !isBoundedLabel(value.destination.chainName) ||
      !Number.isSafeInteger(value.slippageBps) ||
      value.slippageBps < 0 ||
      value.slippageBps > 10_000 ||
      (value.feeTier !== undefined && !['low', 'standard', 'fast'].includes(value.feeTier)) ||
      (value.feeSelection !== undefined &&
        (value.feeTier !== undefined || value.sourceDomain === 'shield' || !sourceIsEvm)) ||
      (value.dedupKey !== undefined && !isBoundedLabel(value.dedupKey, 160)) ||
      (value.externalRecipient !== undefined &&
        (value.operation !== 'withdraw' ||
          !isValidExternalRecipient(
            value.externalRecipient,
            destinationChain.id,
            value.network
          ))) ||
      (sourceIsNear &&
        !nearConfidentialProtocolAccepted(
          value.source.assetId,
          value.source.protocolAssetId,
          value.operation
        )) ||
      (destinationIsNear &&
        !nearConfidentialProtocolAccepted(
          value.destination.assetId,
          value.destination.protocolAssetId,
          value.operation
        ))
    ) {
      throw new Error('Confidential funding request is invalid')
    }
    if (!this.hasCurrentFundingAssets(value))
      throw new Error('Confidential funding asset catalog changed')
    return Object.freeze({
      ...(value.operation === undefined
        ? {}
        : {
            network: value.network,
            keyDomainId: value.keyDomainId,
            accountId: value.accountId,
            operation: value.operation,
            sourceDomain: value.sourceDomain,
            destinationDomain: value.destinationDomain
          }),
      source: Object.freeze({
        chainId: sourceChain.id,
        chainName: value.source.chainName,
        assetId: value.source.assetId,
        protocolAssetId: value.source.protocolAssetId,
        amountRaw: value.source.amountRaw
      }),
      destination: Object.freeze({
        chainId: destinationChain.id,
        chainName: value.destination.chainName,
        assetId: value.destination.assetId,
        protocolAssetId: value.destination.protocolAssetId
      }),
      slippageBps: value.slippageBps,
      ...(value.externalRecipient ? { externalRecipient: value.externalRecipient } : {}),
      ...(value.confidentialRecipient
        ? { confidentialRecipient: value.confidentialRecipient }
        : {}),
      ...(value.purpose ? { purpose: value.purpose } : {}),
      ...(value.feeTier ? { feeTier: value.feeTier } : {}),
      ...(value.feeSelection ? { feeSelection: parseEvmFeeSelection(value.feeSelection) } : {}),
      ...(value.dedupKey ? { dedupKey: value.dedupKey } : {})
    }) as PrepareConfidentialFundingInput & {
      readonly source: PrepareConfidentialFundingInput['source'] & { readonly chainId: ChainId }
      readonly destination: PrepareConfidentialFundingInput['destination'] & {
        readonly chainId: ChainId
      }
    }
  }

  private async prepareWithdrawPreviews(input: {
    readonly sourceAsset: string
    readonly destinationAsset: string
    readonly spendRaw: string
    readonly signerId: string
    readonly recipient: string
    readonly slippageBps: number
  }): Promise<Readonly<{ amounts: readonly string[]; quotes: readonly ConfidentialQuote[] }>> {
    const attempt = async (count: number) => {
      const amounts = splitConfidentialFundingAmount(input.spendRaw, count)
      const quotes = await Promise.all(
        amounts.map(amountRaw =>
          this.quoteBound({
            referral: NOIR_SEND_REFERRAL,
            originAsset: input.sourceAsset,
            destinationAsset: input.destinationAsset,
            amountRaw,
            signerId: input.signerId,
            recipient: input.recipient,
            depositType: 'CONFIDENTIAL_INTENTS',
            refundType: 'CONFIDENTIAL_INTENTS',
            recipientType: 'DESTINATION_CHAIN',
            slippageBps: input.slippageBps,
            dry: true
          })
        )
      )
      quotes.forEach((quote, index) => {
        this.assertQuoteBinding(
          quote,
          {
            originAsset: input.sourceAsset,
            destinationAsset: input.destinationAsset,
            amountRaw: amounts[index],
            signerId: input.signerId,
            recipient: input.recipient,
            depositType: 'CONFIDENTIAL_INTENTS',
            refundType: 'CONFIDENTIAL_INTENTS',
            recipientType: 'DESTINATION_CHAIN',
            slippageBps: input.slippageBps
          },
          this.now()
        )
      })
      // Retry fewer legs when the quoted fee cannot be represented, same as an undersized split.
      if (quotes.some(confidentialQuoteAppFeeUnrepresentable)) {
        throw new Error(CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR)
      }
      return Object.freeze({ amounts, quotes: Object.freeze(quotes) })
    }
    try {
      return await attempt(CONFIDENTIAL_WITHDRAW_DEFAULT_COUNT)
    } catch (error) {
      if (!minimumAmountError(error) && !quotedFeeTooSmall(error)) throw error
      return attempt(2)
    }
  }

  private async signAndFreezeWithdraws(
    plan: ConfidentialFundingPlan
  ): Promise<ConfidentialFundingPlan> {
    if (
      plan.operation === 'withdraw' ||
      plan.operation === 'swap' ||
      plan.operation === 'confidential-transfer'
    )
      return this.signAndFreezeDirectWithdraw(plan)
    if (plan.operation === 'cluster') return this.signAndFreezeCluster(plan)
    const quotes = await Promise.all(
      plan.splitSourceAmounts.map(sourceAmountRaw =>
        this.quoteBound({
          referral: NOIR_SEND_REFERRAL,
          originAsset: plan.source.protocolAssetId,
          destinationAsset: plan.destination.protocolAssetId,
          amountRaw: sourceAmountRaw,
          signerId: plan.signerId,
          recipient: plan.destination.address,
          depositType: 'CONFIDENTIAL_INTENTS',
          refundType: 'CONFIDENTIAL_INTENTS',
          recipientType: 'DESTINATION_CHAIN',
          slippageBps: plan.slippageBps,
          dry: false
        })
      )
    )
    quotes.forEach((quote, sequence) => {
      this.assertQuoteBinding(
        quote,
        {
          originAsset: plan.source.protocolAssetId,
          destinationAsset: plan.destination.protocolAssetId,
          amountRaw: plan.splitSourceAmounts[sequence],
          signerId: plan.signerId,
          recipient: plan.destination.address,
          depositType: 'CONFIDENTIAL_INTENTS',
          refundType: 'CONFIDENTIAL_INTENTS',
          recipientType: 'DESTINATION_CHAIN',
          slippageBps: plan.slippageBps
        },
        this.now()
      )
      if (
        !quote.quote.depositAddress ||
        quote.quote.amountIn !== plan.splitSourceAmounts[sequence]
      ) {
        throw new Error('Confidential withdraw quote does not match the approved batch')
      }
    })
    const formalExpectedRaw = quotes
      .reduce((sum, quote) => sum + BigInt(quote.quote.amountOut), 0n)
      .toString()
    const formalMinimumRaw = quotes
      .reduce((sum, quote) => sum + BigInt(quote.quote.minAmountOut), 0n)
      .toString()
    if (
      BigInt(formalExpectedRaw) < BigInt(plan.minimumOutputRaw) ||
      BigInt(formalMinimumRaw) < BigInt(plan.minimumOutputRaw)
    ) {
      await this.applyGraphStatus(plan, 'relay', 'failed', undefined, 'relay-failed')
      return this.updatePlan(plan, {
        phase: 'failed',
        errorStatus: 'QUOTE_CHANGED'
      })
    }

    const rows: ConfidentialWithdrawRow[] = []
    const requestRows: ConfidentialWithdrawRequest['withdraws'][number][] = []
    const signingChainId = confidentialSigningChainId(
      plan.source.chainId,
      plan.destination.chainId,
      plan.network
    )
    for (let sequence = 0; sequence < plan.splitSourceAmounts.length; sequence += 1) {
      const sourceAmountRaw = plan.splitSourceAmounts[sequence]
      const quote = quotes[sequence]
      const generated = await this.options.api.generateIntent({
        signerId: plan.signerId,
        depositAddress: quote.quote.depositAddress,
        standard: confidentialIntentStandard(signingChainId)
      })
      const binding = assertConfidentialIntentBinding({
        intent: generated.intent,
        quote,
        signerId: plan.signerId,
        sourceAsset: plan.source.protocolAssetId,
        sourceAmountRaw,
        destinationAsset: plan.destination.protocolAssetId,
        destinationAddress: plan.destination.address
      })
      const signedPayload = await this.options.signer.signMessage({
        identity: await this.requirePlanIdentity(plan),
        chainId: signingChainId,
        payload: binding.payload
      })
      const amountRaw = quote.quote.amountOut
      rows.push(
        Object.freeze({
          sequence,
          sourceAmountRaw,
          amountRaw,
          depositAddress: quote.quote.depositAddress,
          destinationAddress: plan.destination.address,
          destinationChain: plan.destination.chainName,
          token: plan.destination.protocolAssetId,
          deadline: binding.deadline,
          status: 'SIGNED',
          signedPayload
        })
      )
      requestRows.push(
        Object.freeze({
          amount: amountRaw,
          deposit_address: quote.quote.depositAddress,
          destination_address: plan.destination.address,
          destination_chain: plan.destination.chainName,
          execution_type: 'CONFIDENTIAL_1CLICK' as const,
          sequence,
          signed_payload: signedPayload,
          token: plan.destination.protocolAssetId
        })
      )
    }
    const frozenRequest = normalizeConfidentialWithdrawRequest({
      from_amount: plan.source.amountRaw,
      from_chain: plan.source.chainName,
      from_token: plan.source.protocolAssetId,
      mode: plan.source.protocolAssetId === plan.destination.protocolAssetId ? 'TRANSFER' : 'SWAP',
      signer_id: plan.signerId,
      withdraws: Object.freeze(requestRows)
    })
    const requestFingerprint = await fingerprintConfidentialValue(frozenRequest)
    plan = await this.updatePlan(plan, {
      phase: 'submitting',
      withdraws: Object.freeze(rows),
      frozenRequest,
      requestFingerprint,
      expectedOutputRaw: formalExpectedRaw,
      minimumOutputRaw: formalMinimumRaw
    })
    await this.ensureGraph(plan)
    await this.applyGraphStatus(plan, 'relay', 'confirming')
    for (const row of rows) {
      await this.applyGraphStatus(plan, `withdraw:${row.sequence}`, 'confirming', {
        externalReference: row.depositAddress
      })
    }
    return plan
  }

  private async signAndFreezeCluster(
    plan: ConfidentialFundingPlan
  ): Promise<ConfidentialFundingPlan> {
    if (plan.frozenRequest) return plan
    const quotes = await Promise.all(
      plan.splitSourceAmounts.map(sourceAmountRaw =>
        this.quoteBound({
          referral: NOIR_SEND_REFERRAL,
          originAsset: plan.source.protocolAssetId,
          destinationAsset: plan.destination.protocolAssetId,
          amountRaw: sourceAmountRaw,
          signerId: plan.signerId,
          recipient: plan.destination.address,
          depositType: 'CONFIDENTIAL_INTENTS',
          refundType: 'CONFIDENTIAL_INTENTS',
          recipientType: 'DESTINATION_CHAIN',
          slippageBps: plan.slippageBps,
          dry: false
        })
      )
    )
    const depositAddresses = new Set<string>()
    quotes.forEach((quote, sequence) => {
      this.assertQuoteBinding(
        quote,
        {
          originAsset: plan.source.protocolAssetId,
          destinationAsset: plan.destination.protocolAssetId,
          amountRaw: plan.splitSourceAmounts[sequence],
          signerId: plan.signerId,
          recipient: plan.destination.address,
          depositType: 'CONFIDENTIAL_INTENTS',
          refundType: 'CONFIDENTIAL_INTENTS',
          recipientType: 'DESTINATION_CHAIN',
          slippageBps: plan.slippageBps
        },
        this.now()
      )
      const address = quote.quote.depositAddress.toLowerCase()
      if (!address || depositAddresses.has(address))
        throw new Error('Cluster withdraw quotes must use distinct deposit addresses')
      depositAddresses.add(address)
    })
    if (
      plan.reviewedAppFeesFingerprint &&
      plan.reviewedAppFeesFingerprint !==
        (await fingerprintDirectConfidentialApproval(quotes.map(readConfidentialQuoteAppFees)))
    ) {
      throw new Error('Shield withdraw fees changed. Review the transfer again.')
    }
    if (quotes.some(confidentialQuoteAppFeeUnrepresentable)) {
      await this.updatePlan(plan, {
        phase: 'failed',
        resumePhase: undefined,
        errorStatus: 'WITHDRAW_PREPARATION_FAILED'
      })
      throw new Error(CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR)
    }
    const expectedOutputRaw = quotes
      .reduce((sum, quote) => sum + BigInt(quote.quote.amountOut), 0n)
      .toString()
    const minimumOutputRaw = quotes
      .reduce((sum, quote) => sum + BigInt(quote.quote.minAmountOut), 0n)
      .toString()
    if (
      BigInt(minimumOutputRaw) < BigInt(plan.minimumOutputRaw) ||
      BigInt(expectedOutputRaw) < BigInt(plan.minimumOutputRaw)
    ) {
      await this.applyGraphStatus(plan, 'relay', 'failed', undefined, 'relay-failed')
      return this.updatePlan(plan, { phase: 'failed', errorStatus: 'QUOTE_CHANGED' })
    }
    const identity = await this.requirePlanIdentity(plan)
    const signingChainId = this.clusterIntentChain(plan, identity)
    const bindings = await Promise.all(
      quotes.map(async (quote, sequence) => {
        const generated = await this.options.api.generateIntent({
          signerId: plan.signerId,
          depositAddress: quote.quote.depositAddress,
          standard: confidentialIntentStandard(signingChainId)
        })
        return assertDirectConfidentialWithdrawIntentBinding({
          intent: generated.intent,
          quote,
          signerId: plan.signerId,
          sourceAsset: plan.source.protocolAssetId,
          sourceAmountRaw: plan.splitSourceAmounts[sequence],
          destinationAsset: plan.destination.protocolAssetId,
          destinationAddress: plan.destination.address,
          now: this.now()
        })
      })
    )
    const nonces = bindings.map(binding => {
      const decoded = JSON.parse(binding.payload) as { nonce: string }
      return decoded.nonce
    })
    if (new Set(nonces).size !== nonces.length)
      throw new Error('Cluster withdraw intents must use distinct nonces')
    const signedPayloads =
      [] as ConfidentialWithdrawRequest['withdraws'][number]['signed_payload'][]
    for (const binding of bindings) {
      signedPayloads.push(
        await this.options.signer.signMessage({
          identity,
          chainId: signingChainId,
          payload: binding.payload
        })
      )
    }
    const rows: ConfidentialWithdrawRow[] = quotes.map((quote, sequence) =>
      Object.freeze({
        sequence,
        sourceAmountRaw: plan.splitSourceAmounts[sequence],
        amountRaw: quote.quote.amountOut,
        depositAddress: quote.quote.depositAddress,
        destinationAddress: plan.destination.address,
        destinationChain: plan.destination.chainName,
        token: plan.destination.protocolAssetId,
        deadline: bindings[sequence].deadline,
        status: 'SIGNED',
        signedPayload: signedPayloads[sequence]
      })
    )
    const frozenRequest = normalizeConfidentialWithdrawRequest({
      from_amount: plan.source.amountRaw,
      from_chain: plan.source.chainName,
      from_token: plan.source.protocolAssetId,
      mode: 'TRANSFER',
      signer_id: plan.signerId,
      withdraws: Object.freeze(
        rows.map(row =>
          Object.freeze({
            amount: row.amountRaw,
            deposit_address: row.depositAddress,
            destination_address: row.destinationAddress,
            destination_chain: row.destinationChain,
            execution_type: 'CONFIDENTIAL_1CLICK' as const,
            sequence: row.sequence,
            signed_payload: row.signedPayload!,
            token: row.token
          })
        )
      )
    })
    const requestFingerprint = await fingerprintConfidentialValue(frozenRequest)
    const frozen = await this.updatePlan(plan, {
      phase: 'submitting',
      withdraws: Object.freeze(rows),
      frozenRequest,
      requestFingerprint,
      expectedOutputRaw,
      minimumOutputRaw
    })
    await this.ensureGraph(frozen)
    await this.applyGraphStatus(frozen, 'relay', 'confirming')
    for (const row of rows)
      await this.applyGraphStatus(frozen, `withdraw:${row.sequence}`, 'confirming', {
        externalReference: row.depositAddress
      })
    return frozen
  }

  private async signAndFreezeDirectWithdraw(
    plan: ConfidentialFundingPlan
  ): Promise<ConfidentialFundingPlan> {
    let row = plan.withdraws[0]
    let formalExpectedOutputRaw = plan.expectedOutputRaw
    let formalMinimumOutputRaw = plan.minimumOutputRaw
    if (!row) throw new Error('Shield withdraw intent is unavailable')
    if (!row.signedPayload) {
      const frozenQuote =
        keepsFrozenConfidentialQuote(plan) && plan.swapQuote?.quoteRequest.dry === false
          ? plan.swapQuote
          : undefined
      if (plan.purpose === 'native-zec-swap' && !frozenQuote) {
        throw new Error('Native ZEC swap quote is unavailable')
      }
      const quote =
        frozenQuote ??
        (await this.quoteBound({
          referral: withdrawalReferral(plan),
          originAsset: plan.source.protocolAssetId,
          destinationAsset: plan.destination.protocolAssetId,
          amountRaw: plan.source.amountRaw,
          signerId: plan.signerId,
          recipient: plan.destination.address,
          depositType: 'CONFIDENTIAL_INTENTS',
          refundType: 'CONFIDENTIAL_INTENTS',
          recipientType: directConfidentialRecipientType(
            plan.purpose === 'native-zec-swap' ? 'withdraw' : plan.operation
          ),
          slippageBps: plan.slippageBps,
          dry: false
        }))
      this.assertQuoteBinding(
        quote,
        {
          originAsset: plan.source.protocolAssetId,
          destinationAsset: plan.destination.protocolAssetId,
          amountRaw: plan.source.amountRaw,
          signerId: plan.signerId,
          recipient: plan.destination.address,
          depositType: 'CONFIDENTIAL_INTENTS',
          refundType: 'CONFIDENTIAL_INTENTS',
          recipientType: directConfidentialRecipientType(
            plan.purpose === 'native-zec-swap' ? 'withdraw' : plan.operation
          ),
          slippageBps: plan.slippageBps
        },
        this.now()
      )
      if (
        keepsFrozenConfidentialQuote(plan) &&
        (await fingerprintDirectConfidentialApproval(
          readConfidentialQuoteAppFees(plan.swapQuote)
        )) !== (await fingerprintDirectConfidentialApproval(readConfidentialQuoteAppFees(quote)))
      ) {
        throw new Error('Shield swap fees changed. Review the transfer again.')
      }
      if (
        plan.operation === 'withdraw' &&
        plan.reviewedAppFeesFingerprint &&
        plan.reviewedAppFeesFingerprint !==
          (await fingerprintDirectConfidentialApproval([readConfidentialQuoteAppFees(quote)]))
      ) {
        throw new Error('Shield withdraw fees changed. Review the transfer again.')
      }
      if (
        !quote.quote.depositAddress ||
        BigInt(quote.quote.amountOut) < BigInt(plan.minimumOutputRaw) ||
        BigInt(quote.quote.minAmountOut) < BigInt(plan.minimumOutputRaw)
      )
        throw new Error('Shield withdraw quote changed. Review the transfer again.')
      const signingChainId = this.directSpendSigningChainId(plan)
      const generated = await this.options.api.generateIntent({
        signerId: plan.signerId,
        depositAddress: quote.quote.depositAddress,
        standard: confidentialIntentStandard(signingChainId)
      })
      const binding = assertDirectConfidentialWithdrawIntentBinding({
        intent: generated.intent,
        quote,
        signerId: plan.signerId,
        sourceAsset: plan.source.protocolAssetId,
        sourceAmountRaw: plan.source.amountRaw,
        destinationAsset: plan.destination.protocolAssetId,
        destinationAddress: plan.destination.address,
        now: this.now()
      })
      const signedPayload = await this.options.signer.signMessage({
        identity: await this.requirePlanIdentity(plan),
        chainId: signingChainId,
        payload: binding.payload
      })
      row = Object.freeze({
        ...row,
        amountRaw: quote.quote.amountOut,
        depositAddress: quote.quote.depositAddress,
        deadline: binding.deadline,
        status: 'SIGNED',
        signedPayload
      })
      formalExpectedOutputRaw = quote.quote.amountOut
      formalMinimumOutputRaw = quote.quote.minAmountOut
    }
    if (row.deadline <= this.now()) {
      throw new Error('Shield withdraw signature expired. Review the transfer again.')
    }
    const frozenRequest = normalizeConfidentialWithdrawRequest({
      from_amount: plan.source.amountRaw,
      from_chain: plan.source.chainName,
      from_token: plan.source.protocolAssetId,
      mode: plan.source.protocolAssetId === plan.destination.protocolAssetId ? 'TRANSFER' : 'SWAP',
      signer_id: plan.signerId,
      withdraws: Object.freeze([
        Object.freeze({
          amount: row.amountRaw,
          deposit_address: row.depositAddress,
          destination_address: plan.destination.address,
          destination_chain: plan.destination.chainName,
          execution_type: 'CONFIDENTIAL_1CLICK' as const,
          sequence: 0,
          signed_payload: row.signedPayload!,
          token: plan.destination.protocolAssetId
        })
      ])
    })
    const requestFingerprint = await fingerprintConfidentialValue(frozenRequest)
    plan = await this.updatePlan(plan, {
      phase: 'submitting',
      withdraws: Object.freeze([row]),
      expectedOutputRaw: formalExpectedOutputRaw,
      minimumOutputRaw: formalMinimumOutputRaw,
      frozenRequest,
      requestFingerprint
    })
    await this.ensureGraph(plan)
    await this.applyGraphStatus(plan, 'relay', 'confirming')
    await this.applyGraphStatus(plan, 'withdraw:0', 'confirming', {
      externalReference: row.depositAddress
    })
    return plan
  }

  private async recoverOrSubmit(
    plan: ConfidentialFundingPlan,
    accessToken: string
  ): Promise<ConfidentialFundingPlan> {
    if (!plan.frozenRequest || !plan.requestFingerprint) {
      throw new Error('Frozen private withdraw request is unavailable')
    }
    const frozenRequest = normalizeConfidentialWithdrawRequest(plan.frozenRequest)
    if ((await fingerprintConfidentialValue(frozenRequest)) !== plan.requestFingerprint) {
      throw new Error('Frozen private withdraw request was modified')
    }
    let current = plan
    for (const requestRow of frozenRequest.withdraws) {
      const row = current.withdraws[requestRow.sequence]
      if (!row || normalizeStatus(row.status) !== 'SIGNED') continue

      const priorStatus = await this.readStatus(
        current,
        row.depositAddress,
        'before-submit',
        row.sequence
      )
      if (!priorStatus) {
        if (!needsConfidentialSubmissionCheck(current)) await this.scheduleMonitoring()
        return current
      }
      const prior = normalizeStatus(priorStatus?.status ?? '')
      let intentHash: string | undefined
      let observedStatus: Awaited<ReturnType<ConfidentialFundingApi['getStatus']>> | null =
        priorStatus
      if (!prior || prior === 'PENDING_DEPOSIT' || prior === 'INCOMPLETE_DEPOSIT') {
        if (row.deadline <= this.now()) {
          if (!needsConfidentialSubmissionCheck(current)) await this.scheduleMonitoring()
          return current
        }
        if (needsConfidentialSubmissionCheck(current)) await this.requirePlanIdentity(current)
        try {
          const submitted = await this.options.api.submitIntent(
            requestRow.signed_payload,
            accessToken
          )
          intentHash = submitted.intentHash
          observedStatus = null
          console.info('[Confidential Funding] Intent submitted', {
            planId: current.planId,
            phase: current.phase,
            sequence: requestRow.sequence,
            intentHash: submitted.intentHash
          })
        } catch (error) {
          if (authenticationError(error)) throw error
          observedStatus = await this.readStatus(
            current,
            row.depositAddress,
            'submit-recovery',
            row.sequence
          )
          const recoveredStatus = normalizeStatus(observedStatus?.status ?? '')
          if (
            !recoveredStatus ||
            recoveredStatus === 'PENDING_DEPOSIT' ||
            recoveredStatus === 'INCOMPLETE_DEPOSIT'
          ) {
            if (error instanceof ConfidentialFundingApiError && error.ambiguous) {
              await this.scheduleMonitoring()
              return current
            }
            throw error
          }
        }
      }

      const nextRows = current.withdraws.map(item =>
        item.sequence === requestRow.sequence
          ? Object.freeze({
              ...item,
              status: observedStatus?.status ?? 'PROCESSING',
              ...(intentHash ? { intentHash } : {}),
              ...(observedStatus?.transactionHash
                ? { transactionHash: observedStatus.transactionHash }
                : {}),
              ...(observedStatus?.errorStatus ? { errorStatus: observedStatus.errorStatus } : {})
            })
          : item
      )
      current = await this.updatePlan(current, { withdraws: Object.freeze(nextRows) })
    }

    const sanitizedRows = current.withdraws.map(({ signedPayload: _signedPayload, ...row }) =>
      Object.freeze({
        ...row,
        status: normalizeStatus(row.status) === 'SIGNED' ? 'PROCESSING' : row.status
      })
    )
    return this.updatePlan(current, {
      phase: 'processing',
      orderId: undefined,
      backendStatus: undefined,
      errorStatus: undefined,
      frozenRequest: undefined,
      withdraws: Object.freeze(sanitizedRows)
    })
  }

  private async ensureOrderHistoryToken(plan: ConfidentialFundingPlan): Promise<string> {
    const stored = await this.options.store.getHistorySession(
      plan.network,
      plan.keyDomainId,
      plan.accountId
    )
    if (
      stored &&
      stored.principalType === 'wallet' &&
      stored.queryAddress.toLowerCase() === plan.signerId.toLowerCase() &&
      Date.parse(stored.expiresAt) > this.now() + SESSION_REFRESH_BUFFER_MS
    )
      return stored.token
    const identity = await this.requirePlanIdentity(plan)
    const chainId = this.orderHistoryAuthChain(plan, identity)
    const challenge = await this.options.api.createOrderAuthChallenge({
      walletAddress: identity.address,
      chainId: parseChainId(chainId).reference
    })
    const signed = await this.options.signer.signMessage({
      identity,
      chainId,
      payload: challenge.message
    })
    const token = await this.options.api.authenticateOrderChallenge(challenge, signed)
    await this.options.store.putHistorySession(
      plan.network,
      plan.keyDomainId,
      plan.accountId,
      token
    )
    return token.token
  }

  private matchesClusterOrder(
    plan: ConfidentialFundingPlan,
    order: ConfidentialPrivateOrder
  ): boolean {
    const frozen = plan.frozenRequest
    if (
      !frozen ||
      order.signerId.toLowerCase() !== frozen.signer_id.toLowerCase() ||
      order.mode !== frozen.mode ||
      order.fromAmount !== frozen.from_amount ||
      order.fromChain !== frozen.from_chain ||
      order.fromToken !== frozen.from_token
    )
      return false
    const rows = order.transactions.filter(row => row.transactionType.toUpperCase() === 'WITHDRAW')
    const deposits = order.transactions.filter(
      row => row.transactionType.toUpperCase() === 'DEPOSIT'
    )
    if (
      rows.length !== frozen.withdraws.length ||
      rows.length + deposits.length !== order.transactions.length ||
      deposits.length > (plan.requiresDeposit ? 1 : 0) ||
      (deposits.length === 1 &&
        (deposits[0].amount !== plan.source.amountRaw ||
          deposits[0].depositAddress.toLowerCase() !==
            plan.depositQuote?.quote.depositAddress.toLowerCase()))
    )
      return false
    return frozen.withdraws.every((expected, sequence) => {
      const actual = rows.find(row => row.sequence === sequence)
      return (
        actual?.amount === expected.amount &&
        actual.depositAddress.toLowerCase() === expected.deposit_address.toLowerCase() &&
        actual.destinationAddress.toLowerCase() === expected.destination_address.toLowerCase() &&
        actual.destinationChain === expected.destination_chain &&
        actual.token === expected.token &&
        (actual.executionType === undefined || actual.executionType === expected.execution_type)
      )
    })
  }

  private async findClusterOrder(
    plan: ConfidentialFundingPlan,
    walletToken: string
  ): Promise<ConfidentialPrivateOrder | null> {
    if (plan.orderId) {
      const details = await this.options.api.getPrivateOrderDetails({
        walletToken,
        orderIds: [plan.orderId]
      })
      const match = details.find(order => order.orderId === plan.orderId)
      if (match && !this.matchesClusterOrder(plan, match))
        throw new Error('Cluster order does not match the signed batch')
      return match ?? null
    }
    const matches: ConfidentialPrivateOrder[] = []
    for (let page = 0; page < 20; page += 1) {
      const result = await this.options.api.getPrivateOrders({
        walletToken,
        signerId: plan.signerId,
        limit: 50,
        offset: page * 50
      })
      for (let index = 0; index < result.orders.length; index += 10) {
        const candidates = result.orders
          .slice(index, index + 10)
          .filter(
            order =>
              order.signerId.toLowerCase() === plan.signerId.toLowerCase() &&
              order.fromAmount === plan.source.amountRaw &&
              order.fromToken === plan.source.protocolAssetId
          )
        if (!candidates.length) continue
        const details = await this.options.api.getPrivateOrderDetails({
          walletToken,
          orderIds: candidates.map(order => order.orderId)
        })
        matches.push(...details.filter(order => this.matchesClusterOrder(plan, order)))
      }
      if (!result.hasNextPage) break
    }
    if (matches.length > 1) throw new Error('Multiple Cluster orders match the signed batch')
    return matches[0] ?? null
  }

  private async recoverOrSubmitCluster(
    plan: ConfidentialFundingPlan
  ): Promise<ConfidentialFundingPlan> {
    if (
      !plan.frozenRequest ||
      !plan.requestFingerprint ||
      (await fingerprintConfidentialValue(
        normalizeConfidentialWithdrawRequest(plan.frozenRequest)
      )) !== plan.requestFingerprint
    )
      throw new Error('Frozen Cluster batch was modified or is unavailable')
    const signerFamily = this.confidentialPlanSignerFamily(plan)
    if (signerFamily !== 'evm') {
      if (plan.batchSubmissionAttemptedAt === undefined) {
        if (plan.withdraws.some(row => row.deadline <= this.now())) {
          throw new Error(
            'Cluster signatures expired before submission. Review the transfer again.'
          )
        }
        plan = await this.updatePlan(plan, { batchSubmissionAttemptedAt: this.now() })
        try {
          const result = await this.options.api.submitWithdraws(plan.frozenRequest!, signerFamily)
          plan = await this.updatePlan(plan, { orderId: result.orderId, phase: 'processing' })
        } catch (error) {
          if (isExplicitAppFeeRejection(error)) {
            plan = await this.updatePlan(plan, { errorStatus: 'APP_FEE_REJECTED_2002' })
            return this.finishRejectedCluster(plan)
          }
          await this.scheduleMonitoring()
          return plan
        }
      }
      // An attempted NEAR batch is recovered from deposit-address status, not resubmitted.
      if (plan.phase === 'submitting') {
        plan = await this.updatePlan(plan, { phase: 'processing' })
      }
      await this.scheduleMonitoring()
      return plan
    }
    let walletToken: string
    try {
      walletToken = await this.ensureOrderHistoryToken(plan)
    } catch (error) {
      if (plan.batchSubmissionAttemptedAt !== undefined && definitiveHistoryAuthRejection(error)) {
        await this.scheduleMonitoring()
      }
      if (
        plan.batchSubmissionAttemptedAt !== undefined ||
        plan.orderId ||
        !definitiveHistoryAuthRejection(error)
      )
        throw error
      for (const row of plan.withdraws) {
        await this.applyGraphStatus(
          plan,
          `withdraw:${row.sequence}`,
          'failed',
          undefined,
          'relay-failed'
        )
      }
      await this.applyGraphStatus(plan, 'relay', 'failed', undefined, 'relay-failed')
      const withdraws = plan.withdraws.map(({ signedPayload: _signedPayload, ...row }) => ({
        ...row,
        status: 'FAILED',
        errorStatus: 'HISTORY_AUTH_REJECTED'
      }))
      return this.updatePlan(plan, {
        phase: 'failed',
        resumePhase: undefined,
        errorStatus: 'HISTORY_AUTH_REJECTED',
        frozenRequest: undefined,
        requestFingerprint: undefined,
        withdraws: Object.freeze(withdraws)
      })
    }
    if (plan.batchSubmissionAttemptedAt === undefined) {
      if (plan.withdraws.some(row => row.deadline <= this.now()))
        throw new Error('Cluster signatures expired before submission. Review the transfer again.')
      plan = await this.updatePlan(plan, { batchSubmissionAttemptedAt: this.now() })
      try {
        const result = await this.options.api.submitWithdraws(plan.frozenRequest!)
        plan = await this.updatePlan(plan, { orderId: result.orderId })
      } catch (error) {
        if (isExplicitAppFeeRejection(error)) {
          plan = await this.updatePlan(plan, { errorStatus: 'APP_FEE_REJECTED_2002' })
          return this.finishRejectedCluster(plan)
        }
        // The request may have reached the service. Recovery only reads order history.
        await this.scheduleMonitoring()
        return plan
      }
    }
    const order = await this.findClusterOrder(plan, walletToken)
    if (!order) {
      await this.scheduleMonitoring()
      return plan
    }
    if (!plan.orderId) plan = await this.updatePlan(plan, { orderId: order.orderId })
    return this.updateClusterOrderObservation(plan, order)
  }

  private assertRejectedClusterCanFinalize(plan: ConfidentialFundingPlan): void {
    if (
      plan.operation !== 'cluster' ||
      (plan.phase !== 'submitting' &&
        !(plan.phase === 'needs-auth' && plan.resumePhase === 'submitting')) ||
      plan.batchSubmissionAttemptedAt === undefined ||
      plan.orderId ||
      !plan.frozenRequest ||
      !plan.requestFingerprint ||
      plan.withdraws.some(
        row =>
          normalizeStatus(row.status) !== 'SIGNED' ||
          !row.signedPayload ||
          row.intentHash !== undefined ||
          row.transactionHash !== undefined ||
          row.scheduledAt !== undefined
      )
    ) {
      throw new Error('Cluster batch is not eligible for rejection finalization')
    }
  }

  private async finishRejectedCluster(
    plan: ConfidentialFundingPlan
  ): Promise<ConfidentialFundingPlan> {
    this.assertRejectedClusterCanFinalize(plan)
    for (const row of plan.withdraws) {
      await this.applyGraphStatus(
        plan,
        `withdraw:${row.sequence}`,
        'failed',
        undefined,
        'relay-failed'
      )
    }
    await this.applyGraphStatus(plan, 'relay', 'failed', undefined, 'relay-failed')
    const graph = await this.options.repository.get(
      {
        keyDomainId: parseKeyDomainId(plan.keyDomainId),
        accountId: parseAccountId(plan.accountId)
      },
      parseTransactionId(plan.transactionId)
    )
    const failedSegment = (name: string) =>
      graph?.segments.find(
        segment =>
          segment.id === parseTransactionSegmentId(`segment:confidential:${plan.planId}:${name}`)
      )?.status === 'failed'
    if (
      !failedSegment('relay') ||
      plan.withdraws.some(row => !failedSegment(`withdraw:${row.sequence}`))
    ) {
      throw new Error('Cluster rejection graph is incomplete')
    }
    return this.updatePlan(plan, {
      phase: 'failed',
      resumePhase: undefined,
      withdraws: Object.freeze(
        plan.withdraws.map(row =>
          Object.freeze({ ...row, status: 'FAILED', errorStatus: plan.errorStatus })
        )
      )
    })
  }

  private async observeRefund(
    plan: ConfidentialFundingPlan,
    refresh: boolean
  ): Promise<ConfidentialFundingPlan> {
    const interval = refresh
      ? REFUND_STATUS_CHECK_INTERVAL_MS
      : refundStatusCheckInterval(plan, this.now())
    if (plan.settlementCheckedAt !== undefined && this.now() - plan.settlementCheckedAt < interval)
      return plan
    // Persist throttling across service-worker restarts without emitting an activity update.
    plan = Object.freeze({ ...plan, settlementCheckedAt: this.now() })
    await this.options.store.putPlan(plan)
    try {
      if (plan.orderId || plan.withdraws.some(row => row.intentHash)) {
        plan = await this.refreshSettlement(plan, undefined, true)
      } else if (plan.depositQuote) {
        const status = await this.readStatus(
          plan,
          plan.depositQuote.quote.depositAddress,
          'deposit'
        )
        if (status) {
          const depositSettlementStatus = normalizeStatus(status.status)
          if (depositSettlementStatus === 'REFUNDED') {
            plan = await this.updatePlan(plan, { phase: 'refunded' })
            void this.options
              .refreshPortfolio?.({
                keyDomainId: plan.keyDomainId,
                accountId: plan.accountId,
                chainIds: [plan.source.chainId],
                domain: 'chain'
              })
              .catch(() => {})
          }
        }
      }
    } catch {
      // Preserve the execution outcome. Observation must never request signatures or resubmit.
    }
    return plan
  }

  private async updateClusterOrderObservation(
    plan: ConfidentialFundingPlan,
    order: ConfidentialPrivateOrder
  ): Promise<ConfidentialFundingPlan> {
    if (!this.matchesClusterOrder(plan, order))
      throw new Error('Cluster order does not match the signed batch')
    const rows = plan.withdraws.map(row => {
      const observed = order.transactions.find(
        item => item.transactionType.toUpperCase() === 'WITHDRAW' && item.sequence === row.sequence
      )!
      const serviceStatus = normalizeStatus(observed.status)
      const serviceRefunded = serviceStatus === 'REFUNDED'
      const canSettleWithoutBroadcast =
        !observed.intentHash && ['FAILED', 'EXPIRED', 'CANCELLED'].includes(serviceStatus)
      return Object.freeze({
        ...mergeConfidentialWithdrawObservation(row, {
          status: serviceRefunded || canSettleWithoutBroadcast ? observed.status : 'PROCESSING',
          // The private-order hash is not specified as a destination hash on refunds.
          ...(!serviceRefunded && observed.transactionHash
            ? { transactionHash: observed.transactionHash }
            : {}),
          ...(observed.errorStatus ? { errorStatus: observed.errorStatus } : {})
        }),
        ...(observed.scheduledAt !== undefined ? { scheduledAt: observed.scheduledAt } : {}),
        ...(observed.intentHash ? { intentHash: observed.intentHash } : {})
      })
    })
    return this.updatePlan(plan, {
      phase: isTerminalPhase(plan.phase) ? plan.phase : 'processing',
      orderId: order.orderId,
      backendStatus: order.status,
      withdraws: Object.freeze(rows)
    })
  }

  private async refreshSettlement(
    plan: ConfidentialFundingPlan,
    accessToken?: string,
    observationOnly = false
  ): Promise<ConfidentialFundingPlan> {
    const previousPhase = plan.phase
    const previousRows = plan.withdraws
    // Wallet history challenges accept only an EVM address. NEAR settlement uses order-status.
    const observesClusterHistory =
      plan.operation === 'cluster' &&
      Boolean(plan.orderId) &&
      this.confidentialPlanSignerFamily(plan) === 'evm'
    if (observesClusterHistory && plan.orderId) {
      const stored = observationOnly
        ? await this.options.store.getHistorySession(plan.network, plan.keyDomainId, plan.accountId)
        : null
      const walletToken = observationOnly
        ? stored?.principalType === 'wallet' &&
          stored.queryAddress.toLowerCase() === plan.signerId.toLowerCase() &&
          Date.parse(stored.expiresAt) > this.now() + SESSION_REFRESH_BUFFER_MS
          ? stored.token
          : undefined
        : await this.ensureOrderHistoryToken(plan)
      let details: readonly ConfidentialPrivateOrder[] = []
      try {
        if (walletToken)
          details = await this.options.api.getPrivateOrderDetails({
            walletToken,
            orderIds: [plan.orderId]
          })
      } catch (error) {
        if (
          error instanceof ConfidentialFundingApiError &&
          [401, 403].includes(error.status ?? -1)
        ) {
          await this.options.store.deleteHistorySession(
            plan.network,
            plan.keyDomainId,
            plan.accountId
          )
          if (!observationOnly) throw new Error('Wallet history authorization is required')
        }
        if (!observationOnly) throw error
      }
      const order = details.find(item => item.orderId === plan.orderId)
      if (order) {
        if (observationOnly) {
          try {
            plan = await this.updateClusterOrderObservation(plan, order)
          } catch {
            // An unbound history response cannot block independent settlement evidence.
          }
        } else plan = await this.updateClusterOrderObservation(plan, order)
      }
    }
    const statuses = await Promise.all(
      plan.withdraws.map(row =>
        this.readStatus(plan, row.depositAddress, 'settlement', row.sequence)
      )
    )
    const rows = plan.withdraws.map((row, index) => {
      const status = statuses[index]
      return mergeConfidentialWithdrawObservation(row, {
        status: status?.status ?? row.status,
        transactionHash: status?.transactionHash,
        errorStatus: status?.errorStatus,
        settledOutputRaw:
          status?.settledAmountOutRaw && isPositiveRaw(status.settledAmountOutRaw)
            ? status.settledAmountOutRaw
            : undefined
      })
    })
    const newlySettled = rows.some((row, index) => {
      const current = normalizeStatus(row.status)
      const previous = normalizeStatus(previousRows[index].status)
      return (
        (current === 'SUCCESS' || current === 'COMPLETED') &&
        previous !== 'SUCCESS' &&
        previous !== 'COMPLETED'
      )
    })
    const settlement = aggregateConfidentialSettlement(rows.map(row => row.status))
    for (const row of rows) {
      const status = normalizeStatus(row.status)
      if (status === 'SUCCESS' || status === 'COMPLETED') {
        await this.applyGraphStatus(plan, `withdraw:${row.sequence}`, 'final', {
          ...(row.transactionHash ? { transactionHash: row.transactionHash } : {}),
          ...(plan.operation === 'withdraw' && row.transactionHash && row.settledOutputRaw
            ? {
                settledAmount: {
                  assetId: parseAssetId(plan.destination.assetId).id,
                  amountRaw: row.settledOutputRaw
                }
              }
            : {})
        })
      } else if (['FAILED', 'REFUNDED', 'EXPIRED', 'CANCELLED'].includes(status)) {
        await this.applyGraphStatus(
          plan,
          `withdraw:${row.sequence}`,
          'failed',
          row.transactionHash ? { transactionHash: row.transactionHash } : undefined,
          failureCode(status)
        )
      } else {
        await this.applyGraphStatus(
          plan,
          `withdraw:${row.sequence}`,
          'confirming',
          row.transactionHash ? { transactionHash: row.transactionHash } : undefined
        )
      }
    }
    const next = await this.updatePlan(plan, {
      phase:
        observationOnly && settlement === 'confirming'
          ? previousPhase
          : phaseForSettlement(settlement),
      withdraws: Object.freeze(rows),
      backendStatus: undefined,
      errorStatus: observationOnly ? plan.errorStatus : undefined
    })
    if (settlement === 'success') {
      await this.applyGraphStatus(next, 'relay', 'final')
    } else if (settlement !== 'confirming') {
      const aggregateFailure: TransactionFailureCode =
        settlement === 'refunded'
          ? 'refunded'
          : settlement === 'expired'
            ? 'expired'
            : settlement === 'cancelled'
              ? 'cancelled'
              : 'relay-failed'
      await this.applyGraphStatus(next, 'relay', 'failed', undefined, aggregateFailure)
    }
    if (
      isTerminalPhase(next.phase) &&
      (!observationOnly ||
        next.phase !== previousPhase ||
        rows.some((row, index) => row.status !== previousRows[index].status))
    ) {
      const refreshedBalances = accessToken
        ? await this.readAndCacheBalancesForPlan(next, accessToken).catch(() => null)
        : null
      await this.options
        .refreshPortfolio?.({
          keyDomainId: next.keyDomainId,
          accountId: next.accountId,
          chainIds: [next.source.chainId],
          domain: 'confidential',
          ...(refreshedBalances === null ? {} : { balanceUpdated: true as const })
        })
        .catch(() => {})
      if (newlySettled && next.destinationDomain !== 'shield') {
        void this.options
          .refreshPortfolio?.({
            keyDomainId: next.keyDomainId,
            accountId: next.accountId,
            chainIds: [next.destination.chainId],
            domain: 'chain'
          })
          .catch(() => {})
      }
    } else if (newlySettled) {
      await this.options
        .refreshPortfolio?.({
          keyDomainId: plan.keyDomainId,
          accountId: plan.accountId,
          chainIds: [plan.source.chainId],
          domain: 'confidential'
        })
        .catch(() => {})
      if (plan.destinationDomain !== 'shield') {
        void this.options
          .refreshPortfolio?.({
            keyDomainId: plan.keyDomainId,
            accountId: plan.accountId,
            chainIds: [plan.destination.chainId],
            domain: 'chain'
          })
          .catch(() => {})
      }
    }
    return next
  }

  private async handleContinuationError(
    planId: string,
    error: unknown
  ): Promise<ConfidentialFundingPlan> {
    const plan = await this.options.store.getPlan(planId)
    if (!plan || plan.network !== this.options.network) throw error
    if (isTerminalPhase(plan.phase)) return plan
    if (isClusterRejectionReason(plan.errorStatus)) {
      await this.scheduleMonitoring()
      return plan
    }
    console.error('[Confidential Funding] Continuation failed', {
      planId: plan.planId,
      phase: plan.phase,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      serviceStatus: error instanceof ConfidentialFundingApiError ? error.status : null,
      retryable: retryableFundingError(error)
    })
    if (authenticationError(error)) {
      if (error instanceof ConfidentialFundingApiError && [401, 403].includes(error.status ?? -1)) {
        await this.options.store.deleteSession(
          plan.network,
          plan.keyDomainId,
          plan.accountId,
          plan.signerId
        )
      }
      return this.updatePlan(plan, {
        phase: 'needs-auth',
        resumePhase: plan.phase === 'needs-auth' ? plan.resumePhase : plan.phase
      })
    }
    if (retryableFundingError(error)) {
      await this.scheduleMonitoring()
      return plan
    }
    return this.updatePlan(plan, {
      errorStatus:
        error instanceof ConfidentialFundingApiError && error.status !== null
          ? `SERVICE_${error.status}`
          : 'LOCAL_PROCESSING_FAILED'
    })
  }

  private async readUsableSession(identity: ConfidentialSigningIdentity) {
    return this.readUsableSessionForScope(
      identity.context.chainAccount.scope.keyDomainId,
      identity.context.chainAccount.scope.accountId,
      identity.address
    )
  }

  private async readUsableSessionForPlan(plan: ConfidentialFundingPlan) {
    return this.readUsableSessionForScope(plan.keyDomainId, plan.accountId, plan.signerId)
  }

  private async readUsableSessionForScope(
    keyDomainId: string,
    accountId: string,
    signerId?: string
  ) {
    const session = await this.options.store.getSession(
      this.options.network,
      keyDomainId,
      accountId,
      signerId
    )
    if (!session) return null
    if (session.expiresAt > this.now() + SESSION_REFRESH_BUFFER_MS) return session
    if (session.refreshExpiresAt <= this.now()) return null
    try {
      const refreshed = await this.options.api.refresh(session)
      const retainedSignerId =
        session.signerId ??
        (signerId && isConfidentialEvmSigner(signerId) ? signerId.toLowerCase() : undefined)
      const next = Object.freeze(
        retainedSignerId ? { ...refreshed, signerId: retainedSignerId } : refreshed
      )
      await this.options.store.putSession(this.options.network, keyDomainId, accountId, next)
      return next
    } catch {
      return null
    }
  }

  private async reconcileDepositRequirement(
    plan: ConfidentialFundingPlan,
    identity: ConfidentialSigningIdentity
  ): Promise<ConfidentialFundingPlan> {
    const session = await this.readUsableSession(identity)
    if (!session) throw new Error('Confidential authorization session is unavailable')
    const balances = await this.readAndCacheBalances(identity, session.accessToken)
    const available = getConfidentialAvailableForAsset(balances, plan.source.protocolAssetId) ?? '0'
    if (!plan.requiresDeposit) {
      if (
        plan.operation === 'withdraw' ||
        plan.operation === 'cluster' ||
        plan.operation === 'swap' ||
        plan.operation === 'confidential-transfer'
      ) {
        const plans = (await this.options.store.listPlans()).filter(
          other =>
            other.network === plan.network &&
            other.keyDomainId === plan.keyDomainId &&
            other.accountId === plan.accountId
        )
        this.assertUnreservedBalance(
          plans,
          plan.source.protocolAssetId,
          plan.source.amountRaw,
          available,
          plan.planId,
          plan.signerId
        )
      } else if (BigInt(available) < BigInt(plan.source.amountRaw)) {
        throw new Error('Confidential balance changed. Review the transfer again.')
      }
      return this.updatePlan(plan, { confidentialBaselineRaw: available })
    }
    return this.updatePlan(plan, { confidentialBaselineRaw: available })
  }

  private async ensureSession(identity: ConfidentialSigningIdentity, authenticate: boolean) {
    const session = await this.readUsableSession(identity)
    if (session || !authenticate) return session
    const chainId = identity.context.chainAccount.scope.chainId
    const unsigned = await this.options.api.createAuthPayload(
      identity.address,
      confidentialSignerFamily(chainId)
    )
    const signed = await this.options.signer.signMessage({
      identity,
      chainId,
      payload: unsigned.payload
    })
    const authenticated = await this.options.api.authenticate(signed)
    const signedSession = Object.freeze({ ...authenticated, signerId: identity.address })
    await this.options.store.putSession(
      this.options.network,
      identity.context.chainAccount.scope.keyDomainId,
      identity.context.chainAccount.scope.accountId,
      signedSession
    )
    return signedSession
  }

  private async refreshPortfolioBalances(
    identity: ConfidentialSigningIdentity,
    accessToken: string
  ) {
    const scope = identity.context.chainAccount.scope
    const key = JSON.stringify([this.options.network, scope.keyDomainId, scope.accountId])
    let refresh = this.balanceRefreshes.get(key)
    if (!refresh) {
      refresh = new DedupPromise<readonly ConfidentialBalance[]>()
      this.balanceRefreshes.set(key, refresh)
    }
    try {
      return await refresh.run(() => this.readAndCacheBalances(identity, accessToken))
    } finally {
      if (this.balanceRefreshes.get(key) === refresh && !refresh.isPending) {
        this.balanceRefreshes.delete(key)
      }
    }
  }

  private async readAndCacheBalances(identity: ConfidentialSigningIdentity, accessToken: string) {
    const requestedAt = this.now()
    const balances = await this.options.api.getBalances(accessToken)
    await this.options.store.putBalances(
      this.options.network,
      identity.context.chainAccount.scope.keyDomainId,
      identity.context.chainAccount.scope.accountId,
      balances,
      requestedAt,
      identity.address
    )
    return balances
  }

  private async readAndCacheBalancesForPlan(plan: ConfidentialFundingPlan, accessToken: string) {
    const requestedAt = this.now()
    const balances = await this.options.api.getBalances(accessToken)
    await this.options.store.putBalances(
      this.options.network,
      plan.keyDomainId,
      plan.accountId,
      balances,
      requestedAt,
      plan.signerId
    )
    return balances
  }

  private nearPreparedDeposit(plan: ConfidentialFundingPlan) {
    const transfer = plan.preparedDeposit?.preparedTransfer
    if (!isNearConfidentialDeposit(transfer)) return null
    try {
      return parsePreparedNearConfidentialDeposit(transfer)
    } catch {
      return null
    }
  }

  private async broadcastNearDeposit(
    plan: ConfidentialFundingPlan
  ): Promise<ConfidentialFundingPlan> {
    const bridge = this.options.nearDeposit
    const rawTransaction = plan.preparedDeposit?.rawTransaction
    const expectedHash = plan.preparedDeposit?.transactionHash
    if (!bridge || !rawTransaction || !expectedHash) {
      await this.scheduleMonitoring()
      return plan
    }
    let transactionHash: string
    try {
      transactionHash = await bridge.broadcastSignedTransaction(rawTransaction)
    } catch {
      await this.scheduleMonitoring()
      return plan
    }
    if (transactionHash !== expectedHash) {
      await this.scheduleMonitoring()
      return plan
    }
    const confirming = await this.updatePlan(plan, { phase: 'deposit-confirming' })
    await this.applyGraphStatus(confirming, 'origin', 'broadcast', { transactionHash })
    return confirming
  }

  private async observeNearDeposit(
    plan: ConfidentialFundingPlan,
    transactionHash: string
  ): Promise<'failed' | 'final' | 'pending'> {
    const bridge = this.options.nearDeposit
    const signerId = this.nearPreparedDeposit(plan)?.signerId
    if (!bridge || !signerId) return 'pending'
    const status = await bridge
      .getTransactionStatus(transactionHash, signerId)
      .catch(() => ({ status: 'unknown' as const }))
    if (status.status === 'final') {
      await this.applyGraphStatus(plan, 'origin', 'final', { transactionHash })
      return 'final'
    }
    if (status.status === 'failed') {
      await this.applyGraphStatus(plan, 'origin', 'failed', undefined, 'reverted')
      return 'failed'
    }
    return 'pending'
  }

  private async ensureGraph(plan: ConfidentialFundingPlan): Promise<void> {
    if (!plan.requiresDeposit && !plan.requestFingerprint) return
    const scope = {
      keyDomainId: parseKeyDomainId(plan.keyDomainId),
      accountId: parseAccountId(plan.accountId)
    }
    const existing = await this.options.repository.get(
      scope,
      parseTransactionId(plan.transactionId)
    )
    const nearDeposit =
      this.nearPreparedDeposit(plan) !== null ||
      parseChainId(plan.source.chainId).namespace === 'near'
    if (existing) {
      if (nearDeposit) return
      const origin = existing.segments.find(segment => segment.role === 'origin')
      if (
        !plan.preparedDeposit?.transactionHash ||
        origin?.status === 'final' ||
        origin?.status === 'failed'
      )
        return
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current =
          attempt === 0
            ? existing
            : await this.options.repository.get(scope, parseTransactionId(plan.transactionId))
        if (!current) return
        const result = await this.options.repository.backfillConfidentialEvmOrigin({
          scope,
          transactionId: parseTransactionId(plan.transactionId),
          expectedRootRevision: current.root.revision,
          transactionHash: plan.preparedDeposit.transactionHash,
          legacySenderAddress: plan.source.address,
          preparedTransfer: plan.preparedDeposit.preparedTransfer,
          observedAt: this.now()
        })
        if (result.status === 'revision-conflict') continue
        if (result.status === 'applied') this.notifyActivityChanged(plan)
        return
      }
      return
    }
    const nearPrepared = nearDeposit ? this.nearPreparedDeposit(plan) : null
    const prepared =
      nearDeposit || !plan.preparedDeposit
        ? null
        : parsePreparedEvmTransfer(plan.preparedDeposit.preparedTransfer)
    const feeAsset = nearPrepared
      ? this.options.assets
          .list(parseChainId('near:mainnet').id)
          .find(entry => entry.asset.kind === 'native')?.asset.id
      : prepared
        ? this.options.assets
            .list(parseChainId(plan.source.chainId).id)
            .find(entry => entry.asset.kind === 'native')?.asset.id
        : undefined
    const graph = createConfidentialFundingGraph({
      planId: plan.planId,
      ...(plan.purpose === 'native-zec-swap' ? { purpose: plan.purpose } : {}),
      ...(plan.operation
        ? {
            operation: plan.operation,
            sourceDomain: plan.sourceDomain,
            destinationDomain: plan.destinationDomain
          }
        : {}),
      scope,
      source: {
        chainId: plan.source.chainId,
        assetId: plan.source.assetId,
        amountRaw: plan.source.amountRaw,
        address: plan.source.address,
        ...(nearPrepared ? { senderAddress: nearPrepared.signerId } : {}),
        ...(prepared
          ? {
              evmSenderAddress: prepared.from,
              evm: {
                nonce: prepared.transaction.nonce,
                maxFeePerGasWei:
                  prepared.transaction.type === 'legacy'
                    ? prepared.transaction.gasPrice
                    : prepared.transaction.maxFeePerGas,
                maxPriorityFeePerGasWei:
                  prepared.transaction.type === 'legacy'
                    ? '0'
                    : prepared.transaction.maxPriorityFeePerGas,
                gasLimit: prepared.transaction.gasLimit,
                ...(prepared.transaction.input.length >= 10
                  ? { methodSelector: prepared.transaction.input.slice(0, 10).toLowerCase() }
                  : {}),
                unsignedTransaction: prepared.transaction
              }
            }
          : {}),
        ...(feeAsset && nearPrepared
          ? {
              feeAssetId: feeAsset,
              maximumFeeRaw: nearPrepared.maximumFeeYocto
            }
          : {}),
        ...(feeAsset && prepared
          ? {
              feeAssetId: feeAsset,
              maximumFeeRaw: (
                BigInt(prepared.transaction.gasLimit) *
                BigInt(
                  prepared.transaction.type === 'legacy'
                    ? prepared.transaction.gasPrice
                    : prepared.transaction.maxFeePerGas
                )
              ).toString()
            }
          : {}),
        ...(plan.preparedDeposit?.transactionHash
          ? { transactionHash: plan.preparedDeposit.transactionHash }
          : {})
      },
      destination: {
        chainId: plan.destination.chainId,
        assetId: plan.destination.assetId,
        expectedAmountRaw: plan.expectedOutputRaw,
        address: plan.destination.address
      },
      externalRecipient:
        Boolean(plan.externalRecipient) &&
        plan.purpose !== 'move' &&
        plan.purpose !== 'native-zec-swap',
      withdrawDepositAddresses: plan.withdraws.map(row => row.depositAddress || null),
      requiresDeposit: plan.requiresDeposit,
      signedWithdrawFingerprint: plan.requestFingerprint,
      now: plan.createdAt
    })
    const result = await this.options.repository.create(graph)
    if (result.status === 'id-conflict') {
      throw new Error('Confidential funding transaction ID conflicts')
    }
    this.notifyActivityChanged(plan)
  }

  private async applyEvmObservation(
    plan: ConfidentialFundingPlan,
    observation: NonNullable<Awaited<ReturnType<typeof observeEvmTransaction>>>
  ): Promise<void> {
    const scope = {
      keyDomainId: parseKeyDomainId(plan.keyDomainId),
      accountId: parseAccountId(plan.accountId)
    }
    const transactionId = parseTransactionId(plan.transactionId)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const graph = await this.options.repository.get(scope, transactionId)
      if (!graph) return
      const segment = graph.segments.find(item => item.id.endsWith(':origin'))
      if (!segment) return
      const event = createEvmTransactionSegmentEvent({
        segment,
        observation,
        eventId: parseTransactionEventId(`event:confidential:${crypto.randomUUID()}`),
        observedAt: this.now()
      })
      if (!event) return
      const result = await this.options.repository.applySegmentEvent({
        scope,
        transactionId,
        segmentId: segment.id,
        event,
        expectedRootRevision: graph.root.revision,
        expectedSegmentRevision: segment.revision
      })
      if (result.status !== 'revision-conflict') {
        this.notifyActivityChanged(plan)
        return
      }
    }
  }

  private async applyGraphStatus(
    plan: ConfidentialFundingPlan,
    segment: 'origin' | 'relay' | `withdraw:${number}`,
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvidence,
    failure?: TransactionFailureCode
  ): Promise<void> {
    const scope = {
      keyDomainId: parseKeyDomainId(plan.keyDomainId),
      accountId: parseAccountId(plan.accountId)
    }
    const transactionId = parseTransactionId(plan.transactionId)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const graph = await this.options.repository.get(scope, transactionId)
      if (!graph) return
      const segmentId = parseTransactionSegmentId(`segment:confidential:${plan.planId}:${segment}`)
      const current = graph.segments.find(item => item.id === segmentId)
      if (!current || current.status === 'final' || current.status === 'failed') return
      const now = this.now()
      const event = {
        id: parseTransactionEventId(`event:confidential:${crypto.randomUUID()}`),
        status,
        cause: status === 'failed' ? ('failure' as const) : ('progress' as const),
        observedAt: now,
        ...(evidence ? { evidence } : {}),
        ...(status === 'failed'
          ? { failure: { code: failure ?? 'relay-failed', occurredAt: now } }
          : {})
      }
      const result = await this.options.repository.applySegmentEvent({
        scope,
        transactionId,
        segmentId,
        event,
        expectedRootRevision: graph.root.revision,
        expectedSegmentRevision: current.revision
      })
      if (result.status !== 'revision-conflict') {
        this.notifyActivityChanged(plan)
        return
      }
    }
  }

  private async requirePlan(planId: string): Promise<ConfidentialFundingPlan> {
    const plan = await this.options.store.getPlan(planId)
    if (!plan || plan.network !== this.options.network) {
      throw new Error('Confidential funding plan was not found')
    }
    return plan
  }

  private async readStatus(
    plan: ConfidentialFundingPlan,
    depositAddress: string,
    stage: 'deposit' | 'before-submit' | 'submit-recovery' | 'settlement',
    sequence?: number
  ) {
    try {
      const chainId = parseChainId(
        stage === 'deposit' ? plan.source.chainId : plan.destination.chainId
      ).reference
      return plan.operation === 'swap' || plan.operation === 'confidential-transfer'
        ? await this.options.api.getOneClickStatus(depositAddress)
        : await this.options.api.getStatus(depositAddress, chainId)
    } catch (error) {
      console.warn('[Confidential Funding] Status request failed', {
        planId: plan.planId,
        phase: plan.phase,
        stage,
        ...(sequence === undefined ? {} : { sequence }),
        errorName: error instanceof Error ? error.name : 'UnknownError',
        serviceStatus: error instanceof ConfidentialFundingApiError ? error.status : null
      })
      return null
    }
  }

  private isNearIncognitoCluster(value: {
    readonly source: { readonly chainId: string }
    readonly destination: { readonly chainId: string }
  }): boolean {
    return (
      parseChainId(value.source.chainId).namespace === 'near' &&
      value.source.chainId === value.destination.chainId
    )
  }

  private isNearDirectShieldWithdraw(value: {
    readonly operation?: string
    readonly sourceDomain?: string
    readonly source: { readonly chainId: string }
    readonly destination: { readonly chainId: string }
  }): boolean {
    return (
      value.operation === 'withdraw' &&
      value.sourceDomain === 'shield' &&
      this.isNearIncognitoCluster(value)
    )
  }

  private async nearDirectShieldPrincipal(
    sourceIdentity: ConfidentialSigningIdentity,
    input: {
      readonly operation?: string
      readonly sourceDomain?: string
      readonly source: { readonly chainId: string }
      readonly destination: { readonly chainId: string }
    }
  ): Promise<ConfidentialSigningIdentity | null> {
    if (!this.isNearDirectShieldWithdraw(input)) return null
    return this.nearClusterPrincipal(sourceIdentity, await this.requireNearAccount(sourceIdentity))
  }

  /**
   * Shield's confidential account is the EVM address when this wallet can sign
   * EVM. An imported NEAR key, and any identity that cannot sign EVM, keeps the
   * NEAR execution account. Hardware signing is unchanged.
   */
  private async nearClusterPrincipal(
    execution: ConfidentialSigningIdentity,
    account: NearConfidentialAccount
  ): Promise<ConfidentialSigningIdentity> {
    const kind = account.walletSource
      ? resolveConfidentialIdentity({
          walletSource: account.walletSource,
          accountIndex: account.accountIndex
        }).kind
      : 'unavailable'
    if (kind !== 'evm') return execution
    const evmChainId = parseChainId(getEvmNetworkConfig(this.options.network).chainId).id
    const evmIdentity = await this.options.signer.resolveIdentity(evmChainId)
    if (
      evmIdentity.kind !== 'evm' ||
      !isConfidentialEvmSigner(evmIdentity.address) ||
      evmIdentity.address !== evmIdentity.address.toLowerCase() ||
      evmIdentity.context.chainAccount.scope.keyDomainId !==
        execution.context.chainAccount.scope.keyDomainId ||
      evmIdentity.context.chainAccount.scope.accountId !==
        execution.context.chainAccount.scope.accountId ||
      evmIdentity.addressIndex !== execution.addressIndex
    ) {
      throw new Error('Confidential funding account or network changed')
    }
    return evmIdentity
  }

  private confidentialPlanSignerFamily(
    plan: Pick<
      ConfidentialFundingPlan,
      'operation' | 'signerId' | 'source' | 'destination' | 'network'
    >
  ): 'evm' | 'near' {
    if (plan.operation === 'cluster' && isConfidentialEvmSigner(plan.signerId)) return 'evm'
    return confidentialSignerFamily(
      confidentialSigningChainId(plan.source.chainId, plan.destination.chainId, plan.network)
    )
  }

  /**
   * History challenges accept only an EVM chain id. An EVM-principal NEAR
   * cluster still proves that principal, on the chain that resolved it.
   */
  private orderHistoryAuthChain(
    plan: ConfidentialFundingPlan,
    identity: ConfidentialSigningIdentity
  ): ChainId {
    const source = parseChainId(plan.source.chainId)
    if (source.namespace === 'eip155') return source.id
    const principal = parseChainId(identity.context.chainAccount.scope.chainId)
    if (principal.namespace !== 'eip155') {
      throw new Error('Wallet history identity is invalid')
    }
    return principal.id
  }

  private clusterIntentChain(
    plan: ConfidentialFundingPlan,
    identity: ConfidentialSigningIdentity
  ): ChainId {
    if (
      plan.operation === 'cluster' &&
      identity.kind === 'evm' &&
      parseChainId(plan.source.chainId).namespace === 'near'
    ) {
      return parseChainId(identity.context.chainAccount.scope.chainId).id
    }
    return confidentialSigningChainId(plan.source.chainId, plan.destination.chainId, plan.network)
  }

  private async nearClusterRouteChanged(
    plan: ConfidentialFundingPlan,
    identity: ConfidentialSigningIdentity
  ): Promise<boolean> {
    const account = await this.requireNearAccount(identity)
    const sourceAddress =
      plan.sourceDomain === 'private' ? account.peaAccountId : account.mainAccountId
    const destinationAddress =
      plan.destinationDomain === 'private' ? account.peaAccountId : account.mainAccountId
    return plan.source.address !== sourceAddress || plan.destination.address !== destinationAddress
  }

  private async requirePlanIdentity(plan: ConfidentialFundingPlan) {
    const signingChainId = confidentialSigningChainId(
      plan.source.chainId,
      plan.destination.chainId,
      plan.network
    )
    let identity = await this.options.signer.resolveIdentity(signingChainId)
    const nearExecution = identity
    const nearCluster = plan.operation === 'cluster' && this.isNearIncognitoCluster(plan)
    const nearDirectDeposit =
      plan.operation === 'deposit' && parseChainId(plan.source.chainId).namespace === 'near'
    const nearShieldWithdraw = this.isNearDirectShieldWithdraw(plan)
    let nearDepositAccount: NearConfidentialAccount | null = null
    if (
      (nearCluster || nearDirectDeposit || nearShieldWithdraw) &&
      isConfidentialEvmSigner(plan.signerId)
    ) {
      const account = await this.requireNearAccount(identity)
      if (nearDirectDeposit) nearDepositAccount = account
      const principal = await this.nearClusterPrincipal(identity, account)
      if (principal.address !== plan.signerId) {
        throw new Error('Active Wallet Account changed before private funding completed')
      }
      identity = principal
    }
    // The withdrawal lands on the NEAR account. The EVM principal only signs the spend.
    const routeIdentity =
      nearShieldWithdraw && isConfidentialEvmSigner(plan.signerId) ? nearExecution : identity
    if (
      !nearCluster &&
      plan.operation === 'withdraw' &&
      plan.sourceDomain === 'shield' &&
      !isConfidentialEvmSigner(plan.signerId) &&
      identity.address !== plan.signerId &&
      (plan.network === 'mainnet' || plan.network === 'testnet')
    ) {
      const nearIdentity = await this.options.signer
        .resolveIdentity(parseChainId(getNearNetworkConfig(plan.network).chainId).id)
        .catch(() => null)
      if (
        !nearIdentity ||
        nearIdentity.kind !== 'near' ||
        isConfidentialEvmSigner(nearIdentity.address) ||
        nearIdentity.address !== plan.signerId ||
        nearIdentity.addressIndex !== plan.addressIndex ||
        nearIdentity.context.chainAccount.scope.keyDomainId !== plan.keyDomainId ||
        nearIdentity.context.chainAccount.scope.accountId !== plan.accountId
      ) {
        throw new Error('Active Wallet Account changed before private funding completed')
      }
      identity = nearIdentity
    }
    this.assertOwnZcashMoveRecipient(plan)
    const nearRouteChanged = nearCluster
      ? await this.nearClusterRouteChanged(plan, routeIdentity)
      : false
    const nearDepositSourceChanged = nearDepositAccount
      ? plan.source.address !==
        (plan.sourceDomain === 'private'
          ? nearDepositAccount.peaAccountId
          : nearDepositAccount.mainAccountId)
      : false
    if (
      identity.context.chainAccount.scope.keyDomainId !== plan.keyDomainId ||
      identity.context.chainAccount.scope.accountId !== plan.accountId ||
      identity.address !== plan.signerId ||
      identity.addressIndex !== plan.addressIndex ||
      routeIdentity.context.chainAccount.scope.keyDomainId !== plan.keyDomainId ||
      routeIdentity.context.chainAccount.scope.accountId !== plan.accountId ||
      (nearCluster
        ? nearRouteChanged
        : nearDepositAccount
          ? nearDepositSourceChanged
          : plan.operation === undefined
            ? routeIdentity.peaAddress.toLowerCase() !== plan.destination.address.toLowerCase()
            : plan.operation === 'deposit'
              ? plan.source.address.toLowerCase() !==
                (plan.sourceDomain === 'private'
                  ? routeIdentity.peaAddress
                  : routeIdentity.address
                ).toLowerCase()
              : plan.operation === 'swap'
                ? plan.source.address.toLowerCase() !== routeIdentity.address.toLowerCase() ||
                  plan.destination.address.toLowerCase() !== routeIdentity.address.toLowerCase()
                : plan.operation === 'confidential-transfer'
                  ? plan.source.address.toLowerCase() !== routeIdentity.address.toLowerCase() ||
                    !isAddress(plan.destination.address) ||
                    /^0x0{40}$/i.test(plan.destination.address) ||
                    plan.destination.address.toLowerCase() === routeIdentity.address.toLowerCase()
                  : plan.externalRecipient
                    ? !isValidExternalRecipient(
                        plan.externalRecipient,
                        plan.destination.chainId,
                        plan.network
                      ) ||
                      plan.externalRecipient.toLowerCase() !==
                        plan.destination.address.toLowerCase() ||
                      plan.source.address.toLowerCase() !== routeIdentity.address.toLowerCase()
                    : plan.destination.address.toLowerCase() !==
                      (plan.destinationDomain === 'private'
                        ? routeIdentity.peaAddress
                        : routeIdentity.address
                      ).toLowerCase())
    ) {
      throw new Error('Active Wallet Account changed before private funding completed')
    }
    return identity
  }

  private assertOwnZcashMoveRecipient(value: {
    readonly purpose?: 'move' | 'native-zec-swap'
    readonly operation?: string
    readonly sourceDomain?: string
    readonly destinationDomain?: string
    readonly network?: Network
    readonly keyDomainId?: string
    readonly accountId?: string
    readonly source: { readonly assetId: string; readonly protocolAssetId: string }
    readonly destination: { readonly assetId: string; readonly protocolAssetId: string }
    readonly externalRecipient?: string
  }): void {
    if (value.purpose === undefined) return
    const isMove = value.purpose === 'move'
    const isNativeZecSwap = value.purpose === 'native-zec-swap'
    const active = this.options.getNativeZecActiveAccount?.()
    const assetId = `${getZcashChainId(this.options.network)}/slip44:133`
    if (
      (!isMove && !isNativeZecSwap) ||
      value.operation !== 'withdraw' ||
      value.sourceDomain !== 'shield' ||
      value.destinationDomain !== 'public' ||
      value.destination.assetId !== assetId ||
      value.destination.protocolAssetId !== ZEC_ZCASH_ASSET ||
      (isMove &&
        (value.source.assetId !== assetId || value.source.protocolAssetId !== ZEC_ZCASH_ASSET)) ||
      (isNativeZecSwap && value.source.protocolAssetId === ZEC_ZCASH_ASSET) ||
      !value.externalRecipient ||
      !active ||
      active.network !== value.network ||
      active.walletId !== value.keyDomainId ||
      active.accountId !== value.accountId ||
      !active.refundAddresses.includes(value.externalRecipient)
    )
      throw new Error(
        isNativeZecSwap
          ? 'Native ZEC swap must receive into the current account'
          : 'ZEC transfers must use a receive address from the current account'
      )
    const parsed = parseZcashAddress(value.externalRecipient, this.options.network)
    if (
      !parsed.scheme.startsWith('zcash-transparent-') &&
      !value.externalRecipient.startsWith(this.options.network === 'mainnet' ? 'u1' : 'utest1')
    )
      throw new Error('This ZEC transfer requires a transparent or unified receive address')
  }

  private assertSameAccount(
    source: ConfidentialSigningIdentity,
    destination: ConfidentialSigningIdentity
  ): void {
    if (
      source.context.chainAccount.scope.keyDomainId !==
        destination.context.chainAccount.scope.keyDomainId ||
      source.context.chainAccount.scope.accountId !==
        destination.context.chainAccount.scope.accountId ||
      source.address !== destination.address ||
      source.addressIndex !== destination.addressIndex
    ) {
      throw new Error(
        'Confidential funding source and destination do not belong to the same Account'
      )
    }
  }

  private requireRpc(chainId: string): EvmTransactionRpc & EvmBroadcastRpc {
    const rpc = this.rpcByChain.get(chainId)
    if (!rpc) throw new Error('Confidential funding EVM network is unavailable')
    return rpc
  }

  private async updatePlan(
    plan: ConfidentialFundingPlan,
    changes: Partial<ConfidentialFundingPlan>
  ): Promise<ConfidentialFundingPlan> {
    const next = Object.freeze({ ...plan, ...changes, updatedAt: this.now() })
    await this.options.store.putPlan(next)
    const event = projectConfidentialPlanResult(
      plan,
      next,
      this.options.assets,
      next.operation === 'deposit'
        ? quotedPrivacyFeeBps(next.depositQuote)
        : next.operation === 'swap' || next.operation === 'confidential-transfer'
          ? quotedPrivacyFeeBps(next.swapQuote)
          : undefined
    )
    if (event) trackEvent(event.name, event.options)
    this.notifyActivityChanged(next)
    return next
  }

  private notifyActivityChanged(plan: ConfidentialFundingPlan): void {
    void this.options
      .onActivityChanged?.({
        network: plan.network,
        keyDomainId: plan.keyDomainId,
        accountId: plan.accountId
      })
      .catch(() => {})
  }

  private async scheduleMonitoring(delayInMinutes?: number): Promise<void> {
    await confidentialMonitoringQueue.run(async () => {
      if (this.options.scheduleMonitoring) {
        await this.options.scheduleMonitoring(delayInMinutes)
        return
      }
      const delay = delayInMinutes ?? CONFIDENTIAL_FUNDING_MONITOR_DELAY_MINUTES
      const alarm = await chrome.alarms.get(CONFIDENTIAL_FUNDING_MONITOR_ALARM)
      if (
        alarm &&
        alarm.scheduledTime > this.now() &&
        alarm.scheduledTime <= this.now() + delay * 60_000
      )
        return
      await chrome.alarms.create(CONFIDENTIAL_FUNDING_MONITOR_ALARM, { delayInMinutes: delay })
    })
  }
}
