import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import {
  parseSupportedBitcoinAddress,
  type BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'
import { formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
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
  formatTokenQuantity,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { formatPortfolioNetworkName } from '@/popup/components/portfolio/portfolio-format'
import { openHardwareBitcoinSignTab } from '@/lib/hardware-tab'
import {
  recordSendApprovalFailure,
  recordSendResult,
  recordSendSubmission
} from '@/popup/services/send-transaction-analytics'
import {
  formatBitcoinInputAddressType,
  isBitcoinBalanceKnown,
  isBitcoinSendAmountValid
} from './bitcoin-send-display'
import { openModal } from '@/popup/provider/ModalManager'
import {
  bitcoinAddressBalancesClient,
  type BitcoinAddressBalanceCatalogView
} from '@/popup/services/bitcoin-address-balances-client'
import { bitcoinAccountTypeDescription } from '@/popup/components/bitcoin/BitcoinAccountTypeSelector'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
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
import { DEFAULT_NETWORK_FEE_TIER, type NetworkFeeTier } from '@/core/transactions/domain'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { usePortfolioUpdates } from '@/popup/hooks/usePortfolioUpdates'
import { useTransferFeePreview } from '@/popup/hooks/useTransferFeePreview'
import { estimateBitcoinSendTime } from '@/popup/services/send-time-estimate'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import { resolvePortfolioTransferAvailability } from '@/popup/services/transfer-availability'
import {
  createNativeTransferSource,
  estimateNativeTransferMaximum,
  fallbackTransferMaximum
} from '@/popup/services/transfer-maximum'
import { getBitcoinSendApprovalError, getBitcoinSendPrepareError } from './bitcoin-send-validation'

export interface BitcoinSendAsset {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
}

interface PreparedReview {
  readonly recipient: string
  readonly amountRaw: string
  readonly feeTier: NetworkFeeTier
  readonly value: BitcoinTransferReview
}

export function BitcoinSendForm({
  selection,
  priceUsd,
  onSubmitted
}: {
  readonly selection: BitcoinSendAsset
  readonly priceUsd: string | null
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
          await openHardwareBitcoinSignTab(submission.transactionId)
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

  return (
    <>
      <SendFormView
        domain="public"
        availableDomains={['public']}
        onDomainChange={() => {}}
        amountInput={
          <SendAmountInputCard
            ariaLabel="BTC amount"
            value={amount}
            onChange={value => {
              if (/^\d*\.?\d*$/.test(value)) {
                setAmount(value)
                setSendMaximum(false)
              }
            }}
            available={availableDisplay}
            symbol="BTC"
            priceUsd={balanceKnown ? priceUsd : null}
            inline
          />
        }
        assetSelector={
          <SendAssetHeader
            assetId={asset.asset.id}
            symbol="BTC"
            icon={asset.metadata.iconUrl}
            networkName={formatPortfolioNetworkName(chain)}
            nativeChain="bitcoin"
            variant="pill"
          />
        }
        balance={
          <span title={balanceKnown ? availableDisplay : undefined}>
            {balanceKnown ? formatTokenQuantity(availableDisplay) : '—'}
          </span>
        }
        maxButton={
          <button
            type="button"
            aria-label="Max"
            aria-pressed={sendMaximum}
            disabled={
              !balanceKnown ||
              BigInt(selectedAvailableRaw) <= 0n ||
              !parsedRecipient ||
              maximum.loading
            }
            onClick={() => {
              setSendMaximum(true)
              void maximum.request()
            }}
            className="rounded-md bg-white/10 px-2 py-1 font-medium text-muted aria-pressed:bg-primary/15 aria-pressed:text-primary disabled:opacity-40"
          >
            Max
          </button>
        }
        recipient={
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <SendFieldLabel>Send to</SendFieldLabel>
              <span>{formatPortfolioNetworkName(chain)}</span>
            </div>
            <SendRecipientInputCard
              id="bitcoin-send-recipient"
              value={recipient}
              onChange={value => {
                setRecipient(value.trim())
                setSelectedRecipient(null)
              }}
              placeholder={
                chain.chain.network.kind === 'testnet'
                  ? 'Bitcoin testnet address'
                  : 'Bitcoin address'
              }
              variant="filled"
              hideLabel
              onSelectRecipient={() => void handleSelectRecipient()}
            />
            {recipient && !parsedRecipient && (
              <p className="mt-2 px-1 text-xs text-danger">
                {chain.chain.network.kind === 'testnet'
                  ? 'Enter a valid Bitcoin testnet address.'
                  : 'Enter a valid Bitcoin address.'}
              </p>
            )}
          </div>
        }
        footer={
          <SendFormActions
            disabled={!validAmount || !parsedRecipient || maximum.loading || feePreview.loading}
            loading={preparing || maximum.loading || feePreview.loading}
            onContinue={handleContinue}
          />
        }
      >
        <div>
          <SendRouteInfoCard
            fee={
              <div className="flex min-w-0 items-center gap-1.5">
                {feePreview.loading && (
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
                  amount={previewFee}
                  symbol="BTC"
                  layout="inline"
                  onTierChange={nextTier => {
                    setFeeTier(nextTier)
                    if (sendMaximum) {
                      setSendMaximum(false)
                      setAmount('')
                    }
                  }}
                />
              </div>
            }
            time={estimateBitcoinSendTime(feeTier)}
            extra={
              <div className="border-t border-white/10 pt-3 text-muted">
                {bitcoinAccountTypeDescription(bitcoinAddressType)}
              </div>
            }
          />
        </div>

        {balanceKnown &&
          !sendMaximum &&
          amountRaw !== null &&
          BigInt(amountRaw) > BigInt(selectedAvailableRaw) && (
            <p role="alert" className="mt-3 text-xs text-danger">
              Insufficient BTC balance.
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
          aria-labelledby="bitcoin-send-review-title"
        >
          <DialogTitle className="sr-only" aria-hidden="true">
            Confirm Send
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review the Bitcoin recipient, inputs, and exact network fee before sending.
          </DialogDescription>

          {review && summary?.schema === 'bitcoin.psbt.v1' && (
            <TransactionReviewView
              title="Confirm Send"
              titleId="bitcoin-send-review-title"
              variant="figma"
              asset={{ symbol: 'BTC', nativeChain: 'bitcoin' }}
              amount={reviewAmount}
              amountPrefix="-"
              network={formatPortfolioNetworkName(chain)}
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
                { label: 'Network', content: formatPortfolioNetworkName(chain) },
                {
                  label: 'From',
                  content: (
                    <span className="font-mono text-muted" title={summary.fields.signer}>
                      {formatSortAddress(summary.fields.signer)}
                    </span>
                  )
                },
                { label: 'Inputs', content: summary.fields.inputs.length },
                {
                  label: 'Network fee',
                  content: (
                    <NetworkFeeTierPicker
                      chainFamily="bitcoin"
                      tier={review.feeTier}
                      amount={fee}
                      symbol="BTC"
                      onTierChange={handleReviewFeeTierChange}
                      disabled={updatingFee || approving}
                    />
                  )
                },
                { label: 'Total', content: <AmountDisplay value={total} symbol="BTC" /> },
                {
                  label: 'Address type',
                  content: formatBitcoinInputAddressType(summary.fields.inputs)
                }
              ]}
              confirmLabel="Confirm"
              confirming={approving}
              submitting={approving}
              preparing={updatingFee}
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
