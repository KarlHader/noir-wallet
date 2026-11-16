import { Icon } from '@iconify/react'
import { useState, type ReactNode } from 'react'
import { getActivityAssetEffects, type ActivityItem } from '@/core/activity'
import type { Network } from '@/types'
import type { ConfidentialFundingPlan } from '@/core/services/confidential-funding'
import { formatSortAddress } from '@/lib/format'
import { formatBaseUnitAmount } from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { getTransactionStatusToneClassName } from '@/lib/transaction-status-presentation'
import {
  formatChainAddressExplorerUrl,
  formatChainTransactionExplorerUrl
} from '@/popup/services/chain-explorer'
import {
  getActivityTransactionReferences,
  isActivityTransactionHash
} from '@/popup/services/activity-transaction-references'
import type {
  ActivityAssetMetadata,
  ActivityChainMetadata
} from '@/popup/services/activity-presentation-catalog'
import { AmountDisplay } from '../common/AmountDisplay'
import { ChainIcon } from '../common/ChainIcon'
import { CopyFeedbackIcon, CopyToast, useCopyToClipboard } from '../common/CopyToast'
import { DetailRow } from '../common/DetailRow'
import { PrivateAddressWarningDialog } from '../account/PrivateAddressWarningDialog'
import { TokenIcon } from '../tokens/TokenIcon'
import { ActivityInteractionIcon } from './ActivityInteractionIcon'
import { ActivityRouteTokenIcons } from './ActivityRouteTokenIcons'
import { TransactionProgressSteps } from './TransactionProgressSteps'
import { TransactionReferenceValue } from './TransactionReferenceValue'
import {
  getActivityApprovalDetails,
  getActivityInteractionPresentation
} from './activity-interaction-adapters'
import { resolveActivityChainId } from './activity-chain'
import {
  getActivityDisplayChanges,
  getActivityProgressSteps,
  getActivityStatusPresentation,
  getActivitySwapPresentation,
  getActivityTransferRecipient,
  isDirectAccountMove,
  isOwnedAccountTransfer,
  resolveActivityChainMetadata
} from './multichain-activity-presentation'

type ActivitySwap = NonNullable<ReturnType<typeof getActivitySwapPresentation>>
type ActivityStatus = ReturnType<typeof getActivityStatusPresentation>

export interface ActivityTransactionFallback {
  readonly source?: { readonly value: string; readonly symbol: string }
  readonly destination?: { readonly value: string; readonly symbol: string }
  readonly sourceNetwork?: string
  readonly destinationNetwork?: string
  readonly fee?: { readonly value: string; readonly symbol: string; readonly label?: string }
}

export interface ActivityTransactionView {
  readonly item: ActivityItem
  readonly network: Network
  readonly swap: ActivitySwap | null
  readonly status: ActivityStatus
  readonly statusLabel: string
  readonly statusTone: ActivityStatus['tone']
  readonly amount: {
    readonly value: string
    readonly symbol: string
    readonly prefix: string
  } | null
  readonly changes: ReturnType<typeof getActivityDisplayChanges>
  readonly showChanges: boolean
  readonly primaryChainId: string | undefined
  readonly primaryNetworkName: string
  readonly primaryChainIconAlias: string | undefined
  readonly interaction: ReturnType<typeof getActivityInteractionPresentation>
  readonly displayMetadata: ActivityAssetMetadata['metadata'] | undefined
  readonly recipient: string | undefined
  readonly recipientLabel: string
  readonly approvalTokenSymbol: string | undefined
  readonly senderAddress: string | undefined
  readonly senderChainId: string | undefined
  readonly fromLabel: string | undefined
  readonly toLabel: string | undefined
  readonly fee: { readonly value: string; readonly symbol: string; readonly label: string } | null
  readonly references: ReturnType<typeof getActivityTransactionReferences>
  readonly confidentialReference: { readonly label: string; readonly value: string } | null
  readonly replacementReferences: readonly {
    readonly id: string
    readonly hash: string
    readonly chainId: string | null
  }[]
  readonly progressSteps: ReturnType<typeof getActivityProgressSteps>
  readonly isCrossChain: boolean
  readonly isIncoming: boolean
  readonly isShieldMove: boolean
  readonly isShieldSend: boolean
  readonly isMove: boolean
  readonly isRefunded: boolean
}

