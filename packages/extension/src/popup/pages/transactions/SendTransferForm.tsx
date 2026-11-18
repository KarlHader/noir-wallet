import { Icon } from '@iconify/react'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { bitcoinAccountTypeDescription } from '@/popup/components/bitcoin/BitcoinAccountTypeSelector'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import { EvmSendTransferView } from '@/popup/components/transaction/EvmSendTransferView'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import { SendTransferView } from '@/popup/components/transaction/SendTransferView'
import { useBitcoinSendTransfer } from '@/popup/hooks/useBitcoinSendTransfer'
import { useEvmSendTransfer } from '@/popup/hooks/useEvmSendTransfer'
import { useSendTransfer, type SendTransferConfig } from '@/popup/hooks/useSendTransfer'
import type { BitcoinTransferSubmission } from '@/popup/services/bitcoin-wallet-client'
import {
  nearWalletClient,
  type NearTransferReview,
  type NearTransferSubmission
} from '@/popup/services/near-wallet-client'
import { estimateBitcoinSendTime } from '@/popup/services/send-time-estimate'
import {
  estimateSolanaFee,
  matchesNearReview,
  matchesSolanaReview
} from '@/popup/services/send-transfer-model'
import {
  solanaWalletClient,
  type SolanaTransferReview,
  type SolanaTransferSubmission
} from '@/popup/services/solana-wallet-client'
import {
  getNearSendApprovalError,
  getNearSendPrepareError
} from '@/popup/services/near-send-validation'
import {
  getSolanaSendApprovalError,
  getSolanaSendPrepareError
} from '@/popup/services/solana-send-validation'

export type SendTransferSubmission =
  | { readonly family: 'bitcoin'; readonly value: BitcoinTransferSubmission }
  | { readonly family: 'solana'; readonly value: SolanaTransferSubmission }
  | { readonly family: 'near'; readonly value: NearTransferSubmission }

interface SendTransferFormProps {
  readonly family: SendTransferSubmission['family']
  readonly selection: { readonly asset: PortfolioAssetView; readonly chain: PortfolioChainView }
  readonly priceUsd: string | null
  readonly initialRecipient?: string
  readonly initialAmount?: string
  readonly onDraftChange?: (
    assetId: string,
    draft: Readonly<{ recipient: string; amount: string }>
  ) => void
  readonly onSubmitted: (submission: SendTransferSubmission) => void
}

type EvmTransferProps = Parameters<typeof useEvmSendTransfer>[0]

export function SendTransferForm(
  props: SendTransferFormProps | (EvmTransferProps & { readonly family: 'evm' })
) {
  if (props.family === 'evm') return <EvmTransfer {...props} />

  const {
    family,
    selection,
    priceUsd,
    initialRecipient,
    initialAmount,
    onDraftChange,
    onSubmitted
  } = props

  switch (family) {
    case 'bitcoin':
      return <BitcoinTransfer selection={selection} priceUsd={priceUsd} onSubmitted={onSubmitted} />
    case 'solana':
      return (
        <ConfiguredTransfer
          key="solana"
          config={{
            family,
            selection,
            priceUsd,
            initialRecipient,
            initialAmount,
            onDraftChange,
            onSubmitted: value => onSubmitted({ family, value }),
            parseRecipient: parseSolanaPublicKey,
            recipientPlaceholder: `${formatPortfolioNetworkName(selection.chain)} address`,
            invalidRecipientMessage: 'Enter a valid Solana address.',
            reviewDescription: 'Review the Solana recipient and exact network fee before signing.',
            reviewMismatchMessage: 'The Solana review does not match the requested transfer.',
            feeDecimals: 9,
            feeSymbol: 'SOL',
            totalLabel: 'Total',
            prepare: solanaWalletClient.prepareTransfer,
            approve: solanaWalletClient.approveTransfer,
            reject: solanaWalletClient.rejectTransfer,
            estimateFeeRaw: estimateSolanaFee,
            matchesReview: matchesSolanaReview,
            reviewSender: value => value.review.summary.fields.feePayer,
            prepareError: getSolanaSendPrepareError,
            approvalError: getSolanaSendApprovalError
          }}
        />
      )
    case 'near':
      return (
        <ConfiguredTransfer
          key="near"
          config={{
            family,
            selection,
            priceUsd,
            onSubmitted: value => onSubmitted({ family, value }),
            parseRecipient: parseNearAccountId,
            recipientPlaceholder:
              selection.chain.chain.network.kind === 'testnet'
                ? 'alice.testnet or implicit account'
                : 'alice.near or implicit account',
            invalidRecipientMessage: 'Enter a valid NEAR account ID.',
            reviewDescription: 'Review the NEAR recipient and maximum network fee before signing.',
            reviewMismatchMessage: 'The NEAR review does not match the requested transfer.',
            feeDecimals: 24,
            feeSymbol: 'NEAR',
            totalLabel: 'Maximum total',
            prepare: nearWalletClient.prepareTransfer,
            approve: nearWalletClient.approveTransfer,
            reject: nearWalletClient.rejectTransfer,
            estimateFeeRaw: value => value.debit.maximumFeeRaw,
            matchesReview: matchesNearReview,
            reviewSender: value => value.review.summary.fields.signerId,
            prepareError: getNearSendPrepareError,
            approvalError: getNearSendApprovalError
          }}
        />
      )
  }
}

