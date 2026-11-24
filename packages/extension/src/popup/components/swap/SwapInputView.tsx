import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import type { AddressType, FundingSource } from '@/types'
import type { SwapToken } from '@/core/services/intents-api'
import type { RheaSwapRouteView } from '@/core/services/rhea-swap'
import {
  formatChainName,
  formatInsufficientBalance,
  formatSortAddress,
  formatSymbol
} from '@/lib/format'
import {
  formatBaseUnitDecimalAmount,
  formatFeeAmount,
  formatFiatAmount,
  formatTokenQuantity
} from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { ExecutionAccountBadge } from '../account/ExecutionAccountSelector'
import { ZcashFundingBadge } from '../zcash/ZcashFundingBadge'
import { TokenIcon } from '../tokens/TokenIcon'
import { Button } from '../ui/button'
import { BalanceSkeleton, Skeleton } from '../ui/skeleton'
import { BalanceHelp } from '../transaction/BalanceHelp'
import { RouteProviderLabel } from '../transaction/RouteProviderLabel'
import { SendRecipientInputCard } from '../transaction/SendInputCards'
import { safeBig } from '@/lib/big'
import { shouldDeferSwapAmountFocus } from '@/popup/services/swap-page-model'
import { getSwapCatalogChainForAsset } from '@/popup/services/swap-catalog-loading'
import { TransactionNotice } from '../transaction/TransactionNotice'
import { getSwapQuoteNotice } from '@/popup/services/swap-quote-error-message'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

export function SwapProviderCard({
  slippage,
  providerName,
  outputAmount,
  outputSymbol,
  isBestPrice = false,
  action,
  details
}: {
  readonly slippage: number
  readonly providerName: string
  readonly outputAmount: string
  readonly outputSymbol: string
  readonly isBestPrice?: boolean
  readonly action?: ReactNode
  readonly details?: ReactNode
}) {
  return (
    <div className="mt-2 rounded-lg border border-white/15 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2 py-1">
        <span className="text-muted">Slippage</span>
        <span>{slippage}%</span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 py-1">
        <span className="text-muted">Provider</span>
        {action}
      </div>
      <div className="mt-1.5 rounded-md bg-white/5 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <RouteProviderLabel router={providerName} size={24} className="font-medium" />
          {isBestPrice && (
            <span className="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
              Best price
            </span>
          )}
          <span
            className="ml-auto min-w-0 truncate text-right font-medium"
            title={`${outputAmount} ${formatSymbol(outputSymbol)}`}
          >
            {formatTokenQuantity(outputAmount)} {formatSymbol(outputSymbol)}
          </span>
        </div>
        {details}
      </div>
    </div>
  )
}

interface SwapInputViewProps {
  tokenIn: SwapToken | null
  tokenOut: SwapToken | null
  tokenInAssetId?: string
  tokenOutAssetId?: string
  tokenInSymbol?: string
  tokenOutSymbol?: string
  isZecSource: boolean
  isZecDestination: boolean
  requiresRecipientAddress: boolean
  canSwitchTokens: boolean
  reverseUnavailableReason?: string | null
  switchingTokens?: boolean
  amountIn: string
  estimatedOut: string
  isEstimatedOut: boolean
  fromFiat: string
  toFiat: string
  rate: string
  providerName?: string
  providerAlternatives?: readonly RheaSwapRouteView[]
  providerSelectedAmountRaw?: string
  showProviderCard?: boolean
  providerIsBestPrice?: boolean
  onSelectProviderRoute?: (index: number) => void
  onRefreshQuote?: () => void
  topContent?: ReactNode
  hideAccountDetails?: boolean
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
  onEnableReceiveNetwork?: () => void
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
  sourceZcashFundingSource?: FundingSource
  destinationBadge?: string
  sourceAccountAction?: ReactNode
  onSelectDestinationAccount?: () => void
  destinationAssetLocked?: boolean
  sourceAssetLocked?: boolean
  hideSwitchAssets?: boolean
  hideReceiveAddress?: boolean
  actionLabel?: string
  actionLoading?: boolean
  actionStatus?: ReactNode
  onAmountInChange: (value: string) => void
  focusAmountOnMount?: boolean
  amountFocusToken?: number
  onMaxClick?: () => void
  onRecipientAddressChange: (value: string) => void
  onSelectRecipientFromWallet?: () => void
  onSelectToken: (type: 'in' | 'out') => void
  onSwitchTokens: () => void
  onRetryTokenCatalog: () => void
  onRetryQuote?: () => void
  onGetQuote: () => void
}

