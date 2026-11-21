import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import {
  parseSupportedBitcoinAddress,
  type BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'
import {
  BitcoinWalletClientError,
  bitcoinWalletClient,
  type BitcoinTransferReview,
  type BitcoinTransferSubmission
} from '@/popup/services/bitcoin-wallet-client'
import type { BitcoinTransferAmount } from '@/infrastructure/chains/bitcoin'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { formatPortfolioNetworkName } from '@/popup/services/portfolio-format'
import { openMultichainHardwareSignTab } from '@/lib/hardware-tab'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'
import {
  formatBitcoinInputAddressType,
  getBitcoinSendApprovalError,
  getBitcoinSendPrepareError,
  isBitcoinBalanceKnown,
  isBitcoinSendAmountValid
} from '@/popup/services/bitcoin-send-model'
import { openModal } from '@/popup/provider/ModalManager'
import {
  bitcoinAddressBalancesClient,
  type BitcoinAddressBalanceCatalogView
} from '@/popup/services/bitcoin-address-balances-client'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import type { SendTransferViewState } from '@/popup/components/transaction/SendTransferView'
import { DEFAULT_NETWORK_FEE_TIER, type NetworkFeeTier } from '@/core/transactions/domain'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { usePortfolioUpdates } from '@/popup/hooks/usePortfolioUpdates'
import { useTransferFeePreview } from '@/popup/hooks/useTransferFeePreview'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import {
  createNativeTransferSource,
  estimateNativeTransferMaximum,
  fallbackTransferMaximum
} from '@/popup/services/transfer-maximum'

interface BitcoinSendAsset {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
}

interface PreparedReview {
  readonly recipient: string
  readonly amountRaw: string
  readonly feeTier: NetworkFeeTier
  readonly value: BitcoinTransferReview
}

export function useBitcoinSendTransfer({
  selection,
  onSubmitted
}: {
  readonly selection: BitcoinSendAsset
  readonly onSubmitted: (submission: BitcoinTransferSubmission) => void
}) {
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [selectedRecipient, setSelectedRecipient] = useState<{
    address: string
    name: string
  } | null>(null)
  const [feeTier, setFeeTier] = useState<NetworkFeeTier>(DEFAULT_NETWORK_FEE_TIER)
  const [sendMaximum, setSendMaximum] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [updatingFee, setUpdatingFee] = useState(false)
  const [review, setReview] = useState<PreparedReview | null>(null)
  const [bitcoinAddressType, setBitcoinAddressType] =
    useState<BitcoinSupportedAddressType>('p2wpkh')
  const [addressCatalog, setAddressCatalog] = useState<BitcoinAddressBalanceCatalogView | null>(
    null
  )
  const { activeAccount } = useActiveAccountNetworks()
  const pendingReview = useRef<BitcoinTransferReview | null>(null)
  const asset = selection.asset
  const chain = selection.chain
  const selectedAvailableRaw = addressCatalog?.availableRaw ?? asset.balance.availableRaw
  const balanceKnown = Boolean(
    addressCatalog && isBitcoinBalanceKnown(addressCatalog.updatedAt || asset.updatedAt)
  )

  const refreshAddressCatalog = useCallback(async () => {
    if (!activeAccount) return
    const value = await bitcoinAddressBalancesClient.getActiveCatalog()
    if (value?.walletId !== activeAccount.walletId || value.accountId !== activeAccount.accountId) {
      return
    }
    setAddressCatalog(value)
    setBitcoinAddressType(value.activeAddressType)
  }, [activeAccount])

  usePortfolioUpdates(
    activeAccount?.walletId ?? null,
    activeAccount?.accountId ?? null,
    refreshAddressCatalog
  )

  useEffect(
    () => () => {
      const pending = pendingReview.current
      if (pending) void bitcoinWalletClient.rejectTransfer(pending.graph.root.id).catch(() => {})
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    bitcoinAddressBalancesClient
      .getActiveCatalog()
      .then(value => {
        if (!cancelled) {
          setAddressCatalog(value)
          if (value) setBitcoinAddressType(value.activeAddressType)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const amountRaw = useMemo(() => {
    try {
      return parseDisplayUnitAmount(amount, asset.metadata.decimals)
    } catch {
      return null
    }
  }, [amount, asset.metadata.decimals])
  const parsedRecipient = useMemo(() => {
    try {
      return parseSupportedBitcoinAddress(recipient, chain.chain.id)
    } catch {
      return null
    }
  }, [chain.chain.id, recipient])
  const maximum = useTransferMaximum({
    enabled:
      balanceKnown &&
      parsedRecipient !== null &&
      BigInt(selectedAvailableRaw) > 0n &&
      !preparing &&
      review === null,
    requestKey: `${activeAccount?.walletId}:${activeAccount?.accountId}:${selectedAvailableRaw}:${parsedRecipient}:${feeTier}:${bitcoinAddressType}`,
    fallback: () =>
      fallbackTransferMaximum(
        createNativeTransferSource({
          asset,
          chain,
          availableRaw: selectedAvailableRaw,
          sender: '',
          bitcoinAddressType
        })
      ),
    estimate: () =>
      estimateNativeTransferMaximum({
        source: createNativeTransferSource({
          asset,
          chain,
          availableRaw: selectedAvailableRaw,
          sender: '',
          bitcoinAddressType
        }),
        recipient: parsedRecipient ?? '',
        feeTier
      })
  })
  const transferAvailability = resolvePortfolioTransferAvailability({
    balanceRaw: selectedAvailableRaw,
    decimals: asset.metadata.decimals,
    isNative: true,
    maximumRaw: maximum.value?.amountRaw ?? null
  })
  const availableDisplay = balanceKnown
    ? transferAvailability.display
    : chain.status === 'error'
      ? '—'
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

  const rejectPrepared = async (value: BitcoinTransferReview) => {
    pendingReview.current = null
    await bitcoinWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
  }

  const estimateFee = useCallback(async () => {
    if (!validAmount || !parsedRecipient || (!sendMaximum && amountRaw === null)) {
      throw new Error('Incomplete Bitcoin transfer')
    }
    let requestedAmount: BitcoinTransferAmount
    if (sendMaximum) {
      requestedAmount = { mode: 'max' }
    } else {
      if (amountRaw === null) throw new Error('Incomplete Bitcoin transfer')
      requestedAmount = { mode: 'exact', valueSats: amountRaw }
    }
    let value: BitcoinTransferReview | null = null
    try {
      value = await bitcoinWalletClient.prepareTransfer(
        { recipient: parsedRecipient, amount: requestedAmount },
        { feeTier, bitcoinAddressType }
      )
      const feeLimit = value.graph.root.intent?.feeLimit
      if (!feeLimit || !/^(?:0|[1-9][0-9]*)$/.test(feeLimit.amountRaw)) {
        throw new Error('Invalid Bitcoin fee estimate')
      }
      return feeLimit.amountRaw
    } finally {
      if (value) await bitcoinWalletClient.rejectTransfer(value.graph.root.id).catch(() => {})
    }
  }, [amountRaw, bitcoinAddressType, feeTier, parsedRecipient, sendMaximum, validAmount])
  const feePreview = useTransferFeePreview({
    enabled:
      validAmount && !sendMaximum && parsedRecipient !== null && !preparing && review === null,
    requestKey: `${parsedRecipient ?? ''}:${amountRaw ?? ''}:${sendMaximum}:${feeTier}:${bitcoinAddressType}`,
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
          onSelect={(address, name) => {
            setRecipient(address)
            setSelectedRecipient(name ? { address, name } : null)
            resolve(address)
          }}
        />
      )
    })
  }

  const handleContinue = async () => {
    if (!validAmount || !parsedRecipient || (!sendMaximum && amountRaw === null)) return
    let requestedAmount: BitcoinTransferAmount
    if (sendMaximum) {
      requestedAmount = { mode: 'max' }
    } else {
      if (amountRaw === null) return
      requestedAmount = { mode: 'exact', valueSats: amountRaw }
    }
    setPreparing(true)
    setError(null)
    try {
      const value = await bitcoinWalletClient.prepareTransfer(
        {
          recipient: parsedRecipient,
          amount: requestedAmount
        },
        { feeTier, bitcoinAddressType }
      )
      const summary = value.review.summary
      if (summary.schema !== 'bitcoin.psbt.v1') {
        await rejectPrepared(value)
        setError('The wallet returned an invalid Bitcoin review.')
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
        setError('The Bitcoin review does not match the requested transfer.')
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
      setError(getBitcoinSendPrepareError(prepareError))
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
    let replacement: BitcoinTransferReview | null = null
    let currentReleased = false
    try {
      await bitcoinWalletClient.rejectTransfer(current.value.graph.root.id)
      pendingReview.current = null
      currentReleased = true

      replacement = await bitcoinWalletClient.prepareTransfer(
        {
          recipient: current.recipient,
          amount: sendMaximum ? { mode: 'max' } : { mode: 'exact', valueSats: current.amountRaw }
        },
        { feeTier: nextFeeTier, bitcoinAddressType }
      )
      const nextSummary = replacement.review.summary
      if (nextSummary.schema !== 'bitcoin.psbt.v1') {
        throw new Error('The wallet returned an invalid Bitcoin review.')
      }
      const recipientOutputs = nextSummary.fields.outputs.filter(
        output => output.classification === 'recipient' && output.address === current.recipient
      )
      if (
        recipientOutputs.length !== 1 ||
        (!sendMaximum && recipientOutputs[0].amountSats !== current.amountRaw)
      ) {
        throw new Error('The Bitcoin review does not match the requested transfer.')
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
        await bitcoinWalletClient.rejectTransfer(replacement.graph.root.id).catch(() => {})
      }
      if (currentReleased) {
        setReview(null)
      }
      const message =
        cause instanceof BitcoinWalletClientError
          ? getBitcoinSendPrepareError(cause)
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
      const submission = await bitcoinWalletClient.approveTransfer(
        review.value.graph.root.id,
        review.value.review.payloadFingerprint.digestHex
      )
      pendingReview.current = null
      setReview(null)
      if (submission.status === 'external-signature-required') {
        try {
          await openMultichainHardwareSignTab(submission.transactionId, 'bitcoin')
        } catch (handoffError) {
          await bitcoinWalletClient.rejectTransfer(submission.transactionId)
          throw handoffError
        }
        window.close()
        return
      }
      recordSendResult(submission.graph, selection.asset.metadata.symbol)
      onSubmitted(submission)
    } catch (approveError) {
      recordSendApprovalFailure(review.value.graph, selection.asset.metadata.symbol)
      const current = review
      pendingReview.current = null
      setReview(null)
      setError(getBitcoinSendApprovalError(approveError))
      void bitcoinWalletClient.rejectTransfer(current.value.graph.root.id).catch(() => {})
    } finally {
      setApproving(false)
    }
  }

  const summary = review?.value.review.summary
  const feeRaw = summary?.schema === 'bitcoin.psbt.v1' ? summary.fields.feeSats : '0'
  const fee = formatBaseUnitAmount(feeRaw, 8)
  const reviewAmount = formatBaseUnitAmount(review?.amountRaw ?? '0', 8)
  const total = review
    ? formatBaseUnitAmount((BigInt(review.amountRaw) + BigInt(feeRaw)).toString(), 8)
    : '0'

  const testnet = chain.chain.network.kind === 'testnet'
  const input: Omit<SendTransferViewState, 'review'> = {
    family: 'bitcoin',
    asset: {
      assetId: asset.asset.id,
      symbol: 'BTC',
      icon: asset.metadata.iconUrl,
      nativeChain: 'bitcoin'
    },
    networkName: formatPortfolioNetworkName(chain),
    recipientPlaceholder: testnet ? 'Bitcoin testnet address' : 'Bitcoin address',
    invalidRecipientMessage: testnet
      ? 'Enter a valid Bitcoin testnet address.'
      : 'Enter a valid Bitcoin address.',
    reviewDescription:
      'Review the Bitcoin recipient, inputs, and exact network fee before sending.',
    feeSymbol: 'BTC',
    totalLabel: 'Total',
    amount,
    recipient,
    selectedRecipient,
    recipientInvalid: Boolean(recipient && !parsedRecipient),
    availableDisplay,
    balanceKnown,
    insufficientBalance:
      balanceKnown &&
      !sendMaximum &&
      amountRaw !== null &&
      BigInt(amountRaw) > BigInt(selectedAvailableRaw),
    maxSelected: sendMaximum,
    maxDisabled:
      !balanceKnown || BigInt(selectedAvailableRaw) <= 0n || !parsedRecipient || maximum.loading,
    feePreviewLoading: feePreview.loading,
    previewFee,
    continueDisabled: !validAmount || !parsedRecipient || maximum.loading || feePreview.loading,
    continueLoading: preparing || maximum.loading || feePreview.loading,
    approving,
    error,
    setInputAmount: value => {
      if (/^\d*\.?\d*$/.test(value)) {
        setAmount(value)
        setSendMaximum(false)
      }
    },
    setInputRecipient: value => {
      setRecipient(value.trim())
      setSelectedRecipient(null)
    },
    selectRecipient: handleSelectRecipient,
    selectMaximum: () => {
      setSendMaximum(true)
      void maximum.request()
    },
    continueTransfer: handleContinue,
    closeReview: handleCloseReview,
    approveTransfer: handleApprove
  }

  return {
    input,
    feeTier,
    bitcoinAddressType,
    changeFeeTier: (nextTier: NetworkFeeTier) => {
      setFeeTier(nextTier)
      if (sendMaximum) {
        setSendMaximum(false)
        setAmount('')
      }
    },
    review:
      review && summary?.schema === 'bitcoin.psbt.v1'
        ? {
            recipient: review.recipient,
            sender: summary.fields.signer,
            amount: reviewAmount,
            fee,
            total,
            feeTier: review.feeTier,
            inputCount: summary.fields.inputs.length,
            inputAddressType: formatBitcoinInputAddressType(summary.fields.inputs)
          }
        : null,
    updatingFee,
    changeReviewFeeTier: handleReviewFeeTierChange
  }
}
