import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '../../components/common/PageHeader'
import { StandardTransactionResult } from '../../components/transaction/StandardTransactionResult'
import { SwapStatusDisplay } from '../../components/swap/SwapStatus'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useWalletStore } from '@/store/wallet-store'
import { useNavigate } from '../../provider/Router'
import { pollingSwapStatus } from '@/core/services/intents-api'
import {
  getConfirmationFailureResultCopy,
  getConfirmedTransactionResultCopy,
  getStandardTransactionResultCopy,
  getSubmittedTransactionResultCopy
} from '@/lib/transaction-status-copy'
import {
  getTransactionRecoveryAction,
  resolveWalletSnapshotRecoveryTarget
} from '@/lib/transaction-replacement'
import { isWalletSnapshotRecoveryError } from '@/lib/errors'
import { isWalletSnapshotIntegrityError } from '@/lib/wallet-snapshot-errors'
import { inspectWalletDb, loadTransactions, loadWalletDb } from '@/lib/indexed-db'
import { openModal } from '@/popup/provider/ModalManager'
import { ResyncZcashContent } from '@/popup/components/account/AccountModals'
import { resyncZcashWallet } from '@/popup/services/zcash-settings-client'
import { useSpeedUp } from '@/popup/hooks/useSpeedUp'
import { isTransactionStatusUpdatedMessage } from '@/types/transaction-messages'
import { isZcashDestination } from '@/lib/cross-chain-transaction'
import { pollingTransactionConfirmations } from '@/lib/zcash-node-rpc'
import { getNetworkConfig } from '@/lib/runtime-network'
import { WALLET_CONFIG } from '@/config/wallet'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { offerSaveRecipient } from '@/popup/services/save-recipient-prompt'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import { intentsAssetManagerClient } from '@/popup/services/intents-asset-manager-client'
import { getChainFromAssetId } from '@/lib/format'
import { resolveSwapStatusPollingProvider } from '@/popup/services/swap-page-model'
import {
  confidentialFundingClient,
  getConfidentialFundingResult
} from '@/popup/services/confidential-funding-client'
import { getConfidentialFundingProgress } from '@/core/services/confidential-funding'
import { toast } from '@/store/toast-store'
import type { ActivityItem } from '@/core/activity'
import {
  getActivityOriginHash,
  getActivityOriginStatus,
  getZcashIntentsOriginStatus
} from '@/popup/services/transaction-progress'
import { resolveZcashResultView } from '@/lib/transaction-result-model'
import { getRheaSwapProgressStatus } from '@/lib/swap-progress'

const RHEA_STATUS_RECHECK_INTERVAL_MS = 15_000

