import { QuoteFeeAmount } from '@/popup/components/transaction/QuoteFeeAmount'
import { Icon } from '@iconify/react'
import { useEffect, useRef, type ComponentProps } from 'react'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TransactionNotice } from '@/popup/components/transaction/TransactionNotice'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatInsufficientBalance } from '@/lib/format'
import { formatPortfolioNetworkName } from '@/popup/services/portfolio-format'
import { getSwapQuoteNotice } from '@/popup/services/swap-quote-error-message'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import { TransactionReviewParty } from '@/popup/components/transaction/TransactionReviewParty'
import {
  SendFormActions,
  SendRouteInfoCard,
  type SendFormAdapter
} from '../transaction/SendInputCards'
import { SendTransferScreen } from '../transaction/SendTransferView'
import type { SendReview } from '../transaction/TransactionReviewView'
import nearLogo from '@/images/figma-near-confidential.svg'
import { formatEvmWeiAsGwei } from '@/infrastructure/chains/evm'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { useEvmSendTransfer, type EvmSendTransferState } from '@/popup/hooks/useEvmSendTransfer'

export type EvmSendAdapterProps = Parameters<typeof useEvmSendTransfer>[0] & {
  readonly shieldModeRequest?: number
}

export function EvmSendAdapter(props: EvmSendAdapterProps) {
  const state = useEvmSendTransfer(props)
  const handledShieldModeRequest = useRef(props.shieldModeRequest ?? 0)
  useEffect(() => {
    if (handledShieldModeRequest.current === props.shieldModeRequest) return
    handledShieldModeRequest.current = props.shieldModeRequest ?? 0
    if (!state.active || state.preparing || state.approving || state.updatingFee || state.review)
      return
    state.selectShield('shield')
  }, [props.shieldModeRequest, state])

  const fields = getEvmSendFields(state)
  const actions = getEvmSendActions(state)
  return (
    <SendTransferScreen
      form={{
        inline: !state.active,
        adapter: fields,
        footer: <SendFormActions {...actions} />,
        children: <EvmSendRouteDetails state={state} showNotice={!fields.recipient.invalid} />
      }}
      review={{
        active: state.active,
        approving: state.approving,
        review: getEvmSendReview(state),
        titleId: 'evm-send-review-title',
        description: 'Review the asset, recipient, and maximum network fee before sending.',
        onCancel: () => void state.handleCloseReview(),
        onConfirm: state.handleApprove
      }}
      destinationPicker={
        fields.recipient.network.onSelect
          ? {
              open: state.networkPickerOpen,
              onOpenChange: state.setNetworkPickerOpen,
              selectedId: state.chain.chain.id,
              options: state.destinationNetworkOptions,
              onSelect: state.selectDestinationNetwork
            }
          : undefined
      }
    />
  )
}

function getEvmSendFields(state: EvmSendTransferState): SendFormAdapter {
  const { asset, chain, maximum, route, sendPrivately } = state
  const symbol = asset.metadata.symbol
  const network = chain.chain.displayName
  const networkIcon = resolveChainIconAlias(chain.chain.family, network, chain.chain.id)
  const canSelectNetwork =
    !sendPrivately && (state.destinationNetworks.length > 1 || state.networkPickerOpen)
  const recipientInvalid = Boolean(state.recipient && !state.validRecipient)
  return {
    amount: {
      ariaLabel: `${symbol} amount`,
      value: state.amount,
      onChange: state.setInputAmount
    },
    asset: {
      assetId: asset.asset.id,
      symbol,
      icon: asset.metadata.iconUrl,
      networkName: network,
      blockchain: networkIcon,
      onSelectAsset: state.selectAsset
    },
    balance: {
      value:
        state.domainAvailableRaw === null
          ? null
          : formatBaseUnitDecimalAmount(state.availableRaw, asset.metadata.decimals),
      testId: 'send-available-balance'
    },
    maximum: {
      selected: state.maxHighlighted,
      disabled:
        route === 'pending' ||
        !state.sourceAddress ||
        BigInt(state.availableRaw) <= 0n ||
        (asset.asset.kind === 'native' && !state.validRecipient) ||
        maximum.loading,
      onClick: state.selectMaximum
    },
    recipient: {
      id: 'evm-send-recipient',
      value: state.recipient,
      onChange: state.setInputRecipient,
      placeholder: 'Enter address',
      invalid: recipientInvalid,
      network: {
        name: network,
        icon: networkIcon,
        onSelect: canSelectNetwork ? state.openDestinationNetworks : undefined
      },
      onSelectRecipient: () => void state.handleSelectRecipient(),
      notice: recipientInvalid && (
        <TransactionNotice
          id="evm-send-recipient-error"
          tone={state.canMoveRecipient && state.recipientPolicyError ? 'warning' : 'error'}
          message={state.recipientPolicyError ?? 'Enter a valid non-zero EVM address.'}
          onRetry={
            state.canMoveRecipient && state.recipientPolicyError
              ? () => void state.handleMoveRecipient()
              : undefined
          }
          retryLabel="Deposit"
        />
      )
    }
  }
}

