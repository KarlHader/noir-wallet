import { useState } from 'react'
import { Icon } from '@iconify/react'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import { formatChainName, formatSymbol } from '@/lib/format'
import { ChainSelector, type ChainSelectorOption } from '@/popup/components/common/ChainSelector'
import { InlineError } from '@/popup/components/common/InlineError'
import { getSwapQuoteNotice } from '@/popup/services/swap-quote-error-message'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { RouteProviderLabel } from './RouteProviderLabel'
import { SendRouteInfoCard, SendFormActions } from './SendInputCards'
import { SendFormSlot } from './SendFormLayout'

interface CrossChainSendFormViewProps {
  readonly shareForm: boolean
  readonly tokenIn: RheaSwapToken | null
  readonly tokenOut: RheaSwapToken | null
  readonly destinationOptions: readonly ChainSelectorOption[]
  readonly selectedDestinationChainId?: string | null
  readonly onSelectDestination: (chainId: string) => void
  readonly amount: string
  readonly estimatedOut: string
  readonly routeCost?: string | null
  readonly recipient: string
  readonly spendableBalance: string
  readonly onSelectSourceAsset?: () => void
  readonly initializing?: boolean
  readonly destinationNameFallback?: string
  readonly sourceSymbolFallback?: string
  readonly sourceNetworkNameFallback?: string
  readonly isQuoting: boolean
  readonly quoteError?: string | null
  readonly recipientError?: string | null
  readonly catalogError: boolean
  readonly sourceAssetsLoading: boolean
  readonly destinationAssetsLoading: boolean
  readonly destinationNetworksLoading?: boolean
  readonly hasInsufficientFunds: boolean
  readonly insufficientMessage?: string
  readonly maxLoading: boolean
  readonly maxDisabled: boolean
  readonly maxDisabledReason?: string
  readonly canGetQuote: boolean
  readonly actionLoading: boolean
  readonly providerName?: string
  readonly slippage: number
  readonly onAmountChange: (value: string) => void
  readonly onMaxClick?: () => void
  readonly onRecipientChange: (value: string) => void
  readonly onSelectRecipient?: () => void
  readonly onRetryCatalog: () => void
  readonly onRetryQuote?: () => void
  readonly onOpenSlippage: () => void
  readonly onReview: () => void
}

