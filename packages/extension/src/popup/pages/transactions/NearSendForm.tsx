import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseNearAccountId } from '@/core/chains/near'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  formatTokenQuantity,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import { Icon } from '@iconify/react'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import {
  SendAssetHeader,
  SendAmountInputCard,
  SendFormActions,
  SendFormView,
  SendFieldLabel,
  SendRouteInfoCard,
  SendRecipientAddress,
  SendRecipientInputCard
} from '@/popup/components/transaction/SendInputCards'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import { openModal } from '@/popup/provider/ModalManager'
import {
  nearWalletClient,
  type NearTransferReview,
  type NearTransferSubmission
} from '@/popup/services/near-wallet-client'
import { useTransferFeePreview } from '@/popup/hooks/useTransferFeePreview'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import {
  createNativeTransferSource,
  estimateNativeTransferMaximum,
  fallbackTransferMaximum,
  isTransferAmountSpendable
} from '@/popup/services/transfer-maximum'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import { getNearSendApprovalError, getNearSendPrepareError } from './near-send-validation'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'

export interface NearSendAsset {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
}

interface PreparedReview {
  readonly recipient: string
  readonly amountRaw: string
  readonly value: NearTransferReview
}

export function NearSendForm({
  selection,
  priceUsd,
  onSubmitted
}: {
  readonly selection: NearSendAsset
  readonly priceUsd: string | null
  readonly onSubmitted: (submission: NearTransferSubmission) => void
}) {
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [selectedRecipient, setSelectedRecipient] = useState<{
    address: string
    name: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [maxSelected, setMaxSelected] = useState(false)
  const [review, setReview] = useState<PreparedReview | null>(null)
  const pendingReview = useRef<NearTransferReview | null>(null)
  const asset = selection.asset
  const chain = selection.chain
  const networkName = formatPortfolioNetworkName(chain)
  const recipientPlaceholder =
    chain.chain.network.kind === 'testnet'
      ? 'alice.testnet or implicit account'
      : 'alice.near or implicit account'

  useEffect(
    () => () => {
      const pending = pendingReview.current
      if (pending) void nearWalletClient.rejectTransfer(pending.graph.root.id).catch(() => {})
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
      return parseNearAccountId(recipient)
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
  const maximumPending =
    maxSelected && asset.asset.kind === 'native' && (maximum.loading || !maximum.value)
  useEffect(() => {
    if (maxSelected && maximum.value)
      setAmount(formatBaseUnitDecimalAmount(maximum.value.amountRaw, asset.metadata.decimals))
  }, [maxSelected, maximum.value, asset.metadata.decimals])

  const rejectPrepared = async (value: NearTransferReview) => {
    pendingReview.current = null
    await nearWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
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
          onSelect={(address, name) => {
            invalidateMaximum()
            if (maxSelected) setAmount('')
            setRecipient(address)
            setSelectedRecipient(name ? { address, name } : null)
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
    setAmount('')
    setMaxSelected(true)
    void maximum.request()
  }

  const estimateFee = useCallback(async () => {
    if (!amountWithinBalance || !amountRaw || !parsedRecipient) {
      throw new Error('Incomplete NEAR transfer')
    }
    let value: NearTransferReview | null = null
    try {
      value = await nearWalletClient.prepareTransfer({
        assetId: asset.asset.id,
        recipient: parsedRecipient,
        amountRaw
      })
      return value.debit.maximumFeeRaw
    } finally {
      if (value) await nearWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
    }
  }, [amountRaw, amountWithinBalance, asset.asset.id, parsedRecipient])
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
  const previewFee = feePreview.amountRaw ? formatBaseUnitAmount(feePreview.amountRaw, 24) : '—'

  const handleContinue = async () => {
    if (!amountWithinBalance || !amountRaw || !parsedRecipient || maximumPending) return
    setPreparing(true)
    setError(null)
    let value: NearTransferReview | null = null
    try {
      value = await nearWalletClient.prepareTransfer({
        assetId: asset.asset.id,
        recipient: parsedRecipient,
        amountRaw
      })
      const summary = value.review.summary
      const transfer = summary.fields.actions[0]
      const transferMatches =
        asset.asset.kind === 'native'
          ? transfer?.kind === 'transfer' && transfer.depositYocto === amountRaw
          : transfer?.kind === 'function-call' &&
            transfer.methodName === 'ft_transfer' &&
            summary.fields.receiverId === asset.asset.reference.replace(/%5F/gi, '_')
      if (
        summary.schema !== 'near.transaction.v1' ||
        value.graph.root.intent?.primaryAmount?.assetId !== asset.asset.id ||
        value.graph.root.intent?.primaryAmount?.amountRaw !== amountRaw ||
        value.graph.root.intent?.recipient?.address !== parsedRecipient ||
        !transferMatches
      ) {
        await rejectPrepared(value)
        setError('The NEAR review does not match the requested transfer.')
        return
      }
      pendingReview.current = value
      setReview({ recipient: parsedRecipient, amountRaw, value })
    } catch (prepareError) {
      if (value) await rejectPrepared(value)
      setError(getNearSendPrepareError(prepareError, networkName))
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
      const submission = await nearWalletClient.approveTransfer(
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
      setError(getNearSendApprovalError(approvalError))
      void nearWalletClient.rejectTransfer(current.value.graph.root.id).catch(() => {})
    } finally {
      setApproving(false)
    }
  }

  const feeRaw = review?.value.graph.root.intent?.feeLimit?.amountRaw ?? '0'
  const reviewAmount = formatBaseUnitAmount(review?.amountRaw ?? '0', asset.metadata.decimals)
  const fee = formatBaseUnitAmount(feeRaw, 24)
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
      <SendFormView
        domain="public"
        availableDomains={['public']}
        onDomainChange={() => {}}
        amountInput={
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
            symbol={asset.metadata.symbol}
            priceUsd={priceUsd}
            inline
          />
        }
        assetSelector={
          <SendAssetHeader
            assetId={asset.asset.id}
            symbol={asset.metadata.symbol}
            icon={asset.metadata.iconUrl}
            networkName={networkName}
            nativeChain={asset.asset.kind === 'native' ? 'near' : undefined}
            blockchain={asset.asset.kind === 'token' ? 'near' : undefined}
            variant="pill"
          />
        }
        balance={
          <span title={transferAvailability.display}>
            {formatTokenQuantity(transferAvailability.display)}
          </span>
        }
        maxButton={
          <button
            type="button"
            aria-label="Max"
            aria-pressed={maxSelected}
            disabled={
              BigInt(asset.balance.availableRaw) <= 0n ||
              (asset.asset.kind === 'native' && !parsedRecipient) ||
              maximum.loading
            }
            onClick={() => void handleMaximum()}
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
              id="near-send-recipient"
              value={recipient}
              onChange={value => {
                invalidateMaximum()
                if (maxSelected) setAmount('')
                setRecipient(value.trim())
                setSelectedRecipient(null)
              }}
              placeholder={recipientPlaceholder}
              variant="filled"
              hideLabel
              onSelectRecipient={() => void handleSelectRecipient()}
            />
            {recipient && !parsedRecipient && (
              <p className="mt-2 px-1 text-xs text-danger">Enter a valid NEAR account ID.</p>
            )}
          </div>
        }
        footer={
          <SendFormActions
            disabled={
              !amountWithinBalance || !parsedRecipient || maximumPending || feePreview.loading
            }
            loading={preparing || feePreview.loading}
            onContinue={handleContinue}
          />
        }
      >
        <div>
          <SendRouteInfoCard
            fee={
              <span>
                {feePreview.loading && (
                  <Icon
                    icon="lucide:loader-circle"
                    width={14}
                    height={14}
                    className="mr-1 inline animate-spin"
                  />
                )}
                {previewFee === '—' ? previewFee : `${previewFee} NEAR`}
              </span>
            }
          />
        </div>

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
      </SendFormView>

      <Dialog
        open={review !== null}
        onOpenChange={open => {
          if (!open && !approving) void handleCloseReview()
        }}
      >
        <DialogContent
          position="bottom"
          className="flex h-dvh max-h-dvh flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-none"
          showCloseButton={false}
          aria-labelledby="near-send-review-title"
        >
          <DialogTitle className="sr-only" aria-hidden="true">
            Confirm Send
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review the NEAR recipient and maximum network fee before signing.
          </DialogDescription>

          {review && summary?.schema === 'near.transaction.v1' && (
            <TransactionReviewView
              title="Confirm Send"
              titleId="near-send-review-title"
              variant="figma"
              asset={{
                assetId: asset.asset.id,
                symbol: asset.metadata.symbol,
                icon: asset.metadata.iconUrl,
                nativeChain: asset.asset.kind === 'native' ? 'near' : undefined,
                blockchain: asset.asset.kind === 'token' ? 'near' : undefined
              }}
              amount={reviewAmount}
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
                {
                  label: 'From',
                  content: (
                    <span className="font-mono text-muted" title={summary.fields.signerId}>
                      {formatSortAddress(summary.fields.signerId)}
                    </span>
                  )
                },
                { label: 'Network', content: networkName },
                {
                  label: 'Network fee',
                  content: <AmountDisplay value={fee} symbol="NEAR" profile="fee" />
                },
                ...(asset.asset.kind === 'native'
                  ? [
                      {
                        label: 'Maximum total',
                        content: <AmountDisplay value={total} symbol="NEAR" />
                      }
                    ]
                  : [])
              ]}
              confirmLabel="Confirm"
              confirming={approving}
              submitting={approving}
              cancelDisabled={approving}
              onCancel={() => void handleCloseReview()}
              onConfirm={handleApprove}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
