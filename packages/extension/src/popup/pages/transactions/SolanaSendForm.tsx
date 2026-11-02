import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { parseSolanaPublicKey } from '@/core/chains/solana'
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
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import {
  SendAssetHeader,
  SendAmountInputCard,
  SendNetworkFeeCard,
  SendRecipientInputCard
} from '@/popup/components/transaction/SendInputCards'
import { openModal } from '@/popup/provider/ModalManager'
import {
  solanaWalletClient,
  type SolanaTransferReview,
  type SolanaTransferSubmission
} from '@/popup/services/solana-wallet-client'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import { useTransferFeePreview } from '@/popup/hooks/useTransferFeePreview'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import {
  createNativeTransferSource,
  estimateNativeTransferMaximum,
  fallbackTransferMaximum,
  isTransferAmountSpendable
} from '@/popup/services/transfer-maximum'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import { getSolanaSendApprovalError, getSolanaSendPrepareError } from './solana-send-validation'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'

export interface SolanaSendAsset {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
}

interface PreparedReview {
  readonly recipient: string
  readonly amountRaw: string
  readonly value: SolanaTransferReview
}

function ReviewLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 py-2.5">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      <div className="min-w-0 text-right text-xs font-medium">{children}</div>
    </div>
  )
}

export function SolanaSendForm({
  selection,
  priceUsd,
  onSubmitted
}: {
  readonly selection: SolanaSendAsset
  readonly priceUsd: string | null
  readonly onSubmitted: (submission: SolanaTransferSubmission) => void
}) {
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [maxSelected, setMaxSelected] = useState(false)
  const [approving, setApproving] = useState(false)
  const [review, setReview] = useState<PreparedReview | null>(null)
  const pendingReview = useRef<SolanaTransferReview | null>(null)
  const asset = selection.asset
  const chain = selection.chain
  const networkName = formatPortfolioNetworkName(chain)

  useEffect(
    () => () => {
      const pending = pendingReview.current
      if (pending) void solanaWalletClient.rejectTransfer(pending.graph.root.id).catch(() => {})
    },
    []
  )

  const amountRaw = useMemo(() => {
    try {
      const parsed = parseDisplayUnitAmount(amount, asset.metadata.decimals)
      return BigInt(parsed) > 0n ? parsed : null
    } catch {
      return null
    }
  }, [amount, asset.metadata.decimals])
  const parsedRecipient = useMemo(() => {
    try {
      return parseSolanaPublicKey(recipient)
    } catch {
      return null
    }
  }, [recipient])
  const maximum = useTransferMaximum({
    enabled:
      asset.asset.kind === 'native' &&
      parsedRecipient !== null &&
      BigInt(asset.balance.availableRaw) > 0n &&
      review === null &&
      !preparing,
    requestKey: `${asset.asset.id}:${asset.balance.availableRaw}:${parsedRecipient}`,
    fallback: () =>
      fallbackTransferMaximum(
        createNativeTransferSource({
          asset,
          chain,
          availableRaw: asset.balance.availableRaw,
          sender: ''
        })
      ),
    estimate: () =>
      estimateNativeTransferMaximum({
        source: createNativeTransferSource({
          asset,
          chain,
          availableRaw: asset.balance.availableRaw,
          sender: ''
        }),
        recipient: parsedRecipient ?? ''
      })
  })
  const transferAvailability = resolvePortfolioTransferAvailability({
    balanceRaw: asset.balance.availableRaw,
    decimals: asset.metadata.decimals,
    isNative: asset.asset.kind === 'native',
    maximumRaw: maximum.value?.amountRaw ?? null
  })
  const spendableRaw = transferAvailability.amountRaw
  const amountWithinBalance = isTransferAmountSpendable(amountRaw, spendableRaw)
  useEffect(() => {
    if (maxSelected && maximum.value)
      setAmount(formatBaseUnitDecimalAmount(maximum.value.amountRaw, asset.metadata.decimals))
  }, [maxSelected, maximum.value, asset.metadata.decimals])

  const rejectPrepared = async (value: SolanaTransferReview) => {
    pendingReview.current = null
    await solanaWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
  }

  const invalidateMaximum = () => {
    setMaxSelected(false)
  }

  const handleSelectRecipient = async () => {
    await openModal<string | undefined>({
      title: 'Select Recipient',
      showCloseButton: true,
      body: resolve => (
        <RecipientSelector
          chainId={chain.chain.id}
          onSelect={address => {
            invalidateMaximum()
            if (maxSelected) setAmount('')
            setRecipient(address)
            resolve(address)
          }}
        />
      )
    })
  }

  const handleMaximum = async () => {
    if (asset.asset.kind === 'token') {
      setAmount(transferAvailability.display)
      setMaxSelected(true)
      return
    }
    setError(null)
    setMaxSelected(true)
    void maximum.request()
  }

  const estimateFee = useCallback(async () => {
    if (!amountWithinBalance || !amountRaw || !parsedRecipient) {
      throw new Error('Incomplete Solana transfer')
    }
    let value: SolanaTransferReview | null = null
    try {
      value = await solanaWalletClient.prepareTransfer({
        assetId: asset.asset.id,
        recipient: parsedRecipient,
        amountRaw
      })
      const feeLimit = value.graph.root.intent?.feeLimit
      if (
        feeLimit?.assetId !== `${chain.chain.id}/slip44:501` ||
        !/^(?:0|[1-9][0-9]*)$/.test(feeLimit.amountRaw)
      ) {
        throw new Error('Invalid Solana fee estimate')
      }
      return feeLimit.amountRaw
    } finally {
      if (value) await solanaWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
    }
  }, [amountRaw, amountWithinBalance, asset.asset.id, chain.chain.id, parsedRecipient])
  const feePreview = useTransferFeePreview({
    enabled:
      amountWithinBalance &&
      parsedRecipient !== null &&
      !preparing &&
      !maximum.loading &&
      review === null,
    requestKey: `${asset.asset.id}:${parsedRecipient ?? ''}:${amountRaw ?? ''}`,
    estimate: estimateFee
  })
  const previewFee = feePreview.amountRaw ? formatBaseUnitAmount(feePreview.amountRaw, 9) : '—'

  const handleContinue = async () => {
    if (!amountWithinBalance || !amountRaw || !parsedRecipient) return
    setPreparing(true)
    setError(null)
    let value: SolanaTransferReview | null = null
    try {
      value = await solanaWalletClient.prepareTransfer({
        assetId: asset.asset.id,
        recipient: parsedRecipient,
        amountRaw
      })
      const summary = value.review.summary
      const nativeTransfer = summary.fields.instructions.find(
        instruction => instruction.interpretation.kind === 'system-transfer'
      )?.interpretation
      const tokenTransfer = summary.fields.instructions.find(
        instruction => instruction.interpretation.kind === 'spl-token-transfer'
      )?.interpretation
      const associatedAccount = summary.fields.instructions.find(
        instruction => instruction.interpretation.kind === 'associated-token-create-idempotent'
      )?.interpretation
      const transferMatches =
        asset.asset.kind === 'native'
          ? nativeTransfer?.kind === 'system-transfer' &&
            nativeTransfer.to === parsedRecipient &&
            nativeTransfer.lamports === amountRaw
          : tokenTransfer?.kind === 'spl-token-transfer' &&
            tokenTransfer.mint === asset.asset.reference &&
            tokenTransfer.amountRaw === amountRaw &&
            associatedAccount?.kind === 'associated-token-create-idempotent' &&
            associatedAccount.owner === parsedRecipient
      if (
        summary.schema !== 'solana.transaction.v1' ||
        value.graph.root.intent?.primaryAmount?.assetId !== asset.asset.id ||
        value.graph.root.intent?.recipient?.address !== parsedRecipient ||
        !transferMatches
      ) {
        await rejectPrepared(value)
        setError('The Solana review does not match the requested transfer.')
        return
      }
      pendingReview.current = value
      setReview({ recipient: parsedRecipient, amountRaw, value })
    } catch (prepareError) {
      if (value) await rejectPrepared(value)
      setError(getSolanaSendPrepareError(prepareError, networkName, asset.metadata.symbol))
    } finally {
      setPreparing(false)
    }
  }

  const handleCloseReview = async () => {
    const current = review
    setReview(null)
    if (current) await rejectPrepared(current.value)
  }

  const handleApprove = async () => {
    if (!review) return
    setApproving(true)
    setError(null)
    recordSendSubmission(review.value.graph, asset.metadata.symbol)
    try {
      const submission = await solanaWalletClient.approveTransfer(
        review.value.graph.root.id,
        review.value.review.payloadFingerprint.digestHex
      )
      pendingReview.current = null
      setReview(null)
      recordSendResult(submission.graph, asset.metadata.symbol)
      onSubmitted(submission)
    } catch (approvalError) {
      recordSendApprovalFailure(review.value.graph, asset.metadata.symbol)
      const current = review
      pendingReview.current = null
      setReview(null)
      setError(getSolanaSendApprovalError(approvalError))
      void solanaWalletClient.rejectTransfer(current.value.graph.root.id).catch(() => {})
    } finally {
      setApproving(false)
    }
  }

  const feeRaw = review?.value.graph.root.intent?.feeLimit?.amountRaw ?? '0'
  const reviewAmount = formatBaseUnitAmount(review?.amountRaw ?? '0', asset.metadata.decimals)
  const fee = formatBaseUnitAmount(feeRaw, 9)
  const total =
    review && asset.asset.kind === 'native'
      ? formatBaseUnitAmount(
          (BigInt(review.amountRaw) + BigInt(feeRaw)).toString(),
          asset.metadata.decimals
        )
      : '0'
  const summary = review?.value.review.summary

  return (
    <>
      <div className="page-content space-y-4">
        <SendAssetHeader
          assetId={asset.asset.id}
          symbol={asset.metadata.symbol}
          icon={asset.metadata.iconUrl}
          networkName={`To ${chain.chain.displayName}`}
          nativeChain={asset.asset.kind === 'native' ? 'solana' : undefined}
          blockchain={asset.asset.kind === 'token' ? 'solana' : undefined}
        />

        <div>
          <SendRecipientInputCard
            id="solana-send-recipient"
            value={recipient}
            onChange={value => {
              invalidateMaximum()
              if (maxSelected) setAmount('')
              setRecipient(value.trim())
            }}
            placeholder={`${networkName} address`}
            autoFocus
            onSelectRecipient={() => void handleSelectRecipient()}
          />
          {recipient && !parsedRecipient && (
            <p className="mt-2 px-1 text-xs text-danger">Enter a valid Solana address.</p>
          )}
        </div>

        <SendAmountInputCard
          ariaLabel={`${asset.metadata.symbol} amount`}
          value={amount}
          onChange={value => {
            if (/^\d*\.?\d*$/.test(value)) {
              invalidateMaximum()
              setAmount(value)
            }
          }}
          available={transferAvailability.display}
          availableLabel={transferAvailability.label}
          symbol={asset.metadata.symbol}
          priceUsd={priceUsd}
          maxSelected={maxSelected}
          maxDisabled={
            asset.asset.kind === 'native' &&
            (!parsedRecipient || BigInt(asset.balance.availableRaw) <= 0n)
          }
          maxLoading={maximum.loading}
          onMax={() => void handleMaximum()}
        />

        <SendNetworkFeeCard loading={feePreview.loading}>
          <span>{previewFee === '—' ? previewFee : `${previewFee} SOL`}</span>
        </SendNetworkFeeCard>

        {amountRaw !== null && !amountWithinBalance && (
          <p role="alert" className="mt-3 text-xs text-danger">
            Insufficient {asset.metadata.symbol} balance.
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
          disabled={!amountWithinBalance || !parsedRecipient || feePreview.loading}
          isLoading={preparing || feePreview.loading}
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
              Review the Solana recipient and exact network fee before signing.
            </DialogDescription>
          </DialogHeader>

          {review && summary?.schema === 'solana.transaction.v1' && (
            <>
              <div className="flex flex-col items-center pb-4">
                <TokenIcon
                  assetId={asset.asset.id}
                  symbol={asset.metadata.symbol}
                  icon={asset.metadata.iconUrl}
                  nativeChain={asset.asset.kind === 'native' ? 'solana' : undefined}
                  blockchain={asset.asset.kind === 'token' ? 'solana' : undefined}
                  size="xl"
                />
                <div className="mt-3 max-w-full text-center text-2xl font-bold">
                  <AmountDisplay value={reviewAmount} symbol={asset.metadata.symbol} />
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
                  <span className="font-mono text-muted" title={summary.fields.feePayer}>
                    {formatSortAddress(summary.fields.feePayer)}
                  </span>
                </ReviewLine>
                <ReviewLine label="Network fee">
                  <AmountDisplay value={fee} symbol="SOL" profile="fee" />
                </ReviewLine>
                {asset.asset.kind === 'native' && (
                  <ReviewLine label="Total">
                    <AmountDisplay value={total} symbol="SOL" />
                  </ReviewLine>
                )}
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
