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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'

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
  providerName?: string
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
      className="min-h-[126px] py-3"
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
            <Skeleton className="h-[26px] w-20" />
            <Skeleton className="h-3 w-16 bg-white/[0.05]" />
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="ml-auto h-[26px] w-20" />
          <Skeleton className="ml-auto h-3 w-12 bg-white/[0.05]" />
        </div>
      </div>
    </section>
  )
}

function ReceiveAddressSkeleton() {
  return (
    <div role="status" aria-label="Loading receive address">
      <Skeleton className="mb-2 h-3.5 w-24" />
      <div className="flex h-[46px] items-center gap-3 rounded-lg bg-card px-3">
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
          <Skeleton className="absolute left-1/2 top-[109px] z-10 size-7 -translate-x-1/2 rounded-md bg-card" />
          <div className="border-t border-white/10 pt-3">
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
    <section className="min-h-[126px] py-3">
      <div className="flex min-h-5 min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs leading-4">
        <div className="flex min-w-0 max-w-full items-center gap-1.5">
          <span className="shrink-0 text-sm font-medium leading-[18px] text-muted">
            {direction}
          </span>
          {accountAction}
          {!accountAction && hasAccountDetails && (
            <>
              {accountAddress ? (
                <span className="truncate font-mono text-xs text-muted" title={accountAddress}>
                  {formatSortAddress(accountAddress)}
                </span>
              ) : accountFallbackLabel ? (
                <span className="truncate text-muted">{accountFallbackLabel}</span>
              ) : null}
              {!accountAction &&
                accountBadge &&
                (accountBadge === 'Confidential' ||
                accountBadge === 'Private' ||
                accountBadge === 'Public' ? (
                  <ExecutionAccountBadge
                    mode={accountBadge === 'Public' ? 'main' : 'private'}
                    className="h-[17px] px-1.5"
                  />
                ) : (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 text-[10px] font-medium leading-[17px]',
                      accountBadge === 'Shielded' || accountBadge === 'Shield'
                        ? 'bg-success/10 text-success'
                        : 'bg-white/7 text-muted'
                    )}
                  >
                    {accountBadge}
                  </span>
                ))}
            </>
          )}
        </div>
        {balance !== undefined && (
          <div className="ml-auto flex min-w-0 max-w-[48%] shrink items-center gap-1">
            <span className="flex min-w-0 shrink items-center gap-1 text-xs font-medium text-muted">
              <span className="shrink-0">Bal.</span>
              <span className="min-w-0 truncate text-right font-sans tabular-nums" title={balance}>
                {formatTokenQuantity(balance)}
              </span>
            </span>
            {onMaxClick && (
              <button
                type="button"
                onClick={onMaxClick}
                disabled={maxLoading || maxDisabled}
                aria-label="Use maximum balance"
                title={maxDisabled ? maxDisabledReason : 'Use maximum balance'}
                className="inline-flex min-w-7 shrink-0 items-center justify-center text-xs font-medium text-foreground enabled:hover:text-primary disabled:opacity-50"
              >
                {maxLoading ? (
                  <Icon
                    icon="lucide:loader-circle"
                    width={12}
                    height={12}
                    className="animate-spin"
                  />
                ) : (
                  'Max'
                )}
              </button>
            )}
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
          validationMessage ? 'mt-2' : 'mt-4'
        )}
      >
        <button
          type="button"
          onClick={onTokenSelect}
          disabled={tokenSelectLocked}
          aria-label={`${direction} asset`}
          className="flex min-w-0 items-center gap-2 text-left transition-opacity enabled:hover:opacity-80"
        >
          <TokenIcon token={token || undefined} size={30} />
          <span className="min-w-0">
            <span className="flex items-center gap-1 text-xl font-semibold leading-[26px]">
              {formatSymbol(token?.symbol) || 'Select'}
              {!tokenSelectLocked && (
                <Icon icon="lucide:chevron-down" width={16} height={16} className="text-muted" />
              )}
            </span>
            <span className="mt-0.5 block truncate text-xs leading-4 text-muted">
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
                'break-all font-sans text-xl font-semibold leading-[26px]',
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
              className="w-full min-w-0 bg-transparent text-right font-sans text-xl font-semibold leading-[26px] outline-none placeholder:text-muted/60"
            />
          )}
          <p
            className={cn(
              'mt-0.5 truncate text-xs leading-4 text-muted',
              isEstimatedAmount && 'opacity-70'
            )}
          >
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
                  {fiatValue ? `≈${formatFiatAmount(fiatValue, { showSign: true })}` : 'Estimated'}
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
        <div className="mt-1 flex items-center justify-end gap-1 text-xs text-muted">
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
  providerName,
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
  const [showRefundAddress, setShowRefundAddress] = useState(false)
  const [recipientSelectorOpen, setRecipientSelectorOpen] = useState(false)
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
  const hasQuoteDetails = Boolean(estimatedOut) && rate !== '...' && rate !== '0'

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
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-2">
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

          <div className="relative border-t border-white/10 pt-2">
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
                className="absolute -top-3.5 left-1/2 z-10 size-7 -translate-x-1/2 rounded-md bg-[#373741] p-0 text-foreground hover:bg-popover disabled:opacity-40"
                variant="secondary"
              >
                <Icon
                  icon={switchingTokens ? 'lucide:loader-circle' : 'lucide:arrow-down-up'}
                  className={switchingTokens ? 'animate-spin' : undefined}
                  width={16}
                  height={16}
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
              accountAction={
                !hideReceiveAddress && tokenOut && !destinationAssetsLoading ? (
                  <button
                    type="button"
                    onClick={() => setRecipientSelectorOpen(true)}
                    aria-label="Choose receive account"
                    title={destinationAddress || 'Choose receive account'}
                    className="flex min-w-0 items-center gap-1.5 text-xs transition-colors hover:text-primary"
                  >
                    <span className="min-w-0 truncate font-mono text-xs text-muted">
                      {destinationAddress
                        ? formatSortAddress(destinationAddress)
                        : requiresRecipientAddress
                          ? 'Custom address'
                          : 'Wallet'}
                    </span>
                    {destinationBadge &&
                      (destinationBadge === 'Public' || destinationBadge === 'Private' ? (
                        <ExecutionAccountBadge
                          mode={destinationBadge === 'Public' ? 'main' : 'private'}
                          className="h-[17px] px-1.5"
                        />
                      ) : (
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 text-[10px] font-medium leading-[17px]',
                            destinationBadge === 'Shield' || destinationBadge === 'Shielded'
                              ? 'bg-success/10 text-success'
                              : 'bg-white/7 text-muted'
                          )}
                        >
                          {destinationBadge}
                        </span>
                      ))}
                    <Icon icon="lucide:chevron-down" width={12} height={12} className="shrink-0" />
                  </button>
                ) : undefined
              }
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

        {!hideReceiveAddress && tokenOut && (requiresRecipientAddress || recipientError) && (
          <div className="mt-2">
            {destinationAssetsLoading ? (
              <ReceiveAddressSkeleton />
            ) : (
              <div>
                <SendRecipientInputCard
                  id="swap-recipient-inline"
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

        {!hasQuoteDetails && (
          <button
            type="button"
            onClick={onOpenSlippageSetting}
            className="mt-2 flex w-full items-center justify-end gap-1 text-xs font-medium leading-4 text-muted hover:text-foreground"
            aria-label={`Set slippage, currently ${slippage}%`}
          >
            Slippage {slippage}%
            <Icon icon="lucide:chevron-down" width={12} height={12} />
          </button>
        )}

        {hasQuoteDetails && (
          <div className="mt-3 space-y-2 rounded-lg border border-white/15 px-2.5 py-2.5 text-xs font-medium leading-4">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="text-muted">Slippage</span>
              <button
                type="button"
                onClick={onOpenSlippageSetting}
                className="flex shrink-0 items-center gap-1 hover:text-primary"
                aria-label={`Set slippage, currently ${slippage}%`}
              >
                {slippage}% <Icon icon="lucide:chevron-down" width={12} height={12} />
              </button>
            </div>
            {providerName && (
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="text-muted">Provider</span>
                <span className="truncate" title={providerName}>
                  {providerName}
                </span>
              </div>
            )}
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="shrink-0 text-muted">Rate</span>
              <span
                className="min-w-0 truncate text-right"
                title={`1 ${formatSymbol(tokenIn?.symbol)} = ${rate} ${formatSymbol(tokenOut?.symbol)}`}
              >
                1 {formatSymbol(tokenIn?.symbol) || '—'} = {isEstimatedOut ? '≈ ' : ''}
                {formatTokenQuantity(rate)} {formatSymbol(tokenOut?.symbol) || '—'}
              </span>
            </div>
            {networkFee && isZecSource && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Network fee</span>
                <span>
                  {feeIsApproximate ? '≈ ' : ''}
                  {formatFeeAmount(networkFee)} ZEC
                </span>
              </div>
            )}
            {walletManagedRefundAddress && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowRefundAddress(value => !value)}
                  aria-expanded={showRefundAddress}
                  className="flex w-full items-center justify-between text-muted hover:text-foreground"
                >
                  <span>Refund address</span>
                  <Icon
                    icon="lucide:chevron-down"
                    width={12}
                    height={12}
                    className={cn('transition-transform', showRefundAddress && 'rotate-180')}
                  />
                </button>
                {showRefundAddress && (
                  <p
                    className="mt-1 break-all font-mono text-xs font-normal"
                    title={walletManagedRefundAddress}
                  >
                    {walletManagedRefundAddress}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="page-footer">
        <Button
          onClick={onGetQuote}
          disabled={!canGetQuote || hasInsufficientFunds || actionLoading}
          isLoading={isQuoting || actionLoading}
          className="h-[45px] w-full text-base font-semibold leading-[21px] text-black"
        >
          {actionLabel}
        </Button>
      </div>

      <Dialog
        open={recipientSelectorOpen && !hideReceiveAddress}
        onOpenChange={setRecipientSelectorOpen}
      >
        <DialogContent
          className="w-[calc(100%-2rem)] max-w-[343px] gap-5 rounded-lg p-4"
          showCloseButton
        >
          <DialogHeader className="text-left">
            <DialogTitle className="text-sm">Receive at</DialogTitle>
          </DialogHeader>
          {tokenOut && (
            <div>
              <SendRecipientInputCard
                id="swap-recipient"
                label="Address"
                variant="filled"
                value={destinationAddress ?? ''}
                placeholder={`${formatChainName(tokenOut.blockchain)} address`}
                onChange={onRecipientAddressChange}
                autoFocus
                onSelectRecipient={
                  onSelectRecipientFromWallet
                    ? () => {
                        setRecipientSelectorOpen(false)
                        window.requestAnimationFrame(() => onSelectRecipientFromWallet())
                      }
                    : undefined
                }
                invalid={Boolean(recipientError)}
              />
              {recipientError && <InlineError message={recipientError} className="mt-2" />}
            </div>
          )}
          <Button
            type="button"
            onClick={() => setRecipientSelectorOpen(false)}
            className="h-10 w-full"
          >
            Done
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
