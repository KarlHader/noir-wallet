import { Icon } from '@iconify/react'
import { getActivityAssetEffects, type ActivityItem } from '@/core/activity'
import { cn } from '@/lib/utils'
import { formatSortAddress } from '@/lib/format'
import { getTransactionStatusToneClassName } from '@/lib/transaction-status-presentation'
import { TokenIcon } from '../tokens/TokenIcon'
import { ChainIcon } from '../common/ChainIcon'
import {
  getActivityRowTextPresentation,
  getActivityAccountRouteLabel,
  getActivityRouteTitle,
  getActivityStatusPresentation,
  getActivitySwapPresentation,
  getActivityDisplayChanges,
  isOwnedAccountTransfer,
  resolveActivityDisplayAmount,
  type ActivityDisplayAmount,
  type ActivitySwapPresentation
} from './multichain-activity-presentation'
import {
  getActivityInteractionPresentation,
  type ActivityInteractionPresentation
} from './activity-interaction-adapters'
import { ActivityInteractionIcon } from './ActivityInteractionIcon'
import type {
  ActivityAssetMetadata,
  ActivityChainMetadata
} from '@/popup/services/activity-presentation-catalog'
import { ExecutionAccountBadge } from '../account/ExecutionAccountSelector'
import { ActivityRouteTokenIcons } from './ActivityRouteTokenIcons'

interface MultichainActivityRowProps {
  readonly item: ActivityItem
  readonly assetMetadata: ReadonlyMap<string, ActivityAssetMetadata>
  readonly chainMetadata: ReadonlyMap<string, ActivityChainMetadata>
  readonly networkName: string
  readonly chainIconAlias?: string
  readonly chainId?: string
  readonly executionAddressModes?: ReadonlyMap<string, 'Public' | 'Confidential'>
  readonly onClick?: (item: ActivityItem) => void
}

function ChainBadge({ alias }: { readonly alias?: string }) {
  if (!alias) return null
  return (
    <ChainIcon
      chain={alias}
      width={16}
      height={16}
      className="absolute -bottom-0.5 -right-0.5 size-4 rounded-[5px] bg-background ring-2 ring-background"
      showTooltip={false}
      alt=""
      aria-hidden="true"
      data-activity-chain-badge
    />
  )
}

function ActivityAvatar({
  primary,
  chainIconAlias,
  interaction
}: {
  readonly primary?: ActivityDisplayAmount
  readonly chainIconAlias?: string
  readonly interaction: ActivityInteractionPresentation | null
}) {
  if (interaction) {
    return <ActivityInteractionIcon presentation={interaction} chainIconAlias={chainIconAlias} />
  }

  if (primary) {
    return (
      <div className="relative size-9 shrink-0" data-activity-avatar="token">
        <TokenIcon
          assetId={primary.assetId}
          symbol={primary.symbol}
          icon={primary.iconUrl}
          size={36}
        />
        <ChainBadge alias={chainIconAlias} />
      </div>
    )
  }

  return (
    <div className="relative size-9 shrink-0" data-activity-avatar="generic">
      <div className="flex size-9 items-center justify-center rounded-full bg-foreground/8 text-foreground">
        <Icon icon="lucide:wallet-cards" width={18} height={18} />
      </div>
      <ChainBadge alias={chainIconAlias} />
    </div>
  )
}

function signedAmount(item: ActivityItem, amount: ActivityDisplayAmount): string {
  const direction = item.snapshot?.direction
  const sign =
    item.kind === 'receive' || direction === 'incoming' ? '+' : direction === 'outgoing' ? '−' : ''
  return `${sign}${amount.formatted} ${amount.symbol}`
}

