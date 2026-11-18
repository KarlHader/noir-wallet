import { Icon } from '@iconify/react'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { InlineError } from '@/popup/components/common/InlineError'
import nearLogo from '@/images/figma-near-confidential.svg'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import { SendRouteInfoCard } from '@/popup/components/transaction/SendInputCards'
import type { EvmSendTransferState } from '@/popup/hooks/useEvmSendTransfer'

export function EvmSendRoutePanels({ state }: { readonly state: EvmSendTransferState }) {
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
          extra={
            privatePreviewReady && privatePreview ? (
              <div className="flex justify-between gap-3 border-t border-white/10 pt-3">
                <span className="text-muted">Est. receive</span>
                <AmountDisplay
                  value={privatePreview.estimatedReceive}
                  symbol={asset.metadata.symbol}
                />
              </div>
            ) : undefined
          }
        />
      )}
      {sendPrivately && privatePreviewError && (
        <InlineError message={privatePreviewError} onRetry={retryPrivatePreview} className="px-1" />
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
