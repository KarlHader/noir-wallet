import { Icon } from '@iconify/react'
import { formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { InlineError } from '@/popup/components/common/InlineError'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import { SendRecipientAddress } from '@/popup/components/transaction/SendInputCards'
import { ExecutionAccountBadge } from '@/popup/components/account/ExecutionAccountSelector'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import { formatEvmWeiAsGwei } from '@/infrastructure/chains/evm'
import type { EvmSendTransferState } from '@/popup/hooks/useEvmSendTransfer'

export function EvmSendReviewView({ state }: { readonly state: EvmSendTransferState }) {
  const {
    active,
    walletMode,
    approving,
    handleCloseReview,
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
    nativeSymbol,
    handleReviewFeeSelectionChange,
    updatingFee,
    confirmationTime,
    maximumTotal,
    intentKey,
    error,
    handleApprove
  } = state
  return (
    <>
      <Dialog
        open={active && review !== null}
        onOpenChange={open => {
          if (!open && !approving) void handleCloseReview()
        }}
      >
        <DialogContent
          position="bottom"
          data-wallet-mode={walletMode}
          className="flex h-dvh max-h-dvh flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-none"
          showCloseButton={false}
          aria-labelledby="evm-send-review-title"
        >
          <DialogTitle className="sr-only" aria-hidden="true">
            Review Send
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review the asset, recipient, and maximum network fee before sending.
          </DialogDescription>

          {review && summary?.schema === 'evm.transaction.v1' && (
            <TransactionReviewView
              title="Confirm Send"
              titleId="evm-send-review-title"
              variant="figma"
              asset={{
                assetId: asset.asset.id,
                symbol: asset.metadata.symbol,
                icon: asset.metadata.iconUrl
              }}
              amount={review.amount}
              amountPrefix="-"
              fiatValue={reviewFiat}
              network={formatPortfolioNetworkName(chain)}
              notice={
                review.privacyWarning || (summary.review.level === 'caution' && !bundledAsset) ? (
                  <div className="mb-3 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-surface px-3 py-2.5 text-xs leading-5 text-warning">
                    <Icon
                      icon="lucide:triangle-alert"
                      width={15}
                      height={15}
                      className="mt-0.5 shrink-0"
                    />
                    <span>
                      {review.privacyWarning}
                      {summary.review.level === 'caution' && !bundledAsset && (
                        <>
                          {review.privacyWarning ? ' ' : ''}This transfer calls a custom Token
                          contract you added. Verify the network, Token, and recipient.
                        </>
                      )}
                    </span>
                  </div>
                ) : undefined
              }
              rows={[
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
                      <SendRecipientAddress
                        address={review.recipient}
                        name={recipientContactName}
                      />
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
                      tier={
                        review.feeSelection.kind === 'tier' ? review.feeSelection.tier : 'standard'
                      }
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
                                  value={formatEvmWeiAsGwei(
                                    summary.fields.maxPriorityFeePerGasWei ?? '0'
                                  )}
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
              ]}
              confirmLabel={review.privacyWarning ? 'Send anyway' : 'Confirm'}
              confirming={approving}
              submitting={approving}
              preparing={updatingFee}
              confirmDisabled={review.intentKey !== intentKey}
              error={error ? <InlineError message={error} className="mt-3" /> : undefined}
              cancelDisabled={approving}
              onCancel={() => void handleCloseReview()}
              onConfirm={handleApprove}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
