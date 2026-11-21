import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { formatSortAddress } from '@/lib/format'
import { formatTokenQuantity } from '@/lib/number-format'
import type { FundingSource } from '@/types'
import nearLogo from '@/images/figma-near-confidential.svg'
import zcashShieldLogo from '@/images/figma-zcash-shield.svg'
import { TokenIcon } from '../tokens/TokenIcon'

export function ZcashMoveAccountCard({
  label,
  source,
  accountName,
  address,
  onClick,
  disabled,
  selected
}: {
  readonly label: 'From' | 'To'
  readonly source: FundingSource | 'confidential'
  readonly accountName: string
  readonly address: string
  readonly onClick?: () => void
  readonly disabled?: boolean
  readonly selected?: boolean
}) {
  const content = (
    <>
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="mt-3 flex min-w-0 items-center gap-3">
        {source !== 'transparent' ? (
          <img
            src={source === 'confidential' ? nearLogo : zcashShieldLogo}
            alt=""
            className="size-8 shrink-0 rounded"
          />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-muted">
            <Icon icon="lucide:wallet" width={19} height={19} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
            <span className="truncate" title={source === 'transparent' ? accountName : 'Shield'}>
              {source === 'transparent' ? accountName : 'Shield'}
            </span>
            {source === 'transparent' && (
              <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-muted">
                Transparent
              </span>
            )}
          </span>
          <span className="mt-1 block truncate text-base font-medium" title={address || undefined}>
            {source === 'confidential'
              ? 'NEAR Confidential'
              : source === 'shielded'
                ? 'Zcash Shield'
                : address
                  ? formatSortAddress(address)
                  : 'Address unavailable'}
          </span>
        </span>
        {selected ? (
          <Icon icon="lucide:check" width={18} className="shrink-0 text-primary" />
        ) : onClick && selected === undefined ? (
          <Icon icon="lucide:chevron-down" width={16} className="shrink-0 text-muted" />
        ) : null}
      </span>
    </>
  )
  const className =
    'block w-full min-w-0 rounded-xl border border-white/5 bg-wallet-surface px-4 py-4 text-left'
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${label}: ${source === 'transparent' ? 'Transparent' : source === 'shielded' ? 'Zcash Shield' : 'NEAR Confidential'}`}
      aria-pressed={selected}
      className={`${className} wallet-interactive enabled:hover:bg-wallet-selected disabled:opacity-50`}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

export function BalanceTransferAmount({
  amount,
  asset,
  balance,
  max
}: {
  readonly amount?: ReactNode
  readonly asset: ReactNode
  readonly balance?: string
  readonly max?: ReactNode
}) {
  return (
    <div className="flex min-h-[145px] min-w-0 shrink-0 flex-col items-center justify-center gap-2 py-3">
      {amount}
      {asset}
      {balance !== undefined && (
        <div className="flex max-w-full items-center gap-2 text-xs text-muted">
          <span className="truncate" title={balance}>
            {formatTokenQuantity(balance)}
          </span>
          {max}
        </div>
      )}
    </div>
  )
}

export function ZcashMoveLayout({
  amount,
  balance,
  max,
  source,
  destination,
  fields,
  onReverse,
  canReverse = false
}: {
  readonly amount: ReactNode
  readonly balance: string
  readonly max: ReactNode
  readonly source: ReactNode
  readonly destination: ReactNode
  readonly fields?: { readonly asset: ReactNode; readonly accounts: ReactNode }
  readonly onReverse?: () => void
  readonly canReverse?: boolean
}) {
  return (
    <>
      <BalanceTransferAmount
        amount={amount}
        balance={balance}
        max={max}
        asset={
          fields?.asset ?? (
            <span className="inline-flex h-9 items-center gap-2 rounded-full bg-wallet-surface px-2.5 text-base font-medium">
              <TokenIcon symbol="ZEC" nativeChain="zcash" blockchain="zec" size={26} />
              ZEC
            </span>
          )
        }
      />
      {fields ? (
        fields.accounts
      ) : (
        <div>
          {source}
          <div className="relative h-2.5">
            {canReverse && onReverse && (
              <button
                type="button"
                aria-label="Switch transfer direction"
                title="Switch transfer direction"
                onClick={onReverse}
                className="absolute left-1/2 top-1/2 z-10 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg border border-white/10 bg-card text-foreground transition-colors hover:bg-wallet-selected"
              >
                <Icon icon="lucide:arrow-down-up" width={18} height={18} />
              </button>
            )}
          </div>
          {destination}
        </div>
      )}
    </>
  )
}
