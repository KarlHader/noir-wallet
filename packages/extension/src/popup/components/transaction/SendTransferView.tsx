import { Icon } from '@iconify/react'
import type { ComponentProps, ReactNode } from 'react'
import { formatSortAddress } from '@/lib/format'
import { formatTokenQuantity } from '@/lib/number-format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import {
  TransactionReviewView,
  type TransactionReviewAsset,
  type TransactionReviewRow
} from './TransactionReviewView'
import {
  SendAssetHeader,
  SendAmountInputCard,
  SendFormActions,
  SendFormView,
  SendFieldLabel,
  SendRouteInfoCard,
  SendRecipientAddress,
  SendRecipientInputCard
} from './SendInputCards'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'

interface SendTransferReviewState {
  readonly recipient: string
  readonly sender: string
  readonly amount: string
  readonly fee: string
  readonly total: string | null
  readonly asset?: TransactionReviewAsset
  readonly feeContent?: ReactNode
  readonly networkBeforeSender?: boolean
  readonly beforeFeeRows?: readonly TransactionReviewRow[]
  readonly afterTotalRows?: readonly TransactionReviewRow[]
  readonly preparing?: boolean
}

export interface SendTransferViewState {
  readonly family: 'solana' | 'near' | 'bitcoin'
  readonly asset: Pick<
    ComponentProps<typeof SendAssetHeader>,
    'assetId' | 'symbol' | 'icon' | 'nativeChain' | 'blockchain'
  >
  readonly priceUsd: string | null
  readonly networkName: string
  readonly recipientPlaceholder: string
  readonly invalidRecipientMessage: string
  readonly reviewDescription: string
  readonly feeSymbol: string
  readonly totalLabel: string
  readonly amount: string
  readonly recipient: string
  readonly selectedRecipient: { readonly address: string; readonly name: string } | null
  readonly recipientInvalid: boolean
  readonly availableDisplay: string
  readonly balanceKnown?: boolean
  readonly insufficientBalance: boolean
  readonly maxSelected: boolean
  readonly maxDisabled: boolean
  readonly feePreviewLoading: boolean
  readonly previewFee: string
  readonly continueDisabled: boolean
  readonly continueLoading: boolean
  readonly approving: boolean
  readonly error: string | null
  readonly review: SendTransferReviewState | null
  readonly setInputAmount: (value: string) => void
  readonly setInputRecipient: (value: string) => void
  readonly selectRecipient: () => Promise<void>
  readonly selectMaximum: () => void
  readonly continueTransfer: () => Promise<void>
  readonly closeReview: () => Promise<void>
  readonly approveTransfer: () => Promise<void>
}

export function SendTransferView({
  state,
  routeInfo
}: {
  readonly state: SendTransferViewState
  readonly routeInfo?: ComponentProps<typeof SendRouteInfoCard>
}) {
  const { asset, family, networkName, feeSymbol, review, selectedRecipient, approving } = state
  const titleId = `${family}-send-review-title`
  const balanceKnown = state.balanceKnown ?? true

  return (
    <>
      <SendFormView
        domain="public"
        availableDomains={['public']}
        onDomainChange={() => {}}
        amountInput={
          <SendAmountInputCard
            ariaLabel={`${asset.symbol} amount`}
            value={state.amount}
            onChange={state.setInputAmount}
            available={state.availableDisplay}
            symbol={asset.symbol}
            priceUsd={state.priceUsd}
            inline
          />
        }
        assetSelector={<SendAssetHeader {...asset} networkName={networkName} variant="pill" />}
        balance={
          <span title={balanceKnown ? state.availableDisplay : undefined}>
            {balanceKnown ? formatTokenQuantity(state.availableDisplay) : '—'}
          </span>
        }
        maxButton={
          <button
            type="button"
            aria-label="Max"
            aria-pressed={state.maxSelected}
            disabled={state.maxDisabled}
            onClick={state.selectMaximum}
            className="rounded-md bg-white/10 px-2 py-1 font-medium text-muted aria-pressed:bg-primary/15 aria-pressed:text-primary disabled:opacity-40"
          >
            Max
          </button>
        }
        recipient={
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <SendFieldLabel>Send to</SendFieldLabel>
              <span>{networkName}</span>
            </div>
            <SendRecipientInputCard
              id={`${family}-send-recipient`}
              value={state.recipient}
              onChange={state.setInputRecipient}
              placeholder={state.recipientPlaceholder}
              variant="filled"
              hideLabel
              onSelectRecipient={() => void state.selectRecipient()}
            />
            {state.recipientInvalid && (
              <p className="mt-2 px-1 text-xs text-danger">{state.invalidRecipientMessage}</p>
            )}
          </div>
        }
        footer={
          <SendFormActions
            disabled={state.continueDisabled}
            loading={state.continueLoading}
            onContinue={() => void state.continueTransfer()}
          />
        }
      >
        <div>
          <SendRouteInfoCard
            fee={
              <span>
                {state.feePreviewLoading && (
                  <Icon
                    icon="lucide:loader-circle"
                    width={14}
                    height={14}
                    className="mr-1 inline animate-spin"
                  />
                )}
                {state.previewFee === '—' ? state.previewFee : `${state.previewFee} ${feeSymbol}`}
              </span>
            }
            {...routeInfo}
          />
        </div>
        {state.insufficientBalance && (
          <p role="alert" className="mt-3 text-xs text-danger">
            Insufficient {asset.symbol} balance.
          </p>
        )}
        {state.error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {state.error}
          </p>
        )}
      </SendFormView>

      <Dialog
        open={review !== null}
        onOpenChange={open => {
          if (!open && !approving) void state.closeReview()
        }}
      >
        <DialogContent
          position="bottom"
          className="flex h-dvh max-h-dvh flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-none"
          showCloseButton={false}
          aria-labelledby={titleId}
        >
          <DialogTitle className="sr-only" aria-hidden="true">
            Confirm Send
          </DialogTitle>
          <DialogDescription className="sr-only">{state.reviewDescription}</DialogDescription>
          {review && (
            <TransactionReviewView
              title="Confirm Send"
              titleId={titleId}
              variant="figma"
              asset={review.asset ?? asset}
              amount={review.amount}
              amountPrefix="-"
              network={networkName}
              rows={[
                {
                  label: 'Recipient',
                  content: (
                    <SendRecipientAddress
                      address={review.recipient}
                      name={
                        selectedRecipient?.address === review.recipient
                          ? selectedRecipient.name
                          : undefined
                      }
                    />
                  )
                },
                ...(review.networkBeforeSender ? [{ label: 'Network', content: networkName }] : []),
                {
                  label: 'From',
                  content: (
                    <span className="font-mono text-muted" title={review.sender}>
                      {formatSortAddress(review.sender)}
                    </span>
                  )
                },
                ...(!review.networkBeforeSender
                  ? [{ label: 'Network', content: networkName }]
                  : []),
                ...(review.beforeFeeRows ?? []),
                {
                  label: 'Network fee',
                  content: review.feeContent ?? (
                    <AmountDisplay value={review.fee} symbol={feeSymbol} profile="fee" />
                  )
                },
                ...(review.total !== null
                  ? [
                      {
                        label: state.totalLabel,
                        content: <AmountDisplay value={review.total} symbol={feeSymbol} />
                      }
                    ]
                  : []),
                ...(review.afterTotalRows ?? [])
              ]}
              confirmLabel="Confirm"
              confirming={approving}
              submitting={approving}
              preparing={review.preparing}
              cancelDisabled={approving}
              onCancel={() => void state.closeReview()}
              onConfirm={() => void state.approveTransfer()}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