interface SwapAssetCardProps {
  direction: 'From' | 'To'
  token: SwapToken | null
  fallbackAssetId?: string
  fallbackSymbol?: string
  displaySymbol?: string
  tokenBadgeBlockchain?: string
  tokenNetworkLabel?: string
  zcashFundingSource?: FundingSource
  amount: string
  fiatValue: string
  accountAddress?: string
  accountBadge?: string
  accountAction?: ReactNode
  accountFallbackLabel?: string
  balance?: string
  balanceLoading?: boolean
  onTokenSelect: () => void
  tokenSelectDisabled?: boolean
  tokenSelectLocked?: boolean
  onAmountChange?: (value: string) => void
  autoFocusAmount?: boolean
  amountFocusToken?: number
  onMaxClick?: () => void
  maxLoading?: boolean
  maxDisabled?: boolean
  maxDisabledReason?: string
  isReadOnly?: boolean
  isAmountLoading?: boolean
  isEstimatedAmount?: boolean
  amountErrorId?: string
  balanceHelp?: boolean
  pendingBalance?: string
}

interface SwapDestinationPanelProps extends Omit<SwapAssetCardProps, 'direction' | 'isReadOnly'> {
  canSwitchAssets: boolean
  reverseUnavailableReason?: string | null
  switchingTokens?: boolean
  hideSwitchAssets?: boolean
  onSwitchAssets: () => void
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

export function SwapAssetCard({
  direction,
  token,
  fallbackAssetId,
  fallbackSymbol,
  displaySymbol,
  tokenBadgeBlockchain,
  tokenNetworkLabel,
  zcashFundingSource,
  amount,
  fiatValue,
  accountAddress,
  accountBadge,
  accountAction,
  accountFallbackLabel,
  balance,
  balanceLoading = false,
  onTokenSelect,
  tokenSelectDisabled = false,
  tokenSelectLocked = false,
  onAmountChange,
  autoFocusAmount = false,
  amountFocusToken,
  onMaxClick,
  maxLoading = false,
  maxDisabled = false,
  maxDisabledReason,
  isReadOnly = false,
  isAmountLoading = false,
  isEstimatedAmount = false,
  amountErrorId,
  balanceHelp = false,
  pendingBalance
}: SwapAssetCardProps) {
  const hasAccountDetails = Boolean(accountAddress || accountFallbackLabel || accountBadge)
  const amountField = useRef<HTMLInputElement>(null)
  const amountInputId = useId()
  const [amountFontSize, setAmountFontSize] = useState(20)
  useLayoutEffect(() => {
    if (isReadOnly || amountFocusToken === undefined) return
    if (shouldDeferSwapAmountFocus(document.activeElement)) return
    const frame = window.requestAnimationFrame(() => {
      amountField.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [amountFocusToken, isReadOnly])
  useLayoutEffect(() => {
    if (isReadOnly || !amountField.current) return
    const input = amountField.current
    const resize = () => {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) return
      const computed = window.getComputedStyle(input)
      context.font = `600 20px ${computed.fontFamily}`
      const textWidth = context.measureText(amount || '0').width
      setAmountFontSize(
        Math.max(
          11,
          Math.min(20, Math.floor(((input.clientWidth - 4) * 20) / Math.max(textWidth, 1)))
        )
      )
    }
    const observer = new ResizeObserver(resize)
    observer.observe(input)
    resize()
    return () => observer.disconnect()
  }, [amount, isReadOnly])
  if (tokenSelectDisabled && !fallbackSymbol) return <SwapAssetCardSkeleton direction={direction} />
  const blockchain = token?.blockchain ?? getSwapCatalogChainForAsset(fallbackAssetId)?.blockchain
  const symbol = formatSymbol(displaySymbol ?? token?.symbol ?? fallbackSymbol)

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
                accountBadge === 'Incognito' ||
                accountBadge === 'Public' ? (
                  <ExecutionAccountBadge
                    mode={accountBadge === 'Public' ? 'main' : 'private'}
                    className="h-[17px] px-1.5"
                  />
                ) : (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 text-[10px] font-medium leading-[17px]',
                      accountBadge === 'Shield'
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
              {balanceLoading ? (
                <BalanceSkeleton />
              ) : (
                <span
                  className="min-w-0 truncate text-right font-sans tabular-nums"
                  title={balance}
                >
                  {formatTokenQuantity(balance)}
                </span>
              )}
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

      <div className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onTokenSelect}
          disabled={tokenSelectLocked}
          aria-label={`${direction} asset`}
          className="flex max-w-[55%] min-w-0 shrink-0 items-center gap-2 text-left transition-opacity enabled:hover:opacity-80"
        >
          <span className="size-[30px] shrink-0">
            <TokenIcon
              token={token || undefined}
              assetId={fallbackAssetId}
              symbol={symbol}
              blockchain={tokenBadgeBlockchain ?? blockchain}
              size={30}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1 text-xl font-semibold leading-[26px]">
              <span className="min-w-0 truncate">{symbol || 'Select'}</span>
              {!tokenSelectLocked && (
                <Icon
                  icon="lucide:chevron-down"
                  width={16}
                  height={16}
                  className="shrink-0 text-muted"
                />
              )}
            </span>
            <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-4 text-muted">
              <span className="truncate">
                {blockchain ? (tokenNetworkLabel ?? formatChainName(blockchain)) : 'Choose network'}
              </span>
              {zcashFundingSource && <ZcashFundingBadge source={zcashFundingSource} />}
            </span>
          </span>
        </button>

        {isReadOnly ? (
          <div className="min-w-0 flex-1 text-right">
            <div
              aria-live="polite"
              aria-label={isEstimatedAmount && amount ? `Estimated output: ${amount}` : undefined}
              title={amount || undefined}
              className={cn(
                'flex h-[26px] items-center justify-end whitespace-nowrap font-sans text-xl font-semibold leading-[26px]',
                amount ? 'overflow-x-auto' : 'overflow-hidden',
                isEstimatedAmount && 'text-muted',
                isAmountLoading && amount && 'swap-quote-shimmer'
              )}
            >
              {isAmountLoading && !amount ? (
                <>
                  <span className="sr-only">Refreshing quote</span>
                  <Skeleton className="h-5 w-20 max-w-full shrink-0" />
                </>
              ) : amount ? (
                <>
                  {isEstimatedAmount && <span aria-hidden="true">≈ </span>}
                  {formatTokenQuantity(amount)}
                </>
              ) : (
                '—'
              )}
            </div>
            <div className="mt-0.5 flex h-4 min-w-0 items-center justify-end gap-1 text-xs leading-4 text-muted">
              {isAmountLoading && !amount ? (
                <Skeleton className="h-2.5 w-12 max-w-full shrink-0" />
              ) : (
                <>
                  {isAmountLoading && isEstimatedAmount && (
                    <Skeleton className="h-2 w-3 shrink-0" />
                  )}
                  <span className="min-w-0 truncate">
                    {fiatValue
                      ? `${isEstimatedAmount ? '≈' : ''}${formatFiatAmount(fiatValue, { showSign: true })}`
                      : isEstimatedAmount
                        ? 'Estimated'
                        : '—'}
                  </span>
                </>
              )}
            </div>
          </div>
        ) : (
          <label htmlFor={amountInputId} className="min-w-0 flex-1 cursor-text text-right">
            <input
              id={amountInputId}
              ref={amountField}
              type="text"
              autoFocus={autoFocusAmount}
              inputMode="decimal"
              value={amount}
              onChange={event => onAmountChange?.(event.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
              aria-label={`${direction} amount`}
              aria-invalid={amountErrorId ? true : undefined}
              aria-describedby={amountErrorId}
              style={{ fontSize: amountFontSize }}
              className="w-full min-w-0 bg-transparent text-right font-sans font-semibold leading-[26px] outline-none placeholder:text-muted/60"
            />
            <p className="mt-0.5 truncate text-xs leading-4 text-muted">
              {fiatValue ? formatFiatAmount(fiatValue, { showSign: true }) : '—'}
            </p>
          </label>
        )}
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

export function SwapDestinationPanel({
  canSwitchAssets,
  reverseUnavailableReason,
  switchingTokens = false,
  hideSwitchAssets = false,
  onSwitchAssets,
  ...cardProps
}: SwapDestinationPanelProps) {
  const reverseReasonId = useId()
  return (
    <div className="relative border-t border-white/10 pt-2">
      {!hideSwitchAssets && (
        <span
          tabIndex={reverseUnavailableReason ? 0 : undefined}
          aria-label={reverseUnavailableReason ?? undefined}
          aria-describedby={reverseUnavailableReason ? reverseReasonId : undefined}
          title={
            reverseUnavailableReason ?? (switchingTokens ? 'Switching assets' : 'Switch assets')
          }
          className="group absolute -top-3.5 left-1/2 z-10 -translate-x-1/2"
        >
          <Button
            type="button"
            onClick={onSwitchAssets}
            disabled={!canSwitchAssets}
            aria-label="Switch assets"
            aria-busy={switchingTokens}
            title={
              reverseUnavailableReason ?? (switchingTokens ? 'Switching assets' : 'Switch assets')
            }
            className="size-7 rounded-md bg-[#373741] p-0 text-foreground hover:bg-popover disabled:opacity-40"
            variant="secondary"
          >
            <Icon
              icon={switchingTokens ? 'lucide:loader-circle' : 'lucide:arrow-down-up'}
              className={switchingTokens ? 'animate-spin' : undefined}
              width={16}
              height={16}
            />
          </Button>
          {reverseUnavailableReason && (
            <span
              id={reverseReasonId}
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-48 -translate-x-1/2 rounded bg-popover p-2 text-center text-xs text-foreground opacity-0 shadow-md group-hover:opacity-100 group-focus:opacity-100"
            >
              {reverseUnavailableReason}
            </span>
          )}
        </span>
      )}
      <SwapAssetCard {...cardProps} direction="To" isReadOnly />
    </div>
  )
}

export function SwapInputView({
  tokenIn,
  tokenOut,
  tokenInAssetId,
  tokenOutAssetId,
  tokenInSymbol,
  tokenOutSymbol,
  isZecSource,
  isZecDestination,
  requiresRecipientAddress,
  canSwitchTokens,
  reverseUnavailableReason,
  switchingTokens = false,
  amountIn,
  estimatedOut,
  isEstimatedOut,
  fromFiat,
  toFiat,
  rate,
  providerName,
  providerAlternatives = [],
  providerSelectedAmountRaw,
  showProviderCard = false,
  providerIsBestPrice = false,
  onSelectProviderRoute,
  onRefreshQuote,
  topContent,
  hideAccountDetails = false,
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
  onEnableReceiveNetwork,
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
  sourceZcashFundingSource,
  destinationBadge: destinationBadgeOverride,
  sourceAccountAction,
  onSelectDestinationAccount,
  destinationAssetLocked = false,
  sourceAssetLocked = false,
  hideSwitchAssets = false,
  hideReceiveAddress = false,
  actionLabel = 'Swap',
  actionLoading = false,
  actionStatus,
  onAmountInChange,
  focusAmountOnMount = false,
  amountFocusToken,
  onMaxClick,
  onRecipientAddressChange,
  onSelectRecipientFromWallet,
  onSelectToken,
  onSwitchTokens,
  onRetryTokenCatalog,
  onRetryQuote,
  onGetQuote
}: SwapInputViewProps) {
  const amountErrorId = useId()
  const recipientErrorId = useId()
  const [showRefundAddress, setShowRefundAddress] = useState(false)
  const [recipientSelectorOpen, setRecipientSelectorOpen] = useState(false)
  const [routesOpen, setRoutesOpen] = useState(false)
  const destinationBadge =
    destinationBadgeOverride ??
    (isZecDestination && !requiresRecipientAddress
      ? addressType === 'shielded'
        ? 'Shield'
        : 'Transparent'
      : undefined)
  const balanceValidationMessage =
    hasInsufficientFunds && !recipientError
      ? (insufficientMessage ?? formatInsufficientBalance(tokenIn?.symbol ?? tokenInSymbol))
      : undefined
  const hasQuoteDetails = Boolean(estimatedOut) && rate !== '...' && rate !== '0'
  const quoteNotice = getSwapQuoteNotice(quoteError)
  const providerNetworkFeeLabel =
    isZecSource && networkFee !== undefined ? `${formatFeeAmount(networkFee)} ZEC` : null

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-2">
        {topContent}
        <div className="relative">
          <SwapAssetCard
            direction="From"
            token={tokenIn}
            fallbackAssetId={tokenInAssetId}
            fallbackSymbol={tokenInSymbol}
            zcashFundingSource={isZecSource ? sourceZcashFundingSource : undefined}
            amount={amountIn}
            fiatValue={fromFiat}
            accountAddress={hideAccountDetails ? undefined : sourceAddress}
            accountBadge={
              hideAccountDetails ? undefined : (sourceBadge ?? (isZecSource ? 'Shield' : undefined))
            }
            accountAction={hideAccountDetails && !isZecSource ? undefined : sourceAccountAction}
            balance={isZecSource ? (availableBalance ?? spendableBalance) : spendableBalance}
            balanceHelp={isZecSource}
            pendingBalance={isZecSource ? pendingBalance : undefined}
            onTokenSelect={() => onSelectToken('in')}
            tokenSelectDisabled={sourceAssetsLoading}
            tokenSelectLocked={sourceAssetLocked}
            onAmountChange={onAmountInChange}
            autoFocusAmount={focusAmountOnMount}
            amountFocusToken={amountFocusToken}
            onMaxClick={onMaxClick}
            maxLoading={maxLoading}
            maxDisabled={maxDisabled}
            maxDisabledReason={maxDisabledReason}
            amountErrorId={balanceValidationMessage ? amountErrorId : undefined}
          />

          <SwapDestinationPanel
            canSwitchAssets={canSwitchTokens}
            reverseUnavailableReason={reverseUnavailableReason}
            switchingTokens={switchingTokens}
            hideSwitchAssets={hideSwitchAssets}
            onSwitchAssets={onSwitchTokens}
            token={tokenOut}
            fallbackAssetId={tokenOutAssetId}
            fallbackSymbol={tokenOutSymbol}
            zcashFundingSource={isZecDestination ? addressType : undefined}
            amount={estimatedOut}
            fiatValue={toFiat}
            accountAddress={hideAccountDetails ? undefined : destinationAddress}
            accountBadge={hideAccountDetails ? undefined : destinationBadge}
            accountFallbackLabel={
              hideAccountDetails
                ? undefined
                : requiresRecipientAddress
                  ? 'Custom address'
                  : 'Wallet'
            }
            accountAction={
              !hideAccountDetails &&
              !hideReceiveAddress &&
              tokenOut &&
              !destinationAssetsLoading ? (
                <button
                  type="button"
                  onClick={() =>
                    onSelectDestinationAccount
                      ? onSelectDestinationAccount()
                      : setRecipientSelectorOpen(true)
                  }
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
                    (destinationBadge === 'Public' || destinationBadge === 'Incognito' ? (
                      <ExecutionAccountBadge
                        mode={destinationBadge === 'Public' ? 'main' : 'private'}
                        className="h-[17px] px-1.5"
                      />
                    ) : (
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 text-[10px] font-medium leading-[17px]',
                          destinationBadge === 'Shield'
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
            isAmountLoading={isQuoting}
            isEstimatedAmount={isEstimatedOut}
          />
        </div>

        {showProviderCard && providerName && tokenOut && (
          <SwapProviderCard
            slippage={slippage}
            providerName={providerName}
            outputAmount={estimatedOut}
            outputSymbol={tokenOut.symbol}
            isBestPrice={providerIsBestPrice}
            action={
              providerAlternatives.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setRoutesOpen(true)}
                  className="flex items-center gap-1 text-muted hover:text-foreground"
                  aria-label={`Choose provider from ${providerAlternatives.length + 1} routes`}
                >
                  {providerAlternatives.length + 1} providers
                  <Icon icon="lucide:chevron-right" width={13} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onRefreshQuote}
                  disabled={!onRefreshQuote || isQuoting}
                  className="flex size-6 items-center justify-center text-muted hover:text-foreground disabled:opacity-50"
                  aria-label="Refresh provider"
                  title="Refresh provider"
                >
                  <Icon icon="lucide:refresh-cw" width={14} />
                </button>
              )
            }
            details={
              providerNetworkFeeLabel ? (
                <div className="mt-1.5 flex items-center justify-end gap-2 text-muted">
                  <span>
                    Network fee <span className="text-foreground">{providerNetworkFeeLabel}</span>
                  </span>
                </div>
              ) : undefined
            }
          />
        )}

        {onEnableReceiveNetwork && (
          <Button
            type="button"
            variant="ghost"
            onClick={onEnableReceiveNetwork}
            className="mt-1 h-8 px-1 text-xs text-primary"
          >
            Enable receive network
          </Button>
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
                  describedBy={
                    recipientError && !recipientSelectorOpen ? recipientErrorId : undefined
                  }
                />
              </div>
            )}
          </div>
        )}

        {hasQuoteDetails && !showProviderCard && (
          <div className="mt-3 space-y-2 rounded-lg border border-white/15 px-2.5 py-2.5 text-xs font-medium leading-4">
            {providerName && !showProviderCard && (
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="text-muted">Provider</span>
                <RouteProviderLabel router={providerName} />
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
            {networkFee && isZecSource && !showProviderCard && (
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
        {balanceValidationMessage ? (
          <TransactionNotice
            id={amountErrorId}
            message={balanceValidationMessage}
            tone="warning"
            role="alert"
            className="mt-2"
          />
        ) : recipientError ? (
          !recipientSelectorOpen && (
            <TransactionNotice id={recipientErrorId} message={recipientError} className="mt-2" />
          )
        ) : catalogError ? (
          <TransactionNotice
            message="Unable to load assets"
            onRetry={onRetryTokenCatalog}
            className="mt-2"
          />
        ) : !isQuoting && quoteError ? (
          <TransactionNotice
            message={quoteNotice ?? quoteError}
            tone={quoteNotice ? 'muted' : onRetryQuote ? 'warning' : 'error'}
            onRetry={onRetryQuote}
            className="mt-2"
          />
        ) : null}
      </div>

      <div className="page-footer">
        {actionStatus}
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
        open={recipientSelectorOpen && !hideReceiveAddress && !onSelectDestinationAccount}
        onOpenChange={setRecipientSelectorOpen}
      >
        <DialogContent position="bottom" scroll="body" className="gap-0 p-0" showCloseButton>
          <DialogHeader className="shrink-0 px-5 pb-4 pt-5 text-left">
            <DialogTitle className="text-sm">Receive at</DialogTitle>
          </DialogHeader>
          {tokenOut && (
            <div className="min-h-0 overflow-y-auto px-5">
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
                describedBy={recipientError ? recipientErrorId : undefined}
              />
              {recipientError && (
                <TransactionNotice
                  id={recipientErrorId}
                  message={recipientError}
                  className="mt-2"
                />
              )}
            </div>
          )}
          <DialogFooter className="p-5">
            <Button type="button" onClick={() => setRecipientSelectorOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={routesOpen && showProviderCard && providerAlternatives.length > 0}
        onOpenChange={setRoutesOpen}
      >
        <DialogContent
          position="bottom"
          scroll="body"
          className="gap-0 bg-popover p-0"
          showCloseButton
        >
          <DialogHeader className="shrink-0 px-5 pb-4 pt-5 text-left">
            <DialogTitle className="text-base">Provider</DialogTitle>
          </DialogHeader>
          <button
            type="button"
            onClick={() => {
              setRoutesOpen(false)
              onRefreshQuote?.()
            }}
            disabled={!onRefreshQuote || isQuoting}
            aria-label="Refresh providers"
            title="Refresh providers"
            className="wallet-interactive absolute right-12 top-4 flex size-8 items-center justify-center rounded-md text-muted hover:text-foreground disabled:opacity-50"
          >
            <Icon icon="lucide:refresh-cw" width={17} />
          </button>
          <div className="min-h-0 space-y-3 overflow-y-auto px-4 pb-5">
            {providerName && (
              <div className="min-h-[98px] rounded-lg border border-primary bg-white/5 px-3 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <RouteProviderLabel
                    router={providerName}
                    size={28}
                    className="text-sm font-medium"
                  />
                  {providerIsBestPrice && (
                    <span className="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
                      Best price
                    </span>
                  )}
                  <span
                    className="ml-auto min-w-0 truncate text-right text-sm font-medium"
                    title={`${estimatedOut} ${formatSymbol(tokenOut?.symbol)}`}
                  >
                    {formatTokenQuantity(estimatedOut)} {formatSymbol(tokenOut?.symbol)}
                  </span>
                </div>
                {providerNetworkFeeLabel && (
                  <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted">
                    <span>
                      Network fee <span className="text-foreground">{providerNetworkFeeLabel}</span>
                    </span>
                  </div>
                )}
              </div>
            )}
            {providerAlternatives.map(route => (
              <button
                key={route.index}
                type="button"
                onClick={() => {
                  setRoutesOpen(false)
                  onSelectProviderRoute?.(route.index)
                }}
                className="wallet-interactive min-h-[98px] w-full rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-left hover:border-white/30"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <RouteProviderLabel
                    router={route.router}
                    size={28}
                    className="text-sm font-medium"
                  />
                  {providerSelectedAmountRaw &&
                    BigInt(route.estimatedOut) >= BigInt(providerSelectedAmountRaw) &&
                    providerAlternatives.every(
                      other => BigInt(route.estimatedOut) >= BigInt(other.estimatedOut)
                    ) && (
                      <span className="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
                        Best price
                      </span>
                    )}
                  <span className="ml-auto min-w-0 truncate text-right text-sm font-medium">
                    {tokenOut
                      ? formatTokenQuantity(
                          formatBaseUnitDecimalAmount(route.estimatedOut, tokenOut.decimals)
                        )
                      : '—'}{' '}
                    {formatSymbol(tokenOut?.symbol)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
