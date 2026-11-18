import { useState } from 'react'
import { Icon } from '@iconify/react'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import { formatChainName, formatSymbol } from '@/lib/format'
import { formatTokenQuantity } from '@/lib/number-format'
import { ChainSelector, type ChainSelectorOption } from '@/popup/components/common/ChainSelector'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { InlineError } from '@/popup/components/common/InlineError'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import {
  SendAmountInputCard,
  SendFieldLabel,
  SendRecipientInputCard,
  SendRouteInfoCard,
  SendAssetHeader,
  SendFormView,
  SendFormActions
} from './SendInputCards'

interface CrossChainSendFormViewProps {
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
  readonly sourceBadge?: string
  readonly onSelectSourceAsset?: () => void
  readonly onSelectShieldSource?: () => void
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
  sourceBadge,
  onSelectSourceAsset,
  onSelectShieldSource,
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
  const destinationName = tokenOut
    ? formatChainName(tokenOut.blockchain)
    : destinationNameFallback || 'Select network'

  return (
    <>
      <SendFormView
        domain={sourceBadge === 'Private' ? 'private' : 'public'}
        availableDomains={
          sourceBadge === 'Private'
            ? ['private']
            : onSelectShieldSource
              ? ['public', 'shield']
              : ['public']
        }
        onDomainChange={domain => {
          if (domain === 'shield') onSelectShieldSource?.()
        }}
        disabled={initializing}
        recipient={
          <div className="order-2">
            <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
              <SendFieldLabel>Send to</SendFieldLabel>
              <button
                type="button"
                onClick={() => setNetworkPickerOpen(true)}
                disabled={
                  initializing || (destinationAssetsLoading && destinationOptions.length === 0)
                }
                aria-label={`Select destination network, ${destinationName}`}
                className="inline-flex min-w-0 items-center gap-1.5 text-xs hover:text-primary disabled:opacity-50"
              >
                {(tokenOut || destinationNameFallback) && (
                  <ChainIcon
                    chain={tokenOut?.blockchain ?? destinationNameFallback ?? ''}
                    width={16}
                    height={16}
                    showTooltip={false}
                  />
                )}
                <span className="max-w-32 truncate">{destinationName}</span>
                <Icon icon="lucide:chevron-down" width={13} height={13} />
              </button>
            </div>
            <SendRecipientInputCard
              id="cross-chain-send-recipient"
              value={recipient}
              onChange={onRecipientChange}
              placeholder="Enter address"
              hideLabel
              disabled={initializing}
              variant="filled"
              invalid={Boolean(recipientError)}
              onSelectRecipient={onSelectRecipient}
            />
            {recipientError && <InlineError message={recipientError} className="mt-2" />}
          </div>
        }
        amountInput={
          <SendAmountInputCard
            ariaLabel={`${sourceSymbol} amount`}
            value={amount}
            onChange={onAmountChange}
            available={spendableBalance}
            symbol={sourceSymbol}
            inline
            disabled={initializing || sourceAssetsLoading}
          />
        }
        assetSelector={
          <SendAssetHeader
            assetId={tokenIn?.assetId}
            symbol={sourceSymbol}
            icon={tokenIn?.icon ?? undefined}
            networkName={
              tokenIn ? formatChainName(tokenIn.blockchain) : (sourceNetworkNameFallback ?? '')
            }
            blockchain={tokenIn?.blockchain ?? sourceNetworkNameFallback}
            variant="pill"
            onSelectAsset={onSelectSourceAsset}
          />
        }
        balance={formatTokenQuantity(spendableBalance)}
        maxButton={
          <button
            type="button"
            onClick={onMaxClick}
            disabled={initializing || !onMaxClick || maxLoading || maxDisabled}
            title={maxDisabled ? maxDisabledReason : 'Max'}
            aria-label="Max"
            className="rounded-md bg-white/10 px-2 py-1 font-medium text-muted disabled:opacity-40"
          >
            {maxLoading ? (
              <Icon icon="lucide:loader-circle" className="size-3 animate-spin" />
            ) : (
              'Max'
            )}
          </button>
        }
        footer={
          <SendFormActions
            onContinue={onReview}
            disabled={initializing || !canGetQuote || hasInsufficientFunds || isQuoting}
            loading={actionLoading}
          />
        }
      >
        {hasInsufficientFunds && (
          <InlineError message={insufficientMessage ?? 'Insufficient balance'} />
        )}

        <SendRouteInfoCard
          provider={
            isQuoting ? (
              <span role="status" className="inline-flex items-center gap-1.5 text-muted">
                <Icon icon="lucide:loader-circle" className="size-3.5 animate-spin" aria-hidden />
                Calculating quote…
              </span>
            ) : (
              (providerName ?? '—')
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
            <>
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
              {!isQuoting && tokenOut && estimatedOut && (
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="text-muted">Est. receive</span>
                  <span
                    className="min-w-0 truncate text-right"
                    title={`${estimatedOut} ${sourceSymbol}`}
                  >
                    {formatTokenQuantity(estimatedOut)} {sourceSymbol}
                  </span>
                </div>
              )}
            </>
          }
        />
        {catalogError && <InlineError message="Unable to load assets" onRetry={onRetryCatalog} />}
        {quoteError && (
          <InlineError message={quoteError} onRetry={onRetryQuote} retrying={isQuoting} />
        )}
      </SendFormView>
      <ChainSelector
        open={networkPickerOpen}
        onOpenChange={setNetworkPickerOpen}
        options={destinationOptions}
        enabledFirst
        loading={destinationNetworksLoading}
        allowSelectionWhileLoading
        selectedId={tokenOut?.rheaChainId ?? selectedDestinationChainId ?? null}
        onSelect={onSelectDestination}
      />
    </>
  )
}