function getEvmSendActions(state: EvmSendTransferState): ComponentProps<typeof SendFormActions> {
  const { route, sendPrivately, feePreview, maximum } = state
  return {
    privacy:
      state.sourceMode === 'main' &&
      state.networkMode === 'mainnet' &&
      state.support.support !== 'unsupported'
        ? { checked: sendPrivately, onChange: state.togglePrivacyRoute }
        : undefined,
    disabled:
      !state.validAmount ||
      !state.validRecipient ||
      state.maximumPending ||
      !state.sourceAddress ||
      route === 'pending' ||
      (sendPrivately && !state.privatePreviewReady) ||
      state.tokenFeeBalanceError !== null ||
      (route === 'onchain' && feePreview.loading),
    loading:
      state.preparing ||
      (state.maxSelected && maximum.loading) ||
      (route === 'onchain' && feePreview.loading) ||
      (state.privatePreviewKey !== null && state.privatePreviewLoading),
    onContinue: state.handleContinue
  }
}

function getEvmSendReview(state: EvmSendTransferState): SendReview | null {
  const {
    approving,
    review,
    summary,
    asset,
    reviewFiat,
    chain,
    bundledAsset,
    accountDisplayName,
    reviewRecipientRole,
    recipientContactName,
    fee,
    loadTierPreviews,
    nativeSymbol,
    handleReviewFeeSelectionChange,
    updatingFee,
    confirmationTime,
    maximumTotal,
    intentKey,
    error
  } = state
  if (!review || summary?.schema !== 'evm.transaction.v1') return null
  return {
    asset: {
      assetId: asset.asset.id,
      symbol: asset.metadata.symbol,
      icon: asset.metadata.iconUrl
    },
    amount: review.amount,
    fiatValue: reviewFiat,
    network: formatPortfolioNetworkName(chain),
    notice:
      review.privacyWarning || (summary.review.level === 'caution' && !bundledAsset) ? (
        <TransactionNotice
          className="mb-3"
          tone="warning"
          message={
            <>
              {review.privacyWarning}
              {summary.review.level === 'caution' && !bundledAsset && (
                <>
                  {review.privacyWarning ? ' ' : ''}This transfer calls a custom Token contract you
                  added. Verify the network, Token, and recipient.
                </>
              )}
            </>
          }
        />
      ) : undefined,
    rows: [
      {
        label: 'Send from',
        content: (
          <TransactionReviewParty
            accountName={accountDisplayName}
            domain={review.sourceMode === 'private' ? 'private' : 'public'}
            address={summary.fields.from}
            chain={chain.chain}
          />
        )
      },
      {
        label: 'Recipient',
        content: (
          <TransactionReviewParty
            accountName={recipientContactName}
            domain={
              reviewRecipientRole === 'unknown'
                ? undefined
                : reviewRecipientRole === 'confidential'
                  ? 'private'
                  : 'public'
            }
            address={review.recipient}
            chain={chain.chain}
          />
        )
      },
      {
        label: 'Network fee',
        content: (
          <NetworkFeeTierPicker
            chainFamily="evm"
            tier={review.feeSelection.kind === 'tier' ? review.feeSelection.tier : 'standard'}
            selection={review.feeSelection}
            feeModel={summary.fields.transactionType === 'legacy' ? 'legacy' : 'eip1559'}
            customDefaults={{
              gasLimit: summary.fields.gasLimit,
              maxFeePerGasWei: summary.fields.maxFeePerGasWei ?? '0',
              maxPriorityFeePerGasWei: summary.fields.maxPriorityFeePerGasWei ?? '0',
              gasPriceWei: summary.fields.gasPriceWei
            }}
            amount={fee}
            symbol={nativeSymbol}
            onTierChange={tier => handleReviewFeeSelectionChange({ kind: 'tier', tier })}
            onSelectionChange={handleReviewFeeSelectionChange}
            loadTierPreviews={loadTierPreviews}
            disabled={updatingFee || approving}
            details={
              <div className="space-y-2 border-t border-border/60 pt-3 text-xs">
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Gas limit</span>
                  <span>{summary.fields.gasLimit}</span>
                </div>
                {summary.fields.transactionType === 'legacy' ? (
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Gas price</span>
                    <AmountDisplay
                      value={formatEvmWeiAsGwei(summary.fields.gasPriceWei ?? '0')}
                      symbol="GWEI"
                      profile="fee"
                    />
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted">Max fee per gas</span>
                      <AmountDisplay
                        value={formatEvmWeiAsGwei(summary.fields.maxFeePerGasWei ?? '0')}
                        symbol="GWEI"
                        profile="fee"
                      />
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted">Priority fee per gas</span>
                      <AmountDisplay
                        value={formatEvmWeiAsGwei(summary.fields.maxPriorityFeePerGasWei ?? '0')}
                        symbol="GWEI"
                        profile="fee"
                      />
                    </div>
                  </>
                )}
              </div>
            }
          />
        )
      },
      {
        label: 'Est. time',
        content: (
          <span title="Estimated first confirmation based on recent blocks.">
            {confirmationTime}
          </span>
        )
      },
      ...(maximumTotal
        ? [
            {
              label: 'Maximum total',
              content: <AmountDisplay value={maximumTotal} symbol={nativeSymbol} />
            }
          ]
        : [])
    ],
    confirmLabel: review.privacyWarning ? 'Send anyway' : 'Confirm',
    preparing: updatingFee,
    confirmDisabled: review.intentKey !== intentKey,
    error: error ? <TransactionNotice message={error} className="mt-3" /> : undefined
  }
}

