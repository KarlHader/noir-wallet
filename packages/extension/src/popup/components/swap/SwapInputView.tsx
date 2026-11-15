import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import type { AddressType } from '@/types'
import type { SwapToken } from '@/core/services/intents-api'
import type { RheaSwapRouteView } from '@/core/services/rhea-swap'
import { formatChainName, formatSortAddress, formatSymbol } from '@/lib/format'
import {
  formatBaseUnitDecimalAmount,
  formatFeeAmount,
  formatFiatAmount,
  formatTokenQuantity
} from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { ExecutionAccountBadge } from '../account/ExecutionAccountSelector'
import { TokenIcon } from '../tokens/TokenIcon'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import { BalanceHelp } from '../transaction/BalanceHelp'
import { SendRecipientInputCard } from '../transaction/SendInputCards'
import { safeBig } from '@/lib/big'
import { shouldDeferSwapAmountFocus } from '@/popup/services/swap-page-model'
import { InlineError } from '../common/InlineError'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import nearIntentsIcon from '@/images/figma-near-confidential.svg'

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  bitget: 'Bitget',
  okx: 'OKX',
  binance: 'Binance',
  '1inch': '1inch',
  paraswap: 'ParaSwap',
  kodiak: 'Kodiak',
  openocean: 'OpenOcean',
  cow: 'CoW',
  zerox: 'Robinhood',
  jupiter: 'Jupiter',
  titan: 'Titan',
  dflow: 'DFlow',
  hyperion: 'Hyperion',
  'near-smart': 'SmartV1',
  'near-smartx': 'SmartV2',
  nearintents: 'NEAR Intents',
  'preswap-nearintents': 'NEAR Intents',
  rango: 'Rango',
  lifi: 'LI.FI',
  jumper: 'Jumper',
  bungee: 'Bungee',
  swapkit: 'SwapKit',
  omnibridge: 'OmniBridge',
  stableflow: 'StableFlow',
  'near-mca-withdraw': 'NEAR Intents',
  'near-confidential': 'NEAR Confidential Intents'
}
const PROVIDER_MARKS: Readonly<Record<string, { readonly slug: string; readonly color: string }>> =
  {
    binance: { slug: 'binance', color: '#F0B90B' },
    okx: { slug: 'okx', color: '#FFFFFF' }
  }

function providerDisplayName(router: string): string {
  return PROVIDER_NAMES[router.trim().toLowerCase()] ?? router
}

function ProviderMark({ router, size }: { readonly router: string; readonly size: 24 | 28 }) {
  const normalized = router.trim().toLowerCase()
  const mark = PROVIDER_MARKS[normalized]
  const [failedRouter, setFailedRouter] = useState<string | null>(null)
  if (normalized === 'near-confidential' || providerDisplayName(router) === 'NEAR Intents') {
    return (
      <img src={nearIntentsIcon} alt="" width={size} height={size} className="shrink-0 rounded" />
    )
  }
  if (mark && failedRouter !== normalized) {
    return (
      <img
        src={`https://cdn.jsdelivr.net/npm/simple-icons@v15/icons/${mark.slug}.svg`}
        alt=""
        width={size}
        height={size}
        className={cn('shrink-0 rounded p-1', size === 24 ? 'size-6' : 'size-7')}
        style={{ backgroundColor: mark.color }}
        onError={() => setFailedRouter(normalized)}
      />
    )
  }
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold',
        size === 24 ? 'size-6' : 'size-7'
      )}
      aria-hidden="true"
    >
      {providerDisplayName(router).slice(0, 1).toUpperCase()}
    </span>
  )
}

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
          <ProviderMark router={providerName} size={24} />
          <span className="min-w-0 truncate font-medium" title={providerDisplayName(providerName)}>
            {providerDisplayName(providerName)}
          </span>
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
  onOpenSlippageSetting: () => void
  showSlippageSetting?: boolean
  onGetQuote: () => void
}

interface SwapAssetCardProps {
  direction: 'From' | 'To'
  token: SwapToken | null
  tokenBadgeBlockchain?: string
  tokenNetworkLabel?: string
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
  autoFocusAmount?: boolean
  amountFocusToken?: number
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

export function SwapAssetCard({
  direction,
  token,
  tokenBadgeBlockchain,
  tokenNetworkLabel,
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
  autoFocusAmount = false,
  amountFocusToken,
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
  if (tokenSelectDisabled) return <SwapAssetCardSkeleton direction={direction} />

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
          'flex items-center justify-between gap-3',
          validationMessage ? 'mt-2' : 'mt-4'
        )}
      >
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
              blockchain={tokenBadgeBlockchain ?? token?.blockchain}
              size={30}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1 text-xl font-semibold leading-[26px]">
              <span className="min-w-0 truncate">{formatSymbol(token?.symbol) || 'Select'}</span>
              {!tokenSelectLocked && (
                <Icon
                  icon="lucide:chevron-down"
                  width={16}
                  height={16}
                  className="shrink-0 text-muted"
                />
              )}
            </span>
            <span className="mt-0.5 block truncate text-xs leading-4 text-muted">
              {token ? (tokenNetworkLabel ?? formatChainName(token.blockchain)) : 'Choose network'}
            </span>
          </span>
        </button>

