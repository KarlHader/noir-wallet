import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { isMultisigUiEnabled } from '@/core/multisig/multisig-runtime-policy'
import { getMultisigSendErrorMessage } from '@/core/multisig/send-errors'
import { withTimeout } from '@/lib/async-utils'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useMultisigGroup, useMultisigGroupStore } from '@/popup/multisig/group-store'
import { useLocation } from '@/popup/provider/Router'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { DeviceCard } from '@/popup/components/multisig/DeviceCard'
import { SegmentedToggle } from '@/popup/components/multisig/SegmentedToggle'
import {
  SendAmountInputCard,
  SendAssetHeader,
  SendNetworkFeeCard,
  SendRecipientInputCard
} from '@/popup/components/transaction/SendInputCards'
import {
  authorityFromReview,
  cancelMultisigSend,
  prepareMultisigSend
} from '@/popup/services/multisig-send-client'
import {
  getMultisigSendSlots,
  parseMultisigSendAmount,
  parseMultisigSendScope,
  resolveMultisigSendContext
} from './send-model'
import type { MultisigSendContext } from './send-model'
import type { DeviceSlot, MultisigTransportKind } from '@/core/multisig/types'
import type { VaultSendReview } from '@/core/multisig/send-rpc'
import { SendReview } from './SendReview'
import { SendSigning } from './SendSigning'
import { SendPendingTransactions } from './SendPendingTransactions'
import { useMultisigSendTransactions } from './useMultisigSendTransactions'
import { getUnresolvedMultisigTransactions } from './send-model'

const SIGNING_TRANSPORT_OPTIONS: { value: MultisigTransportKind; label: string }[] = [
  { value: 'ble', label: 'Bluetooth' },
  { value: 'qr', label: 'QR code' }
]

interface PreparedTransfer {
  review: VaultSendReview
  // The Background binds the signing session to this transport, so it travels with the review.
  transport: MultisigTransportKind
}

function SendLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="page-container page-container--tab">
      <PageHeader title="Multisig send" showBack onBack={() => window.close()} />
      <div className="page-content">{children}</div>
      {footer && <div className="page-footer">{footer}</div>}
    </div>
  )
}

