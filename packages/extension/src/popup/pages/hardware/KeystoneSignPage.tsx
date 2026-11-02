import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { AnimatedQR } from '../../components/hardware/AnimatedQR'
import { QRScanner } from '../../components/hardware/QRScanner'
import { CenteredNotice } from '../../components/hardware/CenteredNotice'
import { HardwareTransactionSummary } from '../../components/hardware/HardwareTransactionSummary'
import { HardwareSigningProgress } from '../../components/hardware/HardwareSigningProgress'
import { Skeleton } from '../../components/ui/skeleton'
import { StandardTransactionResult } from '../../components/transaction/StandardTransactionResult'
import { useLocation } from '../../provider/Router'
import { parseSignedPczt, type UR } from '@/lib/keystone'
import {
  discoverLedger,
  isLedgerTransparentInputDataError,
  ledgerSupportsBluetooth,
  parseLedgerSigningPayload,
  signLedgerPczt,
  type LedgerTransport
} from '@/lib/ledger/device'
import type { LedgerPcztSignatures, LedgerSigningPayload } from '@/core/worker/types'
import { readHardwareSignRequest, type HardwareSignRequest } from '@/lib/hardware-tab'
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { rheaSwapClient } from '@/popup/services/rhea-swap-client'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { buildAccountKey, useAccountDataStore } from '@/store/account-data-store'
import {
  recordHardwareOperationOutcome,
  recordHardwareSignFailure
} from '@/popup/services/hardware-transaction-analytics'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import { MARGINAL_FEE_ZATS } from '@/config/fee'
import { staticFeeFallbackZats } from '@/core/zcash/fee-policy'
import { classifyError, getResponseErrorMessage } from '@/lib/errors'
import { TimeoutError } from '@/lib/async-utils'
import { isValidAddTransactionResponse } from '@/lib/transaction-record-response'
import { resolveZcashResultView } from '@/lib/transaction-result-model'
import {
  getConfirmationFailureResultCopy,
  getConfirmedTransactionResultCopy,
  getStandardTransactionResultCopy,
  TRANSACTION_PENDING_MESSAGE
} from '@/lib/transaction-status-copy'
import { publishHardwareSignResult } from '@/lib/hardware-sign-result'

type Step =
  | 'building'
  | 'show-qr'
  | 'scan'
  | 'ledger-review'
  | 'ledger-device'
  | 'broadcasting'
  | 'pending'
  | 'success'
  | 'failed'
  | 'invalid'

/**
 * Full-tab hardware signing flow: build PCZT, sign on the selected device,
 * then prove and broadcast. Launched via openHardwareSignTab().
 */
