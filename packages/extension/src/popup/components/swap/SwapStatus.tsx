import { useMemo } from 'react'
import { Button } from '../ui/button'
import type { SwapStatus } from '@/core/services/intents-api'
import {
  TransactionResult,
  TransactionResultDetailRow,
  type TransactionStatus
} from '../transaction/TransactionResult'
import { AmountDisplay } from '../common/AmountDisplay'
import { TransactionNotice } from '../transaction/TransactionNotice'
import { TokenIcon } from '../tokens/TokenIcon'
import { formatChainName } from '@/lib/format'
import { isZcashDestination } from '@/lib/cross-chain-transaction'
import { WALLET_CONFIG } from '@/config/wallet'
import { getIntentsStatusCopy } from '@/lib/transaction-status-copy'
import type { TransactionLifecycleStatus } from '@/core/transactions/domain'
import type { Network } from '@/types'
import type { ActivityItem } from '@/core/activity'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { ConfidentialFundingPlan } from '@/core/services/confidential-funding'
import { buildActivityPresentationCatalog } from '@/popup/services/activity-presentation-catalog'
import { useSettingsStore } from '@/store/settings-store'
import { useActivityEvmAssets } from '@/popup/hooks/useActivityEvmAssets'
import {
  ActivityTransactionBody,
  buildActivityTransactionView
} from '../transaction/ActivityTransactionBody'
import { buildActivityExecutionAddressModes } from '@/popup/services/multichain-activity-presentation'
import type { AccountNetworksView } from '@/popup/services/account-networks-client'
import {
  getIntentsProgressPresentation,
  getSwapApprovalProgressStep,
  type SwapApprovalProgress
} from '@/popup/services/transaction-progress'
import { formatChainTransactionExplorerUrl } from '@/popup/services/chain-explorer'
import type { SwapToken } from '@/core/services/intents-api'
import { TransactionProgressSteps } from '../transaction/TransactionProgressSteps'
import { TransactionReferenceValue } from '../transaction/TransactionReferenceValue'
import {
  getConfidentialFundingStatusCopy,
  getSwapTransactionReference,
  getSwapResultAction,
  getSwapActionLabels,
  type ConfidentialFundingStatusView
} from '@/popup/services/swap-status-model'

interface SwapStatusDisplayProps {
  network: Network
  status: SwapStatus | null
  tokenInSymbol: string
  tokenOutSymbol: string
  amountIn: string
  amountOut: string
  actionName?: string
  router?: string
  destinationChain?: string
  internalDestination?: boolean
  destinationConfirmations?: number | null
  originChain?: string
  originTxHash?: string
  originStatus?: TransactionLifecycleStatus
  originConfirmations?: number
  signedOrder?: boolean
  /** ZEC fee for the on-chain leg, in ZEC. Omit to hide the fee row. */
  fee?: string
  confidentialFunding?: ConfidentialFundingStatusView
  confidentialPlan?: ConfidentialFundingPlan | null
  onResumeConfidentialFunding?: () => void
  resumingConfidentialFunding?: boolean
  onClose: () => void
  onViewActivity: () => void
  viewActivityDisabled?: boolean
  activityItem?: ActivityItem | null
  approvalProgress?: SwapApprovalProgress
  beforeSubmission?: {
    readonly token: SwapToken
    readonly error?: string | null
    readonly onContinue?: () => void
    readonly continueDisabled?: boolean
  }
  activeAccount?: AccountNetworksView | null
  portfolio?: PortfolioReadModel | null
}

function TxHashLink({ hash, label, url }: { hash: string; label: string; url: string }) {
  return (
    <div className="flex justify-between items-center py-3 border-b border-white/10">
      <span className="text-sm text-muted">{label}</span>
      <TransactionReferenceValue hash={hash} url={url} />
    </div>
  )
}

