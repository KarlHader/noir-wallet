import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import { formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
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
import { openModal } from '@/popup/provider/ModalManager'
import {
  solanaWalletClient,
  type SolanaTransferReview,
  type SolanaTransferSubmission
} from '@/popup/services/solana-wallet-client'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  formatTokenQuantity,
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

export function SolanaSendForm({
  selection,
  priceUsd,
  initialRecipient,
  initialAmount,
  onDraftChange,
  onSubmitted
}: {
  readonly selection: SolanaSendAsset
  readonly priceUsd: string | null
  readonly initialRecipient?: string
  readonly initialAmount?: string
  readonly onDraftChange?: (
    assetId: string,
    draft: Readonly<{ recipient: string; amount: string }>
  ) => void
  readonly onSubmitted: (submission: SolanaTransferSubmission) => void
}) {
  const [amount, setAmount] = useState(initialAmount ?? '')
  const [recipient, setRecipient] = useState(initialRecipient ?? '')
  const [selectedRecipient, setSelectedRecipient] = useState<{
    address: string
    name: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [maxSelected, setMaxSelected] = useState(false)
  const [approving, setApproving] = useState(false)
  const [review, setReview] = useState<PreparedReview | null>(null)
  const pendingReview = useRef<SolanaTransferReview | null>(null)
  const asset = selection.asset
  const chain = selection.chain
  const networkName = formatPortfolioNetworkName(chain)

  useEffect(() => {
    onDraftChange?.(asset.asset.id, { recipient, amount: maxSelected ? '' : amount })
  }, [amount, asset.asset.id, maxSelected, onDraftChange, recipient])

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
  const maximumPending =
    maxSelected && asset.asset.kind === 'native' && (maximum.loading || !maximum.value)
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
    if (!amountWithinBalance || !amountRaw || !parsedRecipient || maximumPending) return
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
            nativeChain={asset.asset.kind === 'native' ? 'solana' : undefined}
            blockchain={asset.asset.kind === 'token' ? 'solana' : undefined}
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
              id="solana-send-recipient"
              value={recipient}
              onChange={value => {
                invalidateMaximum()
                if (maxSelected) setAmount('')
                setRecipient(value.trim())
                setSelectedRecipient(null)
              }}
              placeholder={`${networkName} address`}
              variant="filled"
              hideLabel
              onSelectRecipient={() => void handleSelectRecipient()}
            />
            {recipient && !parsedRecipient && (
              <p className="mt-2 px-1 text-xs text-danger">Enter a valid Solana address.</p>
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
                {previewFee === '—' ? previewFee : `${previewFee} SOL`}
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
          aria-labelledby="solana-send-review-title"
        >
          <DialogTitle className="sr-only" aria-hidden="true">
            Confirm Send
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review the Solana recipient and exact network fee before signing.
          </DialogDescription>

          {review && summary?.schema === 'solana.transaction.v1' && (
            <TransactionReviewView
              title="Confirm Send"
              titleId="solana-send-review-title"
              variant="figma"
              asset={{
                assetId: asset.asset.id,
                symbol: asset.metadata.symbol,
                icon: asset.metadata.iconUrl,
                nativeChain: asset.asset.kind === 'native' ? 'solana' : undefined,
                blockchain: asset.asset.kind === 'token' ? 'solana' : undefined
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
                    <span className="font-mono text-muted" title={summary.fields.feePayer}>
                      {formatSortAddress(summary.fields.feePayer)}
                    </span>
                  )
                },
                { label: 'Network', content: networkName },
                {
                  label: 'Network fee',
                  content: <AmountDisplay value={fee} symbol="SOL" profile="fee" />
                },
                ...(asset.asset.kind === 'native'
                  ? [{ label: 'Total', content: <AmountDisplay value={total} symbol="SOL" /> }]
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
