import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { mapTransactionGraphToActivityItem, type ActivityItem } from '@/core/activity'
import { getBitcoinNetworkConfig } from '@/config/networks'
import { parseTransactionId } from '@/core/transactions/domain'
import { loadTransactions } from '@/lib/indexed-db'
import { getTransactionRecoveryAction } from '@/lib/transaction-replacement'
import { cn } from '@/lib/utils'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { getTransactionStatusToneClassName } from '@/lib/transaction-status-presentation'
import type { Network, Transaction } from '@/types'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { AccountNetworkView } from '@/popup/services/account-networks-client'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import { formatEvmWeiAsGwei } from '@/infrastructure/chains/evm'
import { openHardwareEvmSignTab } from '@/lib/hardware-tab'
import { openModal } from '@/popup/provider/ModalManager'
import { bitcoinWalletClient } from '@/popup/services/bitcoin-wallet-client'
import { formatChainTransactionExplorerUrl } from '@/popup/services/chain-explorer'
import { useSettingsStore } from '@/store/settings-store'
import { useWalletStore } from '@/store/wallet-store'
import { buildAccountKey } from '@/store/account-data-store'
import { useActivityEvmAssets } from '@/popup/hooks/useActivityEvmAssets'
import { buildActivityPresentationCatalog } from '@/popup/services/activity-presentation-catalog'
import {
  confidentialFundingClient,
  getConfidentialFundingPlanId
} from '@/popup/services/confidential-funding-client'
import {
  canRetryConfidentialSubmission,
  needsConfidentialSubmissionCheck,
  type ConfidentialFundingPlan
} from '@/core/services/confidential-funding'
import { toast } from '@/store/toast-store'
import { DetailRow } from '../common/DetailRow'
import { AmountDisplay } from '../common/AmountDisplay'
import { AccountDomainBadge } from '../account/AccountDomainBadge'
import { formatBaseUnitAmount } from '@/lib/number-format'
import { Button } from '../ui/button'
import {
  getActivityApprovalDetails,
  getActivityInteractionPresentation
} from './activity-interaction-adapters'
import { resolveActivityChainId } from './activity-chain'
import { getActivityTransactionReferences } from '@/popup/services/activity-transaction-references'
import {
  getActivityDetailTitle,
  getActivityRouteTitle,
  isDirectAccountMove,
  getClusterBatchStatusLabel,
  getClusterChildStatusLabel,
  getActivitySwapSourceMethodLabel,
  canCancelEvmActivity,
  getActivityFailureLabel,
  getActivityRecoveryAction,
  getActivityStatusPresentation,
  getActivitySwapPresentation,
  getClusterSettledDestination,
  buildActivityExecutionAddressModes,
  isLegacyPrivateShieldWithdrawDestination,
  isActivityRecoveryTransition
} from './multichain-activity-presentation'
import { ActivityTransactionBody, buildActivityTransactionView } from './ActivityTransactionBody'
import { resolveScopedZcashActivityTransaction } from '@/popup/services/zcash-activity-detail'
import { InlineError } from '../common/InlineError'
import { swapApprovalContinuationClient } from '@/popup/services/swap-approval-continuation-client'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { selectActivityObservation } from '@/popup/services/activity-observation'

interface MultichainActivityDetailProps {
  readonly item: ActivityItem
  readonly network: Network
  readonly portfolio?: PortfolioReadModel | null
  readonly accountNetworks?: readonly AccountNetworkView[]
  readonly onSpeedUp?: (transaction: Transaction) => void
  readonly onClose?: () => void
  readonly onContinueSwap?: (transactionId: string) => void
}