        {isReadOnly ? (
          <div className="min-w-0 flex-1 text-right">
            <p
              aria-live="polite"
              aria-label={isEstimatedAmount && amount ? `Estimated output: ${amount}` : undefined}
              title={amount || undefined}
              className={cn(
                'min-h-[26px] overflow-x-auto whitespace-nowrap font-sans text-xl font-semibold leading-[26px]',
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
            <p className="mt-0.5 truncate text-xs leading-4 text-muted">
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
                    {fiatValue
                      ? `≈${formatFiatAmount(fiatValue, { showSign: true })}`
                      : 'Estimated'}
                  </span>
                </span>
              ) : fiatValue ? (
                formatFiatAmount(fiatValue, { showSign: true })
              ) : (
                '—'
              )}
            </p>
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
              aria-invalid={Boolean(validationMessage) || undefined}
              aria-describedby={validationMessage ? 'swap-source-amount-error' : undefined}
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

export function SwapInputView({
  tokenIn,
  tokenOut,
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
  onOpenSlippageSetting,
  showSlippageSetting = true,
  onGetQuote
}: SwapInputViewProps) {
  const [showRefundAddress, setShowRefundAddress] = useState(false)
  const [recipientSelectorOpen, setRecipientSelectorOpen] = useState(false)
  const [routesOpen, setRoutesOpen] = useState(false)
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
            amount={amountIn}
            fiatValue={fromFiat}
            accountAddress={hideAccountDetails ? undefined : sourceAddress}
            accountBadge={
              hideAccountDetails
                ? undefined
                : (sourceBadge ?? (isZecSource ? 'Shielded' : undefined))
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
            validationMessage={balanceValidationMessage}
          />

          <div className="relative border-t border-white/10 pt-2">
            {!hideSwitchAssets && (
              <span
                title={
                  reverseUnavailableReason ??
                  (switchingTokens ? 'Switching assets' : 'Switch assets')
                }
                className="absolute -top-3.5 left-1/2 z-10 -translate-x-1/2"
              >
                <Button
                  type="button"
                  onClick={onSwitchTokens}
                  disabled={!canSwitchTokens}
                  aria-label="Switch assets"
                  aria-busy={switchingTokens}
                  title={
                    reverseUnavailableReason ??
                    (switchingTokens ? 'Switching assets' : 'Switch assets')
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
              </span>
            )}

            <SwapAssetCard
              direction="To"
              token={tokenOut}
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

        {catalogError && (
          <InlineError
            message="Unable to load assets"
            onRetry={onRetryTokenCatalog}
            className="mt-2 px-1 leading-5"
          />
        )}

        {quoteError && (
          <InlineError
            message={quoteError}
            onRetry={onRetryQuote}
            retrying={isQuoting}
            className="mt-2 px-1 leading-5"
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
                />
                {recipientError && <InlineError message={recipientError} className="mt-2" />}
              </div>
            )}
          </div>
        )}

        {!hasQuoteDetails && showSlippageSetting !== false && (
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

        {hasQuoteDetails && !showProviderCard && (
          <div className="mt-3 space-y-2 rounded-lg border border-white/15 px-2.5 py-2.5 text-xs font-medium leading-4">
            {showSlippageSetting && (
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
            )}
            {providerName && !showProviderCard && (
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
        <DialogContent
          position="bottom"
          className="flex max-h-[calc(100dvh-56px)] flex-col gap-0 p-0"
          showCloseButton
        >
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
              />
              {recipientError && <InlineError message={recipientError} className="mt-2" />}
            </div>
          )}
          <div className="shrink-0 p-5">
            <Button
              type="button"
              onClick={() => setRecipientSelectorOpen(false)}
              className="h-10 w-full"
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={routesOpen && showProviderCard && providerAlternatives.length > 0}
        onOpenChange={setRoutesOpen}
      >
        <DialogContent
          position="bottom"
          className="flex max-h-[80dvh] flex-col gap-0 bg-popover p-0"
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
                  <ProviderMark router={providerName} size={28} />
                  <span
                    className="min-w-0 truncate text-sm font-medium"
                    title={providerDisplayName(providerName)}
                  >
                    {providerDisplayName(providerName)}
                  </span>
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
                  <ProviderMark router={route.router} size={28} />
                  <span
                    className="min-w-0 truncate text-sm font-medium"
                    title={providerDisplayName(route.router)}
                  >
                    {providerDisplayName(route.router)}
                  </span>
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
