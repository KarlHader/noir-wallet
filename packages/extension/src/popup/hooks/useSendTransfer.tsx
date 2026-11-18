import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { TransactionGraph, TransactionId } from '@/core/transactions/domain'
import { formatBaseUnitAmount, formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import type { SendTransferViewState } from '@/popup/components/transaction/SendTransferView'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import { useTransferFeePreview } from '@/popup/hooks/useTransferFeePreview'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import { openModal } from '@/popup/provider/ModalManager'
import {
  createNativeTransferSource,
  estimateNativeTransferMaximum,
  fallbackTransferMaximum,
  isTransferAmountSpendable
} from '@/popup/services/transfer-maximum'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'
import { formatSendReviewAmounts, parseSendAmount } from '@/popup/services/send-transfer-model'

interface TransferReview {
  readonly graph: TransactionGraph
  readonly review: { readonly payloadFingerprint: { readonly digestHex: string } }
}

interface TransferSubmission {
  readonly graph: TransactionGraph
}

export interface SendTransferConfig<R extends TransferReview, S extends TransferSubmission> {
  readonly family: 'solana' | 'near'
  readonly selection: { readonly asset: PortfolioAssetView; readonly chain: PortfolioChainView }
  readonly priceUsd: string | null
  readonly initialRecipient?: string
  readonly initialAmount?: string
  readonly onDraftChange?: (
    assetId: string,
    draft: Readonly<{ recipient: string; amount: string }>
  ) => void
  readonly onSubmitted: (submission: S) => void
  readonly parseRecipient: (value: string) => string
  readonly recipientPlaceholder: string
  readonly invalidRecipientMessage: string
  readonly reviewDescription: string
  readonly reviewMismatchMessage: string
  readonly feeDecimals: number
  readonly feeSymbol: string
  readonly totalLabel: string
  readonly prepare: (intent: {
    assetId: string
    recipient: string
    amountRaw: string
  }) => Promise<R>
  readonly approve: (id: TransactionId, fingerprint: string) => Promise<S>
  readonly reject: (id: TransactionId) => Promise<TransactionGraph>
  readonly estimateFeeRaw: (review: R, chainId: string) => string
  readonly matchesReview: (
    review: R,
    asset: PortfolioAssetView,
    recipient: string,
    amountRaw: string
  ) => boolean
  readonly reviewSender: (review: R) => string
  readonly prepareError: (error: unknown, networkName: string, symbol: string) => string
  readonly approvalError: (error: unknown) => string
}

export function useSendTransfer<R extends TransferReview, S extends TransferSubmission>(
  config: SendTransferConfig<R, S>
): SendTransferViewState {
  const [amount, setAmount] = useState(config.initialAmount ?? '')
  const [recipient, setRecipient] = useState(config.initialRecipient ?? '')
  const [selectedRecipient, setSelectedRecipient] = useState<{
    address: string
    name: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [maxSelected, setMaxSelected] = useState(false)
  const [review, setReview] = useState<{ recipient: string; amountRaw: string; value: R } | null>(
    null
  )
  const pendingReview = useRef<R | null>(null)
  const { asset, chain } = config.selection
  const networkName = formatPortfolioNetworkName(chain)

  useEffect(() => {
    config.onDraftChange?.(asset.asset.id, { recipient, amount: maxSelected ? '' : amount })
  }, [amount, asset.asset.id, maxSelected, config.onDraftChange, recipient])

  const reject = config.reject
  useEffect(
    () => () => {
      const pending = pendingReview.current
      if (pending) void reject(pending.graph.root.id).catch(() => {})
    },
    [reject]
  )

  const amountRaw = useMemo(
    () => parseSendAmount(amount, asset.metadata.decimals),
    [amount, asset.metadata.decimals]
  )
  const parsedRecipient = useMemo(() => {
    try {
      return config.parseRecipient(recipient)
    } catch {
      return null
    }
  }, [recipient, config.parseRecipient])
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
  const availability = resolvePortfolioTransferAvailability({
    balanceRaw: asset.balance.availableRaw,
    decimals: asset.metadata.decimals,
    isNative: asset.asset.kind === 'native',
    maximumRaw: maximum.value?.amountRaw ?? null
  })
  const amountWithinBalance = isTransferAmountSpendable(amountRaw, availability.amountRaw)
  const maximumPending =
    maxSelected && asset.asset.kind === 'native' && (maximum.loading || !maximum.value)
  useEffect(() => {
    if (maxSelected && maximum.value)
      setAmount(formatBaseUnitDecimalAmount(maximum.value.amountRaw, asset.metadata.decimals))
  }, [maxSelected, maximum.value, asset.metadata.decimals])

  const setInputAmount = (value: string) => {
    if (!/^\d*\.?\d*$/.test(value)) return
    setMaxSelected(false)
    setAmount(value)
  }
  const setInputRecipient = (value: string) => {
    setMaxSelected(false)
    if (maxSelected) setAmount('')
    setRecipient(value.trim())
    setSelectedRecipient(null)
  }
  const selectRecipient = async () => {
    await openModal<string | undefined>({
      title: 'Select Recipient',
      showCloseButton: true,
      body: resolve => (
        <RecipientSelector
          chainId={chain.chain.id}
          onSelect={(address, name) => {
            setMaxSelected(false)
            if (maxSelected) setAmount('')
            setRecipient(address)
            setSelectedRecipient(name ? { address, name } : null)
            resolve(address)
          }}
        />
      )
    })
  }
  const selectMaximum = () => {
    if (asset.asset.kind === 'token') {
      setAmount(availability.display)
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
      throw new Error(`Incomplete ${config.feeSymbol} transfer`)
    }
    let value: R | null = null
    try {
      value = await config.prepare({
        assetId: asset.asset.id,
        recipient: parsedRecipient,
        amountRaw
      })
      return config.estimateFeeRaw(value, chain.chain.id)
    } finally {
      if (value) await config.reject(value.graph.root.id).catch(() => {})
    }
  }, [amountRaw, amountWithinBalance, asset.asset.id, chain.chain.id, config, parsedRecipient])
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

  const rejectPrepared = async (value: R) => {
    pendingReview.current = null
    await config.reject(value.graph.root.id).catch(() => {})
  }
  const continueTransfer = async () => {
    if (!amountWithinBalance || !amountRaw || !parsedRecipient || maximumPending) return
    setPreparing(true)
    setError(null)
    let value: R | null = null
    try {
      value = await config.prepare({
        assetId: asset.asset.id,
        recipient: parsedRecipient,
        amountRaw
      })
      if (!config.matchesReview(value, asset, parsedRecipient, amountRaw)) {
        await rejectPrepared(value)
        setError(config.reviewMismatchMessage)
        return
      }
      pendingReview.current = value
      setReview({ recipient: parsedRecipient, amountRaw, value })
    } catch (prepareError) {
      if (value) await rejectPrepared(value)
      setError(config.prepareError(prepareError, networkName, asset.metadata.symbol))
    } finally {
      setPreparing(false)
    }
  }
  const closeReview = async () => {
    const current = review
    setReview(null)
    if (current) await rejectPrepared(current.value)
  }
  const approveTransfer = async () => {
    if (!review) return
    setApproving(true)
    setError(null)
    recordSendSubmission(review.value.graph, asset.metadata.symbol)
    try {
      const submission = await config.approve(
        review.value.graph.root.id,
        review.value.review.payloadFingerprint.digestHex
      )
      pendingReview.current = null
      setReview(null)
      recordSendResult(submission.graph, asset.metadata.symbol)
      config.onSubmitted(submission)
    } catch (approvalError) {
      recordSendApprovalFailure(review.value.graph, asset.metadata.symbol)
      const current = review
      pendingReview.current = null
      setReview(null)
      setError(config.approvalError(approvalError))
      void config.reject(current.value.graph.root.id).catch(() => {})
    } finally {
      setApproving(false)
    }
  }

  const reviewAmounts = review
    ? formatSendReviewAmounts(
        review.amountRaw,
        review.value.graph.root.intent?.feeLimit?.amountRaw ?? '0',
        asset.metadata.decimals,
        config.feeDecimals,
        asset.asset.kind === 'native'
      )
    : null

  return {
    family: config.family,
    asset: {
      assetId: asset.asset.id,
      symbol: asset.metadata.symbol,
      icon: asset.metadata.iconUrl,
      nativeChain: asset.asset.kind === 'native' ? config.family : undefined,
      blockchain: asset.asset.kind === 'token' ? config.family : undefined
    },
    priceUsd: config.priceUsd,
    networkName,
    recipientPlaceholder: config.recipientPlaceholder,
    invalidRecipientMessage: config.invalidRecipientMessage,
    reviewDescription: config.reviewDescription,
    feeSymbol: config.feeSymbol,
    totalLabel: config.totalLabel,
    amount,
    recipient,
    selectedRecipient,
    recipientInvalid: Boolean(recipient && !parsedRecipient),
    insufficientBalance: amountRaw !== null && !amountWithinBalance,
    availableDisplay: availability.display,
    maxSelected,
    maxDisabled:
      BigInt(asset.balance.availableRaw) <= 0n ||
      (asset.asset.kind === 'native' && !parsedRecipient) ||
      maximum.loading,
    continueDisabled:
      !amountWithinBalance || !parsedRecipient || maximumPending || feePreview.loading,
    continueLoading: preparing || (maxSelected && maximum.loading) || feePreview.loading,
    feePreviewLoading: feePreview.loading,
    previewFee: feePreview.amountRaw
      ? formatBaseUnitAmount(feePreview.amountRaw, config.feeDecimals)
      : '—',
    approving,
    error,
    review:
      review && reviewAmounts
        ? {
            recipient: review.recipient,
            sender: config.reviewSender(review.value),
            ...reviewAmounts
          }
        : null,
    setInputAmount,
    setInputRecipient,
    selectRecipient,
    selectMaximum,
    continueTransfer,
    closeReview,
    approveTransfer
  }
}