export function KeystoneSignPage() {
  const location = useLocation()
  const requestId = new URLSearchParams(location.search).get('req')

  const [step, setStep] = useState<Step>('building')
  const [request, setRequest] = useState<HardwareSignRequest | null>(null)
  const [pcztBytes, setPcztBytes] = useState<Uint8Array | null>(null)
  const [vendor, setVendor] = useState<'keystone' | 'ledger'>('keystone')
  const [ledgerPayload, setLedgerPayload] = useState<LedgerSigningPayload | null>(null)
  const [ledgerDisplayAddress, setLedgerDisplayAddress] = useState<string | null>(null)
  const [ledgerDeviceModel, setLedgerDeviceModel] = useState<string>()
  const [legacyLedgerTransport, setLegacyLedgerTransport] = useState<LedgerTransport>()
  const [reviewNotice, setReviewNotice] = useState<string | null>(null)
  const transparentInputRebuiltRef = useRef(false)
  const [deviceMessage, setDeviceMessage] = useState('Follow the instructions on your Ledger')
  const [feeZats, setFeeZats] = useState<string | null>(null)
  const [builtAmount, setBuiltAmount] = useState<string | null>(null)
  const [scannerKey, setScannerKey] = useState(0)
  const [scanError, setScanError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState('')
  const [recordedTransactionId, setRecordedTransactionId] = useState<string>()
  const [transactionTimestamp, setTransactionTimestamp] = useState<number>()
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(true)

  const network = useWalletStore(state => state.currentNetwork)
  const savedLedgerTransport = useSettingsStore(
    state => state.ledgerSigningTransportByWallet[request?.walletId ?? '']
  )
  const saveLedgerTransport = useSettingsStore(state => state.setLedgerSigningTransport)
  const preferredLedgerTransport: LedgerTransport =
    ledgerSupportsBluetooth(ledgerDeviceModel) &&
    (savedLedgerTransport ?? legacyLedgerTransport) === 'bluetooth'
      ? 'bluetooth'
      : 'usb'

  useEffect(() => {
    if (!useSettingsStore.persist.hasHydrated()) void useSettingsStore.persist.rehydrate()
  }, [])
  const resultAccountKey =
    request && recordedTransactionId
      ? buildAccountKey(network, request.walletId, request.accountId)
      : undefined
  const resultTransaction = useAccountDataStore(state => {
    if (!resultAccountKey || !recordedTransactionId) return undefined
    return state.getTransactions(resultAccountKey).find(tx => tx.id === recordedTransactionId)
  })
  const resultView = resolveZcashResultView(
    { step: step === 'pending' ? 'pending' : 'submitted', txHash, timestamp: transactionTimestamp },
    resultTransaction
  )
  const resultCopy =
    resultView.step === 'success'
      ? getConfirmedTransactionResultCopy()
      : resultView.step === 'failed'
        ? getConfirmationFailureResultCopy(resultTransaction?.failureReason)
        : getStandardTransactionResultCopy(resultView.step, {
            shield: request?.kind === 'shield',
            error
          })
  const startedRef = useRef(false)
  // Real ZIP-317 fee returned by the build; fall back to the chosen tier's
  // static estimate if the live estimate was unavailable.
  const feeTier = (request?.marginalFeeZats ?? 0) >= MARGINAL_FEE_ZATS.fast ? 'fast' : 'standard'
  const feeZec = formatBaseUnitDecimalAmount(
    String(feeZats ?? staticFeeFallbackZats(feeTier)),
    ZEC_DECIMALS
  )
  const failedCopy = getStandardTransactionResultCopy('failed', { error })

  useEffect(() => {
    if ((step !== 'success' && step !== 'pending') || !resultAccountKey || !recordedTransactionId)
      return
    const reload = () => {
      void useAccountDataStore.getState().reloadTransactions(resultAccountKey)
    }
    reload()
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const update = message as { type?: string; accountKey?: string; transactionId?: string }
      if (
        (update.type === 'TRANSACTION_UPDATED' || update.type === 'TRANSACTION_STATUS_UPDATED') &&
        update.accountKey === resultAccountKey &&
        update.transactionId === recordedTransactionId
      ) {
        reload()
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [step, resultAccountKey, recordedTransactionId])

  const buildPczt = useCallback(
    async (req: HardwareSignRequest) => {
      setStep('building')
      setError(null)
      setReviewNotice(null)
      setRetryable(true)
      setFeeZats(null)
      setBuiltAmount(null)
      setRecordedTransactionId(undefined)
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'HW_PCZT_BUILD',
          requestId,
          walletId: req.walletId,
          accountId: req.accountId,
          kind: req.kind,
          amount: req.amount,
          ...(req.maxTransfer === undefined ? {} : { maxTransfer: req.maxTransfer }),
          ...(req.to === undefined ? {} : { to: req.to }),
          ...(req.memo === undefined ? {} : { memo: req.memo }),
          ...(req.fundingSource === undefined ? {} : { fundingSource: req.fundingSource }),
          ...(req.marginalFeeZats === undefined ? {} : { marginalFeeZats: req.marginalFeeZats })
        })
        if (!res?.success) {
          throw new Error(getResponseErrorMessage(res) || 'Failed to build transaction')
        }
        if (res.vendor === 'ledger') {
          setLedgerPayload(parseLedgerSigningPayload(res.ledgerPayload))
          setLedgerDisplayAddress(res.ledgerDisplayAddress ?? null)
          setLedgerDeviceModel(
            typeof res.ledgerDeviceModel === 'string' ? res.ledgerDeviceModel : undefined
          )
          setLegacyLedgerTransport(
            res.ledgerSigningTransport === 'usb' || res.ledgerSigningTransport === 'bluetooth'
              ? res.ledgerSigningTransport
              : undefined
          )
          setVendor('ledger')
          setPcztBytes(null)
        } else if (res.vendor === 'keystone') {
          setPcztBytes(base64ToBytes(res.redacted))
          setLedgerPayload(null)
          setLedgerDisplayAddress(null)
          setLedgerDeviceModel(undefined)
          setLegacyLedgerTransport(undefined)
          setVendor('keystone')
        } else {
          throw new Error('Unknown hardware signing device')
        }
        setFeeZats(res.feeZats ?? null)
        setBuiltAmount(res.amount ?? req.amount)
        setStep(res.vendor === 'ledger' ? 'ledger-review' : 'show-qr')
      } catch (e) {
        const raw = e instanceof Error ? e.message : ''
        if (raw.includes('SAPLING_UNSUPPORTED')) {
          setRetryable(false)
          setError(
            'This transfer needs to spend Sapling funds, which Keystone cannot sign. ' +
              'Move or shield your Sapling balance into Orchard using a software wallet ' +
              'with the same recovery phrase, then send from Keystone.'
          )
        } else {
          setError(classifyError(e).userMessage)
        }
        recordHardwareSignFailure(req.kind, 'build')
        recordHardwareOperationOutcome(req, requestId, 'failed')
        setStep('failed')
      }
    },
    [requestId]
  )

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const start = async () => {
      const req = requestId ? await readHardwareSignRequest(requestId) : null
      if (!req) {
        setStep('invalid')
        return
      }
      setRequest(req)
      await buildPczt(req)
    }
    start()
  }, [requestId, buildPczt])

  const reportDappResult = (
    req: HardwareSignRequest,
    result: { success: boolean; txHash?: string; error?: string }
  ) => {
    if (!req.dappRequestId) return
    chrome.runtime
      .sendMessage({ type: 'HW_SIGN_RESULT', requestId: req.dappRequestId, ...result })
      .catch(console.error)
  }

  const submitHardwareSignature = async (
    signed: { signedPcztBase64: string } | { signatures: LedgerPcztSignatures }
  ) => {
    if (!request || !requestId) return
    setScanError(null)
    setStep('broadcasting')

    const accountKey = buildAccountKey(network, request.walletId, request.accountId)
    const wallet = useWalletStore.getState().getWallet(request.walletId)
    const account = wallet?.accounts.find(a => a.id === request.accountId)
    const isShield = request.kind === 'shield'
    const sentAmount = builtAmount ?? request.amount

    let transactionId: string | null = null
    let broadcastHash: string | null = null
    try {
      const addResponse = await chrome.runtime.sendMessage({
        type: 'ADD_TRANSACTION',
        accountKey,
        transaction: {
          txHash: '',
          status: 'pending',
          type: request.kind,
          amount: sentAmount,
          to: isShield ? account?.addresses.shielded || '' : request.displayTo || request.to,
          from:
            isShield || request.fundingSource === 'transparent'
              ? account?.addresses.transparent || ''
              : account?.addresses.shielded || '',
          fromType:
            isShield || request.fundingSource === 'transparent' ? 'transparent' : 'shielded',
          memo: isShield ? 'Shielding transparent funds' : request.memo || '',
          fee: feeZec,
          timestamp: Date.now(),
          network,
          notified: false,
          ...(request.quoteBinding ? { quoteBinding: request.quoteBinding } : {})
        }
      })
      if (!isValidAddTransactionResponse(addResponse)) {
        throw new Error(
          getResponseErrorMessage(addResponse) || 'Failed to create transaction record'
        )
      }
      transactionId = addResponse.transaction.id
      setRecordedTransactionId(transactionId)
      setTransactionTimestamp(addResponse.transaction.timestamp)

      setRetryable(false)
      const submission = await chrome.runtime.sendMessage(
        'signatures' in signed
          ? {
              type: 'SUBMIT_LEDGER_SIGNATURES',
              requestId,
              transactionId,
              signatures: signed.signatures
            }
          : {
              type: 'SUBMIT_HARDWARE_PCZT',
              requestId,
              transactionId,
              signedPcztBase64: signed.signedPcztBase64
            }
      )
      if (!submission?.success || typeof submission.txHash !== 'string') {
        setRetryable(submission?.retryable === true)
        if (submission?.completionPending === true) {
          throw new TimeoutError(TRANSACTION_PENDING_MESSAGE)
        }
        throw new Error(getResponseErrorMessage(submission) || 'Hardware transaction failed')
      }
      const hash = submission.txHash
      broadcastHash = hash

      if (
        request.quoteBinding?.provider === 'rhea-cross-chain-dex' &&
        request.quoteBinding.quoteHandle
      ) {
        try {
          await rheaSwapClient.recordTransactionSubmission(request.quoteBinding.quoteHandle, hash)
          if (transactionId) {
            await rheaSwapClient.startMonitoring({
              quoteHandle: request.quoteBinding.quoteHandle,
              accountKey,
              walletId: request.walletId,
              accountId: request.accountId,
              transactionId,
              isCrossChain: request.quoteBinding.isCrossChain === true,
              destinationAsset: request.quoteBinding.destinationAsset,
              destinationChain: request.quoteBinding.destinationChain
            })
          }
          await rheaSwapClient.reportSubmission(request.quoteBinding.quoteHandle)
        } catch (error) {
          console.warn(
            '[RHEA Swap] Hardware transaction was broadcast but reporting failed:',
            error instanceof Error ? error.name : 'UnknownError'
          )
        }
      }

      try {
        const updateResponse = await chrome.runtime.sendMessage({
          type: 'UPDATE_TRANSACTION',
          accountKey,
          transactionId,
          updates: {
            txHash: hash,
            status: 'pending',
            notified: false,
            ...(request.monitorParams?.depositAddress
              ? { depositAddress: request.monitorParams.depositAddress }
              : {})
          }
        })
        if (!updateResponse?.success) {
          throw new Error(
            getResponseErrorMessage(updateResponse) || 'Failed to update transaction record'
          )
        }
      } catch (bookkeepingError) {
        console.error('[HardwareSign] Broadcast record update failed:', bookkeepingError)
      }

      try {
        // Swaps are tracked by the cross-chain monitor; plain Zcash txs on-chain
        if (request.kind === 'swap' && request.monitorParams) {
          await chrome.runtime.sendMessage({
            type: 'START_TRANSACTION_MONITOR',
            swap: {
              ...request.monitorParams,
              amountIn: sentAmount,
              accountKey,
              walletId: request.walletId,
              accountId: request.accountId,
              transactionId
            }
          })
        } else {
          await chrome.runtime.sendMessage({
            type: 'START_ZCASH_TX_MONITOR',
            tx: {
              txHash: hash,
              accountKey,
              walletId: request.walletId,
              accountId: request.accountId,
              transactionId,
              amount: sentAmount,
              type: request.kind
            }
          })
        }
      } catch (monitorError) {
        console.error('[HardwareSign] Broadcast monitor registration failed:', monitorError)
      }

      try {
        zcashWalletRuntimeClient.requestSync()
      } catch (syncError) {
        console.error('[HardwareSign] Post-broadcast sync request failed:', syncError)
      }
      let originResultPublished = false
      if (request.reportToOrigin) {
        try {
          await publishHardwareSignResult({
            requestId,
            status: 'success',
            txHash: hash,
            accountKey,
            amount: sentAmount,
            transactionId: transactionId ?? undefined,
            completedAt: Date.now()
          })
          originResultPublished = true
        } catch (cause) {
          console.error('[HardwareSign] Failed to report result to the origin surface:', cause)
        }
      }
      recordHardwareOperationOutcome(request, requestId, 'broadcast', transactionId ?? undefined)
      setTxHash(hash)
      setStep('success')
      if (request.reportToOrigin && originResultPublished) {
        window.setTimeout(() => window.close(), 800)
      }
    } catch (e) {
      if (e instanceof TimeoutError && transactionId && !broadcastHash) {
        setError(TRANSACTION_PENDING_MESSAGE)
        setStep('pending')
        return
      }
      if (transactionId && !broadcastHash) {
        chrome.runtime
          .sendMessage({
            type: 'UPDATE_TRANSACTION',
            accountKey,
            transactionId,
            updates: { status: 'failed', notified: true }
          })
          .catch(console.error)
      }
      if (broadcastHash) {
        reportDappResult(request, { success: true, txHash: broadcastHash })
        setTxHash(broadcastHash)
        setStep('success')
        return
      }
      const classified = classifyError(e)
      recordHardwareSignFailure(request.kind, 'broadcast')
      recordHardwareOperationOutcome(request, requestId, 'failed')
      reportDappResult(request, { success: false, error: classified.technicalMessage })
      setError(classified.userMessage)
      setStep('failed')
    }
  }

  const handleSignedScan = async (ur: UR) => {
    try {
      await submitHardwareSignature({ signedPcztBase64: bytesToBase64(parseSignedPczt(ur)) })
    } catch (cause) {
      setScanError(classifyError(cause).userMessage)
      setScannerKey(key => key + 1)
    }
  }

  const handleLedgerSign = async (transport: LedgerTransport) => {
    if (!ledgerPayload || !request) return
    setDeviceMessage(
      transport === 'usb'
        ? 'Select your Ledger in the browser dialog'
        : 'Select your Ledger over Bluetooth'
    )
    setStep('ledger-device')
    try {
      // Browser device prompts must start from the button's user gesture.
      const devicePromise = discoverLedger(transport)
      const device = await devicePromise
      const signatures = await signLedgerPczt({
        transport,
        payload: ledgerPayload,
        device,
        onInteraction: () => setDeviceMessage('Review and approve on your Ledger')
      })
      saveLedgerTransport(request.walletId, transport)
      await submitHardwareSignature({ signatures })
    } catch (cause) {
      if (
        request.fundingSource === 'transparent' &&
        !transparentInputRebuiltRef.current &&
        isLedgerTransparentInputDataError(cause)
      ) {
        transparentInputRebuiltRef.current = true
        await buildPczt(request)
        setReviewNotice(
          'Transparent inputs changed. Review the rebuilt transaction before signing.'
        )
        return
      }
      setError(classifyError(cause).userMessage)
      setRetryable(true)
      recordHardwareSignFailure(request.kind, 'sign')
      recordHardwareOperationOutcome(request, requestId, 'failed')
      setStep('failed')
    }
  }

  const deviceName = vendor === 'ledger' ? 'Ledger' : 'Keystone'
  const title =
    request?.kind === 'shield'
      ? `Shield with ${deviceName}`
      : request?.kind === 'unshield'
        ? `Unshield with ${deviceName}`
        : request?.kind === 'swap'
          ? `Swap with ${deviceName}`
          : `Send with ${deviceName}`

  return (
    <div className="page-container page-container--tab">
      <PageHeader title={title} />

      {step === 'invalid' && (
        <CenteredNotice
          icon="lucide:alert-triangle"
          iconClass="text-warning"
          title="Request expired"
          description="This signing request is no longer available. Close this page and start again from the wallet."
          actionText="Close"
          onAction={() => window.close()}
        />
      )}

      {step === 'building' && (
        <div className="page-content space-y-5 pt-5">
          <HardwareSigningProgress title="Building transaction">
            {request ? (
              <HardwareTransactionSummary
                request={request}
                amountPending={request.maxTransfer === true && !builtAmount}
              />
            ) : (
              <div className="space-y-4">
                <div className="flex flex-col items-center gap-3 py-4">
                  <Skeleton className="size-12 rounded-full" />
                  <Skeleton className="h-8 w-32" />
                </div>
                <div className="space-y-3 rounded-lg bg-card p-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              </div>
            )}
            <div className="flex justify-center pt-2">
              <Skeleton className="size-52 rounded-lg" />
            </div>
          </HardwareSigningProgress>
        </div>
      )}

      {step === 'show-qr' && request && pcztBytes && (
        <>
          <div className="page-content">
            <HardwareTransactionSummary
              request={{ ...request, amount: builtAmount ?? request.amount }}
              feeZec={feeZec}
            />
            <div className="flex flex-col items-center mt-6">
              <div className="bg-white rounded-2xl p-4">
                <AnimatedQR pcztBytes={pcztBytes} size={300} />
              </div>
              <p className="text-xs text-muted text-center mt-4 max-w-[260px]">
                Scan with your Keystone, review the details on the device, then sign.
              </p>
            </div>
          </div>
          <div className="page-footer space-y-3">
            <Button onClick={() => setStep('scan')} className="w-full h-[45px]">
              <Icon icon="lucide:camera" width={16} height={16} className="mr-2" />
              Scan Signed Transaction
            </Button>
            <Button variant="outline" onClick={() => window.close()} className="w-full h-[45px]">
              Cancel
            </Button>
          </div>
        </>
      )}

      {step === 'ledger-review' && request && ledgerPayload && (
        <>
          <div className="page-content pt-5">
            <HardwareTransactionSummary
              request={{ ...request, amount: builtAmount ?? request.amount }}
              feeZec={feeZec}
              ledgerDisplayAddress={ledgerDisplayAddress ?? undefined}
            />
            {reviewNotice && (
              <p role="status" className="mt-4 text-sm text-warning">
                {reviewNotice}
              </p>
            )}
          </div>
          <div className="page-footer space-y-2">
            {(['usb', 'bluetooth'] as const)
              .filter(
                transport => transport === 'usb' || ledgerSupportsBluetooth(ledgerDeviceModel)
              )
              .sort((a, b) =>
                a === preferredLedgerTransport ? -1 : b === preferredLedgerTransport ? 1 : 0
              )
              .map((transport, index) => (
                <Button
                  key={transport}
                  className="w-full"
                  variant={index === 0 ? undefined : 'outline'}
                  onClick={() => void handleLedgerSign(transport)}
                >
                  <Icon
                    icon={transport === 'usb' ? 'lucide:usb' : 'lucide:bluetooth'}
                    width={16}
                    height={16}
                    className="mr-2"
                  />
                  Sign via {transport === 'usb' ? 'USB' : 'Bluetooth'}
                </Button>
              ))}
            <Button className="w-full" variant="ghost" onClick={() => window.close()}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {step === 'ledger-device' && (
        <div className="page-content flex flex-col items-center justify-center gap-4 text-center">
          <Icon
            icon="lucide:loader-2"
            width={32}
            height={32}
            className="animate-spin text-primary"
          />
          <p className="text-sm">{deviceMessage}</p>
        </div>
      )}

      {step === 'scan' && (
        <>
          <div className="page-content">
            <p className="text-sm text-muted text-center mb-4">
              On your Keystone, tap "Get Signature" and scan the QR code it displays.
            </p>
            <QRScanner key={scannerKey} onScan={handleSignedScan} />
            {scanError && <p className="text-xs text-danger text-center mt-3">{scanError}</p>}
          </div>
          <div className="page-footer">
            <Button
              variant="outline"
              onClick={() => setStep('show-qr')}
              className="w-full h-[45px]"
            >
              Back to QR Code
            </Button>
          </div>
        </>
      )}

      {step === 'broadcasting' && request && (
        <div className="page-content space-y-5 pt-5">
          <HardwareSigningProgress title="Finalizing transaction">
            <HardwareTransactionSummary
              request={{ ...request, amount: builtAmount ?? request.amount }}
              feeZec={feeZec}
              ledgerDisplayAddress={ledgerDisplayAddress ?? undefined}
            />
          </HardwareSigningProgress>
        </div>
      )}

      {(step === 'success' || step === 'pending') && request && (
        <div className="flex flex-1 flex-col w-full max-w-[440px] mx-auto min-h-0">
          <StandardTransactionResult
            step={resultView.step}
            shield={request.kind === 'shield'}
            amount={builtAmount ?? request.amount}
            error={error}
            toAddress={request.kind === 'shield' ? undefined : request.displayTo || request.to}
            showTo={request.kind !== 'shield'}
            txHash={resultView.txHash}
            timestamp={resultView.timestamp}
            customTitle={resultCopy.title}
            customDescription={resultCopy.description}
            onDone={() => window.close()}
            onCancel={resultView.step === 'failed' ? () => window.close() : undefined}
          />
        </div>
      )}

      {step === 'failed' && (
        <CenteredNotice
          icon="lucide:x-circle"
          iconClass="text-danger"
          title={retryable ? failedCopy.title : `Cannot Sign with ${deviceName}`}
          description={error || failedCopy.description}
          actionText="Close"
          onRetry={retryable ? () => request && buildPczt(request) : undefined}
          onAction={() => window.close()}
          secondaryText={retryable ? 'Close' : undefined}
          onSecondary={retryable ? () => window.close() : undefined}
        />
      )}
    </div>
  )
}