export function CrossChainSendFormView({
  shareForm,
  tokenIn,
  tokenOut,
  destinationOptions,
  selectedDestinationChainId,
  onSelectDestination,
  amount,
  estimatedOut,
  routeCost,
  recipient,
  spendableBalance,
  onSelectSourceAsset,
  initializing = false,
  destinationNameFallback,
  sourceSymbolFallback,
  sourceNetworkNameFallback,
  isQuoting,
  quoteError,
  recipientError,
  catalogError,
  sourceAssetsLoading,
  destinationAssetsLoading,
  destinationNetworksLoading = false,
  hasInsufficientFunds,
  insufficientMessage,
  maxLoading,
  maxDisabled,
  maxDisabledReason,
  canGetQuote,
  actionLoading,
  providerName,
  slippage,
  onAmountChange,
  onMaxClick,
  onRecipientChange,
  onSelectRecipient,
  onRetryCatalog,
  onRetryQuote,
  onOpenSlippage,
  onReview
}: CrossChainSendFormViewProps) {
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const sourceSymbol = formatSymbol(tokenIn?.symbol) || sourceSymbolFallback || 'Token'
  const quoteNotice = getSwapQuoteNotice(quoteError)
  const destinationId = selectedDestinationChainId ?? tokenOut?.rheaChainId ?? null
  const destination = destinationOptions.find(option => option.id === destinationId)
  const destinationName =
    destination?.name ??
    destinationNameFallback ??
    (tokenOut ? formatChainName(tokenOut.blockchain) : 'Select network')

  return (
    <>
      <SendFormSlot
        inline={!shareForm}
        adapter={{
          recipient: {
            id: 'cross-chain-send-recipient',
            value: recipient,
            onChange: onRecipientChange,
            placeholder: 'Enter address',
            readOnly: initializing,
            invalid: Boolean(recipientError),
            onSelectRecipient,
            feedback: recipientError && <InlineError message={recipientError} />,
            network: {
              name: destinationName,
              icon: destination?.icon ?? tokenOut?.blockchain ?? destinationNameFallback,
              onSelect: () => setNetworkPickerOpen(true),
              disabled:
                initializing || (destinationAssetsLoading && destinationOptions.length === 0)
            }
          },
          amount: {
            ariaLabel: `${sourceSymbol} amount`,
            value: amount,
            onChange: onAmountChange,
            disabled: initializing || sourceAssetsLoading
          },
          asset: {
            assetId: tokenIn?.assetId,
            symbol: sourceSymbol,
            icon: tokenIn?.icon ?? undefined,
            networkName: tokenIn
              ? formatChainName(tokenIn.blockchain)
              : (sourceNetworkNameFallback ?? ''),
            blockchain: tokenIn?.blockchain ?? sourceNetworkNameFallback,
            onSelectAsset: onSelectSourceAsset
          },
          balance: { value: spendableBalance },
          maximum: {
            onClick: onMaxClick,
            disabled: initializing || !onMaxClick || maxLoading || maxDisabled,
            title: maxDisabled ? maxDisabledReason : 'Max',
            loading: maxLoading
          }
        }}
        footer={
          <SendFormActions
            onContinue={onReview}
            disabled={initializing || !canGetQuote || hasInsufficientFunds || isQuoting}
            loading={actionLoading || isQuoting}
          />
        }
      >
        {hasInsufficientFunds && (
          <InlineError message={insufficientMessage ?? 'Insufficient balance'} tone="muted" />
        )}

        <SendRouteInfoCard
          provider={
            isQuoting ? (
              <span role="status" className="inline-flex items-center gap-1.5 text-muted">
                <Icon icon="lucide:loader-circle" className="size-3.5 animate-spin" aria-hidden />
                Calculating quote…
              </span>
            ) : providerName ? (
              <RouteProviderLabel router={providerName} />
            ) : (
              '—'
            )
          }
          feeLabel="Route cost (est.)"
          fee={
            isQuoting || routeCost === undefined ? (
              '—'
            ) : routeCost === null ? (
              'Unavailable'
            ) : (
              <AmountDisplay value={routeCost} symbol={sourceSymbol} profile="fee" />
            )
          }
          extra={
            <div className="flex min-h-5 items-center justify-between gap-3">
              <span className="text-muted">Slippage</span>
              <button
                type="button"
                onClick={onOpenSlippage}
                disabled={initializing}
                className="inline-flex items-center gap-1 hover:text-primary"
                aria-label={`Set slippage, currently ${slippage}%`}
              >
                {slippage}% <Icon icon="lucide:chevron-down" width={12} />
              </button>
            </div>
          }
          estimatedReceive={
            !isQuoting && tokenOut && estimatedOut
              ? { value: estimatedOut, symbol: formatSymbol(tokenOut.symbol) || sourceSymbol }
              : undefined
          }
        />
        {catalogError ? (
          <InlineError message="Unable to load assets" onRetry={onRetryCatalog} />
        ) : !isQuoting && !recipientError && quoteError ? (
          <InlineError
            message={quoteNotice ?? quoteError}
            tone={quoteNotice ? 'muted' : 'error'}
            onRetry={onRetryQuote}
          />
        ) : null}
      </SendFormSlot>
      <ChainSelector
        open={networkPickerOpen}
        onOpenChange={setNetworkPickerOpen}
        options={destinationOptions}
        enabledFirst
        loading={destinationNetworksLoading}
        allowSelectionWhileLoading
        selectedId={destinationId}
        onSelect={onSelectDestination}
      />
    </>
  )
}