export function buildActivityTransactionView(input: {
  readonly item: ActivityItem
  readonly network: Network
  readonly assetMetadata: ReadonlyMap<string, ActivityAssetMetadata>
  readonly chainMetadata: ReadonlyMap<string, ActivityChainMetadata>
  readonly executionAddressModes?: ReadonlyMap<string, 'Public' | 'Confidential'>
  readonly settledDestination?: Parameters<typeof getActivitySwapPresentation>[4]
  readonly legacyPrivateShieldWithdrawDestination?: boolean
  readonly fallback?: ActivityTransactionFallback
  readonly refunded?: boolean
  readonly replacementHash?: string
  readonly statusLabel?: string
  readonly statusTone?: ActivityStatus['tone']
  readonly confidentialPlan?: ConfidentialFundingPlan | null
}): ActivityTransactionView {
  const { item, network, assetMetadata, chainMetadata, fallback } = input
  const rawSwap = getActivitySwapPresentation(
    item,
    assetMetadata,
    chainMetadata,
    input.executionAddressModes,
    input.settledDestination,
    input.legacyPrivateShieldWithdrawDestination
  )
  const sourceAmount = item.snapshot?.primaryAmount
  const destinationAmount = item.snapshot?.counterAmount
  const swap = rawSwap
    ? {
        ...rawSwap,
        ...(rawSwap.source || !fallback?.source || !sourceAmount
          ? {}
          : {
              source: {
                assetId: sourceAmount.assetId,
                symbol: fallback.source.symbol,
                exact: fallback.source.value,
                formatted: fallback.source.value
              }
            }),
        ...(rawSwap.destination || !fallback?.destination || !destinationAmount
          ? {}
          : {
              destination: {
                assetId: destinationAmount.assetId,
                symbol: fallback.destination.symbol,
                exact: fallback.destination.value,
                formatted: fallback.destination.value
              }
            }),
        sourceNetwork:
          rawSwap.sourceNetwork === 'Unknown network'
            ? (fallback?.sourceNetwork ?? rawSwap.sourceNetwork)
            : rawSwap.sourceNetwork,
        destinationNetwork:
          rawSwap.destinationNetwork === 'Unknown network'
            ? (fallback?.destinationNetwork ?? rawSwap.destinationNetwork)
            : rawSwap.destinationNetwork
      }
    : null
  const asset = sourceAmount ? assetMetadata.get(sourceAmount.assetId) : undefined
  const displayMetadata = asset?.metadata ?? sourceAmount?.metadata
  const amount =
    sourceAmount && displayMetadata
      ? {
          value: formatBaseUnitAmount(sourceAmount.amountRaw, displayMetadata.decimals),
          symbol: displayMetadata.symbol,
          prefix:
            item.failureCode === 'refunded' ||
            item.kind === 'receive' ||
            item.snapshot?.direction === 'incoming'
              ? '+'
              : item.snapshot?.direction === 'outgoing'
                ? '−'
                : ''
        }
      : fallback?.source
        ? {
            value: fallback.source.value,
            symbol: fallback.source.symbol,
            prefix: item.snapshot?.direction === 'incoming' ? '+' : '−'
          }
        : null
  const changes = getActivityDisplayChanges(item, assetMetadata)
    .filter(change => !change.isRaw)
    .slice(0, 2)
  const showChanges =
    getActivityAssetEffects(item) !== undefined &&
    !(item.kind === 'transfer' && item.snapshot?.direction === 'self')
  const primaryChainId = asset?.asset.chainId ?? resolveActivityChainId(item)
  const interaction = getActivityInteractionPresentation(item, primaryChainId)
  const chain = primaryChainId
    ? resolveActivityChainMetadata(primaryChainId, chainMetadata)
    : undefined
  const status = getActivityStatusPresentation(item)
  const direction = item.snapshot?.direction
  const isShieldMove = Boolean(
    item.snapshot?.shield && direction === 'self' && item.snapshot.shield.operation !== 'swap'
  )
  const isMove = isShieldMove || (swap !== null && isDirectAccountMove(item, swap))
  const isShieldSend = item.snapshot?.shield?.operation === 'withdraw' && direction === 'outgoing'
  const references = getActivityTransactionReferences(item)
  const confidentialPlan = input.confidentialPlan
  const confidentialIntentHash = confidentialPlan?.withdraws
    .find(row => row.intentHash?.trim())
    ?.intentHash?.trim()
  const confidentialReference =
    confidentialPlan?.operation === 'swap' &&
    confidentialPlan.sourceDomain === 'shield' &&
    confidentialPlan.destinationDomain === 'shield' &&
    confidentialPlan.transactionId === item.id &&
    confidentialPlan.network === network &&
    confidentialPlan.keyDomainId === item.scope.keyDomainId &&
    confidentialPlan.accountId === item.scope.accountId
      ? confidentialIntentHash
        ? { label: 'Intent Hash', value: confidentialIntentHash }
        : confidentialPlan.orderId?.trim()
          ? { label: 'Order ID', value: confidentialPlan.orderId.trim() }
          : null
      : null
  const replacementReferences = item.segments.flatMap(segment => {
    const hash = segment.evidence?.replacementTransactionHash
    const chainId = segment.target.kind === 'onchain' ? segment.target.chainId : null
    return hash && isActivityTransactionHash(hash, chainId)
      ? [{ id: segment.id, hash, chainId }]
      : []
  })
  const origin = item.segments.find(
    segment => segment.role === 'origin' && segment.target.kind === 'onchain'
  )
  const replacementChainId = origin?.target.kind === 'onchain' ? origin.target.chainId : null
  if (
    input.replacementHash &&
    origin &&
    replacementChainId &&
    isActivityTransactionHash(input.replacementHash, replacementChainId) &&
    !replacementReferences.some(reference => reference.hash === input.replacementHash)
  ) {
    replacementReferences.push({
      id: origin.id,
      hash: input.replacementHash,
      chainId: replacementChainId
    })
  }
  let fee: ActivityTransactionView['fee'] = null
  const feeLimit = item.snapshot?.feeLimit
  const feeMetadata = feeLimit
    ? (assetMetadata.get(feeLimit.assetId)?.metadata ?? feeLimit.metadata)
    : undefined
  if (feeLimit && feeMetadata) {
    fee = {
      value: formatBaseUnitAmount(feeLimit.amountRaw, feeMetadata.decimals),
      symbol: feeMetadata.symbol,
      label: item.snapshot?.evm ? 'Fee limit' : 'Network fee'
    }
  } else if (fallback?.fee) {
    fee = { ...fallback.fee, label: fallback.fee.label ?? 'Network fee' }
  }
  const sender = item.snapshot?.sender
  const recipient = swap?.recipientAddress ?? getActivityTransferRecipient(item)
  const approval = getActivityApprovalDetails(item, assetMetadata)
  return {
    item,
    network,
    swap,
    status,
    statusLabel: input.statusLabel ?? status.label,
    statusTone: input.statusTone ?? status.tone,
    amount,
    changes,
    showChanges,
    primaryChainId,
    primaryNetworkName:
      chain?.displayName ?? interaction?.fallbackNetworkName ?? fallback?.sourceNetwork ?? 'Wallet',
    primaryChainIconAlias: chain?.iconAlias ?? interaction?.fallbackChainIconAlias,
    interaction,
    displayMetadata,
    recipient,
    recipientLabel: interaction?.targetLabel ?? 'To',
    approvalTokenSymbol: approval?.tokenSymbol,
    senderAddress: sender?.address,
    senderChainId: sender?.chainId,
    fromLabel:
      item.snapshot?.shield?.sourceDomain === 'shield'
        ? 'NEAR Confidential'
        : item.source === 'zcash-v1' &&
            item.kind === 'transfer' &&
            direction === 'outgoing' &&
            !sender
          ? 'Shielded Pool'
          : undefined,
    toLabel:
      item.snapshot?.shield?.destinationDomain === 'shield' ? 'NEAR Confidential' : undefined,
    fee,
    references,
    confidentialReference,
    replacementReferences,
    progressSteps: getActivityProgressSteps(item, chainId =>
      chainId === 'near:mainnet'
        ? 'NEAR'
        : (resolveActivityChainMetadata(chainId, chainMetadata)?.displayName ?? 'Unknown network')
    ),
    isCrossChain: item.segments.length > 1,
    isIncoming: item.kind === 'receive' || direction === 'incoming',
    isShieldMove,
    isShieldSend,
    isMove,
    isRefunded: input.refunded === true || item.failureCode === 'refunded'
  }
}

