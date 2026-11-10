import { useRef, useState } from 'react'
import { DASH_CHAIN_FEATURE_FLAG } from '@/config/multichain-feature-flags'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { parseDashP2pkhAddress } from '@/infrastructure/chains/dash'
import { formatBaseUnitAmount, parseDisplayUnitAmount } from '@/lib/number-format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import {
  SendAmountInputCard,
  SendAssetHeader,
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
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import {
  dashWalletClient,
  type DashTransferReview,
  type DashTransferSubmission
} from '@/popup/services/dash-wallet-client'
import { estimateDashTransferMaximum } from '@/popup/services/transfer-maximum'

const DASH_SEND_ENABLED = __ENABLED_CHAIN_FEATURE_FLAGS__.includes(DASH_CHAIN_FEATURE_FLAG)

function parseRecipient(value: string, chainId: string): string | null {
  try {
    return parseDashP2pkhAddress(value.trim(), chainId)
  } catch {
    return null
  }
}

export function DashSendForm({
  selection,
  priceUsd,
  onSubmitted
}: {
  readonly selection: { readonly asset: PortfolioAssetView; readonly chain: PortfolioChainView }
  readonly priceUsd: string | null
  readonly onSubmitted: (submission: DashTransferSubmission) => void
}) {
  const { asset, chain } = selection
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [maxSelected, setMaxSelected] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<DashTransferReview | null>(null)
  const pendingReview = useRef<DashTransferReview | null>(null)
  const externalHandoff = useRef(false)
  const parsedRecipient = parseRecipient(recipient, chain.chain.id)
  const maximum = useTransferMaximum({
    enabled: DASH_SEND_ENABLED && parsedRecipient !== null,
    requestKey: `${chain.chain.id}:${parsedRecipient ?? ''}`,
    estimate: () => estimateDashTransferMaximum(parsedRecipient ?? '')
  })

  if (!DASH_SEND_ENABLED || chain.chain.family !== 'dash') return null

  const amountRaw = (() => {
    if (maxSelected) return maximum.value?.amountRaw ?? null
    if (amount.trim() === '') return null
    try {
      return parseDisplayUnitAmount(amount.trim(), asset.metadata.decimals)
    } catch {
      return null
    }
  })()

  const handleMaximum = () => {
    setError(null)
    setMaxSelected(true)
    void maximum.request()
  }

  const handleContinue = async () => {
    if (!parsedRecipient || !amountRaw || BigInt(amountRaw) <= 0n) return
    setPreparing(true)
    setError(null)
    let prepared: DashTransferReview | null = null
    try {
      prepared = await dashWalletClient.prepareTransfer({
        recipient: parsedRecipient,
        amount: maxSelected ? { mode: 'max' } : { mode: 'exact', valueDuffs: amountRaw }
      })
      const reviewedAmount = prepared.graph.root.intent?.primaryAmount?.amountRaw
      const reviewedRecipient = prepared.graph.root.intent?.recipient?.address
      if (
        reviewedRecipient !== parsedRecipient ||
        (maxSelected ? reviewedAmount === undefined : reviewedAmount !== amountRaw)
      ) {
        await dashWalletClient.rejectTransfer(prepared.graph.root.id)
        setError('The Dash review does not match the requested transfer.')
        return
      }
      pendingReview.current = prepared
      setReview(prepared)
    } catch (prepareError) {
      if (prepared)
        await dashWalletClient.rejectTransfer(prepared.graph.root.id).catch(() => undefined)
      setError(
        prepareError instanceof Error
          ? prepareError.message
          : 'Dash transfer could not be prepared.'
      )
    } finally {
      setPreparing(false)
    }
  }

  const handleCloseReview = async () => {
    if (externalHandoff.current) return
    const current = pendingReview.current ?? review
    setReview(null)
    pendingReview.current = null
    if (current) await dashWalletClient.rejectTransfer(current.graph.root.id).catch(() => undefined)
  }

  const handleApprove = async () => {
    if (!review) return
    setApproving(true)
    setError(null)
    try {
      const submission = await dashWalletClient.approveTransfer(
        review.graph.root.id,
        review.review.payloadFingerprint.digestHex
      )
      pendingReview.current = null
      if (submission.status === 'external-signature-required') {
        externalHandoff.current = true
        setReview(null)
        window.close()
        return
      }
      setReview(null)
      onSubmitted(submission)
    } catch (approvalError) {
      const current = review
      const disconnected =
        approvalError instanceof Error &&
        /message port closed|extension context invalidated|receiving end does not exist/i.test(
          approvalError.message
        )
      pendingReview.current = null
      if (disconnected) {
        externalHandoff.current = true
        setReview(null)
        window.close()
        return
      }
      setReview(null)
      setError(
        approvalError instanceof Error ? approvalError.message : 'Dash transfer was not signed.'
      )
      void dashWalletClient.rejectTransfer(current.graph.root.id).catch(() => undefined)
    } finally {
      setApproving(false)
    }
  }

  const feeRaw = review?.graph.root.intent?.feeLimit?.amountRaw ?? maximum.value?.networkFeeRaw
  const feeLabel = feeRaw ? `${formatBaseUnitAmount(feeRaw, 8)} DASH` : 'Single network fee'

  return (
    <>
      <div className="page-content space-y-4">
        <SendAssetHeader
          assetId={asset.asset.id}
          symbol={asset.metadata.symbol}
          icon={asset.metadata.iconUrl}
          networkName={chain.chain.displayName}
        />
        <p className="px-1 text-xs text-muted">Public</p>
        <SendRecipientInputCard
          id="dash-send-recipient"
          value={recipient}
          onChange={value => {
            setMaxSelected(false)
            setRecipient(value.trim())
          }}
          placeholder="Dash address"
          autoFocus
        />
        {recipient !== '' && parsedRecipient === null && (
          <p className="px-1 text-xs text-danger">Enter a valid Dash address.</p>
        )}
        <SendAmountInputCard
          ariaLabel={`${asset.metadata.symbol} amount`}
          value={
            maxSelected && maximum.value ? formatBaseUnitAmount(maximum.value.amountRaw, 8) : amount
          }
          onChange={value => {
            if (/^\d*\.?\d*$/.test(value)) {
              setMaxSelected(false)
              setAmount(value)
            }
          }}
          available={formatBaseUnitAmount(asset.balance.availableRaw, asset.metadata.decimals)}
          availableLabel="Available"
          symbol={asset.metadata.symbol}
          priceUsd={priceUsd}
          maxSelected={maxSelected}
          maxDisabled={parsedRecipient === null}
          maxLoading={maximum.loading}
          onMax={() => void handleMaximum()}
        />
        <SendNetworkFeeCard label="Network fee" loading={maximum.loading && maxSelected}>
          <span>{feeLabel}</span>
        </SendNetworkFeeCard>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="page-footer">
        <Button
          className="h-[45px] w-full"
          disabled={!parsedRecipient || !amountRaw || BigInt(amountRaw) <= 0n}
          isLoading={preparing}
          onClick={() => void handleContinue()}
        >
          Continue
        </Button>
      </div>
      <Dialog
        open={review !== null}
        onOpenChange={open => {
          if (!open && !approving && !externalHandoff.current) void handleCloseReview()
        }}
      >
        <DialogContent position="bottom" className="gap-0 p-0" showCloseButton={!approving}>
          <DialogHeader className="px-5 pb-4 pt-5">
            <DialogTitle className="text-center">Review Send</DialogTitle>
            <DialogDescription className="sr-only">
              Review the public Dash recipient, amount, and network fee before signing.
            </DialogDescription>
          </DialogHeader>
          {review && (
            <div className="space-y-3 px-5 pb-5">
              <AmountDisplay
                value={formatBaseUnitAmount(
                  review.graph.root.intent?.primaryAmount?.amountRaw ?? '0',
                  8
                )}
                symbol="DASH"
              />
              <p className="text-xs text-muted">Public network fee {feeLabel}</p>
              <Button
                className="h-[45px] w-full"
                isLoading={approving}
                onClick={() => void handleApprove()}
              >
                Send
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
