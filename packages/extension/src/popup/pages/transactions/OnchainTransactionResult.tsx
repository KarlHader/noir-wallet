import { InlineError } from '@/popup/components/common/InlineError'
import { useEffect, useMemo, useState } from 'react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { TransactionId } from '@/core/transactions/domain'
import { mapTransactionGraphToActivityItem } from '@/core/activity'
import { formatChainTransactionExplorerUrl } from '@/popup/services/chain-explorer'
import { useWalletStore } from '@/store/wallet-store'
import {
  ActivityTransactionBody,
  buildActivityTransactionView
} from '@/popup/components/transaction/ActivityTransactionBody'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { Button } from '@/popup/components/ui/button'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import {
  TransactionResult,
  TransactionResultDetailRow
} from '@/popup/components/transaction/TransactionResult'
import type { OnchainTransferActivity } from '@/popup/services/onchain-transfer-activity'
import { shouldApplyOnchainTransactionStatus } from '@/popup/services/onchain-transaction-result-status'
import { formatBaseUnitAmount } from '@/lib/number-format'
import {
  getOnchainResultAdapter,
  type OnchainResultFamily,
  type OnchainTransferSubmission
} from '@/popup/services/onchain-result-adapters'
import {
  getOnchainTransactionFailureLabel,
  getOnchainResultAction,
  getOnchainResultExitOutcome,
  getOnchainResultTotal,
  getOnchainTransactionStatusPresentation,
  resolveVisibleTransactionStatus
} from '@/popup/services/onchain-transaction-result'

interface OnchainTransactionResultProps {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly submission: OnchainTransferSubmission
  readonly family: OnchainResultFamily
  readonly onDone: (outcome: ReturnType<typeof getOnchainResultExitOutcome>) => void
  readonly onViewActivity: (transactionId: TransactionId) => void
}