function RouteIcon({ alias }: { readonly alias?: string }) {
  return alias ? (
    <ChainIcon chain={alias} width={18} height={18} className="size-[18px]" showTooltip={false} />
  ) : (
    <Icon icon="lucide:network" width={18} height={18} />
  )
}

export function ActivityTransactionHero({ view }: { readonly view: ActivityTransactionView }) {
  const { item, swap } = view
  if (swap) {
    return (
      <div className="flex flex-col items-center py-7 text-center" data-activity-swap-detail>
        <ActivityRouteTokenIcons route={swap} size="detail" />
        {swap.isExternalDeposit ? (
          <div className="mt-4 max-w-full">
            <p className="text-sm text-muted">
              {view.isRefunded ? 'Deposit' : swap.destinationIsSettled ? 'Received' : 'Expected'}
            </p>
            <div
              className={cn(
                'mt-1 break-all font-sans text-3xl font-bold tabular-nums',
                swap.destinationIsSettled && !view.isRefunded && 'text-primary'
              )}
            >
              {view.isRefunded ? (
                swap.source ? (
                  <AmountDisplay value={swap.source.exact} symbol={swap.source.symbol} />
                ) : (
                  '—'
                )
              ) : swap.destination ? (
                <AmountDisplay
                  value={swap.destination.exact}
                  prefix="+"
                  symbol={swap.destination.symbol}
                />
              ) : (
                '—'
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 max-w-full break-all font-sans text-3xl font-bold tabular-nums">
              {swap.source ? (
                <AmountDisplay value={swap.source.exact} prefix="−" symbol={swap.source.symbol} />
              ) : (
                '—'
              )}
            </div>
            {swap.destination && !view.isRefunded && (
              <div className="mt-1 max-w-full break-all font-sans text-sm text-muted tabular-nums">
                {view.isShieldSend
                  ? 'Recipient receives'
                  : swap.destinationIsSettled
                    ? 'Received'
                    : 'Expected'}{' '}
                <AmountDisplay
                  value={swap.destination.exact}
                  prefix={view.isShieldSend ? '' : '+'}
                  symbol={swap.destination.symbol}
                />
              </div>
            )}
          </>
        )}
      </div>
    )
  }
  const amount = item.snapshot?.primaryAmount
  return (
    <div className="flex flex-col items-center py-8 text-center">
      <div className="relative mb-4">
        {view.interaction ? (
          <ActivityInteractionIcon
            presentation={view.interaction}
            chainIconAlias={view.primaryChainIconAlias}
            size="hero"
          />
        ) : view.displayMetadata && amount ? (
          <TokenIcon
            assetId={amount.assetId}
            symbol={view.amount?.symbol ?? 'Asset'}
            icon={view.displayMetadata.iconUrl}
            size="xl"
            showBadge
            badgeType={view.isIncoming ? 'receive' : 'send'}
          />
        ) : (
          <div className="flex size-16 items-center justify-center rounded-full bg-card">
            <Icon
              icon={view.isIncoming ? 'radix-icons:arrow-bottom-left' : 'lucide:send'}
              width={26}
              height={26}
            />
          </div>
        )}
      </div>
      {view.showChanges && view.changes.length > 0 ? (
        <div className="w-full space-y-1" data-activity-asset-changes>
          {view.changes.map((change, index) => (
            <div
              key={change.assetId}
              className={cn(
                'max-w-full font-sans tabular-nums',
                index === 0 ? 'text-3xl font-bold' : 'text-sm',
                change.direction === 'incoming' && 'text-primary'
              )}
            >
              <AmountDisplay
                value={change.value}
                prefix={change.direction === 'incoming' ? '+' : '−'}
                symbol={change.symbol}
              />
            </div>
          ))}
        </div>
      ) : view.amount ? (
        <div className="max-w-full break-all font-sans text-3xl font-bold tabular-nums">
          <AmountDisplay
            value={view.amount.value}
            prefix={view.amount.prefix}
            symbol={view.amount.symbol}
          />
        </div>
      ) : view.showChanges || view.interaction ? null : (
        <p className="max-w-full break-all font-sans text-3xl font-bold">—</p>
      )}
    </div>
  )
}

export function ActivityTransactionRoute({ view }: { readonly view: ActivityTransactionView }) {
  const swap = view.swap
  if (!swap)
    return (
      <DetailRow label="Network">
        <span className="max-w-[220px] text-right text-sm">{view.primaryNetworkName}</span>
      </DetailRow>
    )
  const sameNetworkAccountTransfer =
    isOwnedAccountTransfer(swap) && swap.sourceNetwork === swap.destinationNetwork
  return sameNetworkAccountTransfer ? (
    <DetailRow label="Network">
      <span className="flex items-center justify-end gap-1.5 text-sm">
        <RouteIcon alias={swap.sourceChainIconAlias} />
        {swap.sourceNetwork}
      </span>
    </DetailRow>
  ) : (
    <DetailRow label="Route">
      <span className="flex min-w-0 max-w-[calc(100vw-110px)] items-center justify-end gap-1 whitespace-nowrap text-right text-xs">
        <RouteIcon alias={swap.sourceChainIconAlias} />
        <span className="min-w-0 truncate" title={swap.sourceNetwork}>
          {swap.sourceNetwork}
        </span>
        <Icon icon="lucide:arrow-right" width={13} height={13} className="shrink-0 text-muted" />
        <RouteIcon alias={swap.destinationChainIconAlias} />
        <span className="min-w-0 truncate" title={swap.destinationNetwork}>
          {swap.destinationNetwork}
        </span>
      </span>
    </DetailRow>
  )
}

export function ActivityTransactionStatus({ view }: { readonly view: ActivityTransactionView }) {
  return (
    <DetailRow label="Status">
      <span
        data-activity-status-value
        className={cn('text-sm', getTransactionStatusToneClassName(view.statusTone))}
      >
        {view.statusLabel}
      </span>
    </DetailRow>
  )
}

function AddressValue({
  address,
  url,
  copyKey,
  onCopy,
  copied
}: {
  readonly address: string
  readonly url: string
  readonly copyKey: string
  readonly onCopy: () => void
  readonly copied: boolean
}) {
  return (
    <span className="flex min-w-0 max-w-[220px] items-center gap-1.5">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={address}
          className="min-w-0 truncate font-mono text-sm text-primary hover:underline"
        >
          {formatSortAddress(address)}
        </a>
      ) : (
        <span className="min-w-0 truncate font-mono text-sm" title={address}>
          {formatSortAddress(address)}
        </span>
      )}
      <button
        type="button"
        aria-label={`Copy ${copyKey} address`}
        title={`Copy ${copyKey} address`}
        className="shrink-0 text-muted hover:text-foreground"
        onClick={onCopy}
      >
        <CopyFeedbackIcon copied={copied} width={14} height={14} />
      </button>
    </span>
  )
}

