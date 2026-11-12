import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseQuantusAddress } from '@/core/chains/quantus'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { QUANTUS_PROVISIONAL_FEE_LIMIT_RAW } from '@/core/keyring/domain/signing-summary'
import { formatSortAddress } from '@/lib/format'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import {
  SendAssetHeader,
  SendAmountInputCard,
  SendNetworkFeeCard,
  SendRecipientInputCard
} from '@/popup/components/transaction/SendInputCards'
import { Button } from '@/popup/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'
import { openModal } from '@/popup/provider/ModalManager'
import {
  quantusWalletClient,
  type QuantusTransferReview,
  type QuantusTransferSubmission
} from '@/popup/services/quantus-wallet-client'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'

export interface QuantusSendAsset {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
}

interface PreparedReview {
  readonly recipient: string
  readonly amountRaw: string
  readonly value: QuantusTransferReview
}

const FEE_LIMIT_RAW = BigInt(QUANTUS_PROVISIONAL_FEE_LIMIT_RAW)

function ReviewLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 py-2.5">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      <div className="min-w-0 text-right text-xs font-medium">{children}</div>
    </div>
  )
}

/**
 * Keeps one raw unit of keep-alive headroom: the reviewed debit must leave the
 * account alive, and the exact fee is only known after signing.
 */
function maximumSpendableRaw(availableRaw: string): string {
  const available = BigInt(availableRaw)
  const reserved = FEE_LIMIT_RAW + 1n
  return available > reserved ? (available - reserved).toString() : '0'
}

