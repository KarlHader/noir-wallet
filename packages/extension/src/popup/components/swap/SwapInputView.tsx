import { useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import type { AddressType } from '@/types'
import type { SwapToken } from '@/core/services/intents-api'
import { formatChainName, formatSortAddress, formatSymbol } from '@/lib/format'
import { formatFeeAmount, formatFiatAmount, formatTokenQuantity } from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { ExecutionAccountBadge } from '../account/ExecutionAccountSelector'
import { TokenIcon } from '../tokens/TokenIcon'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import { BalanceHelp } from '../transaction/BalanceHelp'
import { SendRecipientInputCard } from '../transaction/SendInputCards'
import { safeBig } from '@/lib/big'
import { InlineError } from '../common/InlineError'

interface SwapInputViewProps {
  tokenIn: SwapToken | null
  tokenOut: SwapToken | null
  isZecSource: boolean
  isZecDestination: boolean
  requiresRecipientAddress: boolean
  canSwitchTokens: boolean
  switchingTokens?: boolean
  amountIn: string
  estimatedOut: string
  isEstimatedOut: boolean
  fromFiat: string
  toFiat: string
  rate: string
  addressType: AddressType
  destinationAddress?: string
  spendableBalance: string
  availableBalance?: string
  pendingBalance?: string
  recipientError?: string | null
  slippage: number
  networkFee?: string
  isQuoting: boolean
  quoteError?: string | null
  maxLoading?: boolean
  maxDisabled?: boolean
  maxDisabledReason?: string
  catalogError?: boolean
  sourceAssetsLoading?: boolean
  destinationAssetsLoading?: boolean
  canGetQuote: boolean
  hasInsufficientFunds?: boolean
  insufficientMessage?: string
  walletManagedRefundAddress?: string
  feeIsApproximate?: boolean
  sourceAddress?: string
  sourceBadge?: string
  destinationBadge?: string
  sourceAccountAction?: ReactNode
  destinationAssetLocked?: boolean
  sourceAssetLocked?: boolean
  hideSwitchAssets?: boolean
  hideReceiveAddress?: boolean
  actionLabel?: string
  actionLoading?: boolean
  onAmountInChange: (value: string) => void
  onMaxClick?: () => void
  onRecipientAddressChange: (value: string) => void
  onSelectRecipientFromWallet?: () => void
  onSelectToken: (type: 'in' | 'out') => void
  onSwitchTokens: () => void
  onRetryTokenCatalog: () => void
  onRetryQuote?: () => void
  onOpenSlippageSetting: () => void
  onGetQuote: () => void
}

interface SwapAssetCardProps {
  direction: 'From' | 'To'
  token: SwapToken | null
  amount: string
  fiatValue: string
  accountAddress?: string
  accountBadge?: string
  accountAction?: ReactNode
  accountFallbackLabel?: string
  balance?: string
  onTokenSelect: () => void
  tokenSelectDisabled?: boolean
  tokenSelectLocked?: boolean
  onAmountChange?: (value: string) => void
  onMaxClick?: () => void
  maxLoading?: boolean
  maxDisabled?: boolean
  maxDisabledReason?: string
  isReadOnly?: boolean
  isAmountLoading?: boolean
  isEstimatedAmount?: boolean
  validationMessage?: string
  balanceHelp?: boolean
  pendingBalance?: string
}

function SwapAssetCardSkeleton({ direction }: { readonly direction: 'From' | 'To' }) {
  return (
    <section
      className="min-h-[124px] rounded-xl bg-card/60 px-4 py-3.5"
      role="status"
      aria-label={`Loading ${direction.toLowerCase()} assets`}
    >
      <div className="flex h-5 items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-14 bg-white/[0.05]" />
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-2.5 w-16 bg-white/[0.05]" />
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="ml-auto h-5 w-20" />
          <Skeleton className="ml-auto h-2.5 w-12 bg-white/[0.05]" />
        </div>
      </div>
    </section>
  )
}

function ReceiveAddressSkeleton() {
  return (
    <div role="status" aria-label="Loading receive address">
      <Skeleton className="mb-2 h-3.5 w-24" />
      <div className="flex h-[46px] items-center gap-3 rounded-xl bg-card px-3">
        <Skeleton className="size-6 shrink-0 rounded-lg" />
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="ml-auto h-3 w-12 bg-white/[0.05]" />
      </div>
    </div>
  )
}

function SwapInputSkeleton() {
  return (
    <>
      <div
        className="min-h-0 flex-1 overflow-hidden px-5 pb-3 pt-4"
        role="status"
        aria-label="Loading swap assets"
      >
        <div className="relative">
          <SwapAssetCardSkeleton direction="From" />
          <Skeleton className="absolute left-1/2 top-[108px] z-10 size-9 -translate-x-1/2 rounded-full border-[3px] border-background bg-card" />
          <div className="mt-2">
            <SwapAssetCardSkeleton direction="To" />
          </div>
        </div>
        <div className="mt-5">
          <ReceiveAddressSkeleton />
        </div>
        <div className="mt-5 flex items-center justify-between py-1">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 w-24 bg-white/[0.05]" />
        </div>
      </div>
      <div className="page-footer">
        <Skeleton className="h-[45px] w-full rounded-lg" />
      </div>
    </>
  )
}

function SwapAssetCard({
  direction,
  token,
  amount,
  fiatValue,
  accountAddress,
  accountBadge,
  accountAction,
  accountFallbackLabel,
  balance,
  onTokenSelect,
  tokenSelectDisabled = false,
  tokenSelectLocked = false,
  onAmountChange,
  onMaxClick,
  maxLoading = false,
  maxDisabled = false,
  maxDisabledReason,
  isReadOnly = false,
  isAmountLoading = false,
  isEstimatedAmount = false,
  validationMessage,
  balanceHelp = false,
  pendingBalance
}: SwapAssetCardProps) {
  if (tokenSelectDisabled) return <SwapAssetCardSkeleton direction={direction} />

  const hasAccountDetails = Boolean(accountAddress || accountFallbackLabel || accountBadge)
  const longAmount = amount.length > 12

  return (
    <section className="min-h-[124px] rounded-xl bg-card/60 px-4 py-3.5">
      <div className="flex h-5 min-w-0 items-center justify-between gap-2 text-sm">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-muted">{direction}</span>
          {accountAction}
          {!accountAction && hasAccountDetails && (
            <>
              {accountAddress ? (
                <span className="truncate font-mono text-[13px]" title={accountAddress}>
                  {formatSortAddress(accountAddress)}
                </span>
              ) : accountFallbackLabel ? (
                <span className="truncate text-muted">{accountFallbackLabel}</span>
              ) : null}
              {!accountAction &&
                accountBadge &&
                (accountBadge === 'Confidential' || accountBadge === 'Public' ? (
                  <ExecutionAccountBadge
                    mode={accountBadge === 'Confidential' ? 'private' : 'main'}
                    iconOnly
                  />
                ) : (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {accountBadge}
                  </span>
                ))}
            </>
          )}
        </div>
        {balance !== undefined && (
          <div className="ml-auto flex min-w-0 max-w-[48%] shrink items-center gap-1">
            <button
              type="button"
              onClick={onMaxClick}
              disabled={!onMaxClick || maxLoading || maxDisabled}
              aria-label={
                balanceHelp
                  ? `Available balance: ${balance}`
                  : maxDisabled && maxDisabledReason
                    ? `${maxDisabledReason}. Available balance: ${balance}`
                    : `Use maximum balance: ${balance}`
              }
              title={
                maxDisabled ? maxDisabledReason : onMaxClick ? 'Use maximum balance' : 'Balance'
              }
              className="flex min-w-0 shrink items-center gap-1.5 text-[12px] text-muted transition-colors enabled:hover:text-primary disabled:cursor-default disabled:opacity-50"
            >
              <Icon
                icon={maxLoading ? 'lucide:loader-circle' : 'lucide:wallet-cards'}
                width={14}
                height={14}
                className={maxLoading ? 'shrink-0 animate-spin' : 'shrink-0'}
              />
              <span className="min-w-0 truncate text-right font-mono" title={balance}>
                {formatTokenQuantity(balance)}
              </span>
            </button>
            {balanceHelp && <BalanceHelp kind="available" />}
          </div>
        )}
      </div>

      {validationMessage && (
        <p
          id="swap-source-amount-error"
          className="mt-1 text-right text-xs text-warning"
          role="alert"
        >
          {validationMessage}
        </p>
      )}

      <div
        className={cn(
          longAmount
            ? 'flex flex-col items-stretch gap-2'
            : 'flex items-center justify-between gap-3',
          validationMessage ? 'mt-2' : 'mt-5'
        )}
      >
        <button
          type="button"
          onClick={onTokenSelect}
          disabled={tokenSelectLocked}
          aria-label={`${direction} asset`}
          className="flex min-w-0 items-center gap-2.5 text-left transition-opacity enabled:hover:opacity-80"
        >
          <TokenIcon token={token || undefined} size={36} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-lg font-semibold leading-5">
              {formatSymbol(token?.symbol) || 'Select'}
              {!tokenSelectLocked && (
                <Icon icon="lucide:chevron-down" width={16} height={16} className="text-muted" />
              )}
            </span>
            <span className="mt-1 block truncate text-xs text-muted">
              {token ? formatChainName(token.blockchain) : 'Choose network'}
            </span>
          </span>
        </button>

        <div className="min-w-0 flex-1 text-right">
          {isReadOnly ? (
            <p
              aria-live="polite"
              aria-label={isEstimatedAmount && amount ? `Estimated output: ${amount}` : undefined}
              title={amount || undefined}
              className={cn(
                'break-all font-mono text-xl leading-6',
                isEstimatedAmount && 'text-muted'
              )}
            >
              {isAmountLoading && !amount ? (
                <Icon
                  icon="lucide:loader-circle"
                  width={20}
                  height={20}
                  className="ml-auto animate-spin text-primary"
                  aria-label="Refreshing quote"
                />
              ) : amount ? (
                <>
                  {isEstimatedAmount && <span aria-hidden="true">≈ </span>}
                  {formatTokenQuantity(amount)}
                </>
              ) : (
                '—'
              )}
            </p>
          ) : (
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={event => onAmountChange?.(event.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
              aria-label={`${direction} amount`}
              aria-invalid={Boolean(validationMessage) || undefined}
              aria-describedby={validationMessage ? 'swap-source-amount-error' : undefined}
              className="w-full min-w-0 bg-transparent text-right font-mono text-xl leading-6 outline-none placeholder:text-muted/60"
            />
          )}
          <p className={cn('mt-1 truncate text-xs text-muted', isEstimatedAmount && 'opacity-70')}>
            {isEstimatedAmount ? (
              <span className="inline-flex items-center justify-end gap-1">
                {isAmountLoading && (
                  <Icon
                    icon="lucide:loader-circle"
                    width={11}
                    height={11}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                )}
                <span>
                  Estimated
                  {fiatValue ? ` · ≈${formatFiatAmount(fiatValue, { showSign: true })}` : ''}
                </span>
              </span>
            ) : fiatValue ? (
              formatFiatAmount(fiatValue, { showSign: true })
            ) : (
              '—'
            )}
          </p>
        </div>
      </div>
      {pendingBalance != null && safeBig(pendingBalance).gt(0) && (
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted">
          <span title={`${pendingBalance} ZEC pending`}>
            {formatTokenQuantity(pendingBalance)} ZEC pending
          </span>
          <BalanceHelp kind="pending" />
        </div>
      )}
    </section>
  )
}

export function SwapInputView({
  tokenIn,
  tokenOut,
  isZecSource,
  isZecDestination,
  requiresRecipientAddress,
  canSwitchTokens,
  switchingTokens = false,
  amountIn,
  estimatedOut,
  isEstimatedOut,
  fromFiat,
  toFiat,
  rate,
  addressType,
  destinationAddress,
  spendableBalance,
  availableBalance,
  pendingBalance,
  recipientError,
  slippage,
  networkFee,
  isQuoting,
  quoteError,
  maxLoading = false,
  maxDisabled = false,
  maxDisabledReason,
  catalogError = false,
  sourceAssetsLoading = false,
  destinationAssetsLoading = false,
  canGetQuote,
  hasInsufficientFunds,
  insufficientMessage,
  walletManagedRefundAddress,
  feeIsApproximate,
  sourceAddress,
  sourceBadge,
  destinationBadge: destinationBadgeOverride,
  sourceAccountAction,
  destinationAssetLocked = false,
  sourceAssetLocked = false,
  hideSwitchAssets = false,
  hideReceiveAddress = false,
  actionLabel = 'Swap',
  actionLoading = false,
  onAmountInChange,
  onMaxClick,
  onRecipientAddressChange,
  onSelectRecipientFromWallet,
  onSelectToken,
  onSwitchTokens,
  onRetryTokenCatalog,
  onRetryQuote,
  onOpenSlippageSetting,
  onGetQuote
}: SwapInputViewProps) {
  const [showDetails, setShowDetails] = useState(false)
  const destinationBadge =
    destinationBadgeOverride ??
    (isZecDestination && !requiresRecipientAddress
      ? addressType === 'shielded'
        ? 'Shielded'
        : 'Transparent'
      : undefined)
  const balanceValidationMessage = hasInsufficientFunds
    ? insufficientMessage ||
      (feeIsApproximate ? 'Insufficient balance' : `Insufficient balance (Fee: ${networkFee} ZEC)`)
    : undefined

  if (catalogError) {
    return (
      <div className="flex min-h-0 flex-1 items-center px-8">
        <InlineError
          message="Unable to load assets"
          onRetry={onRetryTokenCatalog}
          className="w-full"
        />
      </div>
    )
  }

  if (sourceAssetsLoading) return <SwapInputSkeleton />

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-4">
        <div className="relative">
          <SwapAssetCard
            direction="From"
            token={tokenIn}
            amount={amountIn}
            fiatValue={fromFiat}
            accountAddress={sourceAddress}
            accountBadge={sourceBadge ?? (isZecSource ? 'Shielded' : undefined)}
            accountAction={sourceAccountAction}
            balance={isZecSource ? (availableBalance ?? spendableBalance) : spendableBalance}
            balanceHelp={isZecSource}
            pendingBalance={isZecSource ? pendingBalance : undefined}
            onTokenSelect={() => onSelectToken('in')}
            tokenSelectDisabled={sourceAssetsLoading}
            tokenSelectLocked={sourceAssetLocked}
            onAmountChange={onAmountInChange}
            onMaxClick={onMaxClick}
            maxLoading={maxLoading}
            maxDisabled={maxDisabled}
            maxDisabledReason={maxDisabledReason}
            validationMessage={balanceValidationMessage}
          />

          <div className="relative mt-2">
            {!hideSwitchAssets && (
              <Button
                type="button"
                onClick={onSwitchTokens}
                disabled={!canSwitchTokens}
                aria-label="Switch assets"
                aria-busy={switchingTokens}
                title={
                  switchingTokens
                    ? 'Switching assets'
                    : canSwitchTokens
                      ? 'Switch assets'
                      : 'The destination asset is not available in this wallet'
                }
                className="absolute -top-6 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full border-[3px] border-background bg-card p-0 text-foreground hover:bg-popover disabled:opacity-40"
                variant="secondary"
              >
                <Icon
                  icon={switchingTokens ? 'lucide:loader-circle' : 'lucide:arrow-down-up'}
                  className={switchingTokens ? 'animate-spin' : undefined}
                  width={17}
                  height={17}
                />
              </Button>
            )}

            <SwapAssetCard
              direction="To"
              token={tokenOut}
              amount={estimatedOut}
              fiatValue={toFiat}
              accountAddress={destinationAddress}
              accountBadge={destinationBadge}
              accountFallbackLabel={requiresRecipientAddress ? 'Custom address' : 'Wallet'}
              onTokenSelect={() => onSelectToken('out')}
              tokenSelectDisabled={destinationAssetsLoading}
              tokenSelectLocked={destinationAssetLocked}
              isReadOnly
              isAmountLoading={isQuoting}
              isEstimatedAmount={isEstimatedOut}
            />
          </div>
        </div>

        {quoteError && (
          <InlineError
            message={quoteError}
            onRetry={onRetryQuote}
            retrying={isQuoting}
            className="mt-2 px-1 leading-5"
          />
        )}

        {!hideReceiveAddress && tokenOut && (
          <div className="mt-5">
            {destinationAssetsLoading ? (
              <ReceiveAddressSkeleton />
            ) : (
              <div>
                <SendRecipientInputCard
                  id="swap-recipient"
                  label="Receive at"
                  variant="filled"
                  value={destinationAddress ?? ''}
                  placeholder={`${formatChainName(tokenOut.blockchain)} address`}
                  onChange={onRecipientAddressChange}
                  onSelectRecipient={onSelectRecipientFromWallet}
                  invalid={Boolean(recipientError)}
                />
                {recipientError && <InlineError message={recipientError} className="mt-2" />}
              </div>
            )}
          </div>
        )}

        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowDetails(value => !value)}
            aria-expanded={showDetails}
            className="flex w-full items-center justify-between py-1 text-sm"
          >
            {networkFee && isZecSource && (
              <span className="flex items-center gap-1.5 text-muted">
                Fee:
                <span className="text-foreground">
                  {`${feeIsApproximate ? '≈ ' : ''}${formatFeeAmount(networkFee)} ZEC`}
                </span>
              </span>
            )}
            <span className="ml-auto flex items-center gap-2 text-muted">
              Slippage <span className="text-foreground">{slippage}%</span>
              <Icon
                icon="lucide:chevron-down"
                width={16}
                height={16}
                className={cn('transition-transform', showDetails && 'rotate-180')}
              />
            </span>
          </button>

          {showDetails && (
            <div className="mt-2 space-y-3 rounded-xl bg-card/60 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Rate</span>
                <span className="text-right">
                  1 {formatSymbol(tokenIn?.symbol) || '—'} ={' '}
                  {isEstimatedOut && rate !== '...' ? '≈ ' : ''}
                  {formatTokenQuantity(rate)} {formatSymbol(tokenOut?.symbol) || '—'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Slippage tolerance</span>
                <Button onClick={onOpenSlippageSetting} variant="secondary" size="sm">
                  {slippage}%
                  <Icon icon="lucide:settings" width={14} height={14} />
                </Button>
              </div>
              {walletManagedRefundAddress && (
                <div className="text-sm">
                  <p className="text-muted">Refund to this wallet</p>
                  <p className="mt-1 truncate font-mono text-xs" title={walletManagedRefundAddress}>
                    {walletManagedRefundAddress}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="page-footer">
        <Button
          onClick={onGetQuote}
          disabled={!canGetQuote || hasInsufficientFunds || actionLoading}
          isLoading={isQuoting || actionLoading}
          className="h-[45px] w-full"
        >
          {actionLabel}
        </Button>
      </div>
    </>
  )
}