/** Public form state is tied to one active independent account, never to the creation session. */
export function SendPage() {
  const { search } = useLocation()
  const scope = useMemo(() => parseMultisigSendScope(search), [search])
  const group = useMultisigGroup(scope)
  const isLoaded = useMultisigGroupStore(state => state.loaded)
  const [hasLoadFailed, setHasLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const wallet = useWalletStore()
  useEffect(() => {
    if (!isMultisigUiEnabled() || isLoaded) return
    let isDisposed = false
    setHasLoadFailed(false)
    void useMultisigGroupStore
      .getState()
      .load()
      .catch(() => {
        if (!isDisposed) setHasLoadFailed(true)
      })
    return () => {
      isDisposed = true
    }
  }, [isLoaded, loadAttempt])
  const context = isMultisigUiEnabled()
    ? resolveMultisigSendContext(
        scope,
        {
          network: wallet.currentNetwork,
          walletId: wallet.currentWalletId,
          accountId: wallet.currentAccountId,
          source: wallet.getCurrentAccount()?.source
        },
        group
      )
    : null
  if (!context) {
    return (
      <SendLayout
        footer={
          <FlowButton variant="outline" onClick={() => window.close()}>
            Close
          </FlowButton>
        }
      >
        {hasLoadFailed ? (
          <InlineError
            message="Unable to load this multisig account."
            onRetry={() => setLoadAttempt(value => value + 1)}
          />
        ) : !isLoaded && isMultisigUiEnabled() ? (
          <div role="status" className="flex items-center justify-center gap-2 text-sm text-muted">
            <Icon icon="lucide:loader-2" className="animate-spin motion-reduce:animate-none" />
            Loading multisig account…
          </div>
        ) : !isMultisigUiEnabled() ? (
          <InlineError message="Multisig sending is not enabled in this build." />
        ) : (
          <InlineError message="This multisig account is unavailable or the active account or network has changed. Open Send again from the account you want to use." />
        )}
      </SendLayout>
    )
  }
  // Replacing the active scope or roster unmounts the entire draft, including pending work.
  return <MultisigSendForm key={JSON.stringify(context)} context={context} />
}

function MultisigSendForm({ context }: { context: MultisigSendContext }) {
  const { scope, group } = context
  const contextKey = JSON.stringify(context)
  const balance = useAccountDataStore(state => state.getCurrentBalance())
  const priceUsd = useWalletStore(state => state.zecPrice)
  const transactionHistory = useMultisigSendTransactions(scope)
  const unresolvedTransactions = getUnresolvedMultisigTransactions(transactionHistory.transactions)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [selectedPhone, setSelectedPhone] = useState<DeviceSlot | null>(null)
  // Signing does not depend on how the group was created; that transport is only the default.
  const [signingTransport, setSigningTransport] = useState<MultisigTransportKind>(
    group.transportKind
  )
  const [isPreparing, setIsPreparing] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedTransfer | null>(null)
  const [isApproved, setIsApproved] = useState(false)
  const [isInvalidated, setIsInvalidated] = useState(false)
  const invalidated = useRef(false)
  const attempt = useRef<AbortController | null>(null)
  const activeReview = useRef<VaultSendReview | null>(null)
  const closeReview = useCallback(() => {
    const current = activeReview.current
    if (current) void cancelMultisigSend(authorityFromReview(current)).catch(() => {})
    activeReview.current = null
  }, [])
  useEffect(() => {
    const invalidateChangedContext = () => {
      const active = useWalletStore.getState()
      const current = resolveMultisigSendContext(
        scope,
        {
          network: active.currentNetwork,
          walletId: active.currentWalletId,
          accountId: active.currentAccountId,
          source: active.getCurrentAccount()?.source
        },
        useMultisigGroupStore.getState().getGroup(scope)
      )
      if (!current || JSON.stringify(current) !== contextKey) {
        // Observe even a switch away and back inside one React render batch.
        invalidated.current = true
        attempt.current?.abort()
        closeReview()
        setIsInvalidated(true)
      }
    }
    const unsubscribeWallet = useWalletStore.subscribe(invalidateChangedContext)
    const unsubscribeGroup = useMultisigGroupStore.subscribe(invalidateChangedContext)
    invalidateChangedContext()
    return () => {
      unsubscribeWallet()
      unsubscribeGroup()
      attempt.current?.abort()
      closeReview()
    }
  }, [closeReview, contextKey, scope])

  const handleSessionClosed = useCallback(() => {
    activeReview.current = null
  }, [])

  const handleSigned = useCallback(() => {
    activeReview.current = null
  }, [])

  const selectedSlots = getMultisigSendSlots(group, selectedPhone)
  const amountZats = parseMultisigSendAmount(amount)
  const recipientAddress = recipient.trim()
  const isRecipientDraftValid = recipientAddress.length > 0 && recipientAddress.length <= 2048
  const memoBytes = new TextEncoder().encode(memo).length
  const canPrepare =
    transactionHistory.status === 'ready' &&
    !transactionHistory.hasSignedWithoutTransaction &&
    unresolvedTransactions.length === 0 &&
    isRecipientDraftValid &&
    amountZats !== null &&
    memoBytes <= 512 &&
    selectedSlots !== null

  const cancelPreparation = () => {
    attempt.current?.abort()
    attempt.current = null
    setIsPreparing(false)
    setFeedback(null)
  }
  const prepareTransfer = async () => {
    if (!canPrepare || !amountZats || !selectedSlots || attempt.current) return
    const controller = new AbortController()
    const transport = signingTransport
    attempt.current = controller
    setIsPreparing(true)
    setFeedback(null)
    const assertCurrent = () => {
      const active = useWalletStore.getState()
      const current = resolveMultisigSendContext(
        scope,
        {
          network: active.currentNetwork,
          walletId: active.currentWalletId,
          accountId: active.currentAccountId,
          source: active.getCurrentAccount()?.source
        },
        useMultisigGroupStore.getState().getGroup(scope)
      )
      if (
        controller.signal.aborted ||
        invalidated.current ||
        !current ||
        JSON.stringify(current) !== contextKey
      ) {
        throw new DOMException('Multisig draft is no longer active', 'AbortError')
      }
    }
    try {
      const result = await withTimeout(
        prepareMultisigSend(
          {
            scope,
            groupId: group.groupId,
            rosterVersion: 1,
            to: recipientAddress,
            amountZats,
            ...(memo ? { memo } : {}),
            selectedSlots,
            transport
          },
          assertCurrent
        ),
        45_000,
        'Multisig preparation'
      )
      assertCurrent()
      if (result.available) {
        activeReview.current = result
        setPrepared({ review: result, transport })
      } else {
        setFeedback(
          result.reason === 'fee_quote_unavailable'
            ? 'The network fee quote is unavailable. Please try again.'
            : 'Multisig sending is unavailable in this wallet version.'
        )
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFeedback(getMultisigSendErrorMessage(error))
      }
    } finally {
      controller.abort()
      if (attempt.current === controller) {
        attempt.current = null
        setIsPreparing(false)
      }
    }
  }
  const clearFeedback = () => setFeedback(null)

  const cancelReview = async () => {
    const review = prepared?.review
    if (!review || isCancelling) return
    setIsCancelling(true)
    try {
      await cancelMultisigSend(authorityFromReview(review))
      activeReview.current = null
      setPrepared(null)
      setFeedback(null)
    } catch {
      setFeedback('Unable to close this review. Please try again or wait for it to expire.')
    } finally {
      setIsCancelling(false)
    }
  }

  if (isInvalidated) {
    return (
      <SendLayout
        footer={
          <FlowButton variant="outline" onClick={() => window.close()}>
            Close
          </FlowButton>
        }
      >
        <InlineError message="The account, network or signing group changed. Open Send again to start a new transfer." />
      </SendLayout>
    )
  }

  if (prepared && isApproved) {
    return (
      <SendSigning
        review={prepared.review}
        transport={prepared.transport}
        group={group}
        onClose={() => window.close()}
        onSessionClosed={handleSessionClosed}
        onSigned={handleSigned}
      />
    )
  }

  if (prepared) {
    const { review } = prepared
    return (
      <SendReview
        review={review}
        transport={prepared.transport}
        group={group}
        isCancelling={isCancelling}
        feedback={feedback}
        onApprove={() => {
          if (Date.now() >= review.binding.expiresAt || invalidated.current) {
            void cancelReview()
            return
          }
          setFeedback(null)
          setIsApproved(true)
        }}
        onCancel={() => void cancelReview()}
      />
    )
  }

  if (transactionHistory.hasSignedWithoutTransaction || unresolvedTransactions.length) {
    return (
      <SendPendingTransactions
        transactions={unresolvedTransactions}
        recoveryStatus={transactionHistory.recoveryStatus}
        hasRefreshFailed={transactionHistory.status === 'error'}
        onRefresh={transactionHistory.refresh}
      />
    )
  }

  return (
    <SendLayout
      footer={
        <div className="space-y-3">
          {feedback && <InlineError message={feedback} />}
          {transactionHistory.status === 'loading' && (
            <div role="status" className="text-sm text-muted">
              Checking saved transfers…
            </div>
          )}
          {transactionHistory.status === 'error' && (
            <InlineError
              message="Unable to read saved transfers. Check status before preparing another payment."
              onRetry={transactionHistory.refresh}
            />
          )}
          <FlowButton
            disabled={!canPrepare || isPreparing}
            aria-busy={isPreparing}
            onClick={() => void prepareTransfer()}
          >
            {isPreparing ? 'Preparing…' : 'Prepare transfer'}
          </FlowButton>
          {isPreparing && (
            <FlowButton variant="outline" onClick={cancelPreparation}>
              Cancel
            </FlowButton>
          )}
        </div>
      }
    >
      <div className="space-y-4 pb-4">
        <SendAssetHeader
          symbol="ZEC"
          nativeChain="zcash"
          networkName={scope.network === 'mainnet' ? 'Zcash · Private' : 'Zcash Testnet · Private'}
        />
        <fieldset disabled={isPreparing} className="min-w-0 space-y-4 disabled:opacity-60">
          <SendRecipientInputCard
            id="multisig-recipient"
            value={recipient}
            onChange={value => {
              setRecipient(value)
              clearFeedback()
            }}
            placeholder="Recipient address"
            invalid={recipient.length > 0 && !isRecipientDraftValid}
          />
          <SendAmountInputCard
            ariaLabel="Amount in ZEC"
            value={amount}
            onChange={value => {
              setAmount(value)
              clearFeedback()
            }}
            available={balance?.confirmed?.shielded ?? balance?.shielded ?? '0'}
            availableLabel="Balance"
            symbol="ZEC"
            priceUsd={priceUsd}
            invalid={amount.length > 0 && amountZats === null}
            error={
              amount.length > 0 && amountZats === null
                ? 'Enter a positive ZEC amount with up to 8 decimal places.'
                : undefined
            }
          />
          <SendNetworkFeeCard label="Network fee rate">
            <span>Standard</span>
          </SendNetworkFeeCard>
          <label className="block space-y-2 text-xs text-muted">
            <span>Memo (optional)</span>
            <textarea
              value={memo}
              onChange={event => {
                setMemo(event.target.value)
                clearFeedback()
              }}
              rows={3}
              aria-invalid={memoBytes > 512}
              className="w-full resize-y rounded-xl border border-border bg-card p-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className={memoBytes > 512 ? 'text-danger' : undefined}>
              {memoBytes} / 512 bytes
            </span>
          </label>
          <div className="space-y-2">
            <h2 className="text-sm font-medium">
              Signers · {group.threshold.replace('-of-', ' of ')}
            </h2>
            {group.threshold === '2-of-3' && (
              <div className="text-xs text-muted">Choose one phone to sign with Noir Wallet.</div>
            )}
            <div className="space-y-2" role="group" aria-label="Signing devices">
              {group.devices.map(device => {
                const isSelected = selectedSlots?.includes(device.slot - 1) ?? device.slot === 1
                const canChoose = group.threshold === '2-of-3' && device.slot !== 1
                return (
                  <DeviceCard
                    key={device.slot}
                    slot={device.slot}
                    role={device.role}
                    title={device.name}
                    subtitle={device.model}
                    status="empty"
                    highlighted={isSelected}
                    onClick={
                      canChoose
                        ? () => {
                            setSelectedPhone(device.slot)
                            clearFeedback()
                          }
                        : undefined
                    }
                    trailing={
                      canChoose ? (
                        <span className={isSelected ? 'text-primary' : 'text-muted'}>
                          <Icon
                            icon={isSelected ? 'lucide:circle-dot' : 'lucide:circle'}
                            aria-hidden="true"
                          />
                          <span className="sr-only">
                            {isSelected ? 'Selected signer' : 'Choose signer'}
                          </span>
                        </span>
                      ) : (
                        <Icon
                          icon="lucide:check"
                          className="text-primary"
                          aria-label="Required signer"
                        />
                      )
                    }
                  />
                )
              })}
            </div>
          </div>
          <div className="space-y-2" role="group" aria-labelledby="multisig-signing-method">
            <h2 id="multisig-signing-method" className="text-sm font-medium">
              Signing method
            </h2>
            <SegmentedToggle
              options={SIGNING_TRANSPORT_OPTIONS}
              value={signingTransport}
              onChange={value => {
                setSigningTransport(value)
                clearFeedback()
              }}
            />
          </div>
        </fieldset>
      </div>
    </SendLayout>
  )
}