export function TransactionResultPage() {
  const { navigate, goBack } = useNavigate()
  const { requestSpeedUp, speedUpSheet } = useSpeedUp()
  const { data, returnPath, clear, updateStep, updateSwapStatus, updateConfidentialFunding } =
    useTransactionResultStore()
  const dataRef = useRef(data)
  const leavingResultRef = useRef(false)
  const revealedSwapDepositRef = useRef<string | null>(null)
  const [destinationConfirmations, setDestinationConfirmations] = useState<number | null>(null)
  const [resumingConfidentialFunding, setResumingConfidentialFunding] = useState(false)
  const [originActivity, setOriginActivity] = useState<ActivityItem | null>(null)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const wallets = useWalletStore(state => state.wallets)
  const resultAccountKey = data?.type === 'zcash' ? data.accountKey : undefined
  const resultTransactionId = data?.type === 'zcash' ? data.transactionId : undefined
  const resultTransaction = useAccountDataStore(state => {
    if (!resultAccountKey || !resultTransactionId) return undefined
    return state.getTransactions(resultAccountKey).find(tx => tx.id === resultTransactionId)
  })
  const resultView =
    data?.type === 'zcash' ? resolveZcashResultView(data, resultTransaction) : undefined
  const resultStep = resultView?.step ?? 'idle'
  const swapZcashAccountKey = data?.type === 'swap' ? data.zcashAccountKey : undefined
  const swapZcashTransactionId = data?.type === 'swap' ? data.zcashTransactionId : undefined
  const swapZcashTransaction = useAccountDataStore(state => {
    if (!swapZcashAccountKey || !swapZcashTransactionId) return undefined
    return state
      .getTransactions(swapZcashAccountKey)
      .find(transaction => transaction.id === swapZcashTransactionId)
  })
  const activityTransactionId = data?.type === 'swap' ? data.activityTransactionId : undefined
  const sourceExecutionMode = data?.type === 'swap' ? (data.sourceExecutionMode ?? 'main') : 'main'
  const recoveryAction = getTransactionRecoveryAction(resultTransaction)
  const snapshotRecoveryTarget =
    data?.type === 'zcash' && resultStep === 'failed' && isWalletSnapshotRecoveryError(data.error)
      ? resolveWalletSnapshotRecoveryTarget(
          resultAccountKey,
          resultTransactionId,
          resultTransaction,
          wallets,
          currentNetwork
        )
      : null
  const isSyncing = useAccountDataStore(state =>
    currentWalletId ? state.getWalletSyncState(currentNetwork, currentWalletId).isSyncing : false
  )
  const swapDepositAddress = data?.type === 'swap' ? data.depositAddress : undefined
  const rheaQuoteHandle = data?.type === 'swap' ? data.rheaQuoteHandle : undefined
  const confidentialFundingPlanId =
    data?.type === 'swap' ? data.confidentialFunding?.planId : undefined
  const waitsForZcashDestination =
    data?.type === 'swap' &&
    data.status?.status === 'SUCCESS' &&
    isZcashDestination({
      destinationAsset: data.status.destinationAsset,
      destinationChain: data.destinationChain
    })
  const destinationZcashTxHash =
    waitsForZcashDestination && data.status?.swapDetails?.destinationChainTxHashes?.length
      ? data.status.swapDetails.destinationChainTxHashes[0].hash
      : undefined
  const swapStatusPollingProvider = resolveSwapStatusPollingProvider({
    depositAddress: swapDepositAddress,
    rheaQuoteHandle
  })

  useEffect(() => {
    dataRef.current = data
  }, [data])

  useEffect(() => {
    if (resultAccountKey && resultTransactionId) {
      void useAccountDataStore.getState().reloadTransactions(resultAccountKey)
    }
  }, [resultAccountKey, resultTransactionId])

  useEffect(() => {
    setOriginActivity(null)
    if (!activityTransactionId) return
    let active = true
    const refresh = () => {
      void evmWalletClient
        .getActivity('read', sourceExecutionMode)
        .then(model => {
          if (!active) return
          const item = model?.items.find(candidate => candidate.id === activityTransactionId)
          if (!item) return
          setOriginActivity(item)
          const current = useTransactionResultStore.getState().data
          if (
            current?.type === 'swap' &&
            current.rheaQuoteHandle &&
            current.activityTransactionId === item.id
          ) {
            updateSwapStatus(
              getRheaSwapProgressStatus(
                item.segments,
                current.status ?? { status: 'PENDING_DEPOSIT' }
              )
            )
          }
        })
        .catch(() => {})
    }
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (!message || typeof message !== 'object' || !('type' in message)) return
      if (
        message.type === 'TRANSACTION_ADDED' ||
        message.type === 'TRANSACTION_UPDATED' ||
        message.type === 'TRANSACTION_STATUS_UPDATED' ||
        message.type === 'CROSS_CHAIN_STATUS_UPDATED'
      ) {
        refresh()
      }
    }
    refresh()
    const timer = setInterval(refresh, 10_000)
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      active = false
      clearInterval(timer)
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [activityTransactionId, sourceExecutionMode, updateSwapStatus])

  useEffect(() => {
    if (!data && !leavingResultRef.current) {
      navigate('/', { replace: true })
    }
  }, [data, navigate])

  useEffect(() => {
    if (!confidentialFundingPlanId) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const recheck = async () => {
      try {
        const plan = await confidentialFundingClient.get(confidentialFundingPlanId)
        if (!active) return
        const result = getConfidentialFundingResult(plan)
        const progress = getConfidentialFundingProgress(plan)
        updateConfidentialFunding({
          phase: plan.phase,
          completed: result.completed,
          total: result.total,
          stage: progress.stage,
          message: progress.message,
          status: result.status
        })
        if (
          !['ready', 'partial', 'refunded', 'failed', 'expired', 'cancelled'].includes(plan.phase)
        ) {
          timer = setTimeout(() => void recheck(), 5_000)
        }
      } catch {
        if (active) timer = setTimeout(() => void recheck(), 5_000)
      }
    }
    void recheck()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [confidentialFundingPlanId, updateConfidentialFunding])

  useEffect(() => {
    if (swapStatusPollingProvider !== 'near-intents' || !swapDepositAddress) return

    const controller = new AbortController()
    void pollingSwapStatus(swapDepositAddress, status => updateSwapStatus(status), {
      interval: 5_000,
      signal: controller.signal
    }).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      console.error('[TransactionResultPage] Status polling failed:', error)
    })

    return () => controller.abort()
  }, [swapDepositAddress, swapStatusPollingProvider, updateSwapStatus])

  useEffect(() => {
    if (swapStatusPollingProvider !== 'rhea-swap') return

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const recheck = async () => {
      try {
        const response: unknown = await chrome.runtime.sendMessage({
          type: 'RECHECK_PENDING_TRANSACTIONS'
        })
        if (!active) return
        const rheaPending =
          typeof response === 'object' && response !== null
            ? Reflect.get(response, 'rheaPending')
            : undefined
        if (rheaPending === false) return
      } catch {
        // The persistent alarm remains the fallback when the service worker is unavailable.
      }
      if (active) timer = setTimeout(() => void recheck(), RHEA_STATUS_RECHECK_INTERVAL_MS)
    }
    void recheck()

    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [rheaQuoteHandle, swapStatusPollingProvider])

  useEffect(() => {
    setDestinationConfirmations(null)
    if (!waitsForZcashDestination || !destinationZcashTxHash) return

    const rpcUrl = getNetworkConfig(currentNetwork).nodeRpcUrl
    if (!rpcUrl) return

    const controller = new AbortController()
    void pollingTransactionConfirmations(
      rpcUrl,
      destinationZcashTxHash,
      WALLET_CONFIG.SPENDABILITY_CONFIRMATIONS,
      setDestinationConfirmations,
      { interval: 5_000, signal: controller.signal }
    ).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      console.error('[TransactionResultPage] Zcash confirmation polling failed:', error)
    })

    return () => controller.abort()
  }, [currentNetwork, destinationZcashTxHash, waitsForZcashDestination])

  useEffect(() => {
    const destinationAsset =
      data?.type === 'swap' ? (data.destinationAsset ?? data.status?.destinationAsset) : undefined
    if (
      data?.type !== 'swap' ||
      data.status?.status !== 'SUCCESS' ||
      !destinationAsset ||
      isZcashDestination({
        destinationAsset,
        destinationChain: data.destinationChain
      }) ||
      revealedSwapDepositRef.current === data.depositAddress
    ) {
      return
    }
    revealedSwapDepositRef.current = data.depositAddress
    const destinationChainId = getChainFromAssetId(destinationAsset)
    void intentsAssetManagerClient
      .showProtocolAsset(destinationAsset)
      .then(enabled =>
        enabled ? evmWalletClient.getPortfolio('refresh', { chainIds: [destinationChainId] }) : null
      )
      .catch(() => {})
  }, [data])

  useEffect(() => {
    const listener = (message: any, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      const currentData = dataRef.current

      if (
        message.type === 'ZCASH_TX_COMPLETED' &&
        currentData?.type === 'zcash' &&
        currentData.accountKey === message.accountKey &&
        currentData.transactionId === message.transactionId
      ) {
        if (message.error) {
          const outcomeStep = message.completionPending === true ? 'pending' : 'failed'
          const copy = getStandardTransactionResultCopy(outcomeStep, {
            shield: currentData.customTitle?.includes('Shield'),
            error: message.error
          })
          updateStep(
            outcomeStep,
            {
              error: message.error,
              customTitle: copy.title,
              customDescription: copy.description
            },
            message.accountKey,
            message.transactionId
          )
        } else if (message.txHash) {
          const copy = getSubmittedTransactionResultCopy(
            currentData.customTitle?.includes('Shield')
          )
          updateStep(
            'submitted',
            {
              txHash: message.txHash,
              customTitle: copy.title,
              customDescription: copy.description
            },
            message.accountKey,
            message.transactionId
          )
        }
      }

      if (
        isTransactionStatusUpdatedMessage(message) &&
        currentData?.type === 'zcash' &&
        currentData.accountKey === message.accountKey &&
        currentData.transactionId === message.transactionId
      ) {
        if (message.status === 'success') {
          const copy = getConfirmedTransactionResultCopy()
          updateStep(
            'success',
            {
              customTitle: copy.title,
              customDescription: copy.description
            },
            message.accountKey,
            message.transactionId
          )
        } else if (message.status === 'failed') {
          const copy = getConfirmationFailureResultCopy(message.failureReason)
          updateStep(
            'failed',
            {
              customTitle: copy.title,
              customDescription: copy.description,
              accountKey: message.accountKey,
              transactionId: message.transactionId
            },
            message.accountKey,
            message.transactionId
          )
        }
        void useAccountDataStore.getState().reloadTransactions(message.accountKey)
      }

      if (message.type === 'CROSS_CHAIN_STATUS_UPDATED' && currentData?.type === 'swap') {
        if (
          (typeof message.quoteHandle === 'string' &&
            message.quoteHandle !== currentData.rheaQuoteHandle) ||
          (typeof message.depositAddress === 'string' &&
            message.depositAddress !== currentData.depositAddress)
        ) {
          return
        }
        const { updateSwapStatus } = useTransactionResultStore.getState()
        updateSwapStatus(message.status)
      }
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [updateStep])

  if (!data) return null

  const handleDone = () => {
    const path =
      data.type === 'swap' &&
      data.status?.status === 'SUCCESS' &&
      data.approvalRequestIdAfterFunding
        ? `/approval?requestId=${encodeURIComponent(data.approvalRequestIdAfterFunding)}&fundingComplete=1`
        : returnPath
    leavingResultRef.current = true
    const saveRecipient =
      data.type === 'zcash' &&
      (resultStep === 'submitted' || resultStep === 'confirming' || resultStep === 'success')
        ? data.saveRecipient
        : null
    navigate(path, { replace: true })
    clear()
    if (saveRecipient) void offerSaveRecipient(saveRecipient)
  }

  const handleViewActivity = () => {
    const transactionId =
      data.type === 'swap' ? (data.activityTransactionId ?? data.zcashTransactionId) : undefined
    const path = transactionId
      ? `/?tab=activity&transactionId=${encodeURIComponent(transactionId)}`
      : '/?tab=activity'
    leavingResultRef.current = true
    navigate(path, { replace: true })
    clear()
  }

  const handleRetry = () => {
    leavingResultRef.current = true
    clear()
    goBack()
  }

  const handleSpeedUp = () => {
    if (recoveryAction === 'speed_up' && resultTransaction) {
      requestSpeedUp(resultTransaction)
    }
  }

  const handleSnapshotRecovery = () => {
    const target = snapshotRecoveryTarget
    if (!target || target.walletId !== currentWalletId) return
    void openModal<void>({
      title: 'Resync Zcash',
      body: resolve => (
        <ResyncZcashContent
          walletId={target.walletId}
          accountId={target.accountId}
          birthdayHeight={target.birthdayHeight}
          onConfirm={async height => {
            const key = `${target.network}_${target.walletId}`
            const inspection = await inspectWalletDb(key)
            let stillNeedsRecovery =
              inspection.status === 'incompatible' || inspection.status === 'quarantined'
            if (!stillNeedsRecovery) {
              try {
                await loadWalletDb(key)
              } catch (error) {
                if (!isWalletSnapshotIntegrityError(error)) throw error
                stillNeedsRecovery = true
              }
            }
            if (!stillNeedsRecovery) {
              throw new Error('Wallet data has changed. Close this page and try sending again.')
            }
            const currentResult = useTransactionResultStore.getState().data
            const active = useWalletStore.getState()
            const transactions = resultAccountKey ? await loadTransactions(resultAccountKey) : []
            const transaction = transactions.find(record => record.id === resultTransactionId)
            const verifiedTarget = resolveWalletSnapshotRecoveryTarget(
              currentResult?.type === 'zcash' &&
                currentResult.accountKey === resultAccountKey &&
                currentResult.transactionId === resultTransactionId &&
                currentResult.step === 'failed' &&
                isWalletSnapshotRecoveryError(currentResult.error)
                ? resultAccountKey
                : undefined,
              resultTransactionId,
              transaction,
              active.wallets,
              active.currentNetwork
            )
            if (
              !verifiedTarget ||
              verifiedTarget.walletId !== target.walletId ||
              verifiedTarget.accountId !== target.accountId ||
              verifiedTarget.network !== target.network ||
              active.currentWalletId !== target.walletId
            ) {
              throw new Error(
                'Transaction account could not be verified. Resync it from Account details.'
              )
            }
            await resyncZcashWallet({
              walletId: target.walletId,
              accountId: target.accountId,
              birthdayHeight: height
            })
            resolve()
            leavingResultRef.current = true
            clear()
            navigate('/', { replace: true })
          }}
          close={() => resolve()}
        />
      )
    })
  }

  const handleCancel = () => {
    leavingResultRef.current = true
    clear()
    goBack()
  }

  const handleResumeConfidentialFunding = async () => {
    if (!confidentialFundingPlanId || resumingConfidentialFunding) return
    setResumingConfidentialFunding(true)
    try {
      const current = await confidentialFundingClient.get(confidentialFundingPlanId)
      const plan = await confidentialFundingClient.confirm(
        current.planId,
        current.approvalFingerprint
      )
      const result = getConfidentialFundingResult(plan)
      const progress = getConfidentialFundingProgress(plan)
      updateConfidentialFunding({
        phase: plan.phase,
        completed: result.completed,
        total: result.total,
        stage: progress.stage,
        message: progress.message,
        status: result.status
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Confidential funding could not continue'
      )
    } finally {
      setResumingConfidentialFunding(false)
    }
  }

  if (data.type === 'zcash') {
    const recordCopy =
      resultStep === data.step
        ? undefined
        : resultStep === 'failed'
          ? getConfirmationFailureResultCopy(resultTransaction?.failureReason)
          : resultStep === 'success'
            ? getConfirmedTransactionResultCopy()
            : getStandardTransactionResultCopy(resultStep, {
                shield: resultTransaction?.type === 'shield'
              })
    const isLoadingRecoveryRecord =
      resultStep === 'failed' &&
      !!data.accountKey &&
      !!data.transactionId &&
      resultTransaction?.status !== 'failed'
    const failureAction =
      resultStep !== 'failed' || isLoadingRecoveryRecord
        ? undefined
        : snapshotRecoveryTarget
          ? { label: 'Resync Zcash', onClick: handleSnapshotRecovery }
          : recoveryAction === 'speed_up'
            ? { label: 'Speed Up', onClick: handleSpeedUp }
            : { label: 'Retry', onClick: handleRetry, retry: true }
    const pendingDescription =
      resultStep === 'pending'
        ? data.error ||
          (isSyncing
            ? 'Waiting for sync to complete before sending...'
            : data.customDescription ||
              'Building and broadcasting your transaction. This may take a few minutes.')
        : data.customDescription

    return (
      <div className="page-container">
        <PageHeader title="" />
        <StandardTransactionResult
          step={resultStep}
          amount={data.amount}
          fromAddress={data.fromAddress}
          toAddress={data.toAddress}
          txHash={resultView?.txHash}
          timestamp={resultView?.timestamp}
          error={data.error}
          customTitle={recordCopy?.title ?? data.customTitle}
          customDescription={recordCopy?.description ?? pendingDescription}
          showFrom={data.showFrom}
          showTo={data.showTo}
          showTxHash={data.showTxHash}
          showTime={data.showTime}
          extraDetails={data.extraDetails}
          failureAction={failureAction}
          onDone={handleDone}
          onCancel={resultStep === 'failed' ? handleCancel : undefined}
        />
        {speedUpSheet}
      </div>
    )
  }

  if (data.type === 'swap') {
    return (
      <div className="page-container">
        <PageHeader title={data.actionName || 'Swap'} />
        <SwapStatusDisplay
          network={currentNetwork}
          status={data.status}
          tokenInSymbol={data.tokenInSymbol}
          tokenOutSymbol={data.tokenOutSymbol}
          amountIn={data.amountIn}
          amountOut={data.amountOut}
          actionName={data.actionName}
          destinationChain={data.destinationChain}
          destinationConfirmations={destinationConfirmations}
          originChain={data.originChain}
          originTxHash={
            data.originTxHash ??
            (originActivity && originActivity.id === data.activityTransactionId
              ? getActivityOriginHash(originActivity)
              : undefined)
          }
          originStatus={
            swapZcashTransaction
              ? getZcashIntentsOriginStatus(swapZcashTransaction)
              : originActivity && originActivity.id === data.activityTransactionId
                ? getActivityOriginStatus(originActivity)
                : undefined
          }
          originConfirmations={swapZcashTransaction?.confirmations}
          signedOrder={data.signedOrder}
          fee={data.fee}
          confidentialFunding={data.confidentialFunding}
          onResumeConfidentialFunding={handleResumeConfidentialFunding}
          resumingConfidentialFunding={resumingConfidentialFunding}
          onClose={handleDone}
          onViewActivity={handleViewActivity}
          viewActivityDisabled={
            data.originChain === 'zcash' &&
            Boolean(data.rheaQuoteHandle) &&
            !data.activityTransactionId &&
            !data.zcashTransactionId
          }
        />
      </div>
    )
  }

  return null
}
