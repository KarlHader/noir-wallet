import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { parseEvmPriorityFeeGwei, type EvmFeeSelection } from '@/infrastructure/chains/evm'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { openMultichainHardwareSignTab } from '@/lib/hardware-tab'
import { EvmWalletClientError, evmWalletClient } from '@/popup/services/evm-wallet-client'
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
import {
  TransactionActionReview,
  TransactionActionRow,
  TransactionActionRows
} from '../transaction/TransactionActionReview'
import { EvmGasReviewDetails } from './EvmGasReviewDetails'

type RecoveryState = NonNullable<Awaited<ReturnType<typeof evmWalletClient.getNonceRecovery>>>
const RECOVERY_CHECK_INTERVAL_MS = 30_000

function NonceRecoveryFeeForm({
  onContinue,
  onCancel
}: {
  readonly onContinue: (selection: EvmFeeSelection) => void
  readonly onCancel: () => void
}) {
  const [feeMode, setFeeMode] = useState<'fast' | 'standard' | 'custom'>('fast')
  const [customPriorityFee, setCustomPriorityFee] = useState('')
  const [error, setError] = useState<string | null>(null)
  const continueWithFee = () => {
    try {
      onContinue(
        feeMode === 'custom'
          ? parseEvmPriorityFeeGwei(customPriorityFee)
          : { kind: 'tier', tier: feeMode }
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid network fee')
    }
  }

  return (
    <div className="space-y-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            {feeMode === 'fast' ? 'Fast' : feeMode === 'standard' ? 'Standard' : 'Custom'}
            <Icon icon="lucide:chevron-down" className="size-4 text-muted" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuRadioGroup
            value={feeMode}
            onValueChange={value => {
              if (value === 'fast' || value === 'standard' || value === 'custom') {
                setFeeMode(value)
                setError(null)
              }
            }}
          >
            <DropdownMenuRadioItem value="fast">Fast</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="standard">Standard</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="custom">Custom</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {feeMode === 'custom' && (
        <Input
          aria-label="Custom priority fee in GWEI"
          value={customPriorityFee}
          onChange={event => {
            setCustomPriorityFee(event.target.value)
            setError(null)
          }}
          placeholder="Priority fee in GWEI"
        />
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button className="flex-1" onClick={continueWithFee}>
          Continue
        </Button>
      </div>
    </div>
  )
}

interface EvmNonceRecoveryBannerProps {
  readonly accountId: string
  readonly chainId: string
  readonly networkName: string
  readonly executionMode: 'main' | 'private'
  readonly feeSymbol: string
  readonly feeDecimals: number
  readonly onUpdated: () => void
}

export function EvmNonceRecoveryBanner({
  accountId,
  chainId,
  networkName,
  executionMode,
  feeSymbol,
  feeDecimals,
  onUpdated
}: EvmNonceRecoveryBannerProps) {
  const [state, setState] = useState<RecoveryState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checkFailed, setCheckFailed] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkRevision, setCheckRevision] = useState(0)
  const refreshSequence = useRef(0)

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    setChecking(true)
    try {
      const next = await evmWalletClient.getNonceRecovery(chainId, executionMode)
      if (sequence !== refreshSequence.current) return
      setState(next)
      setCheckFailed(false)
      setError(null)
    } catch (cause) {
      if (sequence !== refreshSequence.current) return
      setState(null)
      setCheckFailed(
        cause instanceof EvmWalletClientError && cause.code === 'nonce-queue-unavailable'
      )
    } finally {
      if (sequence === refreshSequence.current) {
        setChecking(false)
        setCheckRevision(previous => previous + 1)
      }
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

  const handleRecovery = async () => {
    if (!state || busy || checking) return
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
        return
      }
      const selection = await openModal<EvmFeeSelection | null>({
        title: 'Network fee',
        body: resolve => (
          <NonceRecoveryFeeForm onContinue={resolve} onCancel={() => resolve(null)} />
        )
      })
      if (!selection) return
      const review = await evmWalletClient.prepareNonceRecovery(chainId, executionMode, selection)
      const summary = review.review.summary
      if (summary.schema !== 'evm.transaction.v1') {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        throw new Error('Invalid EVM recovery review')
      }
      if (summary.fields.nonce !== state.pendingNonce || review.graph.root.relation !== undefined) {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        await refresh()
        throw new Error('Pending nonce changed. Review the current recovery transaction.')
      }
      const approved = await openModal<boolean>({
        title: 'Review recovery transaction',
        showCloseButton: false,
        body: resolve => (
          <TransactionActionReview
            notice="Filling this nonce may allow later queued transactions, including token approvals, to go through. It does not cancel them."
            onBack={() => resolve(false)}
            confirmLabel="Confirm recovery"
            onConfirm={() => resolve(true)}
          >
            <TransactionActionRows>
              <TransactionActionRow label="Maximum network fee">
                <AmountDisplay
                  value={formatBaseUnitAmount(summary.fields.maximumFeeWei, feeDecimals)}
                  symbol={feeSymbol}
                  profile="fee"
                />
              </TransactionActionRow>
              <TransactionActionRow label="Effect">Unblock send queue</TransactionActionRow>
            </TransactionActionRows>
            <EvmGasReviewDetails {...summary.fields} />
          </TransactionActionReview>
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
          await openMultichainHardwareSignTab(submission.transactionId, 'evm')
        } else {
          toast.success(
            submission.status === 'broadcast'
              ? 'Recovery submitted. Confirmation is pending.'
              : 'Broadcast interrupted. Retry from Activity.'
          )
        }
      } catch (cause) {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        throw cause
      }
      await refresh()
      onUpdated()
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
          message={error || 'Send not submitted'}
          onRetry={() => void handleRecovery()}
          retrying={busy}
          tone={error ? 'error' : 'warning'}
        />
      </div>
    )
  }

  return (
    <div className="border-b border-border/60 px-5 py-2" aria-label="EVM nonce recovery">
      <div className="flex min-w-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted" title={networkName}>
          {networkName} - New sends paused
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-1.5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
          disabled={busy || checking}
          onClick={() => void handleRecovery()}
        >
          Fix send queue
        </Button>
      </div>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
