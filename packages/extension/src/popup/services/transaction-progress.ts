import type { ActivityItem } from '@/core/activity'
import type { SwapStatusType } from '@/core/services/intents-api'
import type { TransactionLifecycleStatus } from '@/core/transactions/domain'
import { getIntentsStatusCopy } from '@/lib/transaction-status-copy'
import {
  getZcashIntentsOriginStatus,
  isIntentsSettledTransaction
} from '@/lib/cross-chain-transaction'
import type { IntentsProgressEntry } from '@/lib/intents-progress'
import type { Transaction } from '@/types/wallet'
import { WALLET_CONFIG } from '@/config/wallet'

export { getZcashIntentsOriginStatus } from '@/lib/cross-chain-transaction'

export type ProgressStepState = 'complete' | 'active' | 'pending' | 'warning' | 'failed'

export interface TransactionProgressStep {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly state: ProgressStepState
  readonly statusLabel: string
}

export interface IntentsProgressPresentation {
  readonly title: string
  readonly description: string
  readonly steps: readonly TransactionProgressStep[]
}

function getSwapProcessingLabel(router: string | undefined, actionName: string): string {
  const name = router?.trim()
  if (
    !name ||
    name.length > 32 ||
    !/^[a-zA-Z0-9 ._-]+$/.test(name) ||
    name.toLowerCase() === 'unknown'
  ) {
    return `${actionName} processing`
  }
  const provider =
    name.toLowerCase() === 'nearintents' ? 'Intents' : name.toLowerCase() === 'okx' ? 'OKX' : name
  return `${provider} processing`
}

interface IntentsProgressInput {
  readonly status: SwapStatusType
  readonly actionName?: string
  readonly router?: string
  readonly originStatus?: TransactionLifecycleStatus
  readonly originTxHash?: string
  readonly originConfirmations?: number
  readonly destinationTxHash?: string
  readonly waitsForDestinationConfirmations?: boolean
  readonly destinationConfirmations?: number | null
  readonly requiredConfirmations?: number
  readonly signedOrder?: boolean
}