export function OnchainTransactionResult({
  asset,
  chain,
  submission,
  family,
  onDone,
  onViewActivity
}: OnchainTransactionResultProps) {
  const { client, feeDecimals, feeSymbol, feeLabel, totalLabel } = getOnchainResultAdapter(
    family,
    chain
  )
  const showTotal = family === 'bitcoin' || asset.asset.kind === 'native'
  const network = useWalletStore(state => state.currentNetwork)
  const [graph, setGraph] = useState(submission.graph)
  const [activity, setActivity] = useState<OnchainTransferActivity | null>(null)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState(false)
  const initialStatus =
    submission.status === 'signed-pending-broadcast' ? 'signed' : submission.graph.root.status
  const status = resolveVisibleTransactionStatus(activity?.status ?? initialStatus)
  const reconfirming = activity
    ? activity.reconfirming === true
    : submission.graph.root.reconfirming === true
  const segmentEvidence = graph.segments[0]?.evidence
  const presentation = getOnchainTransactionStatusPresentation(status, reconfirming, {
    code: activity?.failureCode ?? graph.root.failure?.code,
    evidence: {
      replacementTransactionHash:
        activity?.replacementTransactionHash ?? segmentEvidence?.replacementTransactionHash,
      confirmations: activity?.confirmations ?? segmentEvidence?.confirmations,
      requiredConfirmations:
        activity?.requiredConfirmations ?? segmentEvidence?.requiredConfirmations
    }
  })

  useEffect(() => {
    if (status === 'final' || status === 'failed' || status === 'signed') return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const next = await client.getTransferActivity(graph)
        if (!active) return
        setRefreshFailed(false)
        if (next) {
          setActivity(current => {
            const currentSnapshot = current ?? {
              status: graph.root.status,
              updatedAt: graph.root.updatedAt
            }
            return shouldApplyOnchainTransactionStatus(currentSnapshot, next) ? next : current
          })
          if (next.status === 'final' || next.status === 'failed') return
        }
      } catch {
        if (active) setRefreshFailed(true)
      }
      if (active) timer = setTimeout(poll, 2_000)
    }

    void poll()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [client, graph, status])

  const amountRaw = graph.root.intent?.primaryAmount?.amountRaw ?? '0'
  const feeRaw = graph.root.intent?.feeLimit?.amountRaw ?? '0'
  const fee = formatBaseUnitAmount(feeRaw, feeDecimals)
  const total = useMemo(
    () => getOnchainResultTotal(amountRaw, feeRaw, asset.metadata.decimals, showTotal),
    [amountRaw, asset.metadata.decimals, feeRaw, showTotal]
  )
  const transactionHash = activity?.transactionHash ?? segmentEvidence?.transactionHash
  const replacementTransactionHash =
    activity?.replacementTransactionHash ?? segmentEvidence?.replacementTransactionHash
  const transactionChainId = graph.segments.find(
    segment => segment.role === 'origin' && segment.target.kind === 'onchain'
  )?.target
  const chainId = transactionChainId?.kind === 'onchain' ? transactionChainId.chainId : null
  const graphItem = mapTransactionGraphToActivityItem(graph)
  const observedItem = {
    ...graphItem,
    status,
    updatedAt: activity?.updatedAt ?? graphItem.updatedAt,
    ...(activity?.failureCode ? { failureCode: activity.failureCode } : {}),
    ...(activity?.reconfirming ? { reconfirming: true as const } : {}),
    segments: graphItem.segments.map(segment =>
      segment.role === 'origin' &&
      segment.target.kind === 'onchain' &&
      segment.target.chainId === chainId &&
      activity
        ? {
            ...segment,
            status: activity.status,
            evidence: {
              ...segment.evidence,
              ...(activity.transactionHash ? { transactionHash: activity.transactionHash } : {}),
              ...(activity.replacementTransactionHash
                ? { replacementTransactionHash: activity.replacementTransactionHash }
                : {}),
              ...(activity.confirmations === undefined
                ? {}
                : { confirmations: activity.confirmations }),
              ...(activity.requiredConfirmations === undefined
                ? {}
                : { requiredConfirmations: activity.requiredConfirmations })
            }
          }
        : segment
    )
  }
  const activityView = buildActivityTransactionView({
    item: observedItem,
    network,
    assetMetadata: new Map([...chain.assets, asset].map(entry => [entry.asset.id, entry] as const)),
    chainMetadata: new Map([
      [
        chain.chain.id,
        {
          displayName: chain.chain.displayName,
          iconAlias: resolveChainIconAlias(
            chain.chain.family,
            chain.chain.displayName,
            chain.chain.id
          )
        }
      ]
    ]),
    fallback: { fee: { value: fee, symbol: feeSymbol, label: feeLabel } }
  })
  const explorerUrl =
    transactionHash && chainId
      ? formatChainTransactionExplorerUrl(chainId, transactionHash, network)
      : ''
  const compactDetails = reconfirming || replacementTransactionHash !== undefined
  const resultAction = getOnchainResultAction(status, explorerUrl)

  const handleResume = async () => {
    setResuming(true)
    setResumeError(false)
    try {
      const next = await client.resumeTransfer(graph.root.id)
      setGraph(next.graph)
      if (next.status === 'broadcast') {
        setActivity({ status: 'broadcast', updatedAt: Date.now() })
      }
    } catch {
      setResumeError(true)
    } finally {
      setResuming(false)
    }
  }

  return (
    <div className="page-container" data-transaction-status={status}>
      <PageHeader title="" />
      <TransactionResult
        status={presentation.resultStatus}
        title={presentation.title}
        description={resultAction === 'retry' ? undefined : presentation.description}
        layout="single-asset"
        onClose={() => onDone(getOnchainResultExitOutcome(status))}
        className={compactDetails ? 'pb-0' : undefined}
        bodyClassName={compactDetails ? 'mt-5' : undefined}
        footer={
          <div className="flex w-full flex-col gap-2">
            {resultAction === 'explorer' && explorerUrl ? (
              <Button asChild className="h-[45px] w-full">
                <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
                  View on Explorer
                </a>
              </Button>
            ) : resultAction === 'activity' ? (
              <Button className="h-[45px] w-full" onClick={() => onViewActivity(graph.root.id)}>
                View Activity
              </Button>
            ) : null}
            <Button
              variant={resultAction === 'done' ? 'default' : 'outline'}
              className="h-[45px] w-full"
              onClick={() => onDone(getOnchainResultExitOutcome(status))}
            >
              Done
            </Button>
          </div>
        }
      >
        <div className="w-full">
          <ActivityTransactionBody view={activityView} />
          {status === 'failed' && presentation.tone === 'error' && (
            <TransactionResultDetailRow label="Reason">
              {getOnchainTransactionFailureLabel(activity?.failureCode)}
            </TransactionResultDetailRow>
          )}
          {total && (
            <TransactionResultDetailRow label={totalLabel}>
              <AmountDisplay value={total} symbol={asset.metadata.symbol} />
            </TransactionResultDetailRow>
          )}

          {refreshFailed && status !== 'final' && status !== 'failed' && (
            <p role="status" className="mt-3 text-center text-xs text-muted">
              Status update delayed.
            </p>
          )}
          {resultAction === 'retry' ? (
            <InlineError
              className="mt-3"
              message={
                resumeError
                  ? 'Broadcast retry failed. Check the network and try again.'
                  : presentation.description || presentation.title
              }
              onRetry={handleResume}
              retrying={resuming}
              retryLabel="Retry broadcast"
              tone={resumeError || presentation.tone === 'error' ? 'error' : 'warning'}
            />
          ) : (
            resumeError && (
              <p role="alert" className="mt-3 text-center text-xs text-danger">
                Broadcast retry failed. Check the network and try again.
              </p>
            )
          )}
        </div>
      </TransactionResult>
    </div>
  )
}