export function ActivityTransactionParties({ view }: { readonly view: ActivityTransactionView }) {
  const { copyToClipboard, showToast, copyFailed, isCopied } = useCopyToClipboard()
  const [privateCopyAddress, setPrivateCopyAddress] = useState<string | null>(null)
  const sender = view.senderAddress
  const recipient = view.recipient
  return (
    <>
      {view.fromLabel ? (
        <DetailRow label="From">
          <span className="text-sm">{view.fromLabel}</span>
        </DetailRow>
      ) : sender && (view.item.kind !== 'shield' || view.item.snapshot?.shield) ? (
        <DetailRow label="From">
          <AddressValue
            address={sender}
            url={
              view.senderChainId
                ? formatChainAddressExplorerUrl(view.senderChainId, sender, view.network)
                : ''
            }
            copyKey="sender"
            onCopy={() => void copyToClipboard(sender, 'sender')}
            copied={isCopied('sender')}
          />
        </DetailRow>
      ) : null}
      {view.toLabel ? (
        <DetailRow label="To">
          <span className="text-sm">{view.toLabel}</span>
        </DetailRow>
      ) : recipient && (view.item.kind !== 'shield' || view.swap) ? (
        <DetailRow label={view.recipientLabel}>
          <span className="inline-flex min-w-0 max-w-[220px] items-center gap-2">
            {view.approvalTokenSymbol && (
              <span className="shrink-0 text-sm">{view.approvalTokenSymbol}</span>
            )}
            <AddressValue
              address={recipient}
              url=""
              copyKey="recipient"
              onCopy={() =>
                view.swap?.destinationAccountMode === 'Confidential'
                  ? setPrivateCopyAddress(recipient)
                  : void copyToClipboard(recipient, 'recipient')
              }
              copied={isCopied('recipient')}
            />
          </span>
        </DetailRow>
      ) : null}
      <CopyToast show={showToast} error={copyFailed} message="Address copied" />
      <PrivateAddressWarningDialog
        address={privateCopyAddress}
        onClose={() => setPrivateCopyAddress(null)}
        onConfirm={() => {
          if (!privateCopyAddress) return
          void copyToClipboard(privateCopyAddress, 'recipient', { toastOnSuccess: true }).then(
            copied => {
              if (copied) setPrivateCopyAddress(null)
            }
          )
        }}
      />
    </>
  )
}

