import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { ActivityItem } from '@/core/activity'
import {
  formatEvmWeiAsGwei,
  parseEvmPriorityFeeGwei,
  type EvmFeeSelection
} from '@/infrastructure/chains/evm'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { openHardwareEvmSignTab } from '@/lib/hardware-tab'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import { openModal } from '@/popup/provider/ModalManager'
import { toast } from '@/store/toast-store'
import { formatBaseUnitAmount } from '@/lib/number-format'
import { AmountDisplay } from '../common/AmountDisplay'
import { InlineError } from '../common/InlineError'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { getEvmNonceRecoveryPresentation } from './evm-nonce-recovery-presentation'

type RecoveryState = NonNullable<Awaited<ReturnType<typeof evmWalletClient.getNonceRecovery>>>
const RECOVERY_CHECK_INTERVAL_MS = 30_000

interface EvmNonceRecoveryBannerProps {
  readonly accountId: string
  readonly chainId: string
  readonly networkName: string
  readonly executionMode: 'main' | 'private'
  readonly feeSymbol: string
  readonly feeDecimals: number
  readonly activityItems: readonly ActivityItem[]
  readonly onUpdated: () => void
}

export function EvmNonceRecoveryBanner({
  accountId,
  chainId,
  networkName,
  executionMode,
  feeSymbol,
  feeDecimals,
  activityItems,
  onUpdated
}: EvmNonceRecoveryBannerProps) {
  const [state, setState] = useState<RecoveryState | null>(null)
  const [busy, setBusy] = useState(false)
  const [feeMode, setFeeMode] = useState<'fast' | 'standard' | 'custom'>('fast')
  const [customPriorityFee, setCustomPriorityFee] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checkFailed, setCheckFailed] = useState(false)
  const [checkRevision, setCheckRevision] = useState(0)
  const [reviewOpen, setReviewOpen] = useState(false)
  const refreshSequence = useRef(0)
  const replacedOperation = activityItems.find(item => item.id === state?.transactionId)?.kind
  const presentation = state ? getEvmNonceRecoveryPresentation(state.action) : null

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    try {
      const next = await evmWalletClient.getNonceRecovery(chainId, executionMode)
      if (sequence !== refreshSequence.current) return
      setState(next)
      setCheckFailed(false)
      setError(null)
    } catch {
      if (sequence !== refreshSequence.current) return
      setState(null)
      setCheckFailed(true)
    } finally {
      if (sequence === refreshSequence.current) setCheckRevision(previous => previous + 1)
    }
  }, [chainId, executionMode])

  useEffect(() => {
    refreshSequence.current += 1
    setState(null)
    setCheckFailed(false)
    void refresh()
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (!message || typeof message !== 'object' || !('type' in message)) return
      if (
        message.type === 'TRANSACTION_ADDED' ||
        message.type === 'TRANSACTION_UPDATED' ||
        message.type === 'TRANSACTION_STATUS_UPDATED'
      ) {
        void refresh()
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      refreshSequence.current += 1
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [accountId, refresh])

  useEffect(() => {
    if (!state && !checkFailed) return
    const timer = setTimeout(() => void refresh(), RECOVERY_CHECK_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [checkFailed, checkRevision, refresh, state])

  useEffect(() => {
    if (
      state?.action === 'await-confirmation' &&
      activityItems.some(
        item =>
          item.id === state.transactionId && (item.status === 'final' || item.status === 'failed')
      )
    ) {
      void refresh()
    }
  }, [activityItems, refresh, state])

  const handleRecovery = async () => {
    if (!state || busy) return
    if (state.action === 'await-confirmation') return
    setBusy(true)
    setError(null)
    try {
      if (state.action === 'retry-broadcast') {
        if (!state.transactionId) throw new Error('Signed transaction is unavailable')
        const submission = await evmWalletClient.resumeTransfer(state.transactionId)
        toast.success(
          submission.status === 'broadcast'
            ? 'Broadcast submitted. Confirmation is pending.'
            : 'Broadcast is still interrupted.'
        )
        await refresh()
        onUpdated()
        setReviewOpen(false)
        return
      }
      const selection: EvmFeeSelection =
        feeMode === 'custom'
          ? parseEvmPriorityFeeGwei(customPriorityFee)
          : { kind: 'tier', tier: feeMode }
      const review = await evmWalletClient.prepareNonceRecovery(chainId, executionMode, selection)
      const summary = review.review.summary
      if (summary.schema !== 'evm.transaction.v1') {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        throw new Error('Invalid EVM recovery review')
      }
      if (
        summary.fields.nonce !== state.pendingNonce ||
        (state.action === 'replace' &&
          review.graph.root.relation?.transactionId !== state.transactionId) ||
        (state.action === 'fill-gap' && review.graph.root.relation !== undefined)
      ) {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        await refresh()
        throw new Error('Pending nonce changed. Review the current recovery transaction.')
      }
      const approved = await openModal<boolean>({
        title: 'Review recovery transaction',
        showCloseButton: false,
        body: resolve => (
          <div className="space-y-4 pb-2">
            <p className="text-sm leading-5 text-muted">
              This sends a zero-value transaction to your own address. It may replace an earlier
              transaction. Recovery completes only after it confirms.
            </p>
            {state.action === 'replace' && (
              <p className="text-sm leading-5 text-warning">
                This will replace your pending {replacedOperation ?? 'transaction'}.
              </p>
            )}
            <div className="space-y-2 border-y border-border/60 py-3 text-xs">
              <div className="flex justify-between gap-3">
                <span className="text-muted">Nonce</span>
                <span className="font-mono">{summary.fields.nonce}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">Maximum network fee</span>
                <span className="font-mono">
                  <AmountDisplay
                    value={formatBaseUnitAmount(summary.fields.maximumFeeWei, feeDecimals)}
                    symbol={feeSymbol}
                    profile="fee"
                  />
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">Max fee per gas</span>
                <span className="font-mono">
                  <AmountDisplay
                    value={formatEvmWeiAsGwei(summary.fields.maxFeePerGasWei ?? '0')}
                    symbol="GWEI"
                    profile="fee"
                  />
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">Priority fee</span>
                <span className="font-mono">
                  <AmountDisplay
                    value={formatEvmWeiAsGwei(summary.fields.maxPriorityFeePerGasWei ?? '0')}
                    symbol="GWEI"
                    profile="fee"
                  />
                </span>
              </div>
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => resolve(false)}>
                Back
              </Button>
              <Button className="flex-1" onClick={() => resolve(true)}>
                Confirm
              </Button>
            </div>
          </div>
        )
      })
      if (!approved) {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        return
      }
      try {
        const submission = await evmWalletClient.approveTransfer(
          review.graph.root.id,
          review.review.payloadFingerprint.digestHex
        )
        if (submission.status === 'external-signature-required') {
          await openHardwareEvmSignTab(submission.transactionId)
        } else {
          toast.success(
            submission.status === 'broadcast'
              ? 'Recovery submitted. Wait for confirmation before continuing.'
              : 'Broadcast interrupted. Retry from Activity.'
          )
        }
      } catch (cause) {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        throw cause
      }
      await refresh()
      onUpdated()
      setReviewOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'EVM nonce recovery failed')
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null

  if (state.action === 'retry-broadcast') {
    return (
      <div className="border-b border-border/60 px-5 py-3" aria-label="EVM nonce recovery">
        <p className="mb-1 text-xs text-muted">{networkName}</p>
        <InlineError
          message={error || presentation?.title || 'Broadcast interrupted'}
          onRetry={() => void handleRecovery()}
          retrying={busy}
          tone={error ? 'error' : 'warning'}
        />
      </div>
    )
  }

  const canReview = state.action === 'fill-gap' || state.action === 'replace'

  return (
    <div className="border-b border-border/60 px-5 py-3" aria-label="EVM nonce recovery">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-muted">
          <Icon icon={presentation?.icon ?? 'lucide:clock-3'} width={17} height={17} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-5 text-foreground">
            {presentation?.title}
          </p>
          <p className="truncate text-xs leading-4 text-muted" title={networkName}>
            {networkName}
          </p>
        </div>
        {presentation?.actionLabel && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 gap-1 px-1.5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
            aria-expanded={canReview ? reviewOpen : undefined}
            disabled={busy}
            onClick={() => {
              if (canReview) setReviewOpen(open => !open)
              else void handleRecovery()
            }}
          >
            {presentation.actionLabel}
            <Icon
              icon={canReview && reviewOpen ? 'lucide:chevron-up' : 'lucide:chevron-right'}
              width={14}
              height={14}
            />
          </Button>
        )}
      </div>
      {canReview && reviewOpen && (
        <div className="ml-12 mt-3 border-t border-border/60 pt-3">
          <p className="text-xs leading-4 text-muted">
            A zero-value transaction to your own address can clear the blocked order after it
            confirms.
            {state.action === 'replace' &&
              ` This may replace your pending ${replacedOperation ?? 'transaction'}.`}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor={`nonce-fee-${chainId}`} className="shrink-0 text-xs text-muted">
              Network fee
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  id={`nonce-fee-${chainId}`}
                  variant="outline"
                  disabled={busy}
                  className="h-8 min-w-0 flex-1 justify-between px-2 text-xs"
                >
                  {feeMode === 'fast' ? 'Fast' : feeMode === 'standard' ? 'Standard' : 'Custom'}
                  <Icon icon="lucide:chevron-down" className="size-3.5 text-muted" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-(--radix-dropdown-menu-trigger-width)">
                <DropdownMenuRadioGroup
                  value={feeMode}
                  onValueChange={value => {
                    if (value === 'fast' || value === 'standard' || value === 'custom') {
                      setFeeMode(value)
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="fast">Fast</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="standard">Standard</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="custom">Custom</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-3 text-xs"
              disabled={busy}
              onClick={() => void handleRecovery()}
            >
              Continue
            </Button>
          </div>
          {feeMode === 'custom' && (
            <div className="mt-2">
              <Input
                aria-label="Custom priority fee in GWEI"
                value={customPriorityFee}
                onChange={event => setCustomPriorityFee(event.target.value)}
                placeholder="Priority fee in GWEI"
                disabled={busy}
                className="h-8 w-full text-xs"
              />
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="ml-12 mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
