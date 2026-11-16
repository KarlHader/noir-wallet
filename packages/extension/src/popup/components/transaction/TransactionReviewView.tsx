import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'

import { Button } from '@/popup/components/ui/button'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { Skeleton } from '@/popup/components/ui/skeleton'
import { TransactionResult, TransactionResultDetailRow } from './TransactionResult'

export interface TransactionReviewAsset {
  readonly assetId?: string
  readonly symbol: string
  readonly icon?: string
  readonly blockchain?: string
  readonly nativeChain?: string
}

export interface TransactionReviewRow {
  readonly label: string
  readonly content: ReactNode
}

export function ReviewDownTriangle({ className }: { readonly className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" width={12} height={12} className={className}>
      <path d="M1 3h10L6 9z" fill="currentColor" />
    </svg>
  )
}

interface TransactionReviewViewProps {
  readonly title: string
  readonly titleId?: string
  readonly showTitle?: boolean
  readonly variant?: 'default' | 'figma'
  readonly asset: TransactionReviewAsset | null
  readonly amount: string
  readonly amountPrefix?: string
  readonly amountDetails?: boolean
  readonly fiatValue?: string | null
  readonly network: string
  readonly rows: readonly TransactionReviewRow[]
  readonly summary?: ReactNode
  readonly exchange?: boolean
  readonly notice?: ReactNode
  readonly afterRows?: ReactNode
  readonly error?: ReactNode
  readonly confirmLabel: string
  readonly confirmTone?: 'default' | 'warning'
  readonly confirming?: boolean
  readonly submitting?: boolean
  readonly preparing?: boolean
  readonly confirmDisabled?: boolean
  readonly cancelDisabled?: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

export function TransactionReviewView({
  title,
  titleId,
  showTitle = true,
  variant = 'default',
  asset,
  amount,
  amountPrefix = '',
  amountDetails = true,
  fiatValue,
  network,
  rows,
  summary,
  exchange = false,
  notice,
  afterRows,
  error,
  confirmLabel,
  confirmTone = 'default',
  confirming = false,
  submitting = false,
  preparing = false,
  confirmDisabled = false,
  cancelDisabled = false,
  onCancel,
  onConfirm
}: TransactionReviewViewProps) {
  const figma = variant === 'figma'
  if (submitting) {
    return (
      <TransactionResult
        status="loading"
        title="Transaction Submitting"
        layout={figma ? 'single-asset' : 'default'}
        onClose={figma ? onCancel : undefined}
        closeDisabled={cancelDisabled || confirming}
      >
        <div>
          {exchange && summary ? (
            summary
          ) : (
            <TransactionResultDetailRow label="Amount">
              <AmountDisplay value={amount} symbol={asset?.symbol} showDetails={false} />
            </TransactionResultDetailRow>
          )}
          {rows
            .filter(row =>
              ['From', 'To', 'Send from', 'Network', 'Recipient', 'Send To'].includes(row.label)
            )
            .map((row, index) => (
              <TransactionResultDetailRow key={`${row.label}-${index}`} label={row.label}>
                {row.content}
              </TransactionResultDetailRow>
            ))}
          {network && !rows.some(row => row.label === 'Network') && (
            <TransactionResultDetailRow label="Network">{network}</TransactionResultDetailRow>
          )}
        </div>
      </TransactionResult>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={preparing || confirming}>
      {showTitle && figma && (
        <div className="flex h-14 shrink-0 items-center justify-between bg-background px-5">
          <h2 id={titleId} className="min-w-0 truncate text-lg font-medium leading-[23px]">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            disabled={cancelDisabled || confirming}
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background hover:bg-accent disabled:opacity-50"
          >
            <Icon icon="lucide:x" width={22} height={22} />
          </button>
        </div>
      )}
      <div
        className={
          figma
            ? 'min-h-0 flex-1 overflow-y-auto px-5 pb-4'
            : 'min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-5'
        }
      >
        {showTitle && !figma && (
          <h2 id={titleId} className="text-center text-base font-semibold">
            {title}
          </h2>
        )}

        {summary ?? (
          <div
            className={
              figma
                ? 'flex flex-col items-start pb-14 pt-10'
                : 'flex flex-col items-center pb-4 pt-4'
            }
          >
            {!figma &&
              (asset ? (
                <TokenIcon
                  assetId={asset.assetId}
                  symbol={asset.symbol}
                  icon={asset.icon}
                  blockchain={asset.blockchain}
                  nativeChain={asset.nativeChain}
                  size="xl"
                />
              ) : (
                <Skeleton className="size-16 rounded-full" />
              ))}
            <div
              className={
                figma
                  ? 'max-w-full min-w-0 break-all text-left text-[40px] font-semibold leading-tight'
                  : 'mt-3 max-w-full min-w-0 text-center text-xl font-bold leading-tight'
              }
            >
              {amount && asset ? (
                <AmountDisplay
                  value={amount}
                  symbol={asset.symbol}
                  prefix={amountPrefix}
                  showDetails={amountDetails}
                  className={figma ? 'justify-start gap-x-1' : undefined}
                />
              ) : (
                <Skeleton className="h-7 w-36" />
              )}
            </div>
            {fiatValue && (
              <p className={figma ? 'mt-2 text-base text-muted' : 'mt-2 text-sm text-muted'}>
                {figma ? fiatValue : `≈${fiatValue}`}
              </p>
            )}
            {!figma &&
              (network ? (
                <p className="mt-1 text-xs text-muted">{network}</p>
              ) : (
                <Skeleton className="mt-2 h-3 w-20" />
              ))}
          </div>
        )}

        {notice}

        <div className={figma ? '' : 'rounded-xl border border-border/60 bg-card/60 px-4'}>
          {rows.map((row, index) => (
            <div
              key={`${row.label}-${index}`}
              className={
                figma
                  ? 'flex min-w-0 items-start justify-between gap-4 border-b border-border/60 py-4'
                  : 'flex min-w-0 items-start justify-between gap-4 py-2.5'
              }
            >
              <span
                className={
                  figma
                    ? 'shrink-0 text-sm font-medium leading-[18px] text-muted'
                    : 'shrink-0 text-xs text-muted'
                }
              >
                {row.label}
              </span>
              <div
                className={
                  figma
                    ? 'min-w-0 break-all text-right text-sm font-medium leading-[18px]'
                    : 'min-w-0 text-right text-xs font-medium'
                }
              >
                {row.content}
              </div>
            </div>
          ))}
        </div>

        {afterRows}
        {error}
      </div>

      <div className={figma ? 'page-footer flex gap-2.5' : 'flex gap-3 p-5 pt-3'}>
        <Button
          variant="outline"
          size={figma ? 'wallet' : 'default'}
          className={figma ? 'h-[45px] flex-1 border-white/10 bg-card' : 'h-[45px] flex-1'}
          disabled={cancelDisabled || confirming}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size={figma ? 'wallet' : 'default'}
          className={`${figma ? 'h-[45px] flex-[2]' : 'h-[45px] flex-1'} ${confirmTone === 'warning' ? 'bg-warning text-black hover:bg-warning/90' : ''}`}
          disabled={confirmDisabled || preparing}
          isLoading={confirming}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}

export function TransactionReviewExchangeSummary({
  source,
  destination,
  destinationLabel,
  destinationPrefix = '+',
  destinationLoading = false,
  presentation
}: {
  readonly source: { readonly asset: TransactionReviewAsset; readonly amount: string }
  readonly destination: { readonly asset: TransactionReviewAsset; readonly amount: string }
  readonly destinationLabel?: string
  readonly destinationPrefix?: string
  readonly destinationLoading?: boolean
  readonly presentation: 'single' | 'exchange'
}) {
  if (presentation === 'single') {
    return (
      <div className="flex max-w-full min-w-0 justify-start pb-14 pt-10 text-left text-[40px] font-semibold leading-tight">
        <AmountDisplay
          value={source.amount}
          symbol={source.asset.symbol}
          prefix="-"
          showDetails={false}
          className="max-w-full justify-start"
        />
      </div>
    )
  }

  return (
    <div className="space-y-3 pb-6 pt-[18px]">
      {([source, destination] as const).map((entry, index) => (
        <div key={index}>
          {index === 1 && <ReviewDownTriangle className="mb-3 ml-4 text-muted/60" />}
          <div className="flex min-w-0 items-center gap-4">
            <TokenIcon
              assetId={entry.asset.assetId}
              symbol={entry.asset.symbol}
              icon={entry.asset.icon}
              blockchain={entry.asset.blockchain}
              nativeChain={entry.asset.nativeChain}
              size={42}
            />
            <div className="min-w-0 flex-1 text-[26px] font-semibold leading-8">
              {index === 1 && destinationLabel && (
                <p className="text-xs font-normal leading-5 text-muted">{destinationLabel}</p>
              )}
              {index === 1 && destinationLoading ? (
                <div className="space-y-2 py-1" role="status" aria-label="Refreshing quote">
                  <div className="h-6 w-44 animate-pulse rounded bg-card" />
                  <div className="h-3 w-16 animate-pulse rounded bg-card" />
                </div>
              ) : (
                <AmountDisplay
                  value={entry.amount}
                  symbol={entry.asset.symbol}
                  prefix={index === 0 ? '-' : destinationPrefix}
                  showDetails={false}
                  className="max-w-full justify-start font-sans tabular-nums"
                />
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