function SwapActivityRow({
  item,
  presentation,
  onClick
}: {
  readonly item: ActivityItem
  readonly presentation: ActivitySwapPresentation
  readonly onClick?: (item: ActivityItem) => void
}) {
  const status = getActivityStatusPresentation(item)
  const sourceSymbol = presentation.source?.symbol ?? 'Asset'
  const destinationSymbol = presentation.destination?.symbol ?? 'Asset'
  const action = getActivityRouteTitle(item, presentation)
  const route = `${presentation.sourceNetwork} → ${presentation.destinationNetwork}`
  const accountRoute =
    presentation.isExternalDeposit || isOwnedAccountTransfer(presentation)
      ? getActivityAccountRouteLabel(presentation)
      : null
  const showStatus = item.status !== 'final'

  return (
    <button
      type="button"
      data-activity-id={item.id}
      data-activity-status={item.status}
      data-activity-account-mode={item.accountMode}
      data-activity-kind={item.kind}
      aria-label={
        presentation.isExternalDeposit
          ? `View ${action} ${destinationSymbol} details from External to Shield`
          : `View ${action} ${sourceSymbol} to ${destinationSymbol} details from ${presentation.sourceNetwork} to ${presentation.destinationNetwork}`
      }
      onClick={() => onClick?.(item)}
      className="wallet-interactive grid min-h-[72px] w-full min-w-0 grid-cols-[36px_minmax(0,1fr)_minmax(0,45%)] items-center gap-3 px-4 py-3 text-left enabled:hover:bg-foreground/6 enabled:active:bg-foreground/10 focus-visible:bg-foreground/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none"
      disabled={!onClick}
    >
      <ActivityRouteTokenIcons route={presentation} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="min-w-0 truncate text-sm font-medium">
            {presentation.isExternalDeposit
              ? `${action} ${destinationSymbol}`
              : action === 'Account Transfer'
                ? action
                : `${action} ${sourceSymbol} → ${destinationSymbol}`}
          </p>
          {item.accountMode === 'private' && <ExecutionAccountBadge mode="private" iconOnly />}
        </div>
        <p className="truncate text-xs text-muted" title={accountRoute ?? route}>
          {accountRoute ?? route}
        </p>
        {accountRoute &&
          !presentation.isExternalDeposit &&
          presentation.sourceNetwork !== presentation.destinationNetwork && (
            <p className="truncate text-[11px] text-muted" title={route}>
              {route}
            </p>
          )}
      </div>
      <div className="min-w-0 justify-self-end text-right">
        {presentation.isExternalDeposit ? (
          <p
            className={cn(
              'break-all font-sans text-sm font-medium tabular-nums',
              presentation.destinationIsSettled && 'text-primary'
            )}
          >
            {presentation.destination
              ? `${presentation.destinationIsSettled ? '+' : 'Expected +'}${presentation.destination.formatted} ${destinationSymbol}`
              : '—'}
          </p>
        ) : (
          <>
            <p className="break-all font-sans text-sm font-medium tabular-nums">
              {presentation.source ? `−${presentation.source.formatted} ${sourceSymbol}` : '—'}
            </p>
            {presentation.destination && (
              <p className="break-all font-sans text-[11px] text-muted tabular-nums">
                {presentation.destinationIsSettled ? 'Received' : 'Expected'} +
                {presentation.destination.formatted} {destinationSymbol}
              </p>
            )}
          </>
        )}
        {showStatus && (
          <p className={cn('text-[11px]', getTransactionStatusToneClassName(status.tone))}>
            {status.label}
          </p>
        )}
      </div>
    </button>
  )
}

