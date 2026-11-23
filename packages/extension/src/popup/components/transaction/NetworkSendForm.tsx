import { Icon } from '@iconify/react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { bitcoinAccountTypeDescription } from '@/popup/components/bitcoin/BitcoinAccountTypeSelector'
import { formatPortfolioNetworkName } from '@/popup/services/portfolio-format'
import type { ChainSelectorOption } from '@/popup/components/common/ChainSelector'
import { EvmSendAdapter, type EvmSendAdapterProps } from '../evm/EvmSendAdapter'
import {
  NearPrivateSendForm,
  useNearSendAccount
} from '@/popup/components/transaction/NearPrivateSendForm'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import { SendTransferView } from '@/popup/components/transaction/SendTransferView'
import { useBitcoinSendTransfer } from '@/popup/hooks/useBitcoinSendTransfer'
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
  guardNearPublicPrepare,
  isNearPrivateSendAsset
} from '@/popup/services/near-send-receive-page'
import {
  getSolanaSendApprovalError,
  getSolanaSendPrepareError
} from '@/popup/services/solana-send-validation'

export type SendTransferSubmission =
  | { readonly family: 'bitcoin'; readonly value: BitcoinTransferSubmission }
  | { readonly family: 'solana'; readonly value: SolanaTransferSubmission }
  | { readonly family: 'near'; readonly value: NearTransferSubmission }

interface NetworkSendFormProps {
  readonly family: SendTransferSubmission['family']
  readonly active: boolean
  readonly selection: { readonly asset: PortfolioAssetView; readonly chain: PortfolioChainView }
  readonly initialRecipient?: string
  readonly initialAmount?: string
  readonly destinationNetworks?: readonly ChainSelectorOption[]
  readonly onSelectDestinationNetwork?: (
    chainId: string,
    draft: Readonly<{ recipient: string; amount: string }>
  ) => void
  readonly onSelectAsset?: (draft: Readonly<{ recipient: string; amount: string }>) => void
  readonly onSubmitted: (submission: SendTransferSubmission) => void
}

export function NetworkSendForm(
  props: NetworkSendFormProps | (EvmSendAdapterProps & { readonly family: 'evm' })
) {
  if (props.family === 'evm') return <EvmSendAdapter {...props} />

  const { family, selection, initialRecipient, initialAmount, onSubmitted } = props

  switch (family) {
    case 'bitcoin':
      return <BitcoinTransfer selection={selection} onSubmitted={onSubmitted} />
    case 'solana':
      return (
        <ConfiguredTransfer
          key="solana"
          shareForm={props.active}
          destinationNetworks={props.destinationNetworks}
          onSelectDestinationNetwork={props.onSelectDestinationNetwork}
          config={{
            family,
            selection,
            initialRecipient,
            initialAmount,
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
        <NearSendBranch
          selection={selection}
          initialRecipient={initialRecipient}
          initialAmount={initialAmount}
          destinationNetworks={props.destinationNetworks}
          onSelectDestinationNetwork={props.onSelectDestinationNetwork}
          onSelectAsset={props.onSelectAsset}
          onSubmitted={value => onSubmitted({ family: 'near', value })}
        />
      )
  }
}

function NearSendBranch({
  selection,
  initialRecipient,
  initialAmount,
  destinationNetworks = [],
  onSelectDestinationNetwork,
  onSelectAsset,
  onSubmitted
}: Pick<
  NetworkSendFormProps,
  | 'selection'
  | 'initialRecipient'
  | 'initialAmount'
  | 'destinationNetworks'
  | 'onSelectDestinationNetwork'
  | 'onSelectAsset'
> & {
  readonly onSubmitted: (submission: NearTransferSubmission) => void
}) {
  const [params] = useSearchParams()
  const source = params.get('source') === 'incognito' ? 'incognito' : 'main'
  const [sendPrivately, setSendPrivately] = useState(
    source === 'incognito' || params.get('mode') === 'private'
  )
  const [draft, setDraft] = useState({
    recipient: initialRecipient ?? '',
    amount: initialAmount ?? ''
  })
  const chainId = selection.chain.chain.id
  const assetId = selection.asset.asset.id
  const accountState = useNearSendAccount(chainId)
  const mainnetPrivateAsset = chainId === 'near:mainnet' && isNearPrivateSendAsset(assetId)
  const publicNetworks = source === 'incognito' ? [] : destinationNetworks
  const selectPublicNetwork = source === 'incognito' ? undefined : onSelectDestinationNetwork
  if (source === 'incognito' || (sendPrivately && mainnetPrivateAsset)) {
    return (
      <NearPrivateSendForm
        selection={selection}
        source={source}
        accountState={accountState}
        initialRecipient={draft.recipient}
        initialAmount={draft.amount}
        destinationNetworks={publicNetworks}
        onSelectDestinationNetwork={selectPublicNetwork}
        onSelectAsset={onSelectAsset}
        onDraftChange={setDraft}
        onTogglePrivacy={source === 'incognito' ? undefined : () => setSendPrivately(false)}
        onSubmitted={onSubmitted}
      />
    )
  }
  return (
    <ConfiguredTransfer
      key="near"
      destinationNetworks={publicNetworks}
      onSelectDestinationNetwork={selectPublicNetwork}
      config={{
        family: 'near',
        selection,
        initialRecipient: draft.recipient,
        initialAmount: draft.amount,
        onDraftChange: setDraft,
        onSelectAsset,
        onSubmitted,
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
        approvalError: getNearSendApprovalError,
        blockPublicPrepare: ({ recipient, amountRaw }) =>
          guardNearPublicPrepare({
            recipient,
            amountRaw,
            chainId,
            assetId,
            accountStatus: accountState.status,
            account: accountState.account,
            now: Date.now()
          }),
        privacy: mainnetPrivateAsset
          ? { checked: false, onChange: () => setSendPrivately(true) }
          : undefined
      }}
    />
  )
}

function ConfiguredTransfer<
  R extends SolanaTransferReview | NearTransferReview,
  S extends SolanaTransferSubmission | NearTransferSubmission
>({
  config,
  shareForm = false,
  destinationNetworks = [],
  onSelectDestinationNetwork
}: Pick<NetworkSendFormProps, 'destinationNetworks' | 'onSelectDestinationNetwork'> & {
  readonly config: SendTransferConfig<R, S>
  readonly shareForm?: boolean
}) {
  const state = useSendTransfer(config)
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const sourceChainId = config.selection.chain.chain.id
  const canSelectNetwork = onSelectDestinationNetwork && destinationNetworks.length > 1
  return (
    <SendTransferView
      state={state}
      shareForm={shareForm}
      networkSelection={
        canSelectNetwork
          ? {
              trigger: {
                icon: destinationNetworks.find(option => option.id === sourceChainId)?.icon,
                onSelect: () => setNetworkPickerOpen(true),
                disabled: state.continueLoading || state.approving || state.review !== null
              },
              picker: {
                open: networkPickerOpen,
                onOpenChange: setNetworkPickerOpen,
                selectedId: sourceChainId,
                options: destinationNetworks,
                onSelect: id => {
                  if (id !== sourceChainId) {
                    onSelectDestinationNetwork(id, {
                      recipient: state.recipient,
                      amount: state.maxSelected ? '' : state.amount
                    })
                  }
                }
              }
            }
          : undefined
      }
    />
  )
}

function BitcoinTransfer({
  selection,
  onSubmitted
}: Pick<NetworkSendFormProps, 'selection' | 'onSubmitted'>) {
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
        review: review && {
          ...review,
          asset: { symbol: 'BTC', nativeChain: 'bitcoin' },
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
