import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'

import { Button } from '@/popup/components/ui/button'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { Skeleton } from '@/popup/components/ui/skeleton'

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

interface TransactionReviewViewProps {
  readonly title: string
  readonly titleId?: string
  readonly showTitle?: boolean
  readonly variant?: 'default' | 'figma'
  readonly asset: TransactionReviewAsset | null
  readonly amount: string
  readonly network: string
  readonly rows: readonly TransactionReviewRow[]
  readonly notice?: ReactNode
  readonly error?: ReactNode
  readonly confirmLabel: string
  readonly confirming?: boolean
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
  network,
  rows,
  notice,
  error,
  confirmLabel,
  confirming = false,
  preparing = false,
  confirmDisabled = false,
  cancelDisabled = false,
  onCancel,
  onConfirm
}: TransactionReviewViewProps) {
  const figma = variant === 'figma'
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={preparing || confirming}>
      <div
        className={
          figma
            ? 'min-h-0 flex-1 overflow-y-auto px-4 pb-4'
            : 'min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-5'
        }
      >
        {showTitle && (
          <div className={figma ? 'relative' : undefined}>
            <h2
              id={titleId}
              className={
                figma
                  ? 'flex h-14 items-center justify-center text-lg font-medium leading-[23px]'
                  : 'text-center text-base font-semibold'
              }
            >
              {title}
            </h2>
            {figma && (
              <button
                type="button"
                aria-label="Back"
                onClick={onCancel}
                disabled={cancelDisabled || confirming}
                className="absolute left-0 top-4 flex size-6 items-center justify-center disabled:opacity-50"
              >
                <Icon icon="lucide:chevron-left" width={20} height={20} />
              </button>
            )}
          </div>
        )}

        <div
          className={
            figma
              ? 'flex flex-col items-center pb-5 pt-[18px]'
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
                ? 'max-w-full min-w-0 break-all text-center text-[40px] font-semibold leading-[37.4px] tracking-[-0.015em]'
                : 'mt-3 max-w-full min-w-0 text-center text-xl font-bold leading-tight'
            }
          >
            {amount && asset ? (
              <AmountDisplay
                value={amount}
                symbol={asset.symbol}
                className={figma ? 'gap-[0.25em] font-sans normal-nums' : undefined}
              />
            ) : (
              <Skeleton className="h-7 w-36" />
            )}
          </div>
          {!figma &&
            (network ? (
              <p className="mt-1 text-xs text-muted">{network}</p>
            ) : (
              <Skeleton className="mt-2 h-3 w-20" />
            ))}
        </div>

        {notice}

        <div
          className={
            figma
              ? 'border-t border-border/60'
              : 'rounded-xl border border-border/60 bg-card/60 px-4'
          }
        >
          {rows.map((row, index) => (
            <div
              key={`${row.label}-${index}`}
              className={
                figma
                  ? 'flex min-w-0 items-start justify-between gap-4 border-b border-border/60 py-4 [&_.font-mono]:font-sans'
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

        {error}
      </div>

      <div className={figma ? 'page-footer flex gap-2.5' : 'flex gap-3 p-5 pt-3'}>
        <Button
          variant="outline"
          size={figma ? 'wallet' : 'default'}
          className="h-[45px] flex-1"
          disabled={cancelDisabled || confirming}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size={figma ? 'wallet' : 'default'}
          className="h-[45px] flex-1"
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
