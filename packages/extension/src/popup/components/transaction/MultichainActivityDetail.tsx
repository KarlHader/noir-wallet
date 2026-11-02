import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import {
  getActivityAssetEffects,
  mapTransactionGraphToActivityItem,
  type ActivityItem
} from '@/core/activity'
import { getBitcoinNetworkConfig } from '@/config/networks'
import { parseTransactionId } from '@/core/transactions/domain'
import { getZcashChainId } from '@/core/chains/registry'
import { formatSortAddress } from '@/lib/format'
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
import { useUserEvmAssets } from '@/popup/hooks/useUserEvmAssets'
import {
  buildActivityPresentationCatalog,
  type ActivityChainMetadata
} from '@/popup/services/activity-presentation-catalog'
import {
  confidentialFundingClient,
  getConfidentialFundingPlanId
} from '@/popup/services/confidential-funding-client'
import { toast } from '@/store/toast-store'
import { DetailRow } from '../common/DetailRow'
import { AmountDisplay } from '../common/AmountDisplay'
import { CopyToast, useCopyToClipboard } from '../common/CopyToast'
import { ChainIcon } from '../common/ChainIcon'
import { formatBaseUnitAmount } from '@/lib/number-format'
import { TokenIcon } from '../tokens/TokenIcon'
import { Button } from '../ui/button'
import { ActivityInteractionIcon } from './ActivityInteractionIcon'
import { TransactionProgressSteps } from './TransactionProgressSteps'
import {
  getActivityApprovalDetails,
  getActivityInteractionPresentation
} from './activity-interaction-adapters'
import { resolveActivityChainId } from './activity-chain'
import {
  getActivityTransactionReferences,
  isActivityTransactionHash
} from '@/popup/services/activity-transaction-references'
import {
  getActivityDetailTitle,
  getActivityRouteTitle,
  getActivityTransferRecipient,
  getActivitySwapSourceMethodLabel,
  getActivityDisplayChanges,
  canCancelEvmActivity,
  getActivityFailureLabel,
  getActivityRecoveryAction,
  getActivityProgressSteps,
  getActivityStatusPresentation,
  getActivitySwapPresentation,
  buildActivityExecutionAddressModes,
  isOwnedAccountTransfer,
  isActivityRecoveryTransition,
  resolveActivityChainMetadata
} from './multichain-activity-presentation'
import { ActivityRouteTokenIcons } from './ActivityRouteTokenIcons'
import { resolveScopedZcashActivityTransaction } from '@/popup/services/zcash-activity-detail'
import { InlineError } from '../common/InlineError'
import { swapApprovalContinuationClient } from '@/popup/services/swap-approval-continuation-client'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'

interface MultichainActivityDetailProps {
  readonly item: ActivityItem
  readonly network: Network
  readonly portfolio?: PortfolioReadModel | null
  readonly accountNetworks?: readonly AccountNetworkView[]
  readonly onSpeedUp?: (transaction: Transaction) => void
  readonly onClose?: () => void
  readonly onContinueSwap?: (transactionId: string) => void
}

function TransactionReference({
  value,
  url,
  compact = false
}: {
  readonly value: string
  readonly url: string
  readonly compact?: boolean
}) {
  const content = <span className="font-mono">{formatSortAddress(value)}</span>
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={value}
      className={cn(
        'cursor-pointer break-all text-primary hover:underline',
        compact ? 'text-xs' : 'text-sm'
      )}
    >
      {content}
    </a>
  ) : (
    <span title={value} className={cn('break-all', compact ? 'text-xs' : 'text-sm')}>
      {content}
    </span>
  )
}

function chainDisplayName(
  chainId: string,
  metadata: ReadonlyMap<string, ActivityChainMetadata>
): string {
  if (chainId === 'near:mainnet') return 'NEAR'
  return resolveActivityChainMetadata(chainId, metadata)?.displayName ?? 'Unknown network'
}

