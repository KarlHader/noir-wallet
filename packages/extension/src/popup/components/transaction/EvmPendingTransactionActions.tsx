import { useEffect, useRef, useState } from 'react'
import type { ActivityItem } from '@/core/activity'
import { parseTransactionId } from '@/core/transactions/domain'
import { formatBaseUnitAmount } from '@/lib/number-format'
import { openHardwareEvmSignTab } from '@/lib/hardware-tab'
import { cn } from '@/lib/utils'
import { formatEvmWeiAsGwei } from '@/infrastructure/chains/evm'
import { openModal } from '@/popup/provider/ModalManager'
import { EvmWalletClientError, evmWalletClient } from '@/popup/services/evm-wallet-client'
import { toast } from '@/store/toast-store'
import { AmountDisplay } from '../common/AmountDisplay'
import { Button } from '../ui/button'
import {
  canCancelEvmActivity,
  canSpeedUpEvmActivity,
  getPendingEvmActivityOrigin
} from './multichain-activity-presentation'

type PendingAction = 'cancel' | 'speed-up'

export function EvmPendingTransactionActions({
  item,
  evmChainIds,
  accountMatches,
  feeDecimals = 18,
  feeSymbol,
  shieldQuoteExpiresAt,
  className
}: {
  readonly item: ActivityItem
  readonly evmChainIds: readonly string[]
  readonly accountMatches: boolean
  readonly feeDecimals?: number
  readonly feeSymbol?: string
  readonly shieldQuoteExpiresAt?: number
  readonly className?: string
}) {
  const [busy, setBusy] = useState<PendingAction | null>(null)
  const [submittedFor, setSubmittedFor] = useState<string | null>(null)
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
  const originKey = `${item.id}:${item.updatedAt}:${getPendingEvmActivityOrigin(item, evmChainIds)?.evidence?.transactionHash ?? ''}`
  if ((!canCancel && !canSpeedUp) || submittedFor === item.id || unavailableFor === originKey)
    return null

  const handleAction = async (action: PendingAction) => {
    if (busy || !accountMatches) return
    const origin = getPendingEvmActivityOrigin(item, evmChainIds)
    if (!origin || origin.target.kind !== 'onchain') return
    if (action === 'speed-up' && !canSpeedUp) return
    const stillCurrent = () => {
      const current = latest.current
      return (
        mounted.current &&
        current.accountMatches &&
        current.item.id === item.id &&
        current.item.scope.keyDomainId === item.scope.keyDomainId &&
        current.item.scope.accountId === item.scope.accountId &&
        getPendingEvmActivityOrigin(current.item, current.evmChainIds) !== null &&
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
      const executionMode =
        item.snapshot?.shield?.sourceDomain === 'private' ||
        (item.snapshot?.shield === undefined && item.accountMode === 'private')
          ? 'private'
          : 'main'
      review =
        action === 'cancel'
          ? await evmWalletClient.prepareCancel(origin.target.chainId, transactionId, executionMode)
          : await evmWalletClient.prepareSpeedUp(
              origin.target.chainId,
              transactionId,
              executionMode
            )
      const summary = review.review.summary
      if (summary.schema !== 'evm.transaction.v1')
        throw new Error('The wallet returned an invalid EVM transaction review')
      if (!stillCurrent()) {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        review = null
        return
      }
      const confirmed = await openModal<boolean>({
        title: action === 'cancel' ? 'Cancel transaction' : 'Speed up transaction',
        showCloseButton: false,
        body: resolve => (
          <div className="space-y-4">
            <p className="text-sm leading-5 text-muted">
              {action === 'cancel'
                ? 'Cancellation requires a network fee and takes effect once confirmed.'
                : 'The original transaction will be resent with a higher network fee.'}
            </p>
            <div className="rounded-md border border-border/60 bg-card/60 px-3 py-2 text-xs">
              {action === 'speed-up' && (
                <>
                  <div className="flex justify-between gap-3 py-1">
                    <span className="text-muted">To</span>
                    <span className="min-w-0 break-all text-right font-mono">
                      {summary.fields.to ?? 'Contract creation'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3 py-1">
                    <span className="text-muted">Value</span>
                    <AmountDisplay
                      value={formatBaseUnitAmount(summary.fields.valueWei, feeDecimals)}
                      symbol={
                        feeSymbol ?? item.snapshot?.feeLimit?.metadata?.symbol ?? 'native token'
                      }
                      profile="fee"
                    />
                  </div>
                </>
              )}
              <div className="flex justify-between gap-3 py-1">
                <span className="text-muted">Nonce</span>
                <span className="font-mono">{summary.fields.nonce}</span>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <span className="text-muted">Maximum network fee</span>
                <AmountDisplay
                  value={formatBaseUnitAmount(summary.fields.maximumFeeWei, feeDecimals)}
                  symbol={feeSymbol ?? item.snapshot?.feeLimit?.metadata?.symbol ?? 'native token'}
                  profile="fee"
                />
              </div>
              {summary.fields.gasPriceWei ? (
                <div className="flex justify-between gap-3 py-1">
                  <span className="text-muted">Gas price</span>
                  <AmountDisplay
                    value={formatEvmWeiAsGwei(summary.fields.gasPriceWei)}
                    symbol="GWEI"
                    profile="fee"
                  />
                </div>
              ) : (
                <>
                  <div className="flex justify-between gap-3 py-1">
                    <span className="text-muted">Max fee per gas</span>
                    <AmountDisplay
                      value={formatEvmWeiAsGwei(summary.fields.maxFeePerGasWei ?? '0')}
                      symbol="GWEI"
                      profile="fee"
                    />
                  </div>
                  <div className="flex justify-between gap-3 py-1">
                    <span className="text-muted">Priority fee per gas</span>
                    <AmountDisplay
                      value={formatEvmWeiAsGwei(summary.fields.maxPriorityFeePerGasWei ?? '0')}
                      symbol="GWEI"
                      profile="fee"
                    />
                  </div>
                </>
              )}
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => resolve(false)}>
                Back
              </Button>
              <Button className="flex-1" onClick={() => resolve(true)}>
                {action === 'cancel' ? 'Confirm cancel' : 'Confirm speed up'}
              </Button>
            </div>
          </div>
        )
      })
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
      if (stillCurrent()) {
        setSubmittedFor(item.id)
        toast.success(action === 'cancel' ? 'Cancellation submitted' : 'Speed Up submitted')
      }
    } catch (error) {
      if (review) await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
      if (stillCurrent()) {
        if (error instanceof EvmWalletClientError && error.code === 'replacement-unavailable') {
          setUnavailableFor(originKey)
        }
        toast.error(error instanceof Error ? error.message : 'The transaction could not be updated')
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