function EvmSendRouteDetails({
  state,
  showNotice
}: {
  readonly state: EvmSendTransferState
  readonly showNotice: boolean
}) {
  const {
    sendPrivately,
    privatePreviewLoading,
    privatePreviewReady,
    privatePreview,
    privateRouteCostFiat,
    asset,
    privatePreviewError,
    retryPrivatePreview,
    route,
    feeSelection,
    feePreview,
    loadTierPreviews,
    previewFee,
    nativeSymbol,
    handleFormFeeSelectionChange,
    confirmationTime,
    amountRaw,
    availableRaw,
    displayedError,
    maximumError,
    handleMaximum,
    support
  } = state
  const privatePreviewNotice = getSwapQuoteNotice(privatePreviewError)
  const insufficient = amountRaw !== null && BigInt(amountRaw) > BigInt(availableRaw)
  return (
    <>
      {sendPrivately && (
        <SendRouteInfoCard
          provider={
            <span className="inline-flex items-center gap-2">
              <img src={nearLogo} alt="" className="size-5 rounded" />
              NEAR Confidential Intents
              {privatePreviewLoading && (
                <Icon
                  icon="lucide:loader-circle"
                  width={14}
                  height={14}
                  className="animate-spin text-muted"
                />
              )}
            </span>
          }
          fee={
            privatePreviewReady && privatePreview ? (
              privatePreview.quote.appFeeBps ? (
                <QuoteFeeAmount
                  sourceAmountRaw={privatePreview.sourceAmountRaw}
                  decimals={asset.metadata.decimals}
                  symbol={asset.metadata.symbol}
                  bps={privatePreview.quote.appFeeBps}
                  fallbackAmount={privatePreview.routeCost}
                />
              ) : privateRouteCostFiat ? (
                `~${privateRouteCostFiat}`
              ) : privatePreview.routeCost === null ? (
                '—'
              ) : (
                <AmountDisplay
                  value={privatePreview.routeCost}
                  symbol={asset.metadata.symbol}
                  profile="fee"
                />
              )
            ) : (
              '—'
            )
          }
          estimatedReceive={
            privatePreviewReady && privatePreview
              ? { value: privatePreview.estimatedReceive, symbol: asset.metadata.symbol }
              : undefined
          }
        />
      )}
      {route === 'onchain' && (
        <SendRouteInfoCard
          networkFee={
            <NetworkFeeTierPicker
              chainFamily="evm"
              tier={feeSelection.kind === 'tier' ? feeSelection.tier : 'standard'}
              selection={feeSelection}
              customDefaults={feePreview.details}
              feeModel={
                feePreview.details?.transactionType ??
                (feeSelection.kind === 'legacy' ? 'legacy' : 'eip1559')
              }
              amount={previewFee}
              symbol={nativeSymbol}
              layout="inline"
              disabled={feePreview.loading}
              onTierChange={tier => handleFormFeeSelectionChange({ kind: 'tier', tier })}
              onSelectionChange={handleFormFeeSelectionChange}
              loadTierPreviews={feePreview.details ? loadTierPreviews : undefined}
            />
          }
          time={
            confirmationTime === '—' ? undefined : (
              <span title="Approximate first confirmation; actual time depends on network conditions.">
                {confirmationTime}
              </span>
            )
          }
        />
      )}

      {!showNotice ? null : displayedError ? (
        <TransactionNotice
          message={displayedError}
          onRetry={maximumError ? handleMaximum : undefined}
          className="mt-3"
        />
      ) : insufficient ? (
        <TransactionNotice
          message={formatInsufficientBalance(asset.metadata.symbol)}
          tone="warning"
        />
      ) : sendPrivately && !privatePreviewLoading && privatePreviewError ? (
        <TransactionNotice
          message={privatePreviewNotice ?? privatePreviewError}
          tone={privatePreviewNotice ? 'muted' : 'warning'}
          onRetry={retryPrivatePreview}
        />
      ) : route === 'pending' ? (
        support.loading ? (
          <p role="status" className="px-1 text-xs text-muted">
            Checking Confidential availability…
          </p>
        ) : (
          <TransactionNotice
            message={
              support.support === 'unsupported'
                ? 'Confidential transfers are unavailable for this asset.'
                : 'Unable to check Confidential availability.'
            }
            onRetry={support.retry}
          />
        )
      ) : null}
    </>
  )
}