function EvmTransfer(props: EvmTransferProps) {
  const state = useEvmSendTransfer(props)
  return <EvmSendTransferView state={state} />
}

function ConfiguredTransfer<
  R extends SolanaTransferReview | NearTransferReview,
  S extends SolanaTransferSubmission | NearTransferSubmission
>({ config }: { readonly config: SendTransferConfig<R, S> }) {
  return <SendTransferView state={useSendTransfer(config)} />
}

function BitcoinTransfer({
  selection,
  priceUsd,
  onSubmitted
}: Pick<SendTransferFormProps, 'selection' | 'priceUsd' | 'onSubmitted'>) {
  const {
    input,
    feeTier,
    bitcoinAddressType,
    changeFeeTier,
    review,
    updatingFee,
    changeReviewFeeTier
  } = useBitcoinSendTransfer({
    selection,
    onSubmitted: value => onSubmitted({ family: 'bitcoin', value })
  })

  return (
    <SendTransferView
      state={{
        ...input,
        priceUsd: input.balanceKnown ? priceUsd : null,
        review: review && {
          ...review,
          asset: { symbol: 'BTC', nativeChain: 'bitcoin' },
          networkBeforeSender: true,
          beforeFeeRows: [{ label: 'Inputs', content: review.inputCount }],
          afterTotalRows: [{ label: 'Address type', content: review.inputAddressType }],
          preparing: updatingFee,
          feeContent: (
            <NetworkFeeTierPicker
              chainFamily="bitcoin"
              tier={review.feeTier}
              amount={review.fee}
              symbol="BTC"
              onTierChange={changeReviewFeeTier}
              disabled={updatingFee || input.approving}
            />
          )
        }
      }}
      routeInfo={{
        fee: (
          <div className="flex min-w-0 items-center gap-1.5">
            {input.feePreviewLoading && (
              <Icon
                icon="lucide:loader-circle"
                width={14}
                height={14}
                className="animate-spin text-muted"
              />
            )}
            <NetworkFeeTierPicker
              chainFamily="bitcoin"
              tier={feeTier}
              amount={input.previewFee}
              symbol="BTC"
              layout="inline"
              onTierChange={changeFeeTier}
            />
          </div>
        ),
        time: estimateBitcoinSendTime(feeTier),
        extra: (
          <div className="border-t border-white/10 pt-3 text-muted">
            {bitcoinAccountTypeDescription(bitcoinAddressType)}
          </div>
        )
      }}
    />
  )
}
