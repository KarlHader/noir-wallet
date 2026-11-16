import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { DialogTitle } from '../ui/dialog'
import { TransactionResult } from './TransactionResult'
import { AmountDisplay } from '../common/AmountDisplay'
import { openModal } from '@/popup/provider/ModalManager'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import { formatSymbol } from '@/lib/format'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { buildActivityPresentationCatalog } from '@/popup/services/activity-presentation-catalog'
import { selectActivityObservation } from '@/popup/services/activity-observation'
import { ActivityTransactionBody, buildActivityTransactionView } from './ActivityTransactionBody'
import type { ActivityItem } from '@/core/activity'
import type { Network } from '@/types'

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
      setStillLoading(false)
    }
    if (!matchesAccount && !accountLoading) {
      onDone()
      return
    }
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const delayTimer = setTimeout(() => {
      if (active) setStillLoading(true)
    }, 10_000)

    const load = async () => {
      try {
        const model = await evmWalletClient.getActivity('read', 'all')
        const item = model?.items.find(candidate => candidate.id === plan.transactionId)
        if (
          active &&
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
          if (
            (next.status === 'final' &&
              next.completeness === 'complete' &&
              next.reconfirming !== true) ||
            next.status === 'failed'
          )
            return
        }
      } catch {
        // The local activity projection may lag a newly started transfer.
      }
      if (active) retryTimer = setTimeout(() => void load(), 3_000)
    }
    void load()
    return () => {
      active = false
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
  const activityView = scopedActivity
    ? buildActivityTransactionView({
        item: scopedActivity,
        network: plan.network,
        assetMetadata: catalog.assetMetadata,
        chainMetadata: catalog.chainMetadata,
        fallback: display
          ? {
              source: { value: display.amount, symbol: formatSymbol(display.symbol) },
              ...(display.receiveAmount && display.receiveSymbol
                ? {
                    destination: {
                      value: display.receiveAmount,
                      symbol: formatSymbol(display.receiveSymbol)
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
  const failed = scopedActivity?.status === 'failed'
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
        status={confirmed ? 'success' : failed ? 'failed' : 'loading'}
        title={confirmed ? 'Transaction Confirmed' : failed ? 'Transaction Failed' : progressTitle}
        footer={
          confirmed || failed ? (
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
          ) : undefined
        }
      >
        {activityView ? (
          <ActivityTransactionBody view={activityView} />
        ) : (
          <div className="divide-y divide-border/60 border-y border-border/60 text-sm">
            {display && (
              <div className="flex justify-between gap-4 py-4">
                <span className="text-muted">Amount</span>
                <span className="min-w-0 text-right font-medium">
                  <AmountDisplay
                    value={display.amount}
                    symbol={formatSymbol(display.symbol)}
                    prefix={display.operation === 'swap' ? '-' : ''}
                  />
                  {display.operation === 'swap' &&
                    display.receiveAmount &&
                    display.receiveSymbol && (
                      <span className="block">
                        <AmountDisplay
                          value={display.receiveAmount}
                          symbol={formatSymbol(display.receiveSymbol)}
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