function SwapChainIcon({ alias }: { readonly alias?: string }) {
  return alias ? (
    <ChainIcon chain={alias} width={18} height={18} className="size-[18px]" showTooltip={false} />
  ) : (
    <div className="flex size-[18px] items-center justify-center rounded-full bg-foreground/8">
      <Icon icon="lucide:network" width={13} height={13} />
    </div>
  )
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
  const [visibleItem, setVisibleItem] = useState(item)
  const [retrying, setRetrying] = useState(false)
  const [retryOutcome, setRetryOutcome] = useState<'broadcast' | 'pending' | 'failed' | null>(null)
  const [privateFundingNeedsAuth, setPrivateFundingNeedsAuth] = useState(false)
  const [resumingPrivateFunding, setResumingPrivateFunding] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [zcashRecord, setZcashRecord] = useState<Transaction | null>(null)
  const [swapApprovalAvailable, setSwapApprovalAvailable] = useState(false)
  const { activeAccount: activeSwapAccount } = useActiveAccountNetworks()
  const { copyToClipboard, showToast } = useCopyToClipboard()
  const endpointSettings = useSettingsStore(state => state.chainEndpointSettings)
  const userEvmAssets = useUserEvmAssets()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
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
    setVisibleItem(current => (item.updatedAt >= current.updatedAt ? item : current))
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
          if (!cancelled && next && next.scope.accountId === item.scope.accountId) {
            setVisibleItem(current => (next.updatedAt >= current.updatedAt ? next : current))
          }
        })
        .catch(() => {})
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [item.id, item.scope.accountId, item.source])
  const { assetMetadata, chainMetadata, evmChainIds } = useMemo(
    () => buildActivityPresentationCatalog({ network, endpointSettings, userEvmAssets, portfolio }),
    [endpointSettings, network, portfolio, userEvmAssets]
  )
  const executionAddressModes = useMemo(
    () => buildActivityExecutionAddressModes(accountNetworks),
    [accountNetworks]
  )
  const swap = getActivitySwapPresentation(
    visibleItem,
    assetMetadata,
    chainMetadata,
    executionAddressModes
  )
  const transferRecipient = getActivityTransferRecipient(visibleItem)
  const swapSourceMethod = getActivitySwapSourceMethodLabel(visibleItem, swap?.source?.symbol)
  const assetEffects =
    visibleItem.kind === 'transfer' && visibleItem.snapshot?.direction === 'self'
      ? undefined
      : getActivityAssetEffects(visibleItem)
  const assetChanges = getActivityDisplayChanges(visibleItem, assetMetadata)
  const displayedChanges = assetChanges.filter(change => !change.isRaw).slice(0, 2)

  const amount = visibleItem.snapshot?.primaryAmount
  const asset = amount ? assetMetadata.get(amount.assetId) : undefined
  const displayMetadata = asset?.metadata ?? amount?.metadata
  const symbol = displayMetadata?.symbol ?? 'Asset'
  const formattedAmount =
    amount && displayMetadata
      ? formatBaseUnitAmount(amount.amountRaw, displayMetadata.decimals)
      : null
  const swapSourceAmount = visibleItem.snapshot?.primaryAmount
  const swapDestinationAmount = visibleItem.snapshot?.counterAmount
  const swapSourceDecimals = swapSourceAmount
    ? (assetMetadata.get(swapSourceAmount.assetId)?.metadata ?? swapSourceAmount.metadata)?.decimals
    : undefined
  const swapDestinationDecimals = swapDestinationAmount
    ? (assetMetadata.get(swapDestinationAmount.assetId)?.metadata ?? swapDestinationAmount.metadata)
        ?.decimals
    : undefined
  const direction = visibleItem.snapshot?.direction
  const isIncoming = visibleItem.kind === 'receive' || direction === 'incoming'
  const sign = isIncoming ? '+' : direction === 'outgoing' ? '−' : ''
  const displayedSign = visibleItem.failureCode === 'refunded' ? '+' : sign
  const status = getActivityStatusPresentation(visibleItem)
  const primaryOnchainSegment = visibleItem.segments.find(
    segment => segment.target.kind === 'onchain'
  )
  const primaryChainId = asset?.asset.chainId ?? resolveActivityChainId(visibleItem)
  const interaction = getActivityInteractionPresentation(visibleItem, primaryChainId)
  const approval = getActivityApprovalDetails(visibleItem, assetMetadata)
  const title = swap
    ? getActivityRouteTitle(visibleItem, swap)
    : getActivityDetailTitle(visibleItem, interaction?.title)
  const sameNetworkAccountTransfer =
    swap && isOwnedAccountTransfer(swap) && swap.sourceNetwork === swap.destinationNetwork
  const primaryNetworkName = primaryChainId
    ? (resolveActivityChainMetadata(primaryChainId, chainMetadata)?.displayName ??
      interaction?.fallbackNetworkName ??
      'Unknown network')
    : 'Wallet'
  const primaryChainIconAlias = primaryChainId
    ? (resolveActivityChainMetadata(primaryChainId, chainMetadata)?.iconAlias ??
      interaction?.fallbackChainIconAlias)
    : interaction?.fallbackChainIconAlias
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
  const usesShieldedPoolSource =
    visibleItem.source === 'zcash-v1' &&
    visibleItem.kind === 'transfer' &&
    direction === 'outgoing' &&
    visibleItem.snapshot?.sender === undefined
  const privateFundingPlanId = getConfidentialFundingPlanId(visibleItem.id)

  useEffect(() => {
    let cancelled = false
    setPrivateFundingNeedsAuth(false)
    if (!privateFundingPlanId) return
    void confidentialFundingClient
      .get(privateFundingPlanId)
      .then(plan => {
        if (!cancelled) setPrivateFundingNeedsAuth(plan.phase === 'needs-auth')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [privateFundingPlanId, visibleItem.updatedAt])

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
      toast.success('Confidential funding resumed')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Confidential funding could not continue'
      )
    } finally {
      setResumingPrivateFunding(false)
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
                <span className="font-mono">
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
                <span className="font-mono">
                  <AmountDisplay
                    value={formatEvmWeiAsGwei(summary.fields.maxFeePerGasWei ?? '0')}
                    symbol="GWEI"
                    profile="fee"
                  />
                </span>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <span className="text-muted">Priority fee per gas</span>
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

  const progressReferences = new Map<string, ReactNode>()
  if (isCrossChain) {
    for (const segment of visibleItem.segments) {
      const reference = transactionReferences.find(candidate => candidate.id === segment.id)
      const unverifiedReplacementHash = segment.evidence?.replacementTransactionHash
      const chainId = segment.target.kind === 'onchain' ? segment.target.chainId : null
      const replacementHash =
        unverifiedReplacementHash && isActivityTransactionHash(unverifiedReplacementHash, chainId)
          ? unverifiedReplacementHash
          : undefined
      if (!reference && !replacementHash) continue
      progressReferences.set(
        segment.id,
        <div className="space-y-1">
          {reference && (
            <TransactionReference
              value={reference.hash}
              url={
                reference.chainId
                  ? formatChainTransactionExplorerUrl(reference.chainId, reference.hash, network)
                  : ''
              }
              compact
            />
          )}
          {replacementHash && (
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-muted">Replacement</span>
              <TransactionReference
                value={replacementHash}
                url={
                  chainId
                    ? formatChainTransactionExplorerUrl(chainId, replacementHash, network)
                    : ''
                }
                compact
              />
            </div>
          )}
        </div>
      )
    }
  }

  return (
    <article
      data-activity-detail-id={visibleItem.id}
      className="min-w-0"
      aria-labelledby="multichain-activity-detail-title"
    >
      <h2 id="multichain-activity-detail-title" className="pr-8 text-xl font-semibold">
        {title}
      </h2>

      {swap ? (
        <div className="flex flex-col items-center py-7 text-center" data-activity-swap-detail>
          <ActivityRouteTokenIcons route={swap} size="detail" />
          <div className="mt-4 max-w-full break-all font-mono text-3xl font-bold">
            {swap.source && swapSourceAmount && swapSourceDecimals !== undefined ? (
              <AmountDisplay
                value={formatBaseUnitAmount(swapSourceAmount.amountRaw, swapSourceDecimals)}
                prefix="−"
                symbol={swap.source.symbol}
              />
            ) : (
              '—'
            )}
          </div>
          {swap.destination && (
            <div className="mt-1 max-w-full break-all font-mono text-sm text-muted">
              Expected{' '}
              {swapDestinationAmount && swapDestinationDecimals !== undefined ? (
                <AmountDisplay
                  value={formatBaseUnitAmount(
                    swapDestinationAmount.amountRaw,
                    swapDestinationDecimals
                  )}
                  prefix="+"
                  symbol={swap.destination.symbol}
                />
              ) : (
                '—'
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center py-8 text-center">
          <div className="relative mb-4">
            {interaction ? (
              <ActivityInteractionIcon
                presentation={interaction}
                chainIconAlias={primaryChainIconAlias}
                size="hero"
              />
            ) : displayMetadata && amount ? (
              <TokenIcon
                assetId={amount.assetId}
                symbol={symbol}
                icon={displayMetadata.iconUrl}
                size="xl"
                showBadge
                badgeType={isIncoming ? 'receive' : 'send'}
              />
            ) : (
              <div className="flex size-16 items-center justify-center rounded-full bg-card">
                <Icon
                  icon={direction === 'incoming' ? 'radix-icons:arrow-bottom-left' : 'lucide:send'}
                  width={26}
                  height={26}
                />
              </div>
            )}
          </div>
          {assetEffects && displayedChanges.length > 0 ? (
            <div className="w-full space-y-1" data-activity-asset-changes>
              {displayedChanges.map((change, index) => (
                <div
                  key={change.assetId}
                  className={cn(
                    'max-w-full font-mono',
                    index === 0 ? 'text-3xl font-bold' : 'text-sm',
                    change.direction === 'incoming' && 'text-primary'
                  )}
                >
                  <AmountDisplay
                    value={change.value}
                    prefix={change.direction === 'incoming' ? '+' : '−'}
                    symbol={change.symbol}
                    className="[&>span:first-child]:truncate [&>span:last-child]:max-w-24 [&>span:last-child]:truncate"
                  />
                </div>
              ))}
            </div>
          ) : formattedAmount !== null ? (
            <div className="max-w-full break-all font-mono text-3xl font-bold">
              <AmountDisplay value={formattedAmount} prefix={displayedSign} symbol={symbol} />
            </div>
          ) : assetEffects || interaction ? null : (
            <p className="max-w-full break-all font-mono text-3xl font-bold">—</p>
          )}
        </div>
      )}

      <div className="mb-6 space-y-4">
        {swap ? (
          <>
            {sameNetworkAccountTransfer ? (
              <DetailRow label="Network">
                <span className="flex items-center justify-end gap-1.5 text-sm">
                  <SwapChainIcon alias={swap.sourceChainIconAlias} />
                  {swap.sourceNetwork}
                </span>
              </DetailRow>
            ) : (
              <DetailRow label="Route">
                <span className="flex max-w-[245px] min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-right text-sm">
                  <SwapChainIcon alias={swap.sourceChainIconAlias} />
                  <span>{swap.sourceNetwork}</span>
                  <Icon icon="lucide:arrow-right" width={13} height={13} className="text-muted" />
                  <SwapChainIcon alias={swap.destinationChainIconAlias} />
                  <span>{swap.destinationNetwork}</span>
                </span>
              </DetailRow>
            )}
            {swap.sourceAccountMode &&
              swap.destinationAccountMode &&
              swap.sourceAccountMode !== swap.destinationAccountMode && (
                <DetailRow label="Account">
                  <span className="text-sm">
                    {swap.sourceAccountMode} → {swap.destinationAccountMode}
                  </span>
                </DetailRow>
              )}
          </>
        ) : (
          <DetailRow label="Network">
            <span className="max-w-[220px] text-right text-sm">{primaryNetworkName}</span>
          </DetailRow>
        )}
        <DetailRow label="Date">
          <span className="max-w-[220px] text-right text-sm">
            {new Date(visibleItem.createdAt).toLocaleString()}
          </span>
        </DetailRow>
        <DetailRow label="Status">
          <span
            data-activity-status-value
            className={cn('text-sm', getTransactionStatusToneClassName(status.tone))}
          >
            {status.label}
          </span>
        </DetailRow>
        {visibleItem.kind === 'shield' && (
          <DetailRow label="Privacy">
            <span className="text-sm">Transparent → Shielded</span>
          </DetailRow>
        )}
        {visibleItem.kind !== 'shield' && visibleItem.snapshot?.sender && (
          <DetailRow label="From">
            <span
              className="max-w-[220px] truncate font-mono text-sm"
              title={visibleItem.snapshot.sender.address}
            >
              {formatSortAddress(visibleItem.snapshot.sender.address)}
            </span>
          </DetailRow>
        )}
        {usesShieldedPoolSource && (
          <DetailRow label="From">
            <span className="text-sm">Shielded Pool</span>
          </DetailRow>
        )}
        {swap?.recipientAddress ? (
          <DetailRow label="To">
            <span className="flex min-w-0 max-w-[220px] items-center gap-1.5">
              <span className="min-w-0 truncate font-mono text-sm" title={swap.recipientAddress}>
                {formatSortAddress(swap.recipientAddress)}
              </span>
              <button
                type="button"
                aria-label="Copy recipient address"
                title="Copy recipient address"
                className="shrink-0 text-muted hover:text-foreground"
                onClick={() => {
                  if (swap.recipientAddress) void copyToClipboard(swap.recipientAddress)
                }}
              >
                <Icon icon="lucide:copy" width={14} height={14} />
              </button>
            </span>
          </DetailRow>
        ) : visibleItem.kind !== 'shield' && !swap && transferRecipient ? (
          <DetailRow label={interaction?.targetLabel ?? 'To'}>
            <span className="inline-flex min-w-0 max-w-[220px] items-center gap-2">
              {approval?.tokenSymbol && (
                <span className="shrink-0 text-sm">{approval.tokenSymbol}</span>
              )}
              <span className="truncate font-mono text-sm" title={transferRecipient}>
                {formatSortAddress(transferRecipient)}
              </span>
            </span>
          </DetailRow>
        ) : null}
        {visibleItem.snapshot?.evm?.methodSelector &&
          (approval?.methodLabel || swapSourceMethod) && (
            <DetailRow label="Method">
              <span className="text-right text-sm" title={visibleItem.snapshot.evm.methodSelector}>
                {approval?.methodLabel ?? swapSourceMethod}
              </span>
            </DetailRow>
          )}
        {fee && feeAsset && (
          <DetailRow label={visibleItem.snapshot?.evm ? 'Fee limit' : 'Network fee'}>
            <AmountDisplay
              value={formatBaseUnitAmount(fee.amountRaw, feeAsset.metadata.decimals)}
              symbol={feeAsset.metadata.symbol}
              profile="fee"
              className="text-sm"
            />
          </DetailRow>
        )}
        {visibleItem.source === 'zcash-v1' && scopedZcashRecord?.fee && !fee && (
          <DetailRow label="Network fee">
            <AmountDisplay
              value={scopedZcashRecord.fee}
              symbol="ZEC"
              profile="fee"
              className="text-sm"
            />
          </DetailRow>
        )}
        {!isCrossChain &&
          transactionReferences.map(reference => (
            <DetailRow key={reference.id} label={reference.label}>
              <TransactionReference
                value={reference.hash}
                url={
                  reference.chainId
                    ? formatChainTransactionExplorerUrl(reference.chainId, reference.hash, network)
                    : ''
                }
              />
            </DetailRow>
          ))}
        {visibleItem.segments.flatMap(segment => {
          if (isCrossChain) return []
          const unverifiedReplacementHash = segment.evidence?.replacementTransactionHash
          const segmentChainId =
            segment.target.kind === 'onchain' ? segment.target.chainId : undefined
          const replacementTransactionHash =
            unverifiedReplacementHash &&
            isActivityTransactionHash(unverifiedReplacementHash, segmentChainId ?? null)
              ? unverifiedReplacementHash
              : undefined
          const replacementUrl =
            segmentChainId && replacementTransactionHash
              ? formatChainTransactionExplorerUrl(
                  segmentChainId,
                  replacementTransactionHash,
                  network
                )
              : ''

          return [
            replacementTransactionHash ? (
              <DetailRow key={`${segment.id}:replacement`} label="Replacement Hash">
                <TransactionReference value={replacementTransactionHash} url={replacementUrl} />
              </DetailRow>
            ) : null
          ]
        })}
        {visibleItem.source === 'zcash-v1' && scopedZcashRecord?.replacedByTxHash && (
          <DetailRow label="Replacement Hash">
            <TransactionReference
              value={scopedZcashRecord.replacedByTxHash}
              url={formatChainTransactionExplorerUrl(
                getZcashChainId(network),
                scopedZcashRecord.replacedByTxHash,
                network
              )}
            />
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
      <CopyToast show={showToast} message="Address copied" />

      {isCrossChain && (
        <TransactionProgressSteps
          steps={getActivityProgressSteps(visibleItem, chainId =>
            chainDisplayName(chainId, chainMetadata)
          )}
          referenceByStepId={progressReferences}
          className="mt-5"
        />
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
