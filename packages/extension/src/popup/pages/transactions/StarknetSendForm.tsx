import { useEffect, useMemo, useRef, useState } from 'react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'
import { formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { formatBaseUnitAmount, parseDisplayUnitAmount } from '@/lib/number-format'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import {
  SendAmountInputCard,
  SendAssetHeader,
  SendNetworkFeeCard,
  SendRecipientInputCard
} from '@/popup/components/transaction/SendInputCards'
import { Button } from '@/popup/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/popup/components/ui/dialog'
import {
  starknetWalletClient,
  type StarknetTransferReview,
  type StarknetTransferSubmission
} from '@/popup/services/starknet-wallet-client'
import { resolveStarknetTransferAvailability } from '@/popup/services/transfer-availability'
import { isTransferAmountSpendable } from '@/popup/services/transfer-maximum'

export function StarknetSendForm({
  selection,
  priceUsd,
  onSubmitted
}: {
  readonly selection: { readonly asset: PortfolioAssetView; readonly chain: PortfolioChainView }
  readonly priceUsd: string | null
  readonly onSubmitted: (submission: StarknetTransferSubmission) => void
}) {
  const asset = selection.asset
  const chain = selection.chain
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [maximumRaw, setMaximumRaw] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [review, setReview] = useState<StarknetTransferReview | null>(null)
  const pendingReview = useRef<StarknetTransferReview | null>(null)
  const networkName = formatPortfolioNetworkName(chain)
  const availability = resolveStarknetTransferAvailability({
    balanceRaw: asset.balance.availableRaw,
    decimals: asset.metadata.decimals,
    maximumRaw
  })
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
      return normalizeStarknetFelt(recipient.trim())
    } catch {
      return null
    }
  }, [recipient])

  useEffect(
    () => () => {
      const pending = pendingReview.current
      if (pending) void starknetWalletClient.rejectTransfer(pending.graph.root.id).catch(() => {})
    },
    []
  )

  const handleMax = async () => {
    setError(null)
    try {
      const max = await starknetWalletClient.quoteMaximum(asset.asset.id)
      if (max === null) {
        setError('STRK cannot cover the network fee.')
        return
      }
      setMaximumRaw(max)
      setAmount(formatBaseUnitAmount(max, asset.metadata.decimals))
    } catch (maxError) {
      setError(maxError instanceof Error ? maxError.message : 'Starknet max amount is unavailable.')
    }
  }

  const handleContinue = async () => {
    if (
      !amountRaw ||
      !parsedRecipient ||
      !isTransferAmountSpendable(amountRaw, availability.amountRaw)
    ) {
      return
    }
    setPreparing(true)
    setError(null)
    try {
      const value = await starknetWalletClient.prepareTransfer({
        assetId: asset.asset.id,
        recipient: parsedRecipient,
        amountRaw
      })
      if (
        value.graph.root.intent?.primaryAmount?.amountRaw !== amountRaw ||
        value.graph.root.intent?.recipient?.address !== parsedRecipient ||
        value.graph.root.intent?.feeLimit?.amountRaw !== value.maxFeeRaw
      ) {
        await starknetWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
        setError('The Starknet review does not match this transfer.')
        return
      }
      pendingReview.current = value
      setReview(value)
    } catch (prepareError) {
      setError(
        prepareError instanceof Error
          ? prepareError.message
          : 'Starknet transfer could not be prepared.'
      )
    } finally {
      setPreparing(false)
    }
  }

  const closeReview = async () => {
    const current = review
    pendingReview.current = null
    setReview(null)
    if (current) await starknetWalletClient.rejectTransfer(current.graph.root.id).catch(() => {})
  }

  const handleApprove = async () => {
    if (!review) return
    setApproving(true)
    setError(null)
    try {
      const submission = await starknetWalletClient.approveTransfer(
        review.graph.root.id,
        review.payloadFingerprint
      )
      pendingReview.current = null
      setReview(null)
      onSubmitted(submission)
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : 'Starknet transfer was not approved.'
      )
      await closeReview()
    } finally {
      setApproving(false)
    }
  }

  return (
    <>
      <div className="page-content space-y-4">
        <SendAssetHeader
          assetId={asset.asset.id}
          symbol={asset.metadata.symbol}
          icon={asset.metadata.iconUrl}
          networkName={networkName}
          blockchain="starknet"
        />
        <SendRecipientInputCard
          id="starknet-send-recipient"
          value={recipient}
          onChange={setRecipient}
          placeholder="0x…"
        />
        <SendAmountInputCard
          ariaLabel={`${asset.metadata.symbol} amount`}
          value={amount}
          onChange={setAmount}
          available={availability.display}
          availableLabel={availability.label}
          symbol={asset.metadata.symbol}
          priceUsd={priceUsd}
          onMax={() => void handleMax()}
        />
        <SendNetworkFeeCard>
          <span>—</span>
        </SendNetworkFeeCard>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button
          className="w-full"
          disabled={
            preparing ||
            !amountRaw ||
            !parsedRecipient ||
            !isTransferAmountSpendable(amountRaw, availability.amountRaw)
          }
          onClick={() => void handleContinue()}
        >
          {preparing ? 'Reviewing' : 'Review'}
        </Button>
      </div>
      <Dialog
        open={review !== null}
        onOpenChange={open => {
          if (!open) void closeReview()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review transfer</DialogTitle>
          </DialogHeader>
          {review ? (
            <div className="space-y-3">
              <AmountDisplay
                value={formatBaseUnitAmount(
                  review.graph.root.intent?.primaryAmount?.amountRaw ?? '0',
                  asset.metadata.decimals
                )}
                symbol={asset.metadata.symbol}
              />
              <div className="flex justify-between text-xs">
                <span className="text-muted">To</span>
                <span>{formatSortAddress(review.graph.root.intent?.recipient?.address ?? '')}</span>
              </div>
              {review.deployMaxFeeRaw ? (
                <div className="flex justify-between text-xs">
                  <span className="text-muted">Deploy max fee</span>
                  <span>{formatBaseUnitAmount(review.deployMaxFeeRaw, 18)} STRK</span>
                </div>
              ) : null}
              <div className="flex justify-between text-xs">
                <span className="text-muted">Invoke max fee</span>
                <span>{formatBaseUnitAmount(review.invokeMaxFeeRaw, 18)} STRK</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">Max fee</span>
                <span>{formatBaseUnitAmount(review.maxFeeRaw, 18)} STRK</span>
              </div>
              <Button className="w-full" disabled={approving} onClick={() => void handleApprove()}>
                {approving ? 'Sending' : 'Confirm'}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