export function MultichainActivityRow({
  item,
  assetMetadata,
  chainMetadata,
  networkName,
  chainIconAlias,
  chainId,
  executionAddressModes,
  onClick
}: MultichainActivityRowProps) {
  const changes = getActivityDisplayChanges(item, assetMetadata)
  const observed =
    getActivityAssetEffects(item) !== undefined &&
    !(item.kind === 'transfer' && item.snapshot?.direction === 'self')
  const summaryChange = changes.find(change => !change.isRaw)
  const primary =
    (observed ? summaryChange : undefined) ??
    resolveActivityDisplayAmount(item.snapshot?.primaryAmount, assetMetadata)
  const counter = resolveActivityDisplayAmount(item.snapshot?.counterAmount, assetMetadata)
  const swap = getActivitySwapPresentation(
    item,
    assetMetadata,
    chainMetadata,
    executionAddressModes
  )
  if (swap) return <SwapActivityRow item={item} presentation={swap} onClick={onClick} />
  const status = getActivityStatusPresentation(item)
  const interaction = getActivityInteractionPresentation(item, chainId)
  const resolvedNetworkName =
    interaction && networkName === 'Wallet' ? interaction.fallbackNetworkName : networkName
  const text = getActivityRowTextPresentation(
    item,
    primary?.symbol,
    counter?.symbol,
    resolvedNetworkName,
    chainId
  )
  const showStatus = item.status !== 'final'
  const isCancelled = item.status === 'failed' && item.failureCode === 'user-rejected'
  const isIncoming = item.kind === 'receive' || item.snapshot?.direction === 'incoming'
  const accessibleTitle =
    item.kind === 'contract-call' && interaction?.family === 'evm' ? 'Contract call' : text.title
  const showChanges = observed && summaryChange !== undefined
  const subtitle =
    interaction?.family === 'evm' && interaction.targetAddress
      ? `${resolvedNetworkName} · ${formatSortAddress(interaction.targetAddress)}`
      : text.subtitle

  return (
    <button
      type="button"
      data-activity-id={item.id}
      data-activity-status={item.status}
      data-activity-account-mode={item.accountMode}
      aria-label={`View ${accessibleTitle} details on ${resolvedNetworkName}`}
      onClick={() => onClick?.(item)}
      className={cn(
        'wallet-interactive grid min-h-[72px] w-full min-w-0 grid-cols-[36px_minmax(0,1fr)_minmax(0,45%)] items-center gap-3 px-4 py-3 text-left enabled:hover:bg-foreground/6 enabled:active:bg-foreground/10 focus-visible:bg-foreground/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none',
        isCancelled && 'opacity-60'
      )}
      disabled={!onClick}
    >
      <ActivityAvatar primary={primary} chainIconAlias={chainIconAlias} interaction={interaction} />

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <p
            className={cn(
              'min-w-0 truncate text-sm font-medium',
              status.tone === 'error' && !isCancelled && 'text-danger'
            )}
          >
            {accessibleTitle}
          </p>
          {item.accountMode === 'private' && <ExecutionAccountBadge mode="private" iconOnly />}
        </div>
        <p className="truncate text-xs text-muted" title={subtitle}>
          {subtitle}
        </p>
      </div>

      <div className={cn('min-w-0 justify-self-end text-right', showChanges && 'max-w-[145px]')}>
        {showChanges && summaryChange ? (
          <div data-activity-asset-changes>
            <p
              title={`${summaryChange.direction === 'incoming' ? '+' : '−'}${summaryChange.value} ${summaryChange.symbol}`}
              className={cn(
                'flex min-w-0 flex-wrap items-baseline justify-end gap-1 font-sans text-sm font-medium tabular-nums',
                summaryChange.direction === 'incoming' && 'text-primary'
              )}
            >
              <span className="min-w-0 break-all">
                {summaryChange.direction === 'incoming' ? '+' : '−'}
                {summaryChange.formatted}
              </span>
              <span className="max-w-16 shrink-0 truncate">{summaryChange.symbol}</span>
            </p>
          </div>
        ) : primary || !observed ? (
          <p
            className={cn(
              'break-all font-sans text-sm font-medium tabular-nums',
              isIncoming && 'text-primary'
            )}
          >
            {primary ? signedAmount(item, primary) : '—'}
          </p>
        ) : null}
        {showStatus ? (
          <p
            className={cn(
              'truncate text-[11px]',
              status.tone === 'error'
                ? isCancelled
                  ? 'text-muted'
                  : 'text-danger'
                : getTransactionStatusToneClassName(status.tone)
            )}
          >
            {status.label}
          </p>
        ) : null}
      </div>
    </button>
  )
}
