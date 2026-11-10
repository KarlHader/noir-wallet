import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { parseSupportedPearlAddress } from '@/core/chains/pearl'
import { formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { Button } from '@/popup/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import {
  PearlWalletClientError,
  pearlWalletClient,
  type PearlTransferReview,
  type PearlTransferSubmission
} from '@/popup/services/pearl-wallet-client'
import type { PearlTransferAmount } from '@/infrastructure/chains/pearl'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'
import { openModal } from '@/popup/provider/ModalManager'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import {
  SendAssetHeader,
  SendAmountInputCard,
  SendNetworkFeeCard,
  SendRecipientInputCard
} from '@/popup/components/transaction/SendInputCards'
import { DEFAULT_NETWORK_FEE_TIER, type NetworkFeeTier } from '@/core/transactions/domain'
import { useTransferFeePreview } from '@/popup/hooks/useTransferFeePreview'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import {
  createNativeTransferSource,
  fallbackTransferMaximum
} from '@/popup/services/transfer-maximum'
import { getPearlSendApprovalError, getPearlSendPrepareError } from './pearl-send-validation'
import { isBitcoinBalanceKnown, isBitcoinSendAmountValid } from './bitcoin-send-display'

export interface PearlSendAsset {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
}

interface PreparedReview {
  readonly recipient: string
  readonly amountRaw: string
  readonly feeTier: NetworkFeeTier
  readonly value: PearlTransferReview
}

function ReviewLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 py-2.5">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      <div className="min-w-0 text-right text-xs font-medium">{children}</div>
    </div>
  )
}

