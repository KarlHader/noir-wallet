import { Button } from '../ui/button'
import type { SwapStatus } from '@/core/services/intents-api'
import { formatSortAddress } from '@/lib/format'
import { TransactionResult, type TransactionStatus } from '../transaction/TransactionResult'
import { AmountDisplay } from '../common/AmountDisplay'
import { isZcashDestination } from '@/lib/cross-chain-transaction'
import { WALLET_CONFIG } from '@/config/wallet'
import { getIntentsStatusCopy } from '@/lib/transaction-status-copy'
import type { TransactionLifecycleStatus } from '@/core/transactions/domain'
import type { Network } from '@/types'
import { getIntentsProgressPresentation } from '@/popup/services/transaction-progress'
import { TransactionProgressSteps } from '../transaction/TransactionProgressSteps'
import {
  getConfidentialFundingStatusCopy,
  getSwapTransactionReference,
  getSwapResultAction,
  getSwapActionLabels,
  type ConfidentialFundingStatusView
} from './swap-status-model'

interface SwapStatusDisplayProps {
  network: Network
  status: SwapStatus | null
  tokenInSymbol: string
  tokenOutSymbol: string
  amountIn: string
  amountOut: string
  actionName?: string
  destinationChain?: string
  destinationConfirmations?: number | null
  originChain?: string
  originTxHash?: string
  originStatus?: TransactionLifecycleStatus
  originConfirmations?: number
  signedOrder?: boolean
  /** ZEC fee for the on-chain leg, in ZEC. Omit to hide the fee row. */
  fee?: string
  confidentialFunding?: ConfidentialFundingStatusView
  onResumeConfidentialFunding?: () => void
  resumingConfidentialFunding?: boolean
  onClose: () => void
  onViewActivity: () => void
  viewActivityDisabled?: boolean
}

function TxHashLink({
  hash,
  assetId,
  fallbackChain,
  network
}: {
  hash: string
  assetId?: string
  fallbackChain?: string
  network: Network
}) {
  const { label: chainLabel, url: explorerUrl } = getSwapTransactionReference(
    assetId,
    fallbackChain,
    hash,
    network
  )

  if (!explorerUrl) {
    return (
      <div className="flex justify-between items-center py-3 border-b border-white/10">
        <span className="text-sm text-muted">{chainLabel} Tx</span>
        <span className="text-sm font-mono text-muted">{formatSortAddress(hash)}</span>
      </div>
    )
  }

  return (
    <div className="flex justify-between items-center py-3 border-b border-white/10">
      <span className="text-sm text-muted">{chainLabel} Tx</span>
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-mono text-primary cursor-pointer hover:underline"
      >
        {formatSortAddress(hash)}
      </a>
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
  destinationChain: destinationChainHint,
  destinationConfirmations,
  originChain: originChainHint,
  originTxHash,
  originStatus,
  originConfirmations,
  signedOrder,
  fee,
  confidentialFunding,
  onResumeConfidentialFunding,
  resumingConfidentialFunding,
  onClose,
  onViewActivity,
  viewActivityDisabled
}: SwapStatusDisplayProps) {
  const currentStatus = status?.status || 'PENDING_DEPOSIT'
  const destinationTxHash = status?.swapDetails?.destinationChainTxHashes?.[0]?.hash
  const requiredConfirmations = WALLET_CONFIG.SPENDABILITY_CONFIRMATIONS
  const waitsForZcashDestination =
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
    originStatus,
    originTxHash: originTxHash ?? status?.swapDetails?.originChainTxHashes?.[0]?.hash,
    originConfirmations,
    destinationTxHash,
    waitsForDestinationConfirmations: waitsForSpendability,
    destinationConfirmations,
    requiredConfirmations,
    signedOrder
  })
  const txStatus: TransactionStatus = statusCopy.resultStatus
  const resultAction = getSwapResultAction(
    txStatus,
    confidentialFunding?.phase === 'needs-auth' && onResumeConfidentialFunding !== undefined,
    !!confidentialFunding
  )

  const labels = getSwapActionLabels(actionName)
  const showFee = !!fee

  return (
    <TransactionResult
      status={txStatus}
      showStatus={!!confidentialFunding}
      title={confidentialFunding ? statusCopy.title : progress.title}
      description={confidentialFunding ? statusCopy.description : progress.description}
      footer={
        resultAction === 'continue' && onResumeConfidentialFunding ? (
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
      <div className="w-full space-y-3">
        <TransactionProgressSteps steps={progress.steps} className="pb-2" />
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/10 py-3">
          <span className="text-sm text-muted">{labels.sendLabel}</span>
          <AmountDisplay value={amountIn} symbol={tokenInSymbol} className="text-sm font-medium" />
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/10 py-3">
          <span className="text-sm text-muted">{labels.receiveLabel}</span>
          <AmountDisplay
            value={amountOut}
            symbol={tokenOutSymbol}
            className="text-sm font-medium"
          />
        </div>

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

        {originTxHash && !status?.swapDetails?.originChainTxHashes?.length && (
          <TxHashLink
            hash={originTxHash}
            assetId={status?.originAsset}
            fallbackChain={originChainHint}
            network={network}
          />
        )}

        {status?.swapDetails?.originChainTxHashes?.map((tx, i) => (
          <TxHashLink
            key={`origin-${i}`}
            hash={tx.hash}
            assetId={status.originAsset}
            fallbackChain={originChainHint}
            network={network}
          />
        ))}

        {status?.swapDetails?.destinationChainTxHashes?.map((tx, i) => (
          <TxHashLink
            key={`dest-${i}`}
            hash={tx.hash}
            assetId={status.destinationAsset}
            fallbackChain={destinationChainHint}
            network={network}
          />
        ))}
      </div>
    </TransactionResult>
  )
}
