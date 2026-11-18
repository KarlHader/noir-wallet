import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { ActivityItem } from '@/core/activity'
import { parseTransactionId } from '@/core/transactions/domain'
import { formatSortAddress } from '@/lib/format'
import { formatBaseUnitAmount } from '@/lib/number-format'
import { openHardwareEvmSignTab } from '@/lib/hardware-tab'
import { cn } from '@/lib/utils'
import { formatEvmWeiAsGwei } from '@/infrastructure/chains/evm'
import { openModal } from '@/popup/provider/ModalManager'
import {
  EvmWalletClientError,
  evmWalletClient,
  type EvmTransferReview
} from '@/popup/services/evm-wallet-client'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import { toast } from '@/store/toast-store'
import { AmountDisplay } from '../common/AmountDisplay'
import { Button } from '../ui/button'
import { NetworkFeeTierPicker } from './NetworkFeeTierPicker'
import {
  canCancelEvmActivity,
  canSpeedUpEvmActivity,
  getPendingEvmActivityOrigin
} from './multichain-activity-presentation'

type PendingAction = 'cancel' | 'speed-up'

function getReplacementOriginKey(
  item: ActivityItem,
  evmChainIds: readonly string[]
): string | null {
  const origin = getPendingEvmActivityOrigin(item, evmChainIds)
  if (!origin || origin.target.kind !== 'onchain') return null
  return JSON.stringify([
    item.id,
    item.scope.keyDomainId,
    item.scope.accountId,
    item.kind,
    origin.target.chainId,
    origin.status,
    origin.evidence?.transactionHash,
    item.snapshot?.sender,
    item.snapshot?.evm?.nonce,
    item.snapshot?.evm?.unsignedTransaction,
    item.snapshot?.protocol?.expiresAt,
    item.snapshot?.shield?.sourceDomain,
    item.accountMode
  ])
}