export function PearlSendForm({
  selection,
  priceUsd,
  onSubmitted
}: {
  readonly selection: PearlSendAsset
  readonly priceUsd: string | null
  readonly onSubmitted: (submission: PearlTransferSubmission) => void
}) {
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [feeTier, setFeeTier] = useState<NetworkFeeTier>(DEFAULT_NETWORK_FEE_TIER)
  const [sendMaximum, setSendMaximum] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [updatingFee, setUpdatingFee] = useState(false)
  const [review, setReview] = useState<PreparedReview | null>(null)
  const pendingReview = useRef<PearlTransferReview | null>(null)
  const asset = selection.asset
  const chain = selection.chain
  const availableRaw = asset.balance.availableRaw
  const balanceKnown = isBitcoinBalanceKnown(asset.updatedAt)
  const networkName = formatPortfolioNetworkName(chain)

  useEffect(
    () => () => {
      const pending = pendingReview.current
      if (pending) void pearlWalletClient.rejectTransfer(pending.graph.root.id).catch(() => {})
    },
    []
  )

  const amountRaw = useMemo(() => {
    try {
      return parseDisplayUnitAmount(amount, asset.metadata.decimals)
    } catch {
      return null
    }
  }, [amount, asset.metadata.decimals])
  const parsedRecipient = useMemo(() => {
    try {
      return parseSupportedPearlAddress(recipient, chain.chain.id)
    } catch {
      return null
    }
  }, [chain.chain.id, recipient])

  const maximum = useTransferMaximum({
    enabled:
      balanceKnown &&
      parsedRecipient !== null &&
      BigInt(availableRaw) > 0n &&
      !preparing &&
      review === null,
    requestKey: `${availableRaw}:${parsedRecipient}:${feeTier}`,
    fallback: () =>
      fallbackTransferMaximum(
        createNativeTransferSource({
          asset,
          chain,
          availableRaw,
          sender: ''
        })
      ),
    estimate: async () => {
      if (!parsedRecipient) throw new Error('Incomplete Pearl transfer')
      let value: PearlTransferReview | null = null
      try {
        value = await pearlWalletClient.prepareTransfer(
          { recipient: parsedRecipient, amount: { mode: 'max' } },
          { feeTier }
        )
        const primary = value.graph.root.intent?.primaryAmount?.amountRaw
        const fee = value.graph.root.intent?.feeLimit?.amountRaw
        if (
          typeof primary !== 'string' ||
          !/^(?:0|[1-9][0-9]*)$/.test(primary) ||
          typeof fee !== 'string' ||
          !/^(?:0|[1-9][0-9]*)$/.test(fee)
        ) {
          throw new Error('Invalid Pearl maximum estimate')
        }
        return {
          amountRaw: primary,
          networkFeeRaw: fee,
          networkFeeSymbol: 'PRL',
          networkFeeDecimals: 8
        }
      } finally {
        if (value) await pearlWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
      }
    }
  })
  const transferAvailability = resolvePortfolioTransferAvailability({
    balanceRaw: availableRaw,
    decimals: asset.metadata.decimals,
    isNative: true,
    maximumRaw: maximum.value?.amountRaw ?? null
  })
  const availableDisplay = balanceKnown
    ? transferAvailability.display
    : chain.status === 'error'
      ? 'Unavailable'
      : 'Updating…'
  useEffect(() => {
    if (sendMaximum && maximum.value)
      setAmount(formatBaseUnitDecimalAmount(maximum.value.amountRaw, asset.metadata.decimals))
  }, [sendMaximum, maximum.value, asset.metadata.decimals])
  const validAmount = isBitcoinSendAmountValid({
    sendMaximum,
    amountRaw,
    availableRaw: maximum.value?.amountRaw ?? '0',
    balanceKnown: balanceKnown && maximum.value !== null
  })

  const rejectPrepared = async (value: PearlTransferReview) => {
    pendingReview.current = null
    await pearlWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
  }

  const estimateFee = useCallback(async () => {
    if (!validAmount || !parsedRecipient || (!sendMaximum && amountRaw === null)) {
      throw new Error('Incomplete Pearl transfer')
    }
    let requestedAmount: PearlTransferAmount
    if (sendMaximum) {
      requestedAmount = { mode: 'max' }
    } else {
      if (amountRaw === null) throw new Error('Incomplete Pearl transfer')
      requestedAmount = { mode: 'exact', valueSats: amountRaw }
    }
    let value: PearlTransferReview | null = null
    try {
      value = await pearlWalletClient.prepareTransfer(
        { recipient: parsedRecipient, amount: requestedAmount },
        { feeTier }
      )
      const feeLimit = value.graph.root.intent?.feeLimit
      if (!feeLimit || !/^(?:0|[1-9][0-9]*)$/.test(feeLimit.amountRaw)) {
        throw new Error('Invalid Pearl fee estimate')
      }
      return feeLimit.amountRaw
    } finally {
      if (value) await pearlWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
    }
  }, [amountRaw, feeTier, parsedRecipient, sendMaximum, validAmount])
  const feePreview = useTransferFeePreview({
    enabled:
      validAmount && !sendMaximum && parsedRecipient !== null && !preparing && review === null,
    requestKey: `${parsedRecipient ?? ''}:${amountRaw ?? ''}:${sendMaximum}:${feeTier}`,
    estimate: estimateFee
  })
  const previewFeeRaw = sendMaximum
    ? maximum.fallbackUsed
      ? null
      : maximum.value?.networkFeeRaw
    : feePreview.amountRaw
  const previewFee = previewFeeRaw ? formatBaseUnitAmount(previewFeeRaw, 8) : '—'

  const handleSelectRecipient = async () => {
    await openModal<string | undefined>({
      title: 'Select Recipient',
      showCloseButton: true,
      body: resolve => (
        <RecipientSelector
          chainId={chain.chain.id}
          onSelect={address => {
            setRecipient(address)
            resolve(address)
          }}
        />
      )
    })
  }

  const handleContinue = async () => {
    if (!validAmount || !parsedRecipient || (!sendMaximum && amountRaw === null)) return
    let requestedAmount: PearlTransferAmount
    if (sendMaximum) {
      requestedAmount = { mode: 'max' }
    } else {
      if (amountRaw === null) return
      requestedAmount = { mode: 'exact', valueSats: amountRaw }
    }
    setPreparing(true)
    setError(null)
    try {
      const value = await pearlWalletClient.prepareTransfer(
        {
          recipient: parsedRecipient,
          amount: requestedAmount
        },
        { feeTier }
      )
      const summary = value.review.summary
      if (summary.schema !== 'pearl.psbt.v1') {
        await rejectPrepared(value)
        setError('The wallet returned an invalid Pearl review.')
        return
      }
      const recipientOutputs = summary.fields.outputs.filter(
        output => output.classification === 'recipient' && output.address === parsedRecipient
      )
      if (
        recipientOutputs.length !== 1 ||
        (!sendMaximum && recipientOutputs[0].amountSats !== amountRaw)
      ) {
        await rejectPrepared(value)
        setError('The Pearl review does not match the requested transfer.')
        return
      }
      pendingReview.current = value
      setReview({
        recipient: parsedRecipient,
        amountRaw: recipientOutputs[0].amountSats,
        feeTier,
        value
      })
    } catch (prepareError) {
      setError(getPearlSendPrepareError(prepareError))
    } finally {
      setPreparing(false)
    }
  }

  const handleCloseReview = async () => {
    const current = review
    setReview(null)
    if (current) await rejectPrepared(current.value)
  }

  const handleReviewFeeTierChange = async (nextFeeTier: NetworkFeeTier) => {
    const current = review
    if (!current || nextFeeTier === current.feeTier) return

    setUpdatingFee(true)
    setError(null)
    let replacement: PearlTransferReview | null = null
    let currentReleased = false
    try {
      await pearlWalletClient.rejectTransfer(current.value.graph.root.id)
      pendingReview.current = null
      currentReleased = true

      replacement = await pearlWalletClient.prepareTransfer(
        {
          recipient: current.recipient,
          amount: sendMaximum ? { mode: 'max' } : { mode: 'exact', valueSats: current.amountRaw }
        },
        { feeTier: nextFeeTier }
      )
      const nextSummary = replacement.review.summary
      if (nextSummary.schema !== 'pearl.psbt.v1') {
        throw new Error('The wallet returned an invalid Pearl review.')
      }
      const recipientOutputs = nextSummary.fields.outputs.filter(
        output => output.classification === 'recipient' && output.address === current.recipient
      )
      if (
        recipientOutputs.length !== 1 ||
        (!sendMaximum && recipientOutputs[0].amountSats !== current.amountRaw)
      ) {
        throw new Error('The Pearl review does not match the requested transfer.')
      }

      pendingReview.current = replacement
      setFeeTier(nextFeeTier)
      setAmount(formatBaseUnitDecimalAmount(recipientOutputs[0].amountSats, 8))
      setReview({
        recipient: current.recipient,
        amountRaw: recipientOutputs[0].amountSats,
        feeTier: nextFeeTier,
        value: replacement
      })
      replacement = null
    } catch (cause) {
      if (replacement) {
        await pearlWalletClient.rejectTransfer(replacement.graph.root.id).catch(() => {})
      }
      if (currentReleased) {
        setReview(null)
      }
      const message =
        cause instanceof PearlWalletClientError
          ? getPearlSendPrepareError(cause)
          : cause instanceof Error
            ? cause.message
            : 'The network fee could not be updated.'
      setError(message)
      throw new Error(message)
    } finally {
      setUpdatingFee(false)
    }
  }

  const handleApprove = async () => {
    if (!review) return
    setApproving(true)
    setError(null)
    recordSendSubmission(review.value.graph, selection.asset.metadata.symbol)
    try {
      const submission = await pearlWalletClient.approveTransfer(
        review.value.graph.root.id,
        review.value.review.payloadFingerprint.digestHex
      )
      pendingReview.current = null
      setReview(null)
      recordSendResult(submission.graph, selection.asset.metadata.symbol)
      onSubmitted(submission)
    } catch (approveError) {
      recordSendApprovalFailure(review.value.graph, selection.asset.metadata.symbol)
      const current = review
      pendingReview.current = null
      setReview(null)
      setError(getPearlSendApprovalError(approveError))
      void pearlWalletClient.rejectTransfer(current.value.graph.root.id).catch(() => {})
    } finally {
      setApproving(false)
    }
  }

  const summary = review?.value.review.summary
  const feeRaw = summary?.schema === 'pearl.psbt.v1' ? summary.fields.feeSats : '0'
  const fee = formatBaseUnitAmount(feeRaw, 8)
  const reviewAmount = formatBaseUnitAmount(review?.amountRaw ?? '0', 8)
  const total = review
    ? formatBaseUnitAmount((BigInt(review.amountRaw) + BigInt(feeRaw)).toString(), 8)
    : '0'

  return (
    <>
      <div className="page-content space-y-4">
        <SendAssetHeader
          assetId={asset.asset.id}
          symbol="PRL"
          icon={asset.metadata.iconUrl}
          networkName={networkName}
          nativeChain="pearl"
        />

        <div>
          <SendRecipientInputCard
            id="pearl-send-recipient"
            value={recipient}
            onChange={value => setRecipient(value.trim())}
            placeholder={
              chain.chain.network.kind === 'testnet'
                ? 'tprl1p… Pearl testnet address'
                : 'prl1p… Pearl address'
            }
            autoFocus
            onSelectRecipient={() => void handleSelectRecipient()}
          />
          {recipient && !parsedRecipient && (
            <p className="mt-2 px-1 text-xs text-danger">
              {chain.chain.network.kind === 'testnet'
                ? 'Enter a valid Pearl testnet address.'
                : 'Enter a valid Pearl address.'}
            </p>
          )}
        </div>

        <SendAmountInputCard
          ariaLabel="PRL amount"
          value={amount}
          onChange={value => {
            if (/^\d*\.?\d*$/.test(value)) {
              setAmount(value)
              setSendMaximum(false)
            }
          }}
          available={availableDisplay}
          availableLabel={transferAvailability.label}
          symbol={balanceKnown ? 'PRL' : ''}
          priceUsd={balanceKnown ? priceUsd : null}
          maxSelected={sendMaximum}
          maxDisabled={!balanceKnown || !parsedRecipient || BigInt(availableRaw) <= 0n}
          maxLoading={maximum.loading}
          onMax={() => {
            setSendMaximum(true)
            void maximum.request()
          }}
        />

        <SendNetworkFeeCard loading={feePreview.loading}>
          <NetworkFeeTierPicker
            chainFamily="pearl"
            tier={feeTier}
            amount={previewFee}
            symbol="PRL"
            onTierChange={nextTier => {
              setFeeTier(nextTier)
              if (sendMaximum) {
                setSendMaximum(false)
                setAmount('')
              }
            }}
          />
        </SendNetworkFeeCard>

        {balanceKnown &&
          !sendMaximum &&
          amountRaw !== null &&
          BigInt(amountRaw) > BigInt(availableRaw) && (
            <p role="alert" className="mt-3 text-xs text-danger">
              Insufficient PRL balance.
            </p>
          )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}
      </div>

      <div className="page-footer">
        <Button
          className="h-[45px] w-full"
          disabled={!validAmount || !parsedRecipient || maximum.loading || feePreview.loading}
          isLoading={preparing || maximum.loading || feePreview.loading}
          onClick={handleContinue}
        >
          Continue
        </Button>
      </div>

      <Dialog
        open={review !== null}
        onOpenChange={open => {
          if (!open && !approving) void handleCloseReview()
        }}
      >
        <DialogContent
          position="bottom"
          className="max-h-[calc(100dvh-12px)] gap-0 overflow-y-auto p-0"
          showCloseButton={!approving}
        >
          <DialogHeader className="px-5 pb-4 pt-5">
            <DialogTitle className="text-center">Review Send</DialogTitle>
            <DialogDescription className="sr-only">
              Review the Pearl recipient, inputs, and exact network fee before sending.
            </DialogDescription>
          </DialogHeader>

          {review && summary?.schema === 'pearl.psbt.v1' && (
            <>
              <div className="flex flex-col items-center pb-4">
                <TokenIcon symbol="PRL" nativeChain="pearl" size="xl" />
                <div className="mt-3 max-w-full px-5 text-center text-2xl font-bold">
                  <AmountDisplay value={reviewAmount} symbol="PRL" />
                </div>
                <p className="mt-1 text-xs text-muted">{networkName}</p>
              </div>

              <div className="mx-5 rounded-xl border border-border/60 bg-card/60 px-4">
                <ReviewLine label="Send To">
                  <span className="font-mono text-muted" title={review.recipient}>
                    {formatSortAddress(review.recipient)}
                  </span>
                </ReviewLine>
                <ReviewLine label="Network">{networkName}</ReviewLine>
                <ReviewLine label="From">
                  <span className="font-mono text-muted" title={summary.fields.signer}>
                    {formatSortAddress(summary.fields.signer)}
                  </span>
                </ReviewLine>
                <ReviewLine label="Inputs">{summary.fields.inputs.length}</ReviewLine>
                <ReviewLine label="Network fee">
                  <NetworkFeeTierPicker
                    chainFamily="pearl"
                    tier={review.feeTier}
                    amount={fee}
                    symbol="PRL"
                    onTierChange={handleReviewFeeTierChange}
                    disabled={updatingFee || approving}
                  />
                </ReviewLine>
                <ReviewLine label="Total">
                  <AmountDisplay value={total} symbol="PRL" />
                </ReviewLine>
                <ReviewLine label="Address type">Taproot · BIP-86</ReviewLine>
              </div>

              <div className="flex gap-3 p-5">
                <Button
                  variant="outline"
                  className="h-[45px] flex-1"
                  disabled={approving}
                  onClick={() => void handleCloseReview()}
                >
                  Cancel
                </Button>
                <Button className="h-[45px] flex-1" isLoading={approving} onClick={handleApprove}>
                  Send
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
