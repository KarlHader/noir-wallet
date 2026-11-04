import { useState, useCallback, useEffect, useRef } from 'react'
import { Icon } from '@iconify/react'
import { useNavigate } from '../../provider/Router'
import { openModal } from '../../provider/ModalManager'
import { useWalletStore } from '@/store/wallet-store'
import { buildAccountKey, useAccountDataStore } from '@/store/account-data-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { useSettingsStore } from '@/store/settings-store'
import { marginalFeeForTier, staticFeeFallbackZats } from '@/config/fee'
import { fetchQuote, type QuoteResult } from '@/core/services/intents-api'
import { parseAmount } from '@/lib/format'
import { useSwapPreferences } from '@/store/swap-store'
import { toast } from '@/store/toast-store'
import { useTransaction } from '../../hooks/useTransaction'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '../../hooks/useMaxTransferEstimate'
import { accountManager } from '@/core/wallet/account-manager'
import { openHardwareSignAndWait, openHardwareSignTab } from '@/lib/hardware-tab'
import { isSidePanelSurface } from '@/config/extension-display'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent } from '@/lib/analytics'
import type { TrackOptions } from '@/lib/analytics'
import { calculateSwapUsdAmount } from '@/lib/analytics/swap'
import { TokenSelector } from '../../components/tokens/TokenSelector'
import { SwapQRCode } from '../../components/swap/SwapQRCode'
import { SlippageSettingContent } from '../../components/swap/SlippageSetting'
import { SwapReviewView } from '../../components/swap/SwapReviewView'
import { SwapInputView } from '../../components/swap/SwapInputView'
import { useSwapState } from '../../hooks/useSwapState'
import { AddressSelectorModal } from '../../components/account/AddressSelector'
import { PageHeader } from '../../components/common/PageHeader'
import { safeBig } from '@/lib/big'
import { classifyError } from '@/lib/errors'
import { isHardwareKeySource } from '@/lib/hardware-capabilities'
import { getIntentsStatusCopy } from '@/lib/transaction-status-copy'
import type { FundingSource } from '@/types'
import { getFundingSourceUnavailableReason } from '@/lib/funding-source'
import { getFundingAmountError, getFundingBalance } from '@/lib/funding-balance'
import { getMaxSpendableZec } from '@/config/wallet'
import { sanitizeMemoForRecipient } from '@/lib/zcash-memo'
import { selectSwapFeeEstimate } from '@/lib/swap-fee'
import { FundingSourceSelector } from '../../components/transaction/FundingSourceSelector'
import { HardwareSigningPending } from '../../components/hardware/HardwareSigningPending'
import { getNoirSwapReferral } from '@/config/near'

const SWAP_FAILED_COPY = getIntentsStatusCopy('FAILED', { actionName: 'Swap' })

type SwapViewStep = 'input' | 'review' | 'deposit'

function feeContextKey() {
  const wallet = useWalletStore.getState()
  const settings = useSettingsStore.getState()
  return JSON.stringify([
    wallet.currentWalletId,
    wallet.currentAccountId,
    wallet.currentNetwork,
    settings.rpcEndpointModes.zcash,
    settings.rpcEndpointPreferences.zcash,
    settings.customRpcEndpoints.zcash
  ])
}

