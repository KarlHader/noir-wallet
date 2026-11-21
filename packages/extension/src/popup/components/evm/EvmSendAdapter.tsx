import { Icon } from '@iconify/react'
import { useEffect, useRef, type ComponentProps } from 'react'
import { formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { InlineError } from '@/popup/components/common/InlineError'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatPortfolioNetworkName } from '@/popup/services/portfolio-format'
import { getSwapQuoteNotice } from '@/popup/services/swap-quote-error-message'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import { SendRecipientAddress } from '@/popup/components/transaction/SendInputCards'
import { ExecutionAccountBadge } from '@/popup/components/account/ExecutionAccountSelector'
import {
  SendFormActions,
  SendRouteInfoCard,
  type SendFormAdapter
} from '../transaction/SendInputCards'
import { SendTransferScreen } from '../transaction/SendTransferView'
import type { SendReview } from '../transaction/TransactionReviewView'
import nearLogo from '@/images/figma-near-confidential.svg'
import { formatEvmWeiAsGwei } from '@/infrastructure/chains/evm'
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
        children: <EvmSendRouteDetails state={state} />
      }}
      review={{
        active: state.active,
        approving: state.approving,
        review: getEvmSendReview(state),
        titleId: 'evm-send-review-title',
        description: 'Review the asset, recipient, and maximum network fee before sending.',
        walletMode: state.walletMode,
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
  const { asset, chain, maximum, route, sendPrivately, transferAvailability } = state
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
      value: state.domainAvailableRaw === null ? null : transferAvailability.display,
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
      feedback: recipientInvalid && (
        <div className="flex items-start justify-between gap-3 px-1 text-xs text-danger">
          <p className="min-w-0 flex-1">
            {state.recipientPolicyError ?? 'Enter a valid non-zero EVM address.'}
          </p>
          {state.canMoveRecipient && state.recipientPolicyError && (
            <button
              type="button"
              onClick={() => void state.handleMoveRecipient()}
              className="inline-flex shrink-0 items-center gap-1 font-medium text-primary"
            >
              <Icon icon="lucide:arrow-right-left" width={13} height={13} aria-hidden="true" />
              Deposit
            </button>
          )}
        </div>
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
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-surface px-3 py-2.5 text-xs leading-5 text-warning">
          <Icon icon="lucide:triangle-alert" width={15} height={15} className="mt-0.5 shrink-0" />
          <span>
            {review.privacyWarning}
            {summary.review.level === 'caution' && !bundledAsset && (
              <>
                {review.privacyWarning ? ' ' : ''}This transfer calls a custom Token contract you
                added. Verify the network, Token, and recipient.
              </>
            )}
          </span>
        </div>
      ) : undefined,
    rows: [
      {
        label: 'Send from',
        content: (
          <span className="inline-flex min-w-0 max-w-full items-center justify-end gap-1.5">
            <ExecutionAccountBadge mode={review.sourceMode} />
            <span
              className="min-w-0 truncate font-mono text-sm"
              title={`${accountDisplayName}: ${summary.fields.from}`}
            >
              {formatSortAddress(summary.fields.from)}
            </span>
          </span>
        )
      },
      {
        label: 'Recipient',
        content: (
          <span className="inline-flex min-w-0 max-w-full items-center justify-end gap-1.5">
            {reviewRecipientRole !== 'unknown' && (
              <ExecutionAccountBadge
                mode={reviewRecipientRole === 'confidential' ? 'private' : 'main'}
              />
            )}
            <SendRecipientAddress address={review.recipient} name={recipientContactName} />
          </span>
        )
      },
      {
        label: 'Network',
        content: (
          <span className="inline-flex items-center justify-end gap-1.5">
            <ChainIcon
              chain={resolveChainIconAlias(
                chain.chain.family,
                chain.chain.displayName,
                chain.chain.id
              )}
              className="size-4"
            />
            {formatPortfolioNetworkName(chain)}
          </span>
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
    error: error ? <InlineError message={error} className="mt-3" /> : undefined
  }
}

function EvmSendRouteDetails({ state }: { readonly state: EvmSendTransferState }) {
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
              privateRouteCostFiat ? (
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
      {sendPrivately && !privatePreviewLoading && privatePreviewError && (
        <InlineError
          message={privatePreviewNotice ?? privatePreviewError}
          tone={privatePreviewNotice ? 'muted' : 'error'}
          onRetry={retryPrivatePreview}
          className="px-1"
        />
      )}

      {route === 'onchain' && (
        <SendRouteInfoCard
          fee={
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

      {amountRaw !== null && BigInt(amountRaw) > BigInt(availableRaw) && (
        <p role="alert" className="mt-3 text-xs text-danger">
          Insufficient {asset.metadata.symbol} balance.
        </p>
      )}
      {displayedError && (
        <InlineError
          message={displayedError}
          onRetry={maximumError ? handleMaximum : undefined}
          className="mt-3 px-1"
        />
      )}
      {route === 'pending' &&
        (support.loading ? (
          <p role="status" className="px-1 text-xs text-muted">
            Checking Confidential availability…
          </p>
        ) : (
          <InlineError
            message={
              support.support === 'unsupported'
                ? 'Confidential transfers are unavailable for this asset.'
                : 'Unable to check Confidential availability.'
            }
            onRetry={support.retry}
            className="px-1"
          />
        ))}
    </>
  )
}