export function MultichainActivityDetail({
  item,
  network,
  portfolio,
  accountNetworks = [],
  onSpeedUp,
  onClose,
  onContinueSwap
}: MultichainActivityDetailProps) {
  const [observedItem, setVisibleItem] = useState(item)
  const visibleItem = selectActivityObservation(observedItem, item)
  const [retrying, setRetrying] = useState(false)
  const [retryOutcome, setRetryOutcome] = useState<'broadcast' | 'pending' | 'failed' | null>(null)
  const [privateFundingNeedsAuth, setPrivateFundingNeedsAuth] = useState(false)
  const [confidentialPlan, setConfidentialPlan] = useState<ConfidentialFundingPlan | null>(null)
  const [resumingPrivateFunding, setResumingPrivateFunding] = useState(false)
  const [checkingPrivateFunding, setCheckingPrivateFunding] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [zcashRecord, setZcashRecord] = useState<Transaction | null>(null)
  const [swapApprovalAvailable, setSwapApprovalAvailable] = useState(false)
  const { activeAccount: activeSwapAccount } = useActiveAccountNetworks()
  const endpointSettings = useSettingsStore(state => state.chainEndpointSettings)
  const {
    userAssets: userEvmAssets,
    detectedAssets: detectedEvmAssets,
    catalogTokens
  } = useActivityEvmAssets()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeSwapAccount
  })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const scopedZcashRecord =
    item.scope.keyDomainId === currentWalletId &&
    item.scope.accountId === currentAccountId &&
    currentNetwork === network &&
    zcashRecord?.id === item.id
      ? zcashRecord
      : null

  useEffect(() => {
    let cancelled = false
    setZcashRecord(null)
    if (
      item.source !== 'zcash-v1' ||
      !currentWalletId ||
      !currentAccountId ||
      item.scope.keyDomainId !== currentWalletId ||
      item.scope.accountId !== currentAccountId ||
      network !== currentNetwork
    ) {
      return
    }
    void loadTransactions(buildAccountKey(network, currentWalletId, currentAccountId))
      .then(transactions => {
        if (!cancelled) {
          setZcashRecord(
            resolveScopedZcashActivityTransaction(item, transactions, {
              walletId: currentWalletId,
              accountId: currentAccountId,
              network
            })
          )
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [currentAccountId, currentNetwork, currentWalletId, item, network])

  useEffect(() => {
    setVisibleItem(current => selectActivityObservation(current, item))
  }, [item])

  useEffect(() => {
    let cancelled = false
    setSwapApprovalAvailable(false)
    if (
      visibleItem.source !== 'wallet-v2' ||
      (visibleItem.kind !== 'contract-call' && visibleItem.kind !== 'approve') ||
      visibleItem.status === 'failed' ||
      network !== currentNetwork ||
      activeSwapAccount?.walletId !== visibleItem.scope.keyDomainId ||
      activeSwapAccount.accountId !== visibleItem.scope.accountId
    )
      return
    void swapApprovalContinuationClient
      .get(visibleItem.id)
      .then(record => {
        if (!cancelled)
          setSwapApprovalAvailable(
            Boolean(
              record &&
              record.walletId === visibleItem.scope.keyDomainId &&
              record.accountId === visibleItem.scope.accountId &&
              record.network === network
            )
          )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    visibleItem.id,
    visibleItem.kind,
    visibleItem.source,
    visibleItem.status,
    visibleItem.updatedAt,
    visibleItem.scope.keyDomainId,
    visibleItem.scope.accountId,
    network,
    currentNetwork,
    activeSwapAccount?.walletId,
    activeSwapAccount?.accountId
  ])

  useEffect(() => {
    let cancelled = false
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (!message || typeof message !== 'object' || !('type' in message)) return
      if (
        message.type !== 'TRANSACTION_ADDED' &&
        message.type !== 'TRANSACTION_UPDATED' &&
        message.type !== 'TRANSACTION_STATUS_UPDATED' &&
        message.type !== 'CROSS_CHAIN_STATUS_UPDATED'
      ) {
        return
      }

      void evmWalletClient
        .getActivity('read')
        .then(model => {
          const next = model?.items.find(
            candidate => candidate.id === item.id && candidate.source === item.source
          )
          if (
            !cancelled &&
            effectiveWalletId === item.scope.keyDomainId &&
            effectiveAccountId === item.scope.accountId &&
            currentNetwork === network &&
            model?.scope.keyDomainId === item.scope.keyDomainId &&
            model.scope.accountId === item.scope.accountId &&
            next?.scope.keyDomainId === item.scope.keyDomainId &&
            next.scope.accountId === item.scope.accountId
          ) {
            setVisibleItem(current => selectActivityObservation(current, next))
          }
        })
        .catch(() => {})
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [
    effectiveAccountId,
    currentNetwork,
    effectiveWalletId,
    item.id,
    item.scope.accountId,
    item.scope.keyDomainId,
    item.source,
    network
  ])

  const pendingEvmOrigin =
    visibleItem.source === 'wallet-v2' &&
    visibleItem.segments.some(
      segment =>
        segment.role === 'origin' &&
        segment.target.kind === 'onchain' &&
        segment.target.chainId.startsWith('eip155:') &&
        (segment.status === 'signed' ||
          segment.status === 'broadcast' ||
          segment.status === 'confirming')
    )
  const pendingConfidentialActivity =
    getConfidentialFundingPlanId(visibleItem.id) !== null &&
    visibleItem.status !== 'final' &&
    visibleItem.status !== 'failed'

  useEffect(() => {
    if (
      (!pendingEvmOrigin && !pendingConfidentialActivity) ||
      effectiveWalletId !== item.scope.keyDomainId ||
      effectiveAccountId !== item.scope.accountId ||
      currentNetwork !== network
    )
      return

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let recheckInFlight = false
    const refreshActivity = async () => {
      try {
        const model = await evmWalletClient.getActivity('read')
        const next = model?.items.find(
          candidate => candidate.id === item.id && candidate.source === item.source
        )
        if (
          active &&
          model?.scope.keyDomainId === item.scope.keyDomainId &&
          model.scope.accountId === item.scope.accountId &&
          next?.scope.keyDomainId === item.scope.keyDomainId &&
          next.scope.accountId === item.scope.accountId
        ) {
          setVisibleItem(current => selectActivityObservation(current, next))
        }
      } catch {
        // Retry while the transaction is still pending.
      } finally {
        if (active) timer = setTimeout(() => void refreshActivity(), 3_000)
      }
      if (active && pendingEvmOrigin && !recheckInFlight) {
        recheckInFlight = true
        void chrome.runtime
          .sendMessage({ type: 'RECHECK_FAST_PENDING_TRANSACTIONS', family: 'evm' })
          .catch(() => {})
          .finally(() => {
            recheckInFlight = false
          })
      }
    }
    void refreshActivity()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [
    effectiveAccountId,
    currentNetwork,
    effectiveWalletId,
    item.id,
    item.scope.accountId,
    item.scope.keyDomainId,
    item.source,
    network,
    pendingEvmOrigin,
    pendingConfidentialActivity
  ])
  const { assetMetadata, chainMetadata, evmChainIds } = useMemo(
    () =>
      buildActivityPresentationCatalog({
        network,
        endpointSettings,
        userEvmAssets,
        detectedEvmAssets,
        catalogTokens,
        portfolio
      }),
    [endpointSettings, network, portfolio, userEvmAssets, detectedEvmAssets, catalogTokens]
  )
  const executionAddressModes = useMemo(
    () => buildActivityExecutionAddressModes(accountNetworks),
    [accountNetworks]
  )
  const privateFundingPlanId = getConfidentialFundingPlanId(visibleItem.id)
  const activeConfidentialPlan =
    confidentialPlan?.transactionId === visibleItem.id &&
    confidentialPlan.network === network &&
    confidentialPlan.keyDomainId === visibleItem.scope.keyDomainId &&
    confidentialPlan.accountId === visibleItem.scope.accountId
      ? confidentialPlan
      : null
  const legacyPrivateShieldWithdrawDestination = isLegacyPrivateShieldWithdrawDestination(
    visibleItem,
    activeConfidentialPlan,
    currentNetwork === network ? activeSwapAccount : null,
    network
  )
  const swap = getActivitySwapPresentation(
    visibleItem,
    assetMetadata,
    chainMetadata,
    executionAddressModes,
    getClusterSettledDestination(visibleItem, activeConfidentialPlan),
    legacyPrivateShieldWithdrawDestination
  )
  const swapSourceMethod = getActivitySwapSourceMethodLabel(visibleItem, swap?.source?.symbol)
  const amount = visibleItem.snapshot?.primaryAmount
  const asset = amount ? assetMetadata.get(amount.assetId) : undefined
  const direction = visibleItem.snapshot?.direction
  const isShieldMove = Boolean(
    visibleItem.snapshot?.shield &&
    direction === 'self' &&
    visibleItem.snapshot.shield.operation !== 'swap'
  )
  const isMove = isShieldMove || (swap !== null && isDirectAccountMove(visibleItem, swap))
  const status = getActivityStatusPresentation(visibleItem)
  const primaryOnchainSegment = visibleItem.segments.find(
    segment => segment.target.kind === 'onchain'
  )
  const primaryChainId = asset?.asset.chainId ?? resolveActivityChainId(visibleItem)
  const senderMode = visibleItem.snapshot?.sender?.address
    ? executionAddressModes.get(visibleItem.snapshot.sender.address.toLowerCase())
    : undefined
  const recipientMode = visibleItem.snapshot?.recipient?.address
    ? executionAddressModes.get(visibleItem.snapshot.recipient.address.toLowerCase())
    : undefined
  const accountRoute =
    visibleItem.kind === 'transfer' && senderMode && recipientMode && senderMode !== recipientMode
      ? ([
          senderMode === 'Confidential' ? 'private' : 'public',
          recipientMode === 'Confidential' ? 'private' : 'public'
        ] as const)
      : null
  const interaction = getActivityInteractionPresentation(visibleItem, primaryChainId)
  const approval = getActivityApprovalDetails(visibleItem, assetMetadata)
  const title = swap
    ? getActivityRouteTitle(visibleItem, swap)
    : getActivityDetailTitle(visibleItem, interaction?.title)
  const fee = visibleItem.snapshot?.feeLimit
  const feeAsset = fee ? assetMetadata.get(fee.assetId) : undefined
  const recoveryAction = getActivityRecoveryAction(
    visibleItem,
    evmChainIds,
    getBitcoinNetworkConfig(network).chainId
  )
  const cancelAvailable = canCancelEvmActivity(visibleItem, evmChainIds)
  const isCrossChain = visibleItem.segments.length > 1
  const transactionReferences = getActivityTransactionReferences(visibleItem)
  const explorerReference = !isCrossChain ? transactionReferences[0] : undefined
  const explorerUrl = explorerReference?.chainId
    ? formatChainTransactionExplorerUrl(explorerReference.chainId, explorerReference.hash, network)
    : ''
  const needsSubmissionCheck =
    activeConfidentialPlan !== null && needsConfidentialSubmissionCheck(activeConfidentialPlan)
  const canCheckSubmission =
    needsSubmissionCheck &&
    activeConfidentialPlan.keyDomainId === effectiveWalletId &&
    activeConfidentialPlan.accountId === effectiveAccountId &&
    activeConfidentialPlan.network === currentNetwork
  const canRetrySubmission =
    activeConfidentialPlan !== null && canRetryConfidentialSubmission(activeConfidentialPlan)

  useEffect(() => {
    let cancelled = false
    let latestUpdatedAt = -Infinity
    setPrivateFundingNeedsAuth(false)
    setConfidentialPlan(null)
    if (!privateFundingPlanId) return
    const refreshPlan = () => {
      void confidentialFundingClient
        .get(privateFundingPlanId)
        .then(plan => {
          if (
            !cancelled &&
            plan.network === network &&
            plan.keyDomainId === visibleItem.scope.keyDomainId &&
            plan.accountId === visibleItem.scope.accountId &&
            plan.transactionId === visibleItem.id
          ) {
            if (plan.updatedAt >= latestUpdatedAt) {
              latestUpdatedAt = plan.updatedAt
              setPrivateFundingNeedsAuth(plan.phase === 'needs-auth')
              setConfidentialPlan(plan)
            }
          }
        })
        .catch(() => {})
    }
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'TRANSACTION_UPDATED'
      ) {
        refreshPlan()
      }
    }
    refreshPlan()
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [
    privateFundingPlanId,
    visibleItem.updatedAt,
    visibleItem.id,
    visibleItem.scope.keyDomainId,
    visibleItem.scope.accountId,
    network
  ])

  const handleRetryBroadcast = async () => {
    setRetrying(true)
    setRetryOutcome(null)
    try {
      const transactionId = parseTransactionId(visibleItem.id)
      const submission =
        recoveryAction === 'retry-bitcoin-broadcast'
          ? await bitcoinWalletClient.resumeTransfer(transactionId)
          : await evmWalletClient.resumeTransfer(transactionId)
      const nextItem = mapTransactionGraphToActivityItem(submission.graph)
      if (
        !isActivityRecoveryTransition(
          visibleItem,
          nextItem,
          evmChainIds,
          getBitcoinNetworkConfig(network).chainId
        )
      ) {
        throw new Error('Invalid Activity recovery transition')
      }
      setVisibleItem(nextItem)
      setRetryOutcome(nextItem.status === 'broadcast' ? 'broadcast' : 'pending')
    } catch {
      setRetryOutcome('failed')
    } finally {
      setRetrying(false)
    }
  }

  const handleSpeedUp = async () => {
    if (!onSpeedUp || !currentWalletId || !currentAccountId || network !== currentNetwork) return
    try {
      const transactions = await loadTransactions(
        buildAccountKey(network, currentWalletId, currentAccountId)
      )
      const current = useWalletStore.getState()
      const transaction = resolveScopedZcashActivityTransaction(visibleItem, transactions, {
        walletId: current.currentWalletId,
        accountId: current.currentAccountId,
        network: current.currentNetwork
      })
      if (getTransactionRecoveryAction(transaction ?? undefined) !== 'speed_up' || !transaction) {
        toast.error('This transaction is no longer eligible for Speed Up')
        return
      }
      onClose?.()
      onSpeedUp(transaction)
    } catch {
      toast.error('Unable to load this transaction')
    }
  }

  const handleResumePrivateFunding = async () => {
    if (!privateFundingPlanId || resumingPrivateFunding) return
    setResumingPrivateFunding(true)
    try {
      const plan = await confidentialFundingClient.get(privateFundingPlanId)
      await confidentialFundingClient.confirm(plan.planId, plan.approvalFingerprint)
      setPrivateFundingNeedsAuth(false)
      toast.success(
        plan.operation === 'cluster'
          ? 'Cluster transfer resumed'
          : plan.operation
            ? 'Shield transfer resumed'
            : 'Confidential funding resumed'
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Confidential funding could not continue'
      )
    } finally {
      setResumingPrivateFunding(false)
    }
  }

  const handleCheckPrivateFunding = async () => {
    if (!privateFundingPlanId || !canCheckSubmission || checkingPrivateFunding) return
    setCheckingPrivateFunding(true)
    try {
      const plan = await confidentialFundingClient.checkSubmission(privateFundingPlanId)
      setConfidentialPlan(plan)
      setPrivateFundingNeedsAuth(plan.phase === 'needs-auth')
      if (needsConfidentialSubmissionCheck(plan)) toast.info('No update yet. Check again later.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Transfer status is unavailable')
    } finally {
      setCheckingPrivateFunding(false)
    }
  }

  const handleCancelTransaction = async () => {
    if (!primaryChainId || cancelling) return
    setCancelling(true)
    let review: Awaited<ReturnType<typeof evmWalletClient.prepareCancel>> | null = null
    try {
      review = await evmWalletClient.prepareCancel(
        primaryChainId,
        parseTransactionId(visibleItem.id),
        visibleItem.accountMode === 'private' ? 'private' : 'main'
      )
      const summary = review.review.summary
      if (summary.schema !== 'evm.transaction.v1') {
        throw new Error('The wallet returned an invalid EVM cancellation review')
      }
      const confirmed = await openModal<boolean>({
        title: 'Cancel transaction',
        showCloseButton: false,
        body: resolve => (
          <div className="space-y-4">
            <p className="text-sm leading-5 text-muted">
              This sends a zero-value transaction to your own address with the same nonce and a
              higher fee. Cancellation is not guaranteed until the replacement confirms.
            </p>
            <div className="rounded-md border border-border/60 bg-card/60 px-3 py-2 text-xs">
              <div className="flex justify-between gap-3 py-1">
                <span className="text-muted">Nonce</span>
                <span className="font-mono">{summary.fields.nonce}</span>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <span className="text-muted">Maximum network fee</span>
                <span className="font-sans tabular-nums">
                  <AmountDisplay
                    value={formatBaseUnitAmount(
                      summary.fields.maximumFeeWei,
                      feeAsset?.metadata.decimals ?? 18
                    )}
                    profile="fee"
                  />
                </span>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <span className="text-muted">Max fee per gas</span>
                <span className="font-sans tabular-nums">
                  <AmountDisplay
                    value={formatEvmWeiAsGwei(summary.fields.maxFeePerGasWei ?? '0')}
                    symbol="GWEI"
                    profile="fee"
                  />
                </span>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <span className="text-muted">Priority fee per gas</span>
                <span className="font-sans tabular-nums">
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
                Confirm cancel
              </Button>
            </div>
          </div>
        )
      })
      if (!confirmed) {
        await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
        return
      }
      const submission = await evmWalletClient.approveTransfer(
        review.graph.root.id,
        review.review.payloadFingerprint.digestHex
      )
      review = null
      if (submission.status === 'external-signature-required') {
        await openHardwareEvmSignTab(submission.transactionId)
        window.close()
        return
      }
      setVisibleItem(mapTransactionGraphToActivityItem(submission.graph))
      toast.success('Cancellation submitted')
    } catch (error) {
      if (review) await evmWalletClient.rejectTransfer(review.graph.root.id).catch(() => {})
      toast.error(error instanceof Error ? error.message : 'Transaction could not be cancelled')
    } finally {
      setCancelling(false)
    }
  }

  const sharedView = buildActivityTransactionView({
    item: visibleItem,
    network,
    assetMetadata,
    chainMetadata,
    executionAddressModes,
    settledDestination: getClusterSettledDestination(visibleItem, activeConfidentialPlan),
    legacyPrivateShieldWithdrawDestination,
    confidentialPlan: activeConfidentialPlan,
    refunded: activeConfidentialPlan?.phase === 'refunded',
    replacementHash: scopedZcashRecord?.replacedByTxHash,
    statusLabel: needsSubmissionCheck
      ? 'Needs attention'
      : activeConfidentialPlan?.operation === 'cluster'
        ? getClusterBatchStatusLabel(activeConfidentialPlan)
        : undefined,
    statusTone: needsSubmissionCheck ? 'warning' : undefined,
    fallback:
      scopedZcashRecord?.fee &&
      (scopedZcashRecord.type !== 'receive' || Number(scopedZcashRecord.fee) > 0)
        ? { fee: { value: scopedZcashRecord.fee, symbol: 'ZEC' } }
        : undefined
  })

  return (
    <article
      data-activity-detail-id={visibleItem.id}
      className="min-w-0"
      aria-labelledby="multichain-activity-detail-title"
    >
      <h2 id="multichain-activity-detail-title" className="pr-8 text-xl font-semibold">
        {title}
      </h2>

      <ActivityTransactionBody view={sharedView} showDate />
      <div className="mb-6 space-y-4">
        {swap?.sourceAccountMode &&
          swap.destinationAccountMode &&
          swap.sourceAccountMode !== swap.destinationAccountMode && (
            <DetailRow label={isMove ? 'Move direction' : 'Account'}>
              <span className="flex items-center gap-1.5">
                {swap.sourceAccountMode === 'External' ? (
                  <span className="text-sm">External</span>
                ) : (
                  <AccountDomainBadge
                    domain={
                      swap.sourceAccountMode === 'Confidential'
                        ? 'private'
                        : swap.sourceAccountMode === 'Shield'
                          ? 'shield'
                          : 'public'
                    }
                  />
                )}
                <Icon icon="lucide:arrow-right" width={13} height={13} className="text-muted" />
                <AccountDomainBadge
                  domain={
                    swap.destinationAccountMode === 'Confidential'
                      ? 'private'
                      : swap.destinationAccountMode === 'Shield'
                        ? 'shield'
                        : 'public'
                  }
                />
              </span>
            </DetailRow>
          )}
        {!swap && primaryChainId?.startsWith('eip155:') && (
          <DetailRow label="Account">
            <span className="flex items-center gap-1.5">
              {accountRoute ? (
                <>
                  <AccountDomainBadge domain={accountRoute[0]} />
                  <Icon icon="lucide:arrow-right" width={13} height={13} className="text-muted" />
                  <AccountDomainBadge domain={accountRoute[1]} />
                </>
              ) : (
                <AccountDomainBadge
                  domain={visibleItem.accountMode === 'private' ? 'private' : 'public'}
                />
              )}
            </span>
          </DetailRow>
        )}
        {activeConfidentialPlan?.operation === 'cluster' && (
          <>
            <DetailRow label="Method">
              <span className="text-sm">Cluster</span>
            </DetailRow>
            <DetailRow label="Transfers">
              <span className="text-sm">{activeConfidentialPlan.withdraws.length}</span>
            </DetailRow>
            <div className="space-y-2 border-t border-white/10 pt-3">
              {activeConfidentialPlan.withdraws.map(row => (
                <div key={row.sequence} className="flex items-start justify-between gap-3 text-sm">
                  <span className="text-muted">Transfer {row.sequence + 1}</span>
                  <div className="min-w-0 text-right">
                    <div>{getClusterChildStatusLabel(row, activeConfidentialPlan)}</div>
                    {row.scheduledAt && Number.isSafeInteger(row.scheduledAt) && (
                      <div className="text-xs text-muted">
                        Earliest broadcast {new Date(row.scheduledAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {visibleItem.kind === 'shield' && !visibleItem.snapshot?.shield && (
          <DetailRow label="Privacy">
            <span className="flex items-center gap-1.5">
              <AccountDomainBadge domain="public" chainFamily="zcash" />
              <Icon icon="lucide:arrow-right" width={13} height={13} className="text-muted" />
              <AccountDomainBadge domain="shield" />
            </span>
          </DetailRow>
        )}
        {visibleItem.snapshot?.evm?.methodSelector &&
          (approval?.methodLabel || swapSourceMethod) && (
            <DetailRow label="Method">
              <span className="text-right text-sm" title={visibleItem.snapshot.evm.methodSelector}>
                {approval?.methodLabel ?? swapSourceMethod}
              </span>
            </DetailRow>
          )}
        {visibleItem.failureCode && (
          <DetailRow label="Reason">
            <span
              className={cn(
                'max-w-[220px] text-right text-sm',
                getTransactionStatusToneClassName(status.tone)
              )}
            >
              {getActivityFailureLabel(
                visibleItem.failureCode,
                primaryOnchainSegment?.evidence,
                visibleItem.source
              )}
            </span>
          </DetailRow>
        )}
      </div>
      {visibleItem.source === 'zcash-v1' && scopedZcashRecord?.memo && (
        <div className="mb-6 space-y-2">
          <span className="text-sm text-muted">Memo</span>
          <div className="max-h-40 overflow-y-auto rounded-md border border-border/50 bg-card/30 px-3 py-2.5">
            <p className="whitespace-pre-wrap wrap-break-word font-mono text-xs leading-5 text-foreground/80 select-text">
              {scopedZcashRecord.memo}
            </p>
          </div>
        </div>
      )}
      {explorerUrl && (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-4 flex items-center justify-center gap-1.5 border-t border-white/8 pt-4 text-sm text-primary"
        >
          View on explorer
          <Icon icon="lucide:arrow-up-right" width={15} height={15} />
        </a>
      )}
      {retryOutcome === 'broadcast' && (
        <p role="status" className="mt-4 text-center text-xs text-muted">
          Broadcast submitted. Background monitoring will continue.
        </p>
      )}
      {retryOutcome === 'pending' && recoveryAction === 'none' && (
        <p role="status" className="mt-4 text-center text-xs text-warning">
          The network has not accepted this transaction yet. You can retry the same signed
          transaction.
        </p>
      )}
      {retryOutcome === 'failed' && recoveryAction === 'none' && (
        <p role="alert" className="mt-4 text-center text-xs text-danger">
          Broadcast retry failed. Check the network and try again.
        </p>
      )}
      {recoveryAction !== 'none' && (
        <InlineError
          className="mt-4"
          message={
            retryOutcome === 'failed'
              ? 'Broadcast retry failed. Check the network and try again.'
              : retryOutcome === 'pending'
                ? 'The network has not accepted this transaction yet.'
                : 'Broadcast was interrupted.'
          }
          onRetry={handleRetryBroadcast}
          retrying={retrying}
          retryLabel="Retry broadcast"
          tone={retryOutcome === 'failed' ? 'error' : 'warning'}
        />
      )}
      {onSpeedUp && getTransactionRecoveryAction(scopedZcashRecord ?? undefined) === 'speed_up' && (
        <Button className="mt-4 h-[45px] w-full" onClick={() => void handleSpeedUp()}>
          Speed Up
        </Button>
      )}
      {cancelAvailable && (
        <Button
          variant="outline"
          className="mt-4 h-[45px] w-full"
          isLoading={cancelling}
          onClick={() => void handleCancelTransaction()}
        >
          Cancel transaction
        </Button>
      )}
      {privateFundingNeedsAuth && (
        <Button
          className="mt-4 h-[45px] w-full"
          isLoading={resumingPrivateFunding}
          onClick={handleResumePrivateFunding}
        >
          Continue
        </Button>
      )}
      {needsSubmissionCheck && (
        <InlineError
          className="mt-4"
          message={
            canCheckSubmission
              ? canRetrySubmission
                ? 'Transfer submission needs a retry.'
                : 'Submission window ended. Check the transfer status.'
              : 'Switch to this Account to check the transfer.'
          }
          onRetry={canCheckSubmission ? () => void handleCheckPrivateFunding() : undefined}
          retrying={checkingPrivateFunding}
          retryLabel={canRetrySubmission ? 'Retry submission' : 'Check status'}
          tone="warning"
        />
      )}
      {swapApprovalAvailable &&
        onContinueSwap &&
        activeSwapAccount?.walletId === visibleItem.scope.keyDomainId &&
        activeSwapAccount.accountId === visibleItem.scope.accountId && (
          <Button
            className="mt-4 h-[45px] w-full"
            onClick={() => {
              onClose?.()
              onContinueSwap(visibleItem.id)
            }}
          >
            Continue Swap
          </Button>
        )}
    </article>
  )
}