export function Swap() {
  const { navigate } = useNavigate()
  const currentAccount = useWalletStore(state => state.getCurrentAccount())
  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const zecPrice = useWalletStore(state => state.zecPrice)
  const isHardwareWallet = useWalletStore(state =>
    isHardwareKeySource(state.getCurrentWallet()?.keySource)
  )
  const feeTier = useSettingsStore(state => state.feeTier)
  const setFeeTier = useSettingsStore(state => state.setFeeTier)
  const storeBalance = useAccountDataStore(state => state.getCurrentBalance())

  const swapReferral = getNoirSwapReferral(currentWallet?.keySource)
  const swap = useSwapState(swapReferral)
  const {
    addRecentRefundAddress,
    addRecentRecipientAddress,
    getRecentRefundAddresses,
    getRecentRecipientAddresses
  } = useSwapPreferences()
  const { setResult, updateSwapTxHash } = useTransactionResultStore()
  const { sendTransaction } = useTransaction()

  const [viewStep, setViewStep] = useState<SwapViewStep>('input')
  const [quoteResult, setQuoteResult] = useState<QuoteResult | null>(null)
  const [quotedRecipient, setQuotedRecipient] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isHardwareSigning, setIsHardwareSigning] = useState(false)
  const [maxSelected, setMaxSelected] = useState(false)
  const [fundingSource, setFundingSource] = useState<FundingSource>('shielded')
  const confirmationInFlight = useRef(false)
  const reviewRevision = useRef(0)

  useEffect(
    () => () => {
      reviewRevision.current += 1
    },
    []
  )

  const sourceBalance = getFundingBalance(storeBalance, fundingSource)
  const rawSpendable = swap.isZecToOther ? sourceBalance.spendable : '0'
  const fundingSourceUnavailableReason = getFundingSourceUnavailableReason(
    currentWallet?.keySource,
    fundingSource
  )
  const swapMemo =
    swap.isZecToOther && swap.tokenIn && swap.tokenOut
      ? `Swap ${swap.tokenIn.symbol} → ${swap.tokenOut.symbol}`
      : undefined
  const onChainSwapMemo = sanitizeMemoForRecipient(swap.depositAddress, swapMemo)

  const maxTransfer = useMaxTransferEstimate({
    to: swap.depositAddress,
    memo: onChainSwapMemo,
    feeTier,
    fundingSource,
    enabled: swap.isZecToOther && !!swap.depositAddress
  })
  const isMaxTransferAmount =
    !!maxTransfer.maxAmount && safeBig(swap.amountIn || '0').eq(maxTransfer.maxAmount)

  // Estimate as soon as we have a deposit address, so the input page reflects
  // the live tier fee instead of waiting until the review step.
  const feeEstimate = useFeeEstimate({
    type: 'send',
    to: swap.depositAddress,
    amount: swap.amountIn,
    memo: onChainSwapMemo,
    fundingSource,
    feeTier,
    enabled: swap.isZecToOther && !!swap.depositAddress && !maxSelected && !isMaxTransferAmount
  })
  const feeByTier = feeEstimate.feeByTier
  const isMaxFeeMode = maxSelected || isMaxTransferAmount
  const displayedFeeByTier = isMaxFeeMode ? maxTransfer.feeByTier : feeByTier
  const displayedFeeLoadingByTier = isMaxFeeMode
    ? maxTransfer.loadingByTier
    : feeEstimate.loadingByTier
  const displayedFeeLoading = isMaxFeeMode ? maxTransfer.loading : feeEstimate.loading
  const standardFeeZats = feeByTier.standard ?? staticFeeFallbackZats('standard')
  const selectedFeeZats = feeByTier[feeTier] ?? staticFeeFallbackZats(feeTier)
  const extraFeeZec = safeBig(Math.max(0, selectedFeeZats - standardFeeZats))
    .div(1e8)
    .toNumber()
  const fallbackSpendable = swap.isZecToOther
    ? (() => {
        const trimmed = safeBig(getMaxSpendableZec(rawSpendable)).minus(extraFeeZec)
        return trimmed.lt(0) ? safeBig(0) : trimmed
      })()
    : safeBig(0)
  const effectiveSpendable = maxTransfer.maxAmount
    ? safeBig(maxTransfer.maxAmount)
    : fallbackSpendable
  const spendableBalance = swap.isZecToOther ? effectiveSpendable.toFixed() : '0'
  const selectedFee = selectSwapFeeEstimate(
    swap.amountIn,
    maxSelected,
    maxTransfer.maxAmount,
    { ...maxTransfer, feeZats: maxTransfer.feeByTier[feeTier] },
    feeEstimate
  )
  const networkFee =
    selectedFee.feeZats === null ? undefined : safeBig(selectedFee.feeZats).div(1e8).toFixed()
  const selectedFeeQuote = selectedFee.feeQuote
  const feeReady = selectedFee.ready
  const latestFee = useRef(selectedFee)
  latestFee.current = selectedFee

  useEffect(() => {
    if (!swap.isZecToOther || !selectedFee.staleMax || isSending) return
    reviewRevision.current += 1
    setMaxSelected(false)
    setViewStep('input')
    toast.info('Maximum amount changed', 'Review the quote again before sending.')
  }, [swap.isZecToOther, selectedFee.staleMax, isSending])

  const amountError = swap.isZecToOther
    ? getFundingAmountError(swap.amountIn, sourceBalance, maxTransfer.maxAmount)
    : null
  const amountErrorCopy =
    amountError === 'pending'
      ? 'Wait for pending funds or lower the amount.'
      : amountError === 'fee'
        ? 'Lower the amount or select Max to include the network fee.'
        : amountError === 'insufficient'
          ? 'Amount exceeds available balance.'
          : undefined
  const hasInsufficientFunds = !!amountError

  const swapEventBase = useCallback(
    (): TrackOptions => ({
      pageId: PAGE_IDS.SWAP,
      inputAmount: swap.amountIn,
      inputSymbol: swap.tokenIn?.symbol,
      inputTokenCode: swap.tokenIn?.assetId,
      outputAmount: swap.amountOut,
      outputSymbol: swap.tokenOut?.symbol,
      outputTokenCode: swap.tokenOut?.assetId,
      usdAmount: calculateSwapUsdAmount({
        amountIn: swap.amountIn,
        inputPrice: swap.tokenIn?.price,
        amountOut: swap.amountOut,
        outputPrice: swap.tokenOut?.price
      }),
      extra: { direction: swap.isZecToOther ? 'zec_to_other' : 'other_to_zec' }
    }),
    [swap]
  )

  const getQuote = useCallback(async () => {
    const { tokenIn, tokenOut, amountIn, isZecToOther, recipientAddress, refundAddress } = swap

    if (!tokenIn || !tokenOut || !amountIn || safeBig(amountIn).lte(0)) {
      toast.error('Please enter amount')
      return
    }

    if (isZecToOther && amountError) {
      toast.error(amountErrorCopy || 'Amount exceeds available balance.')
      return
    }

    if (isZecToOther && fundingSourceUnavailableReason) {
      toast.error(fundingSourceUnavailableReason)
      return
    }

    let refundTo: string
    let recipient: string

    if (isZecToOther) {
      if (!recipientAddress) {
        toast.error('Please enter receive address')
        return
      }
      refundTo = currentAccount?.addresses.transparent || ''
      recipient = recipientAddress
    } else {
      if (!refundAddress) {
        toast.error('Please enter refund address')
        return
      }
      refundTo = refundAddress
      recipient = currentAccount?.addresses[swap.addressType] || ''
    }

    swap.setIsQuoting(true)

    try {
      if (!currentAccount) {
        throw new Error('Wallet account is unavailable')
      }
      let quotedAmount = amountIn
      let result: QuoteResult | null = null

      for (let attempt = 0; attempt < 3; attempt += 1) {
        result = await fetchQuote({
          originAsset: tokenIn.assetId,
          destinationAsset: tokenOut.assetId,
          amount: parseAmount(quotedAmount, tokenIn.decimals),
          refundTo,
          recipient,
          originChain: tokenIn.blockchain,
          destinationChain: tokenOut.blockchain,
          slippageTolerance: Math.round(swap.slippage * 100),
          referral: swapReferral
        })

        const quote = result.quoteSuccessResult?.quote
        if (result.quoteStatus !== 'success' || !quote) break
        if (!quote.depositAddress) throw new Error('Quote did not include a deposit address')

        if (!isZecToOther || !maxSelected) break

        const feeQuote = await accountManager.getFeeQuote()
        const estimate = await accountManager.estimateMaxTransfer(
          quote.depositAddress,
          sanitizeMemoForRecipient(
            quote.depositAddress,
            `Swap ${tokenIn.symbol} → ${tokenOut.symbol}`
          ),
          marginalFeeForTier(feeTier, feeQuote.standardMarginalFeeZats),
          fundingSource,
          feeQuote.id
        )
        const exactMax = safeBig(estimate.maxAmountZats).div(1e8).toFixed()
        if (safeBig(quotedAmount).eq(exactMax)) break
        if (safeBig(exactMax).lte(0) || attempt === 2) {
          throw new Error('Unable to calculate the maximum spendable amount for this quote')
        }
        quotedAmount = exactMax
        swap.updateAmountIn(exactMax)
      }

      if (result?.quoteStatus === 'success' && result.quoteSuccessResult?.quote) {
        const quote = result.quoteSuccessResult.quote
        const usdAmount = calculateSwapUsdAmount({
          amountIn: quotedAmount,
          inputPrice: tokenIn.price,
          amountOut: quote.amountOutFormatted,
          outputPrice: tokenOut.price
        })
        setQuoteResult(result)
        setQuotedRecipient(recipient)
        swap.setAmountOut(quote.amountOutFormatted)
        swap.setDepositAddress(quote.depositAddress)

        if (isZecToOther && recipientAddress && tokenOut) {
          addRecentRecipientAddress(tokenOut.blockchain, recipientAddress)
        }
        if (!isZecToOther && refundAddress && tokenIn) {
          addRecentRefundAddress(tokenIn.blockchain, refundAddress)
        }

        sendAnalyticsEvent(ANALYTICS_EVENTS.SWAP_QUOTED, {
          ...swapEventBase(),
          inputAmount: quotedAmount,
          outputAmount: quote.amountOutFormatted,
          usdAmount
        })
        setViewStep('review')
      } else {
        toast.error(result?.message || 'Failed to get quote')
      }
    } catch (err) {
      toast.error(classifyError(err).userMessage)
    } finally {
      swap.setIsQuoting(false)
    }
  }, [
    swap,
    currentAccount,
    amountError,
    amountErrorCopy,
    fundingSourceUnavailableReason,
    swapEventBase,
    maxSelected,
    feeTier,
    fundingSource,
    swapReferral
  ])

  const navigateToSwapResult = useCallback(
    (txHash?: string) => {
      setResult(
        {
          type: 'swap',
          depositAddress: swap.depositAddress,
          status: null,
          tokenInSymbol: swap.tokenIn?.symbol || '',
          tokenOutSymbol: swap.tokenOut?.symbol || '',
          amountIn: swap.amountIn,
          amountOut: swap.amountOut,
          destinationChain: swap.tokenOut?.blockchain,
          zcashTxHash: txHash
        },
        '/'
      )
      navigate('/transaction-result')
    },
    [swap, navigate, setResult]
  )

  const handleConfirmSwap = useCallback(async () => {
    if (confirmationInFlight.current) return
    confirmationInFlight.current = true
    const revision = reviewRevision.current
    const contextKey = feeContextKey()
    setIsSending(true)
    try {
      if (!swap.depositAddress) return
      if (swap.isZecToOther) {
        if (!feeReady || !selectedFeeQuote || networkFee === undefined) {
          toast.error('Network fee estimate is unavailable. Please try again.')
          return
        }
        try {
          const currentQuote = await accountManager.getFeeQuote()
          if (revision !== reviewRevision.current || contextKey !== feeContextKey()) return
          if (
            currentQuote.id !== selectedFeeQuote.id ||
            selectedFeeQuote.expiresAt <= Date.now() ||
            !latestFee.current.ready ||
            latestFee.current.feeQuote?.id !== selectedFeeQuote.id ||
            latestFee.current.feeZats !== selectedFee.feeZats
          ) {
            throw new Error('Fee estimate changed')
          }
        } catch {
          if (isMaxFeeMode) maxTransfer.refresh()
          else feeEstimate.refresh()
          return
        }
        if (amountError) {
          toast.error(amountErrorCopy || 'Amount exceeds available balance.')
          return
        }

        const exactMax = maxTransfer.maxAmount
        if (exactMax && safeBig(swap.amountIn || '0').gt(exactMax)) {
          toast.error(
            'Amount exceeds spendable balance',
            'Lower the amount or select Max to include the network fee.'
          )
          return
        }

        const quote = quoteResult?.quoteSuccessResult?.quote
        const quoteBinding = quote
          ? {
              depositAddress: quote.depositAddress,
              originAsset: swap.tokenIn?.assetId,
              destinationAsset: swap.tokenOut?.assetId,
              minAmountOut: quote.minAmountOut,
              recipient: quotedRecipient,
              deadline:
                quote.deadline && Number.isFinite(Date.parse(quote.deadline))
                  ? Date.parse(quote.deadline)
                  : undefined
            }
          : undefined
        const monitorParams =
          swap.tokenIn && swap.tokenOut
            ? {
                kind: 'swap' as const,
                direction: 'from_zcash' as const,
                depositAddress: swap.depositAddress,
                tokenInSymbol: swap.tokenIn.symbol,
                tokenOutSymbol: swap.tokenOut.symbol,
                amountOut: swap.amountOut,
                usdAmount: calculateSwapUsdAmount({
                  amountIn: swap.amountIn,
                  inputPrice: swap.tokenIn.price,
                  amountOut: swap.amountOut,
                  outputPrice: swap.tokenOut.price
                }),
                actionName: 'Swap',
                originChain: swap.tokenIn.blockchain,
                destinationChain: swap.tokenOut.blockchain,
                originAsset: swap.tokenIn.assetId,
                destinationAsset: swap.tokenOut.assetId,
                quoteExpiresAt: quoteBinding?.deadline
              }
            : undefined

        const marginalFeeZats = marginalFeeForTier(
          feeTier,
          selectedFeeQuote.standardMarginalFeeZats
        )

        const submitBase = swapEventBase()
        sendAnalyticsEvent(ANALYTICS_EVENTS.SWAP_SUBMITTED, {
          ...submitBase,
          hasTransaction: 1,
          extra: { ...submitBase.extra, hardware: isHardwareWallet, funding_source: fundingSource }
        })

        // Hardware wallets sign the deposit transfer in a dedicated tab.
        if (isHardwareWallet) {
          const { currentWalletId } = useWalletStore.getState()
          if (!currentWalletId || !currentAccount) return
          const request = {
            kind: 'swap' as const,
            walletId: currentWalletId,
            accountId: currentAccount.id,
            to: swap.depositAddress,
            amount: swap.amountIn,
            displayTo: quotedRecipient,
            quoteBinding,
            monitorParams,
            fundingSource,
            marginalFeeZats,
            feeQuoteId: selectedFeeQuote.id,
            feeTier
          }
          const isSidePanel = isSidePanelSurface(window.location.search)

          if (!isSidePanel) {
            await openHardwareSignTab(request)
            window.close()
            return
          }

          setIsHardwareSigning(true)
          try {
            const result = await openHardwareSignAndWait(request)
            if (result.status === 'success') {
              navigateToSwapResult(result.txHash)
            } else if (result.status === 'timeout') {
              toast.error('Hardware signing timed out', 'The swap review has been restored.')
            } else {
              toast.info('Hardware signing cancelled')
            }
          } catch (cause) {
            toast.error('Could not open hardware signing', classifyError(cause).userMessage)
          } finally {
            setIsHardwareSigning(false)
          }
          return
        }

        navigateToSwapResult()

        let result: Awaited<ReturnType<typeof sendTransaction>>
        try {
          const fromAddress = currentAccount?.addresses[fundingSource] || ''
          const sentBase = swapEventBase()
          const failedBase = swapEventBase()
          result = await sendTransaction({
            to: swap.depositAddress,
            amount: swap.amountIn,
            from: fromAddress,
            fromType: fundingSource,
            txType: 'swap',
            displayTo: quotedRecipient,
            memo: onChainSwapMemo,
            quoteBinding,
            monitorParams,
            marginalFeeZats,
            feeQuoteId: selectedFeeQuote.id,
            feeTier,
            fee: networkFee,
            analytics: {
              onSuccess: {
                name: ANALYTICS_EVENTS.SWAP_DEPOSIT_SENT,
                options: {
                  ...sentBase,
                  hasTransaction: 1,
                  params: { from_token: swap.tokenIn?.symbol, to_token: swap.tokenOut?.symbol }
                }
              },
              onFail: {
                name: ANALYTICS_EVENTS.SWAP_FAILED,
                options: failedBase
              }
            }
          })
        } catch (cause) {
          result = { step: 'failed', error: classifyError(cause).userMessage }
        }

        if (result.step === 'success') {
          if (result.txHash) updateSwapTxHash(result.txHash)
        } else if (result.step === 'pending') {
          const currentResult = useTransactionResultStore.getState().data
          if (
            currentResult?.type === 'swap' &&
            currentResult.depositAddress === swap.depositAddress
          ) {
            setResult(
              {
                type: 'zcash',
                step: 'pending',
                amount: swap.amountIn,
                error: result.error,
                accountKey: result.accountKey,
                transactionId: result.transactionId,
                timestamp: result.timestamp
              },
              '/'
            )
          }
        } else if (result.step === 'failed') {
          setResult(
            {
              type: 'zcash',
              step: 'failed',
              amount: swap.amountIn,
              customTitle: SWAP_FAILED_COPY.title,
              customDescription: result.error || SWAP_FAILED_COPY.description || '',
              error: result.error
            },
            '/'
          )
        }
      } else {
        const quote = quoteResult?.quoteSuccessResult?.quote
        const walletState = useWalletStore.getState()
        if (
          !quote ||
          !swap.tokenIn ||
          !swap.tokenOut ||
          !currentAccount ||
          !walletState.currentWalletId
        ) {
          toast.error('Swap quote is no longer available')
          return
        }

        try {
          const accountKey = buildAccountKey(
            walletState.currentNetwork,
            walletState.currentWalletId,
            currentAccount.id
          )
          const progressResponse = await chrome.runtime.sendMessage({
            type: 'REGISTER_INTENTS_PROGRESS',
            progress: {
              kind: 'swap',
              direction: 'to_zcash',
              depositAddress: quote.depositAddress,
              tokenInSymbol: swap.tokenIn.symbol,
              tokenOutSymbol: swap.tokenOut.symbol,
              tokenInIcon: swap.tokenIn.icon || undefined,
              tokenOutIcon: swap.tokenOut.icon || undefined,
              amountIn: swap.amountIn,
              amountOut: quote.amountOutFormatted,
              usdAmount: calculateSwapUsdAmount({
                amountIn: swap.amountIn,
                inputPrice: swap.tokenIn.price,
                amountOut: quote.amountOutFormatted,
                outputPrice: swap.tokenOut.price
              }),
              actionName: 'Swap',
              accountKey,
              originChain: swap.tokenIn.blockchain,
              destinationChain: swap.tokenOut.blockchain,
              originAsset: swap.tokenIn.assetId,
              destinationAsset: swap.tokenOut.assetId,
              quoteExpiresAt:
                quote.deadline && Number.isFinite(Date.parse(quote.deadline))
                  ? Date.parse(quote.deadline)
                  : undefined
            }
          })
          if (!progressResponse?.success) {
            throw new Error(progressResponse?.error || 'Failed to save swap progress')
          }
          if (revision !== reviewRevision.current) return

          sendAnalyticsEvent(ANALYTICS_EVENTS.SWAP_DEPOSIT_SHOWN, swapEventBase())
          setViewStep('deposit')
        } catch (error) {
          toast.error('Could not prepare deposit', classifyError(error).userMessage)
        }
      }
    } finally {
      confirmationInFlight.current = false
      setIsSending(false)
    }
  }, [
    swap.depositAddress,
    swap.isZecToOther,
    swap.amountIn,
    swap.addressType,
    swap.tokenIn,
    swap.tokenOut,
    currentAccount,
    isHardwareWallet,
    fundingSource,
    feeTier,
    onChainSwapMemo,
    amountError,
    amountErrorCopy,
    maxTransfer.maxAmount,
    selectedFeeQuote,
    selectedFee.feeZats,
    feeReady,
    networkFee,
    quoteResult,
    quotedRecipient,
    navigateToSwapResult,
    setResult,
    sendTransaction,
    swapEventBase
  ])

  const handleConfirmDeposit = useCallback(() => {
    sendAnalyticsEvent(ANALYTICS_EVENTS.SWAP_DEPOSIT_CONFIRMED, swapEventBase())
    navigateToSwapResult()
  }, [navigateToSwapResult, swapEventBase])

  const handleSelectToken = useCallback(
    async (type: 'in' | 'out') => {
      await openModal({
        title: 'SELECT ASSET',
        showCloseButton: true,
        body: (_resolve, close) => (
          <TokenSelector
            excludeZec={true}
            selectedToken={(type === 'in' ? swap.tokenIn : swap.tokenOut) || undefined}
            onSelect={token => {
              if (type === 'in') {
                swap.selectTokenIn(token)
              } else {
                swap.selectTokenOut(token)
              }
              close()
            }}
          />
        )
      })
    },
    [swap]
  )

  const handleSelectZecAddress = useCallback(async () => {
    await openModal({
      title: 'Select Address',
      showCloseButton: true,
      body: (_resolve, close) => (
        <AddressSelectorModal
          selectedType={swap.addressType}
          onSelect={type => {
            swap.setAddressType(type)
            close()
          }}
          showCopy={false}
        />
      )
    })
  }, [swap])

  const handleSelectFundingSource = useCallback(async () => {
    if (!currentAccount) return
    await openModal<FundingSource>({
      title: 'Funding Source',
      showCloseButton: true,
      body: (resolve, close) => (
        <FundingSourceSelector
          selectedType={fundingSource}
          zecPrice={zecPrice}
          options={(
            [
              ['shielded', currentAccount.addresses.shielded],
              ['transparent', currentAccount.addresses.transparent]
            ] as const
          ).map(([type, address]) => ({
            type,
            address,
            available: storeBalance?.confirmed[type] ?? '0',
            pending: storeBalance?.pending[type] ?? '0',
            disabledReason: getFundingSourceUnavailableReason(currentWallet?.keySource, type)
          }))}
          onSelect={source => {
            if (source !== fundingSource) {
              setFundingSource(source)
              setMaxSelected(false)
              setQuoteResult(null)
              swap.setDepositAddress('')
              swap.updateAmountIn('')
            }
            close()
            resolve(source)
          }}
        />
      )
    })
  }, [currentAccount, currentWallet?.keySource, fundingSource, storeBalance, swap, zecPrice])

  const handleOpenSlippageSetting = useCallback(async () => {
    await openModal({
      title: 'Slippage Tolerance',
      showCloseButton: true,
      body: (_resolve, close) => (
        <SlippageSettingContent
          currentSlippage={swap.slippage}
          onSave={newSlippage => {
            swap.setSlippage(newSlippage)
            close()
          }}
        />
      )
    })
  }, [swap])

  const getHeaderProps = () => {
    switch (viewStep) {
      case 'review':
        return {
          showBack: true,
          onBack: () => {
            reviewRevision.current += 1
            setViewStep('input')
          }
        }
      case 'deposit':
        return { showBack: true, onBack: () => setViewStep('input') }
      default:
        return { showBack: true }
    }
  }

  // Render content based on view step
  const renderContent = () => {
    if (
      viewStep === 'review' &&
      quoteResult?.quoteStatus === 'success' &&
      swap.tokenIn &&
      swap.tokenOut
    ) {
      const minAmountOut = quoteResult.quoteSuccessResult?.quote.minAmountOut || '0'
      const priceImpact =
        swap.tokenIn.price && swap.tokenOut.price
          ? Math.max(
              0,
              (1 -
                safeBig(swap.amountOut || 0).toNumber() /
                  safeBig(swap.amountIn || 1).toNumber() /
                  (swap.tokenIn.price / swap.tokenOut.price)) *
                100
            )
          : 0

      return (
        <SwapReviewView
          tokenIn={swap.tokenIn}
          tokenOut={swap.tokenOut}
          amountIn={swap.amountIn}
          amountOut={swap.amountOut}
          recipient={quotedRecipient}
          minAmountOut={minAmountOut}
          priceImpact={priceImpact}
          fromFiat={swap.fromFiat}
          toFiat={swap.toFiat}
          slippage={swap.slippage}
          onConfirm={handleConfirmSwap}
          isLoading={isSending}
          feeTier={swap.isZecToOther ? feeTier : undefined}
          selectedFeeZec={swap.isZecToOther ? networkFee : undefined}
          insufficient={hasInsufficientFunds}
          feeUnavailable={swap.isZecToOther && !feeReady}
          feeError={swap.isZecToOther && (isMaxFeeMode ? maxTransfer.error : feeEstimate.error)}
          onRetryFee={isMaxFeeMode ? maxTransfer.refresh : feeEstimate.refresh}
          fundingSource={swap.isZecToOther ? fundingSource : undefined}
        />
      )
    }

    if (viewStep === 'deposit' && swap.tokenIn) {
      return (
        <SwapQRCode
          depositAddress={swap.depositAddress}
          amount={swap.amountIn}
          token={swap.tokenIn}
          onConfirmDeposit={handleConfirmDeposit}
        />
      )
    }

    const recentRefund = swap.tokenIn ? getRecentRefundAddresses(swap.tokenIn.blockchain) : []
    const recentRecipient = swap.tokenOut
      ? getRecentRecipientAddresses(swap.tokenOut.blockchain)
      : []

    return (
      <SwapInputView
        tokenIn={swap.tokenIn}
        tokenOut={swap.tokenOut}
        isZecToOther={swap.isZecToOther}
        amountIn={swap.amountIn}
        estimatedOut={swap.displayOut}
        fromFiat={swap.fromFiat}
        toFiat={swap.toFiat}
        rate={swap.rate}
        addressType={swap.addressType}
        fundingSource={fundingSource}
        availableBalance={sourceBalance.available}
        spendableBalance={spendableBalance}
        pendingBalance={sourceBalance.pending}
        recipientAddress={swap.recipientAddress}
        refundAddress={swap.refundAddress}
        slippage={swap.slippage}
        isQuoting={swap.isQuoting}
        areTokensLoading={swap.areTokensLoading}
        canGetQuote={swap.canGetQuote}
        hasInsufficientFunds={hasInsufficientFunds}
        amountError={amountErrorCopy}
        recentRefundAddresses={recentRefund}
        recentRecipientAddresses={recentRecipient}
        feeTier={feeTier}
        onFeeTierChange={setFeeTier}
        feeByTier={displayedFeeByTier}
        feeLoadingByTier={displayedFeeLoadingByTier}
        feeLoading={displayedFeeLoading}
        onAmountInChange={value => {
          setMaxSelected(false)
          swap.updateAmountIn(value)
        }}
        onMaxClick={() => {
          setMaxSelected(true)
          swap.updateAmountIn(spendableBalance)
        }}
        onRecipientAddressChange={swap.setRecipientAddress}
        onRefundAddressChange={swap.setRefundAddress}
        onSelectToken={handleSelectToken}
        onSelectZecAddress={handleSelectZecAddress}
        onSelectFundingSource={handleSelectFundingSource}
        onSwitchTokens={swap.switchTokens}
        onOpenSlippageSetting={handleOpenSlippageSetting}
        onGetQuote={getQuote}
      />
    )
  }

  if (isHardwareSigning) {
    return (
      <HardwareSigningPending
        signerName={currentWallet?.keySource === 'keystone' ? 'Keystone' : 'Ledger'}
      />
    )
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Swap"
        {...getHeaderProps()}
        rightContent={
          viewStep === 'input' ? (
            <button
              type="button"
              aria-label="Swap progress"
              title="Swap progress"
              onClick={() => navigate('/swap-progress')}
              className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/10 hover:text-foreground"
            >
              <Icon icon="lucide:history" className="size-[18px]" />
            </button>
          ) : undefined
        }
      />
      {renderContent()}
    </div>
  )
}