export function getIntentsProgressPresentation({
  status,
  actionName = 'Swap',
  router,
  originStatus,
  originTxHash,
  originConfirmations,
  destinationTxHash,
  waitsForDestinationConfirmations = false,
  destinationConfirmations,
  requiredConfirmations,
  signedOrder = false
}: IntentsProgressInput): IntentsProgressPresentation {
  const copy = getIntentsStatusCopy(status, {
    actionName,
    hasDestinationTxHash: !!destinationTxHash,
    waitsForZcashConfirmations: waitsForDestinationConfirmations,
    destinationConfirmations,
    requiredConfirmations
  })
  const originIsFinal =
    signedOrder ||
    originStatus === 'final' ||
    (originConfirmations != null && originConfirmations > 0) ||
    status === 'PROCESSING' ||
    status === 'SUCCESS' ||
    status === 'REFUNDED'
  const originFailed = originStatus === 'failed' && !originIsFinal
  const hasOriginEvidence = !!originTxHash || !!originStatus || signedOrder
  const originState: ProgressStepState = originFailed
    ? 'failed'
    : originIsFinal
      ? 'complete'
      : hasOriginEvidence
        ? 'active'
        : 'pending'
  const relayFailed = status === 'FAILED'
  const relayWarning = status === 'INCOMPLETE_DEPOSIT'
  const relayComplete = status === 'SUCCESS' || status === 'REFUNDED'
  const relayState: ProgressStepState = relayFailed
    ? 'failed'
    : relayWarning
      ? 'warning'
      : relayComplete
        ? 'complete'
        : originIsFinal
          ? 'active'
          : 'pending'
  const destinationState: ProgressStepState =
    status === 'SUCCESS'
      ? waitsForDestinationConfirmations
        ? 'active'
        : 'complete'
      : status === 'REFUNDED'
        ? 'active'
        : 'pending'

  const steps: TransactionProgressStep[] = [
    {
      id: 'origin',
      label: signedOrder ? 'Order submitted' : 'Source transaction',
      detail: signedOrder ? undefined : originConfirmations ? 'Confirmed on-chain' : undefined,
      state: originState,
      statusLabel: originFailed
        ? 'Failed'
        : signedOrder
          ? 'Submitted'
          : originIsFinal
            ? 'Confirmed'
            : originStatus === 'confirming'
              ? 'Confirming'
              : originTxHash || originStatus === 'broadcast'
                ? 'Submitted'
                : 'Pending'
    },
    {
      id: 'intents',
      label: getSwapProcessingLabel(router, actionName),
      detail: relayFailed
        ? copy.description
        : relayState === 'active' && status !== 'PROCESSING'
          ? 'Waiting for required confirmations and deposit recognition'
          : undefined,
      state: relayState,
      statusLabel: relayFailed
        ? 'Failed'
        : relayWarning
          ? 'Amount too low'
          : relayComplete
            ? 'Completed'
            : relayState === 'active'
              ? status === 'PROCESSING'
                ? 'Processing'
                : status === 'KNOWN_DEPOSIT_TX'
                  ? 'Deposit confirming'
                  : 'Waiting for deposit'
              : 'Pending'
    },
    {
      id: 'destination',
      label:
        status === 'REFUNDED' || status === 'INCOMPLETE_DEPOSIT'
          ? 'Refund transfer'
          : actionName === 'Supply'
            ? 'Protocol settlement'
            : 'Destination transfer',
      state: destinationState,
      statusLabel:
        status === 'REFUNDED'
          ? 'Submitted'
          : status === 'FAILED'
            ? 'Not started'
            : destinationState === 'complete'
              ? 'Completed'
              : destinationState === 'active'
                ? 'Confirming'
                : 'Pending'
    }
  ]

  const sourceConfirmedButUnrecognized =
    originIsFinal && (status === 'PENDING_DEPOSIT' || status === 'KNOWN_DEPOSIT_TX')
  const sourceBroadcastButUnrecognized =
    !originIsFinal &&
    !!originTxHash &&
    (status === 'PENDING_DEPOSIT' || status === 'KNOWN_DEPOSIT_TX')
  const sourceNotYetBroadcast = !originTxHash && !originIsFinal && status === 'PENDING_DEPOSIT'
  return {
    title: sourceConfirmedButUnrecognized
      ? signedOrder
        ? 'Order submitted'
        : 'Source transaction confirmed'
      : sourceBroadcastButUnrecognized
        ? 'Source transaction submitted'
        : sourceNotYetBroadcast
          ? 'Waiting for source transaction'
          : copy.title,
    description: sourceConfirmedButUnrecognized
      ? signedOrder
        ? 'The order was submitted. Waiting for the required confirmations before processing; do not submit again.'
        : 'The source transaction is confirmed. Waiting for the required confirmations before processing; do not send again.'
      : sourceBroadcastButUnrecognized
        ? 'The source transaction was submitted. Processing will start after the required chain confirmations; do not send again.'
        : sourceNotYetBroadcast
          ? 'Waiting for the source transaction to be submitted or detected.'
          : (copy.description ?? ''),
    steps
  }
}

export function getLegacyIntentsProgressPresentation(
  transaction: Transaction,
  progress: IntentsProgressEntry
): IntentsProgressPresentation {
  const outboundFromZcash = isIntentsSettledTransaction(transaction.type)
  const waitsForDestinationConfirmations =
    transaction.status === 'relay_confirmed' ||
    (transaction.status === 'confirming' && progress.status === 'SUCCESS')
  return getIntentsProgressPresentation({
    status: progress.status,
    actionName: progress.actionName,
    router: 'Intents',
    originStatus: outboundFromZcash
      ? getZcashIntentsOriginStatus(transaction)
      : !transaction.txHash
        ? 'created'
        : transaction.status === 'success' || transaction.status === 'relay_confirmed'
          ? 'final'
          : 'broadcast',
    originTxHash: transaction.txHash,
    originConfirmations: outboundFromZcash ? transaction.confirmations : undefined,
    destinationTxHash: transaction.destinationTxHash,
    waitsForDestinationConfirmations,
    destinationConfirmations: waitsForDestinationConfirmations
      ? transaction.confirmations
      : undefined,
    requiredConfirmations:
      transaction.requiredConfirmations ?? WALLET_CONFIG.SPENDABILITY_CONFIRMATIONS
  })
}

export function getActivityOriginStatus(
  item: ActivityItem
): TransactionLifecycleStatus | undefined {
  return item.segments.find(segment => segment.role === 'origin')?.status
}

export function getActivityOriginHash(item: ActivityItem): string | undefined {
  return item.segments.find(segment => segment.role === 'origin')?.evidence?.transactionHash
}
