import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { DialogTitle } from '../ui/dialog'
import { TransactionResult } from './TransactionResult'
import { AmountDisplay } from '../common/AmountDisplay'
import { openModal } from '@/popup/provider/ModalManager'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import { formatShieldSymbol } from '@/lib/format'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { buildActivityPresentationCatalog } from '@/popup/services/activity-presentation-catalog'
import { selectActivityObservation } from '@/popup/services/activity-observation'
import {
  confidentialFundingClient,
  getConfidentialFundingPlanId
} from '@/popup/services/confidential-funding-client'
import { ActivityTransactionBody, buildActivityTransactionView } from './ActivityTransactionBody'
import type { ActivityPerspective } from '@/popup/services/activity-action-label'
import type { ActivityItem } from '@/core/activity'
import type { ConfidentialFundingPlan } from '@/core/services/confidential-funding'
import type { Network } from '@/types'
import { getActivityStatusPresentation } from '@/popup/services/multichain-activity-presentation'
import { EvmPendingTransactionActions } from '../evm/EvmPendingTransactionActions'

export interface ConfidentialActivityTarget {
  readonly network: Network
  readonly keyDomainId: string
  readonly accountId: string
  readonly transactionId: string
}

interface ConfidentialActivitySheetProps {
  readonly plan: ConfidentialActivityTarget
  readonly display?: ConfidentialActivityDisplay
  readonly onDone: () => void
  readonly onViewActivity: () => void
  readonly inDialog?: boolean
}

export interface ConfidentialActivityDisplay {
  readonly operation: 'send' | 'move' | 'swap'
  readonly perspective?: ActivityPerspective
  readonly amount: string
  readonly symbol: string
  readonly receiveAmount?: string
  readonly receiveSymbol?: string
  readonly from?: string
  readonly recipient?: string
  readonly network?: string
}

