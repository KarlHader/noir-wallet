import { Icon } from '@iconify/react'
import { TransactionNotice } from './TransactionNotice'
import type { ComponentProps, ReactNode } from 'react'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { ChainSelector } from '../common/ChainSelector'
import {
  SendReviewDialog,
  type TransactionReviewAsset,
  type TransactionReviewRow
} from './TransactionReviewView'
import { type SendFormAdapter, SendFormActions, SendRouteInfoCard } from './SendInputCards'
import { SendFormSlot } from './SendFormLayout'
import { TransactionReviewParty } from './TransactionReviewParty'

type DestinationPicker = Pick<
  ComponentProps<typeof ChainSelector>,
  'open' | 'onOpenChange' | 'selectedId' | 'options' | 'onSelect'
>

export function SendTransferScreen({
  form,
  review,
  destinationPicker
}: {
  readonly form: ComponentProps<typeof SendFormSlot>
  readonly review: ComponentProps<typeof SendReviewDialog>
  readonly destinationPicker?: DestinationPicker
}) {
  return (
    <>
      <SendFormSlot {...form} />
      {destinationPicker && (
        <ChainSelector
          {...destinationPicker}
          enabledFirst
          label={`Networks for ${form.adapter.asset.symbol}`}
        />
      )}
      <SendReviewDialog {...review} />
    </>
  )
}

interface SendTransferReviewState {
  readonly recipient: string
  readonly sender: string
  readonly amount: string
  readonly fee: string
  readonly total: string | null
  readonly asset?: TransactionReviewAsset
  readonly feeContent?: ReactNode
  readonly beforeFeeRows?: readonly TransactionReviewRow[]
  readonly afterTotalRows?: readonly TransactionReviewRow[]
  readonly preparing?: boolean
}

export interface SendTransferViewState {
  readonly family: 'solana' | 'near' | 'bitcoin'
  readonly asset: Pick<
    SendFormAdapter['asset'],
    'assetId' | 'symbol' | 'icon' | 'nativeChain' | 'blockchain' | 'onSelectAsset'
  >
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
  readonly privacy?: { readonly checked: boolean; readonly onChange: () => void }
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
  shareForm = false,
  routeInfo,
  networkSelection
}: {
  readonly state: SendTransferViewState
  readonly shareForm?: boolean
  readonly routeInfo?: ComponentProps<typeof SendRouteInfoCard>
  readonly networkSelection?: {
    readonly trigger: Omit<SendFormAdapter['recipient']['network'], 'name'>
    readonly picker: DestinationPicker
  }
}) {
  const { asset, family, networkName, feeSymbol, review, selectedRecipient, approving } = state
  const titleId = `${family}-send-review-title`
  const balanceKnown = state.balanceKnown ?? true

  return (
    <SendTransferScreen
      destinationPicker={networkSelection?.picker}
      form={{
        inline: !shareForm,
        adapter: {
          amount: {
            ariaLabel: `${asset.symbol} amount`,
            value: state.amount,
            onChange: state.setInputAmount
          },
          asset: { ...asset, networkName },
          balance: { value: balanceKnown ? state.availableDisplay : null },
          maximum: {
            selected: state.maxSelected,
            disabled: state.maxDisabled,
            onClick: state.selectMaximum
          },
          recipient: {
            id: `${family}-send-recipient`,
            value: state.recipient,
            onChange: state.setInputRecipient,
            placeholder: state.recipientPlaceholder,
            invalid: state.recipientInvalid,
            network: { name: networkName, ...networkSelection?.trigger },
            onSelectRecipient: () => void state.selectRecipient(),
            feedback: state.recipientInvalid && (
              <TransactionNotice message={state.invalidRecipientMessage} />
            )
          }
        },
        footer: (
          <SendFormActions
            disabled={state.continueDisabled}
            loading={state.continueLoading}
            onContinue={() => void state.continueTransfer()}
            privacy={state.privacy}
          />
        ),
        children: (
          <>
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
                    {state.previewFee === '—'
                      ? state.previewFee
                      : `${state.previewFee} ${feeSymbol}`}
                  </span>
                }
                {...routeInfo}
              />
            </div>
            {!state.recipientInvalid && (
              <TransactionNotice
                className="mt-3"
                tone={state.error ? 'error' : 'warning'}
                message={
                  state.error ??
                  (state.insufficientBalance ? `Insufficient ${asset.symbol} balance.` : null)
                }
              />
            )}
          </>
        )
      }}
      review={{
        titleId,
        description: state.reviewDescription,
        approving,
        onCancel: () => void state.closeReview(),
        onConfirm: () => void state.approveTransfer(),
        review: review && {
          asset: review.asset ?? asset,
          amount: review.amount,
          network: networkName,
          rows: [
            {
              label: 'Recipient',
              content: (
                <TransactionReviewParty
                  address={review.recipient}
                  chain={{ name: networkName, icon: family }}
                  accountName={
                    selectedRecipient?.address === review.recipient
                      ? selectedRecipient.name
                      : undefined
                  }
                />
              )
            },
            {
              label: 'From',
              content: (
                <TransactionReviewParty
                  domain="public"
                  address={review.sender}
                  chain={{ name: networkName, icon: family }}
                />
              )
            },
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
          ],
          confirmLabel: 'Confirm',
          preparing: review.preparing
        }
      }}
    />
  )
}