export function ActivityTransactionFee({ view }: { readonly view: ActivityTransactionView }) {
  return view.fee ? (
    <DetailRow label={view.fee.label}>
      <AmountDisplay
        value={view.fee.value}
        symbol={view.fee.symbol}
        profile="fee"
        className="text-sm"
      />
    </DetailRow>
  ) : null
}

export function ActivityTransactionReferences({
  view
}: {
  readonly view: ActivityTransactionView
}) {
  const { copyToClipboard, showToast, copyFailed, isCopied } = useCopyToClipboard()
  const confidentialReference = view.confidentialReference
  if (view.isCrossChain && !confidentialReference) return null
  return (
    <>
      {!view.isCrossChain &&
        view.references.map(reference => (
          <DetailRow key={reference.id} label={reference.label}>
            <TransactionReferenceValue
              hash={reference.hash}
              url={
                reference.chainId
                  ? formatChainTransactionExplorerUrl(
                      reference.chainId,
                      reference.hash,
                      view.network
                    )
                  : ''
              }
            />
          </DetailRow>
        ))}
      {!view.isCrossChain &&
        view.replacementReferences.map(reference => (
          <DetailRow key={`${reference.id}:replacement`} label="Replacement Hash">
            <TransactionReferenceValue
              hash={reference.hash}
              url={
                reference.chainId
                  ? formatChainTransactionExplorerUrl(
                      reference.chainId,
                      reference.hash,
                      view.network
                    )
                  : ''
              }
            />
          </DetailRow>
        ))}
      {confidentialReference && (
        <DetailRow label={confidentialReference.label}>
          <span className="flex min-w-0 max-w-[220px] items-center gap-1.5">
            <span
              className="min-w-0 truncate font-mono text-sm"
              title={confidentialReference.value}
            >
              {confidentialReference.value}
            </span>
            <button
              type="button"
              aria-label={`Copy ${confidentialReference.label}`}
              title={`Copy ${confidentialReference.label}`}
              className="shrink-0 text-muted hover:text-foreground"
              onClick={() =>
                void copyToClipboard(confidentialReference.value, 'confidential-reference', {
                  toastOnSuccess: true
                })
              }
            >
              <CopyFeedbackIcon
                copied={isCopied('confidential-reference')}
                width={14}
                height={14}
              />
            </button>
          </span>
        </DetailRow>
      )}
      <CopyToast show={showToast} error={copyFailed} message="Reference copied" />
    </>
  )
}