export function SwapStatusDisplay({
  network,
  status,
  tokenInSymbol,
  tokenOutSymbol,
  amountIn,
  amountOut,
  actionName,
  router,
  destinationChain: destinationChainHint,
  internalDestination = false,
  destinationConfirmations,
  originChain: originChainHint,
  originTxHash,
  originStatus,
  originConfirmations,
  signedOrder,
  fee,
  confidentialFunding,
  confidentialPlan,
  onResumeConfidentialFunding,
  resumingConfidentialFunding,
  onClose,
  onViewActivity,
  viewActivityDisabled,
  activityItem,
  approvalProgress,
  beforeSubmission,
  activeAccount,
  portfolio
}: SwapStatusDisplayProps) {
  const currentStatus = status?.status || 'PENDING_DEPOSIT'
  const destinationTxHash = status?.swapDetails?.destinationChainTxHashes?.[0]?.hash
  const requiredConfirmations = WALLET_CONFIG.SPENDABILITY_CONFIRMATIONS
  const waitsForZcashDestination =
    !internalDestination &&
    currentStatus === 'SUCCESS' &&
    isZcashDestination({
      destinationAsset: status?.destinationAsset,
      destinationChain: destinationChainHint
    })
  const destinationIsSpendable =
    destinationConfirmations != null && destinationConfirmations >= requiredConfirmations
  const waitsForSpendability = waitsForZcashDestination && !destinationIsSpendable
  const actionLabel = actionName || 'Swap'
  const statusCopy = confidentialFunding
    ? getConfidentialFundingStatusCopy(confidentialFunding, actionLabel)
    : getIntentsStatusCopy(currentStatus, {
        actionName: actionLabel,
        hasDestinationTxHash: !!destinationTxHash,
        waitsForZcashConfirmations: waitsForSpendability,
        destinationConfirmations,
        requiredConfirmations
      })
  const progress = getIntentsProgressPresentation({
    status: currentStatus,
    actionName: actionLabel,
    router,
    originStatus,
    originTxHash: originTxHash ?? status?.swapDetails?.originChainTxHashes?.[0]?.hash,
    originConfirmations,
    destinationTxHash,
    internalDestination,
    waitsForDestinationConfirmations: waitsForSpendability,
    destinationConfirmations,
    requiredConfirmations,
    signedOrder
  })
  const approvalStep = approvalProgress && getSwapApprovalProgressStep(approvalProgress)
  const approvalReference = approvalProgress?.transactionHash && (
    <TransactionReferenceValue
      hash={approvalProgress.transactionHash}
      url={formatChainTransactionExplorerUrl(
        approvalProgress.chainId,
        approvalProgress.transactionHash,
        network
      )}
      compact
    />
  )
  const submittingOrigin =
    !!beforeSubmission && !beforeSubmission.error && approvalProgress?.status === 'confirmed'
  const sourceNetwork = originChainHint && formatChainName(originChainHint)
  const destinationNetwork = destinationChainHint && formatChainName(destinationChainHint)
  const fallbackSteps = approvalStep
    ? progress.steps
        .filter(step => step.id === 'origin' || originChainHint !== destinationChainHint)
        .map(step => {
          switch (step.id) {
            case 'origin':
              return {
                ...step,
                label: 'Origin transaction',
                detail: sourceNetwork,
                ...(submittingOrigin ? { state: 'active' as const, statusLabel: 'Submitting' } : {})
              }
            case 'intents':
              return { ...step, label: 'Cross-chain' }
            case 'destination':
              return { ...step, label: 'Destination transaction', detail: destinationNetwork }
            default:
              return step
          }
        })
    : progress.steps
  const steps = approvalStep ? [approvalStep, ...fallbackSteps] : fallbackSteps
  const referenceByStepId =
    approvalStep && approvalReference ? new Map([[approvalStep.id, approvalReference]]) : undefined
  const txStatus: TransactionStatus = statusCopy.resultStatus
  const resultAction = getSwapResultAction(
    txStatus,
    confidentialFunding?.phase === 'needs-auth' && onResumeConfidentialFunding !== undefined,
    !!confidentialFunding
  )

  const labels = getSwapActionLabels(actionName)
  const isSend = actionName === 'Send' || actionName === 'Cross-chain Send'
  const showExchangeAmounts = !actionName || actionName === 'Swap'
  const showFee = !!fee
  const showDestinationAmount = showExchangeAmounts && confidentialFunding?.phase !== 'refunded'
  const endpointSettings = useSettingsStore(state => state.chainEndpointSettings)
  const {
    userAssets: userEvmAssets,
    detectedAssets: detectedEvmAssets,
    catalogTokens
  } = useActivityEvmAssets()
  const scopedPortfolio =
    activityItem &&
    portfolio?.scope.keyDomainId === activityItem.scope.keyDomainId &&
    portfolio.scope.accountId === activityItem.scope.accountId
      ? portfolio
      : null
  const activityCatalog = useMemo(
    () =>
      buildActivityPresentationCatalog({
        network,
        endpointSettings,
        userEvmAssets,
        detectedEvmAssets,
        catalogTokens,
        portfolio: scopedPortfolio
      }),
    [network, endpointSettings, userEvmAssets, detectedEvmAssets, catalogTokens, scopedPortfolio]
  )
  const activityView = activityItem
    ? buildActivityTransactionView({
        item: activityItem,
        network,
        assetMetadata: activityCatalog.assetMetadata,
        chainMetadata: activityCatalog.chainMetadata,
        executionAddressModes:
          activeAccount?.walletId === activityItem.scope.keyDomainId &&
          activeAccount.accountId === activityItem.scope.accountId
            ? buildActivityExecutionAddressModes(activeAccount.networks)
            : undefined,
        confidentialPlan,
        refunded: confidentialFunding?.phase === 'refunded',
        fallback: {
          source: { value: amountIn, symbol: tokenInSymbol },
          destination: { value: amountOut, symbol: tokenOutSymbol },
          ...(originChainHint ? { sourceNetwork: originChainHint } : {}),
          ...(destinationChainHint ? { destinationNetwork: destinationChainHint } : {}),
          ...(fee ? { fee: { value: fee, symbol: 'ZEC', label: 'Network fee' } } : {})
        }
      })
    : null
  const fallbackReferences = [
    ...(!status?.swapDetails?.originChainTxHashes?.length && originTxHash
      ? [
          {
            role: 'origin' as const,
            hash: originTxHash,
            assetId: status?.originAsset,
            chain: originChainHint
          }
        ]
      : []),
    ...(status?.swapDetails?.originChainTxHashes?.map(tx => ({
      role: 'origin' as const,
      hash: tx.hash,
      assetId: status.originAsset,
      chain: originChainHint
    })) ?? []),
    ...(status?.swapDetails?.destinationChainTxHashes?.map(tx => ({
      role: 'destination' as const,
      hash: tx.hash,
      assetId: status.destinationAsset,
      chain: destinationChainHint
    })) ?? [])
  ].map(reference => ({
    role: reference.role,
    hash: reference.hash,
    ...getSwapTransactionReference(reference.assetId, reference.chain, reference.hash, network)
  }))
  const transactionReferences = fallbackReferences
    .filter(
      (reference, index, all) =>
        all.findIndex(candidate =>
          reference.url
            ? candidate.url === reference.url
            : candidate.role === reference.role && candidate.hash === reference.hash
        ) === index
    )
    .map(reference => ({ ...reference, label: `${reference.label} Tx` }))

  return (
    <TransactionResult
      status={txStatus}
      showStatus={isSend || !!confidentialFunding}
      title={confidentialFunding ? statusCopy.title : progress.title}
      description={confidentialFunding ? statusCopy.description : progress.description}
      footer={
        beforeSubmission ? (
          <div className="w-full space-y-2">
            {beforeSubmission.error && <TransactionNotice message={beforeSubmission.error} />}
            {beforeSubmission.onContinue && (
              <Button
                className="h-[45px] w-full"
                onClick={beforeSubmission.onContinue}
                disabled={beforeSubmission.continueDisabled}
              >
                Review New Quote
              </Button>
            )}
          </div>
        ) : resultAction === 'continue' && onResumeConfidentialFunding ? (
          <Button
            onClick={onResumeConfidentialFunding}
            disabled={resumingConfidentialFunding}
            isLoading={resumingConfidentialFunding}
            className="h-[45px] w-full"
          >
            Continue
          </Button>
        ) : (
          <Button
            onClick={resultAction === 'done' ? onClose : onViewActivity}
            disabled={resultAction !== 'done' && viewActivityDisabled}
            className="h-[45px] w-full"
          >
            {resultAction === 'done' ? 'Done' : 'View Activity'}
          </Button>
        )
      }
    >
      {activityView ? (
        <ActivityTransactionBody
          view={activityView}
          showAmountsAsDetails={isSend}
          precedingProgress={
            approvalStep ? { step: approvalStep, reference: approvalReference } : undefined
          }
        />
      ) : beforeSubmission ? (
        <>
          <div className="flex flex-col items-center py-7 text-center">
            <TokenIcon token={beforeSubmission.token} size={40} showChainBadge={false} />
            <div className="mt-4 max-w-full break-all text-3xl font-bold tabular-nums">
              <AmountDisplay value={amountIn} prefix="−" symbol={tokenInSymbol} />
            </div>
            <div className="mt-1 max-w-full break-all text-sm text-muted tabular-nums">
              Expected <AmountDisplay value={amountOut} prefix="+" symbol={tokenOutSymbol} />
            </div>
          </div>
          {sourceNetwork && destinationNetwork && (
            <TransactionResultDetailRow label="Route">
              {sourceNetwork} → {destinationNetwork}
            </TransactionResultDetailRow>
          )}
          <TransactionProgressSteps
            steps={steps}
            referenceByStepId={referenceByStepId}
            className="mt-5"
          />
        </>
      ) : (
        <div className="w-full space-y-3">
          <TransactionProgressSteps
            steps={steps}
            referenceByStepId={referenceByStepId}
            className="pb-2"
          />
          <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/10 py-3">
            <span className="text-sm text-muted">
              {showExchangeAmounts ? labels.sendLabel : 'Amount'}
            </span>
            <AmountDisplay
              value={amountIn}
              symbol={tokenInSymbol}
              prefix={showExchangeAmounts ? '- ' : undefined}
              className="text-sm font-medium"
            />
          </div>
          {showDestinationAmount && (
            <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/10 py-3">
              <span className="text-sm text-muted">{labels.receiveLabel}</span>
              <AmountDisplay
                value={amountOut}
                symbol={tokenOutSymbol}
                prefix="+ "
                className="text-sm font-medium"
              />
            </div>
          )}

          {showFee && (
            <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/10 py-3">
              <span className="text-sm text-muted">Fee</span>
              <AmountDisplay
                value={fee}
                symbol="ZEC"
                prefix="≈ "
                profile="fee"
                className="text-sm font-medium"
              />
            </div>
          )}

          {transactionReferences.map((reference, index) => (
            <TxHashLink key={`${reference.url}:${reference.hash}:${index}`} {...reference} />
          ))}
        </div>
      )}
    </TransactionResult>
  )
}