export function ConfidentialActivityView({
  plan,
  display,
  onDone,
  onViewActivity,
  inDialog = false
}: ConfidentialActivitySheetProps) {
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const { activeAccount, loading: accountLoading } = useActiveAccountNetworks()
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const [activity, setActivity] = useState<ActivityItem | null>(null)
  const [confidentialPlan, setConfidentialPlan] = useState<ConfidentialFundingPlan | null>(null)
  const activityRef = useRef<ActivityItem | null>(null)
  const targetRef = useRef('')
  const [stillLoading, setStillLoading] = useState(false)
  const endpointSettings = useSettingsStore(state => state.chainEndpointSettings)
  const catalog = useMemo(
    () =>
      buildActivityPresentationCatalog({
        network: plan.network,
        endpointSettings,
        userEvmAssets: []
      }),
    [plan.network, endpointSettings]
  )
  const matchesAccount =
    currentNetwork === plan.network &&
    effectiveAccount?.walletId === plan.keyDomainId &&
    effectiveAccount.accountId === plan.accountId

  useEffect(() => {
    const target = JSON.stringify([
      plan.network,
      plan.keyDomainId,
      plan.accountId,
      plan.transactionId
    ])
    if (targetRef.current !== target) {
      targetRef.current = target
      activityRef.current = null
      setActivity(null)
      setConfidentialPlan(null)
      setStillLoading(false)
    }
    if (!matchesAccount && !accountLoading) {
      onDone()
      return
    }
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let inFlight: Promise<void> | null = null
    let pendingUpdate = false
    const delayTimer = setTimeout(() => {
      if (active) setStillLoading(true)
    }, 10_000)

    const planId = getConfidentialFundingPlanId(plan.transactionId)
    const load = () => {
      if (!active) return
      if (inFlight) {
        pendingUpdate = true
        return
      }
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      inFlight = Promise.allSettled([
        planId ? confidentialFundingClient.get(planId) : Promise.resolve(null),
        evmWalletClient.getActivity('read', 'all')
      ])
        .then(([planResult, activityResult]) => {
          if (!active) return
          const nextPlan = planResult.status === 'fulfilled' ? planResult.value : null
          const scopedPlan =
            nextPlan?.transactionId === plan.transactionId &&
            nextPlan.network === plan.network &&
            nextPlan.keyDomainId === plan.keyDomainId &&
            nextPlan.accountId === plan.accountId
              ? nextPlan
              : null
          if (scopedPlan) setConfidentialPlan(scopedPlan)

          const model = activityResult.status === 'fulfilled' ? activityResult.value : null
          const item = model?.items.find(candidate => candidate.id === plan.transactionId)
          if (
            model?.scope.keyDomainId === plan.keyDomainId &&
            model.scope.accountId === plan.accountId &&
            item?.scope.keyDomainId === plan.keyDomainId &&
            item.scope.accountId === plan.accountId
          ) {
            const next = activityRef.current
              ? selectActivityObservation(activityRef.current, item)
              : item
            activityRef.current = next
            setActivity(next)
          }
          const current = activityRef.current
          if (
            scopedPlan?.phase !== 'refunded' &&
            !(
              current?.status === 'failed' ||
              (current?.status === 'final' &&
                current.completeness === 'complete' &&
                current.reconfirming !== true)
            )
          ) {
            retryTimer = setTimeout(load, 3_000)
          }
        })
        .catch(() => {})
        .finally(() => {
          inFlight = null
          if (active && pendingUpdate) {
            pendingUpdate = false
            load()
          }
        })
    }
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (!message || typeof message !== 'object' || !('type' in message)) return
      if (
        message.type === 'TRANSACTION_ADDED' ||
        message.type === 'TRANSACTION_UPDATED' ||
        message.type === 'TRANSACTION_STATUS_UPDATED' ||
        message.type === 'CROSS_CHAIN_STATUS_UPDATED'
      )
        load()
    }
    chrome.runtime.onMessage.addListener(listener)
    load()
    return () => {
      active = false
      chrome.runtime.onMessage.removeListener(listener)
      clearTimeout(delayTimer)
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
  }, [
    matchesAccount,
    accountLoading,
    onDone,
    plan.accountId,
    plan.keyDomainId,
    plan.network,
    plan.transactionId
  ])

  const scopedActivity =
    matchesAccount &&
    activity?.id === plan.transactionId &&
    activity.scope.keyDomainId === plan.keyDomainId &&
    activity.scope.accountId === plan.accountId
      ? activity
      : null
  const scopedPlan =
    scopedActivity &&
    confidentialPlan?.transactionId === plan.transactionId &&
    confidentialPlan.network === plan.network &&
    confidentialPlan.keyDomainId === plan.keyDomainId &&
    confidentialPlan.accountId === plan.accountId
      ? confidentialPlan
      : null
  const refunded = scopedPlan?.phase === 'refunded' || scopedActivity?.failureCode === 'refunded'
  const activityView = scopedActivity
    ? buildActivityTransactionView({
        item: scopedActivity,
        network: plan.network,
        assetMetadata: catalog.assetMetadata,
        chainMetadata: catalog.chainMetadata,
        confidentialPlan: scopedPlan,
        perspective: display?.perspective,
        refunded,
        ...(refunded ? { statusLabel: 'Refunded', statusTone: 'neutral' as const } : {}),
        fallback: display
          ? {
              source: { value: display.amount, symbol: formatShieldSymbol(display.symbol) },
              ...(display.receiveAmount && display.receiveSymbol
                ? {
                    destination: {
                      value: display.receiveAmount,
                      symbol: formatShieldSymbol(display.receiveSymbol)
                    }
                  }
                : {}),
              ...(display.network ? { sourceNetwork: display.network } : {})
            }
          : undefined
      })
    : null
  const confirmed =
    scopedActivity?.status === 'final' &&
    scopedActivity.reconfirming !== true &&
    scopedActivity.completeness === 'complete'
  const failed = scopedActivity?.status === 'failed' && !refunded
  const failedPresentation =
    failed && scopedActivity ? getActivityStatusPresentation(scopedActivity) : null
  const neutralFailure = failedPresentation?.tone === 'neutral'
  const origin = scopedActivity?.segments.find(segment => segment.role === 'origin')
  const destination = scopedActivity?.segments.find(segment => segment.role === 'destination')
  const progressTitle =
    destination && ['broadcast', 'confirming'].includes(destination.status)
      ? 'Destination processing'
      : origin?.status === 'final'
        ? 'Source confirmed'
        : origin?.evidence?.transactionHash
          ? 'Source transaction pending'
          : 'Transaction Submitting'

  return (
    <>
      {inDialog && <DialogTitle className="sr-only">Transaction activity</DialogTitle>}
      <TransactionResult
        status={
          refunded
            ? 'neutral'
            : confirmed
              ? 'success'
              : neutralFailure
                ? 'neutral'
                : failed
                  ? 'failed'
                  : 'loading'
        }
        title={
          refunded
            ? 'Transaction Refunded'
            : confirmed
              ? 'Transaction Confirmed'
              : neutralFailure
                ? `Transaction ${failedPresentation.label}`
                : failed
                  ? 'Transaction Failed'
                  : progressTitle
        }
        footer={
          <div className="space-y-2">
            {scopedActivity && (
              <EvmPendingTransactionActions
                key={scopedActivity.id}
                item={scopedActivity}
                evmChainIds={catalog.evmChainIds}
                accountMatches={matchesAccount}
                amountMetadata={
                  scopedActivity.snapshot?.primaryAmount
                    ? (catalog.assetMetadata.get(scopedActivity.snapshot.primaryAmount.assetId)
                        ?.metadata ?? scopedActivity.snapshot.primaryAmount.metadata)
                    : undefined
                }
                feeDecimals={
                  scopedActivity.snapshot?.feeLimit
                    ? (catalog.assetMetadata.get(scopedActivity.snapshot.feeLimit.assetId)?.metadata
                        .decimals ?? scopedActivity.snapshot.feeLimit.metadata?.decimals)
                    : undefined
                }
                feeSymbol={
                  scopedActivity.snapshot?.feeLimit
                    ? (catalog.assetMetadata.get(scopedActivity.snapshot.feeLimit.assetId)?.metadata
                        .symbol ?? scopedActivity.snapshot.feeLimit.metadata?.symbol)
                    : undefined
                }
                shieldQuoteExpiresAt={Date.parse(scopedPlan?.depositQuote?.quote.deadline ?? '')}
              />
            )}
            {confirmed || failed || refunded ? (
              <Button onClick={onDone} className="h-[45px] w-full">
                Done
              </Button>
            ) : stillLoading ? (
              <Button
                variant="outline"
                className="h-[45px] w-full"
                onClick={() => {
                  onDone()
                  onViewActivity()
                }}
              >
                View Activity
              </Button>
            ) : null}
          </div>
        }
      >
        {activityView ? (
          <ActivityTransactionBody
            view={activityView}
            showDate={activityView.item.snapshot?.shield?.operation === 'cluster'}
          />
        ) : (
          <div className="divide-y divide-border/60 border-y border-border/60 text-sm">
            {display && (
              <div className="flex justify-between gap-4 py-4">
                <span className="text-muted">Amount</span>
                <span className="min-w-0 text-right font-medium">
                  <AmountDisplay
                    value={display.amount}
                    symbol={formatShieldSymbol(display.symbol)}
                    prefix={display.operation === 'swap' ? '-' : ''}
                  />
                  {display.operation === 'swap' &&
                    display.receiveAmount &&
                    display.receiveSymbol && (
                      <span className="block">
                        <AmountDisplay
                          value={display.receiveAmount}
                          symbol={formatShieldSymbol(display.receiveSymbol)}
                          prefix="+"
                        />
                      </span>
                    )}
                </span>
              </div>
            )}
            {display?.from && (
              <div className="flex justify-between gap-4 py-4">
                <span className="text-muted">From</span>
                <span className="min-w-0 break-all text-right">{display.from}</span>
              </div>
            )}
            {display?.recipient && (
              <div className="flex justify-between gap-4 py-4">
                <span className="text-muted">Recipient</span>
                <span className="min-w-0 break-all text-right">{display.recipient}</span>
              </div>
            )}
            {display?.network && (
              <div className="flex justify-between gap-4 py-4">
                <span className="text-muted">Network</span>
                <span className="text-right">{display.network}</span>
              </div>
            )}
          </div>
        )}
      </TransactionResult>
    </>
  )
}

export function openConfidentialActivity(
  plan: ConfidentialActivityTarget,
  onViewActivity: () => void,
  display?: ConfidentialActivityDisplay
): Promise<void> {
  return openModal<void>({
    className: 'max-h-[calc(100dvh-1rem)] grid-rows-[minmax(0,1fr)_auto] gap-0 p-0',
    body: resolve => (
      <ConfidentialActivityView
        plan={plan}
        display={display}
        onDone={resolve}
        onViewActivity={onViewActivity}
        inDialog
      />
    )
  })
}