export function ActivityTransactionProgress({ view }: { readonly view: ActivityTransactionView }) {
  if (!view.isCrossChain) return null
  const referenceByStepId = new Map<string, ReactNode>()
  for (const segment of view.item.segments) {
    const reference = view.references.find(candidate => candidate.id === segment.id)
    const replacement = view.replacementReferences.find(candidate => candidate.id === segment.id)
    if (!reference && !replacement) continue
    referenceByStepId.set(
      segment.id,
      <div className="space-y-1">
        {reference && (
          <TransactionReferenceValue
            hash={reference.hash}
            url={
              reference.chainId
                ? formatChainTransactionExplorerUrl(reference.chainId, reference.hash, view.network)
                : ''
            }
            compact
          />
        )}
        {replacement && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-muted">Replacement</span>
            <TransactionReferenceValue
              hash={replacement.hash}
              url={
                replacement.chainId
                  ? formatChainTransactionExplorerUrl(
                      replacement.chainId,
                      replacement.hash,
                      view.network
                    )
                  : ''
              }
              compact
            />
          </div>
        )}
      </div>
    )
  }
  return (
    <TransactionProgressSteps
      steps={view.progressSteps}
      referenceByStepId={referenceByStepId}
      className="mt-5"
    />
  )
}

export function ActivityTransactionBody({
  view,
  showDate = false
}: {
  readonly view: ActivityTransactionView
  readonly showDate?: boolean
}) {
  return (
    <>
      <ActivityTransactionHero view={view} />
      <div className="mb-6 space-y-4">
        <ActivityTransactionRoute view={view} />
        {showDate && (
          <DetailRow label="Date">
            <span className="max-w-[220px] text-right text-sm">
              {new Date(view.item.createdAt).toLocaleString()}
            </span>
          </DetailRow>
        )}
        {!view.isShieldMove && <ActivityTransactionStatus view={view} />}
        <ActivityTransactionParties view={view} />
        <ActivityTransactionFee view={view} />
        {view.isShieldMove && <ActivityTransactionStatus view={view} />}
        <ActivityTransactionReferences view={view} />
      </div>
      <ActivityTransactionProgress view={view} />
    </>
  )
}