function ReplacementReviewContent({
  action,
  item,
  initialReview,
  amountMetadata,
  feeDecimals,
  feeSymbol,
  onFeeChange,
  resolve
}: {
  readonly action: PendingAction
  readonly item: ActivityItem
  readonly initialReview: EvmTransferReview
  readonly amountMetadata?: Readonly<{ readonly decimals: number; readonly symbol: string }>
  readonly feeDecimals: number
  readonly feeSymbol: string
  readonly onFeeChange: (selection: EvmFeeSelection) => Promise<EvmTransferReview>
  readonly resolve: (confirmed: boolean) => void
}) {
  const [displayReview, setDisplayReview] = useState(initialReview)
  const [selection, setSelection] = useState<EvmFeeSelection>({ kind: 'tier', tier: 'standard' })
  const [updating, setUpdating] = useState(false)
  const [ready, setReady] = useState(true)
  const [advanced, setAdvanced] = useState(false)
  const summary = displayReview.review.summary
  if (summary.schema !== 'evm.transaction.v1') return null
  const fields = summary.fields
  const primary = item.snapshot?.primaryAmount
  const primaryMetadata = amountMetadata ?? primary?.metadata
  const originalAmount =
    primary && primaryMetadata
      ? `${formatBaseUnitAmount(primary.amountRaw, primaryMetadata.decimals)} ${primaryMetadata.symbol}`
      : null
  const recipient = item.snapshot?.recipient?.address ?? fields.to
  const changeFee = async (next: EvmFeeSelection) => {
    setUpdating(true)
    setReady(false)
    try {
      const nextReview = await onFeeChange(next)
      setDisplayReview(nextReview)
      setSelection(next)
      setReady(true)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 border-b border-border/60 pb-3 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted">Original transaction</span>
          <span className="text-right font-medium">
            {originalAmount ?? (action === 'cancel' ? 'Pending transaction' : 'Speed up')}
          </span>
        </div>
        {action === 'speed-up' && recipient && (
          <div className="flex justify-between gap-3">
            <span className="text-muted">To</span>
            <span className="font-mono" title={recipient}>
              {formatSortAddress(recipient)}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">Maximum network fee</span>
        <NetworkFeeTierPicker
          chainFamily="evm"
          tier={selection.kind === 'tier' ? selection.tier : 'standard'}
          selection={selection}
          amount={formatBaseUnitAmount(fields.maximumFeeWei, feeDecimals)}
          symbol={feeSymbol}
          onTierChange={tier => changeFee({ kind: 'tier', tier })}
          onSelectionChange={changeFee}
          disabled={updating}
          feeModel={fields.transactionType === 'legacy' ? 'legacy' : 'eip1559'}
          customDefaults={{
            gasLimit: fields.gasLimit,
            maxFeePerGasWei: fields.maxFeePerGasWei ?? '0',
            maxPriorityFeePerGasWei: fields.maxPriorityFeePerGasWei ?? '0',
            gasPriceWei: fields.gasPriceWei
          }}
        />
      </div>
      <div>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted"
          onClick={() => setAdvanced(value => !value)}
          aria-expanded={advanced}
        >
          Advanced{' '}
          <Icon
            icon={advanced ? 'lucide:chevron-up' : 'lucide:chevron-down'}
            width={14}
            height={14}
          />
        </button>
        {advanced && (
          <div className="mt-2 space-y-1 border-t border-border/60 pt-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted">Nonce</span>
              <span className="font-mono">{fields.nonce}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Gas limit</span>
              <span className="font-mono">{fields.gasLimit}</span>
            </div>
            {fields.gasPriceWei ? (
              <div className="flex justify-between">
                <span className="text-muted">Gas price</span>
                <AmountDisplay
                  value={formatEvmWeiAsGwei(fields.gasPriceWei)}
                  symbol="GWEI"
                  profile="fee"
                />
              </div>
            ) : (
              <>
                <div className="flex justify-between">
                  <span className="text-muted">Max fee per gas</span>
                  <AmountDisplay
                    value={formatEvmWeiAsGwei(fields.maxFeePerGasWei ?? '0')}
                    symbol="GWEI"
                    profile="fee"
                  />
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Priority fee per gas</span>
                  <AmountDisplay
                    value={formatEvmWeiAsGwei(fields.maxPriorityFeePerGasWei ?? '0')}
                    symbol="GWEI"
                    profile="fee"
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {!ready && !updating && (
        <p role="status" className="text-xs text-muted">
          Select a network fee to continue.
        </p>
      )}
      <div className="flex gap-3">
        <Button variant="outline" className="flex-1" onClick={() => resolve(false)}>
          Back
        </Button>
        <Button
          className="flex-1"
          disabled={!ready || updating}
          isLoading={updating}
          onClick={() => resolve(true)}
        >
          {action === 'cancel' ? 'Confirm cancel' : 'Confirm speed up'}
        </Button>
      </div>
    </div>
  )
}

export function EvmPendingTransactionActions({
  item,
  evmChainIds,
  accountMatches,
  amountMetadata,
  feeDecimals = 18,
  feeSymbol,
  shieldQuoteExpiresAt,
  className
}: {
  readonly item: ActivityItem
  readonly evmChainIds: readonly string[]
  readonly accountMatches: boolean
  readonly amountMetadata?: Readonly<{ readonly decimals: number; readonly symbol: string }>
  readonly feeDecimals?: number
  readonly feeSymbol?: string
  readonly shieldQuoteExpiresAt?: number
  readonly className?: string
}) {
  const [busy, setBusy] = useState<PendingAction | null>(null)
  const [submittedFor, setSubmittedFor] = useState<{ id: string; action: PendingAction } | null>(
    null
  )
  const [unavailableFor, setUnavailableFor] = useState<string | null>(null)
  const mounted = useRef(true)
  const latest = useRef({ item, evmChainIds, accountMatches, shieldQuoteExpiresAt })
  latest.current = { item, evmChainIds, accountMatches, shieldQuoteExpiresAt }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const canCancel = accountMatches && canCancelEvmActivity(item, evmChainIds)
  const canSpeedUp =
    accountMatches && canSpeedUpEvmActivity(item, evmChainIds, Date.now(), shieldQuoteExpiresAt)
  const originKey = getReplacementOriginKey(item, evmChainIds)
  const origin = item.segments.find(segment => segment.role === 'origin')
  const cancellationPending =
    item.source === 'wallet-v2' &&
    item.status !== 'final' &&
    item.status !== 'failed' &&
    origin?.target.kind === 'onchain' &&
    evmChainIds.includes(origin.target.chainId) &&
    origin.status === 'broadcast' &&
    origin.evidence?.replacementTransactionHash !== undefined
  if (cancellationPending) {
    return (
      <p role="status" className={cn('text-center text-xs text-muted', className)}>
        Cancellation pending
      </p>
    )
  }
  if (!canCancel && !canSpeedUp) return null
  if (submittedFor?.id === item.id)
    return (
      <p role="status" className={cn('text-center text-xs text-muted', className)}>
        {submittedFor.action === 'cancel' ? 'Cancellation pending' : 'Speed up pending'}
      </p>
    )
  if (originKey !== null && unavailableFor === originKey)
    return (
      <p role="status" className={cn('text-center text-xs text-muted', className)}>
        Transaction status is updating
      </p>
    )

  const handleAction = async (action: PendingAction) => {
    if (busy || !accountMatches) return
    const origin = getPendingEvmActivityOrigin(item, evmChainIds)
    if (!origin || origin.target.kind !== 'onchain') return
    const chainId = origin.target.chainId
    const executionMode =
      item.snapshot?.shield?.sourceDomain === 'private' ||
      (item.snapshot?.shield === undefined && item.accountMode === 'private')
        ? 'private'
        : 'main'
    if (action === 'speed-up' && !canSpeedUp) return
    const markUnavailable = () => {
      if (originKey !== null) setUnavailableFor(originKey)
      void chrome.runtime
        .sendMessage({ type: 'RECHECK_FAST_PENDING_TRANSACTIONS', family: 'evm' })
        .catch(() => {})
      void evmWalletClient
        .getActivity('refresh', executionMode, { chainIds: [chainId] })
        .catch(() => {})
    }
    const stillCurrent = () => {
      const current = latest.current
      return (
        mounted.current &&
        current.accountMatches &&
        current.item.id === item.id &&
        originKey !== null &&
        getReplacementOriginKey(current.item, current.evmChainIds) === originKey &&
        current.item.scope.keyDomainId === item.scope.keyDomainId &&
        current.item.scope.accountId === item.scope.accountId &&
        (action === 'cancel' ||
          canSpeedUpEvmActivity(
            current.item,
            current.evmChainIds,
            Date.now(),
            current.shieldQuoteExpiresAt
          ))
      )
    }
    setBusy(action)
    let review: Awaited<ReturnType<typeof evmWalletClient.prepareCancel>> | null = null
    try {
      const transactionId = parseTransactionId(item.id)
      const prepare = (feeSelection?: EvmFeeSelection) =>
        action === 'cancel'
          ? evmWalletClient.prepareCancel(chainId, transactionId, executionMode, feeSelection)
          : evmWalletClient.prepareSpeedUp(chainId, transactionId, executionMode, feeSelection)
      review = await prepare()
      const summary = review.review.summary
      if (summary.schema !== 'evm.transaction.v1')
        throw new Error('The wallet returned an invalid EVM transaction review')
      if (!stillCurrent()) {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        review = null
        return
      }
      const feeUpdate = { current: null as Promise<EvmTransferReview> | null }
      const confirmed = await openModal<boolean>({
        title: action === 'cancel' ? 'Cancel transaction' : 'Speed up transaction',
        showCloseButton: false,
        body: resolve => (
          <ReplacementReviewContent
            action={action}
            item={item}
            initialReview={review!}
            amountMetadata={amountMetadata}
            feeDecimals={feeDecimals}
            feeSymbol={feeSymbol ?? item.snapshot?.feeLimit?.metadata?.symbol ?? 'native token'}
            onFeeChange={selection => {
              feeUpdate.current = (async () => {
                if (review) {
                  const previous = review
                  review = null
                  await evmWalletClient.rejectTransfer(previous.graph.root.id)
                }
                if (!stillCurrent()) throw new Error('Transaction status changed. Try again.')
                let next: EvmTransferReview
                try {
                  next = await prepare(selection)
                } catch (error) {
                  if (
                    error instanceof EvmWalletClientError &&
                    error.code === 'replacement-unavailable' &&
                    stillCurrent()
                  )
                    markUnavailable()
                  throw error
                }
                if (next.review.summary.schema !== 'evm.transaction.v1') {
                  await evmWalletClient.rejectTransfer(next.graph.root.id).catch(() => {})
                  throw new Error('The wallet returned an invalid EVM transaction review')
                }
                if (!stillCurrent()) {
                  await evmWalletClient.rejectTransfer(next.graph.root.id).catch(() => {})
                  throw new Error('Transaction status changed. Try again.')
                }
                review = next
                return next
              })()
              return feeUpdate.current
            }}
            resolve={resolve}
          />
        )
      })
      if (feeUpdate.current) await feeUpdate.current.catch(() => {})
      if (!review) return
      if (!confirmed || review.review.expiresAt <= Date.now() || !stillCurrent()) {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        review = null
        if (confirmed && stillCurrent()) throw new Error('Transaction review expired. Try again.')
        return
      }
      const submission = await evmWalletClient.approveTransfer(
        review.graph.root.id,
        review.review.payloadFingerprint.digestHex
      )
      review = null
      if (submission.status === 'external-signature-required') {
        if (!stillCurrent()) return
        await openHardwareEvmSignTab(submission.transactionId)
        window.close()
        return
      }
      if (submission.status === 'broadcast' && stillCurrent()) {
        setSubmittedFor({ id: item.id, action })
      }
    } catch (error) {
      if (review) await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
      if (stillCurrent()) {
        if (error instanceof EvmWalletClientError && error.code === 'replacement-unavailable') {
          markUnavailable()
        } else {
          toast.error(
            error instanceof Error ? error.message : 'The transaction could not be updated'
          )
        }
      }
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  return (
    <div className={cn('space-y-2', className)}>
      {canSpeedUp && (
        <Button
          className="h-[45px] w-full"
          disabled={busy !== null}
          isLoading={busy === 'speed-up'}
          onClick={() => void handleAction('speed-up')}
        >
          Speed Up
        </Button>
      )}
      {canCancel && (
        <Button
          variant="outline"
          className="h-[45px] w-full"
          disabled={busy !== null}
          isLoading={busy === 'cancel'}
          onClick={() => void handleAction('cancel')}
        >
          Cancel transaction
        </Button>
      )}
    </div>
  )
}