export function QuantusSendForm({
  selection,
  priceUsd,
  onSubmitted
}: {
  readonly selection: QuantusSendAsset
  readonly priceUsd: string | null
  readonly onSubmitted: (submission: QuantusTransferSubmission) => void
}) {
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [review, setReview] = useState<PreparedReview | null>(null)
  const pendingReview = useRef<QuantusTransferReview | null>(null)
  const asset = selection.asset
  const chain = selection.chain
  const networkName = formatPortfolioNetworkName(chain)
  const decimals = asset.metadata.decimals
  const symbol = asset.metadata.symbol

  useEffect(
    () => () => {
      const pending = pendingReview.current
      if (pending) void quantusWalletClient.rejectTransfer(pending.graph.root.id).catch(() => {})
    },
    []
  )

  const amountRaw = useMemo(() => {
    try {
      const parsed = parseDisplayUnitAmount(amount, decimals)
      return BigInt(parsed) > 0n ? parsed : null
    } catch {
      return null
    }
  }, [amount, decimals])
  const parsedRecipient = useMemo(() => {
    try {
      return parseQuantusAddress(recipient)
    } catch {
      return null
    }
  }, [recipient])

  const transferAvailability = resolvePortfolioTransferAvailability({
    balanceRaw: asset.balance.availableRaw,
    decimals,
    isNative: true,
    maximumRaw: maximumSpendableRaw(asset.balance.availableRaw)
  })
  const spendableRaw = transferAvailability.amountRaw
  const amountWithinBalance =
    amountRaw !== null && BigInt(amountRaw) < BigInt(asset.balance.availableRaw)
  const feeDisplay = review
    ? `${formatBaseUnitAmount(review.value.graph.root.intent?.feeLimit?.amountRaw ?? '0', decimals)} ${symbol}`
    : 'Calculated on Continue'

  const rejectPrepared = async (value: QuantusTransferReview) => {
    pendingReview.current = null
    await quantusWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
  }

  const handleSelectRecipient = () => {
    void openModal<string | undefined>({
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

  const handleMaximum = () => {
    setAmount(formatBaseUnitDecimalAmount(spendableRaw, decimals))
  }

  const handleContinue = useCallback(async () => {
    if (!amountWithinBalance || !amountRaw || !parsedRecipient) return
    setPreparing(true)
    setError(null)
    let value: QuantusTransferReview | null = null
    try {
      value = await quantusWalletClient.prepareTransfer({
        recipient: parsedRecipient,
        amountRaw,
        keepAlive: true
      })
      const summary = value.review.summary
      if (
        summary.schema !== 'quantus.transfer.v1' ||
        value.graph.root.intent?.primaryAmount?.assetId !== asset.asset.id ||
        value.graph.root.intent?.primaryAmount?.amountRaw !== amountRaw ||
        value.graph.root.intent?.recipient?.address !== parsedRecipient ||
        summary.fields.recipient !== parsedRecipient ||
        summary.fields.amountRaw !== amountRaw
      ) {
        await rejectPrepared(value)
        setError('The Quantus review does not match the requested transfer.')
        return
      }
      pendingReview.current = value
      setReview({ recipient: parsedRecipient, amountRaw, value })
    } catch (prepareError) {
      if (value) await rejectPrepared(value)
      setError(
        prepareError instanceof Error && prepareError.message
          ? prepareError.message
          : 'The Quantus transfer could not be prepared.'
      )
    } finally {
      setPreparing(false)
    }
  }, [amountRaw, amountWithinBalance, asset.asset.id, parsedRecipient])

  const handleCloseReview = async () => {
    const current = review
    setReview(null)
    if (current) await rejectPrepared(current.value)
  }

  const handleApprove = async () => {
    if (!review) return
    setApproving(true)
    setError(null)
    recordSendSubmission(review.value.graph, symbol)
    try {
      const submission = await quantusWalletClient.approveTransfer(
        review.value.graph.root.id,
        review.value.review.payloadFingerprint.digestHex
      )
      pendingReview.current = null
      setReview(null)
      recordSendResult(submission.graph, symbol)
      onSubmitted(submission)
    } catch (approvalError) {
      recordSendApprovalFailure(review.value.graph, symbol)
      const current = review
      pendingReview.current = null
      setReview(null)
      setError(
        approvalError instanceof Error && approvalError.message
          ? approvalError.message
          : 'The Quantus transfer could not be signed.'
      )
      void quantusWalletClient.rejectTransfer(current.value.graph.root.id).catch(() => {})
    } finally {
      setApproving(false)
    }
  }

  const feeRaw = review?.value.graph.root.intent?.feeLimit?.amountRaw ?? '0'
  const reviewAmount = formatBaseUnitAmount(review?.amountRaw ?? '0', decimals)
  const fee = formatBaseUnitAmount(feeRaw, decimals)
  const total = review
    ? formatBaseUnitAmount((BigInt(review.amountRaw) + BigInt(feeRaw)).toString(), decimals)
    : '0'
  const summary = review?.value.review.summary

  return (
    <>
      <div className="page-content space-y-4">
        <SendAssetHeader
          assetId={asset.asset.id}
          symbol={symbol}
          icon={asset.metadata.iconUrl}
          networkName={networkName}
          nativeChain="quantus"
          blockchain={undefined}
        />

        <div>
          <SendRecipientInputCard
            id="quantus-send-recipient"
            value={recipient}
            onChange={value => setRecipient(value.trim())}
            placeholder="qz… SS58 address"
            autoFocus
            onSelectRecipient={handleSelectRecipient}
          />
          {recipient && !parsedRecipient && (
            <p className="mt-2 px-1 text-xs text-danger">Enter a valid Quantus SS58 address.</p>
          )}
        </div>

        <SendAmountInputCard
          ariaLabel={`${symbol} amount`}
          value={amount}
          onChange={value => {
            if (/^\d*\.?\d*$/.test(value)) setAmount(value)
          }}
          available={transferAvailability.display}
          availableLabel={transferAvailability.label}
          symbol={symbol}
          priceUsd={priceUsd}
          maxSelected={false}
          maxDisabled={!parsedRecipient || BigInt(spendableRaw) <= 0n}
          maxLoading={false}
          onMax={handleMaximum}
        />

        <SendNetworkFeeCard label="Network fee (max)" loading={preparing}>
          <span>{feeDisplay}</span>
        </SendNetworkFeeCard>

        {amountRaw !== null && !amountWithinBalance && (
          <p role="alert" className="mt-3 text-xs text-danger">
            Insufficient {symbol} balance to cover the transfer and its network fee.
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
          disabled={!amountWithinBalance || !parsedRecipient}
          isLoading={preparing}
          onClick={() => void handleContinue()}
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
              Review the Quantus recipient and maximum network fee before signing.
            </DialogDescription>
          </DialogHeader>

          {review && summary?.schema === 'quantus.transfer.v1' && (
            <>
              <div className="flex flex-col items-center pb-4">
                <TokenIcon
                  assetId={asset.asset.id}
                  symbol={symbol}
                  icon={asset.metadata.iconUrl}
                  nativeChain="quantus"
                  blockchain={undefined}
                  size="xl"
                />
                <div className="mt-3 max-w-full text-center text-2xl font-bold">
                  <AmountDisplay value={reviewAmount} symbol={symbol} />
                </div>
                <p className="mt-1 text-xs text-muted">{networkName}</p>
              </div>

              <div className="mx-5 rounded-xl border border-border/60 bg-card/60 px-4">
                <ReviewLine label="Send To">
                  <span className="font-mono text-muted" title={review.recipient}>
                    {formatSortAddress(review.recipient)}
                  </span>
                </ReviewLine>
                <ReviewLine label="From">
                  <span className="font-mono text-muted" title={summary.fields.signerAddress}>
                    {formatSortAddress(summary.fields.signerAddress)}
                  </span>
                </ReviewLine>
                <ReviewLine label="Network fee (max)">
                  <AmountDisplay value={fee} symbol={symbol} profile="fee" />
                </ReviewLine>
                <ReviewLine label="Maximum total">
                  <AmountDisplay value={total} symbol={symbol} />
                </ReviewLine>
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
