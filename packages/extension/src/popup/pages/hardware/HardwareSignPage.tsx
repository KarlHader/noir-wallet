import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { AnimatedQR } from '../../components/hardware/AnimatedQR'
import { QRScanner } from '../../components/hardware/QRScanner'
import { CenteredNotice } from '../../components/hardware/CenteredNotice'
import { HardwareTransactionSummary } from '../../components/hardware/HardwareTransactionSummary'
import { StandardTransactionResult } from '../../components/transaction/StandardTransactionResult'
import { useLocation } from '../../provider/Router'
import { parseSignedPczt, type UR } from '@/lib/keystone'
import {
  readHardwareSignRequest,
  clearHardwareSignRequest,
  type HardwareSignRequest
} from '@/lib/hardware-tab'
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import { accountManager } from '@/core/wallet/account-manager'
import { useWalletStore } from '@/store/wallet-store'
import { buildAccountKey, useAccountDataStore } from '@/store/account-data-store'
import { resolveZcashResultView } from '@/store/transaction-result-store'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent } from '@/lib/analytics'
import { safeBig } from '@/lib/big'
import { staticFeeFallbackZats } from '@/config/fee'
import { classifyError } from '@/lib/errors'
import { isValidAddTransactionResponse } from '@/lib/transaction-record-response'
import { TimeoutError } from '@/lib/async-utils'
import {
  discoverLedger,
  getLedgerDeviceName,
  isLedgerTransparentInputDataError,
  ledgerSupportsBluetooth,
  shouldRebuildLedgerPczt,
  signLedgerPczt,
  type LedgerTransport
} from '@/lib/ledger/device'
import {
  getConfirmationFailureResultCopy,
  getConfirmedTransactionResultCopy,
  getStandardTransactionResultCopy
} from '@/lib/transaction-status-copy'
import { TRANSACTION_PENDING_MESSAGE } from '@/lib/transaction-status-copy'
import { publishHardwareSignResult } from '@/lib/hardware-sign-result'
import { isTransactionStatusUpdatedMessage } from '@/types/transaction-messages'

type Step =
  | 'building'
  | 'show-qr'
  | 'scan'
  | 'review-ledger'
  | 'broadcasting'
  | 'pending'
  | 'success'
  | 'failed'
  | 'invalid'

interface BuiltHardwarePczt {
  full: string
  redacted: string
  feeZats?: string
  amount?: string
  ledgerDisplayAddress?: string
}

function applyBuiltDetails(
  request: HardwareSignRequest,
  built: BuiltHardwarePczt
): HardwareSignRequest {
  const amount = built.amount || request.amount
  const ledgerDisplayAddress = built.ledgerDisplayAddress || request.ledgerDisplayAddress
  return amount !== request.amount || ledgerDisplayAddress !== request.ledgerDisplayAddress
    ? { ...request, amount, ledgerDisplayAddress }
    : request
}

async function requestHardwarePcztBuild(req: HardwareSignRequest): Promise<BuiltHardwarePczt> {
  const res = await chrome.runtime.sendMessage({
    type: 'HW_PCZT_BUILD',
    walletId: req.walletId,
    accountId: req.accountId,
    kind: req.kind,
    to: req.to,
    amount: req.amount,
    maxTransfer: req.maxTransfer,
    memo: req.memo,
    fundingSource: req.fundingSource,
    marginalFeeZats: req.marginalFeeZats,
    feeQuoteId: req.feeQuoteId
  })
  if (!res?.success) {
    throw new Error(res?.error || 'Failed to build transaction')
  }
  return res
}

async function requestHardwarePcztFinalize(
  req: HardwareSignRequest,
  fullPczt: string,
  signedPczt: string,
  transactionId: string
): Promise<string> {
  const res = await chrome.runtime.sendMessage({
    type: 'HW_PCZT_FINALIZE',
    walletId: req.walletId,
    accountId: req.accountId,
    transactionId,
    fullPczt,
    signedPczt
  })
  if (!res?.success || !res.txHash) {
    if (res?.completionPending === true) throw new TimeoutError(TRANSACTION_PENDING_MESSAGE)
    throw new Error(res?.error || 'Failed to send transaction')
  }
  return res.txHash
}

/**
 * Full-tab hardware signing flow. Keystone uses animated QR transport; Ledger
 * uses HID/BLE and the same PCZT proving and broadcast pipeline.
 */
export function HardwareSignPage({ signer = 'keystone' }: { signer?: 'keystone' | 'ledger' }) {
  const location = useLocation()
  const requestId = new URLSearchParams(location.search).get('req')

  const [step, setStep] = useState<Step>('building')
  const [request, setRequest] = useState<HardwareSignRequest | null>(null)
  const [pcztBytes, setPcztBytes] = useState<Uint8Array | null>(null)
  const [feeZats, setFeeZats] = useState<string | null>(null)
  const [scannerKey, setScannerKey] = useState(0)
  const [scanError, setScanError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState('')
  const [recordedTransactionId, setRecordedTransactionId] = useState<string>()
  const [transactionTimestamp, setTransactionTimestamp] = useState<number>()
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(true)
  const [transport, setTransport] = useState<LedgerTransport>('usb')
  const [ledgerDeviceModel, setLedgerDeviceModel] = useState<string>()
  const [ledgerDeviceName, setLedgerDeviceName] = useState<string>()
  const [deviceMessage, setDeviceMessage] = useState('Connect and unlock your Ledger')
  const [isLedgerSigning, setIsLedgerSigning] = useState(false)

  const network = useWalletStore(state => state.currentNetwork)
  const resultAccountKey =
    request && recordedTransactionId
      ? buildAccountKey(network, request.walletId, request.accountId)
      : undefined
  const resultTransaction = useAccountDataStore(state => {
    if (!resultAccountKey || !recordedTransactionId) return undefined
    return state
      .getTransactions(resultAccountKey)
      .find(transaction => transaction.id === recordedTransactionId)
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
  // Full PCZT (with witnesses) stays in the tab and is merged with the
  // hardware-signed copy before proving. Only the redacted PCZT leaves the tab.
  const fullPcztRef = useRef<string | null>(null)
  const redactedPcztRef = useRef<string | null>(null)
  const requestRef = useRef<HardwareSignRequest | null>(null)

  // Real ZIP-317 fee returned by the build; fall back to the chosen tier's
  // static estimate if the live estimate was unavailable.
  const feeTier = request?.feeTier ?? 'standard'
  const feeZec = safeBig(feeZats ?? staticFeeFallbackZats(feeTier))
    .div(1e8)
    .toFixed()
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
      const update = message as {
        type?: string
        accountKey?: string
        transactionId?: string
      }
      if (
        (update.type === 'TRANSACTION_UPDATED' || isTransactionStatusUpdatedMessage(message)) &&
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
      setRetryable(true)
      setFeeZats(null)
      setRecordedTransactionId(undefined)
      fullPcztRef.current = null
      redactedPcztRef.current = null
      setPcztBytes(null)
      try {
        const res = await requestHardwarePcztBuild(req)
        const effectiveRequest = applyBuiltDetails(req, res)
        requestRef.current = effectiveRequest
        setRequest(effectiveRequest)
        fullPcztRef.current = res.full
        redactedPcztRef.current = res.redacted
        setPcztBytes(base64ToBytes(res.redacted))
        setFeeZats(res.feeZats ?? null)
        if (signer === 'ledger') {
          const hardwareData = await accountManager.getHardwareWalletData(req.walletId)
          setLedgerDeviceModel(hardwareData.deviceModel)
          setLedgerDeviceName(hardwareData.deviceName)
          setTransport(
            hardwareData.ledgerSigningTransport === 'bluetooth' &&
              ledgerSupportsBluetooth(hardwareData.deviceModel)
              ? 'bluetooth'
              : 'usb'
          )
        }
        setStep(signer === 'ledger' ? 'review-ledger' : 'show-qr')
      } catch (e) {
        const raw = e instanceof Error ? e.message : ''
        if (raw.includes('SAPLING_UNSUPPORTED')) {
          setRetryable(false)
          setError(
            `This transfer needs to spend Sapling funds, which ${signer === 'ledger' ? 'Ledger' : 'Keystone'} cannot sign. ` +
              'Move or shield your Sapling balance into Orchard using a software wallet ' +
              'with the same recovery phrase, then try again.'
          )
        } else {
          setError(classifyError(e).userMessage)
        }
        sendAnalyticsEvent(ANALYTICS_EVENTS.HW_SIGN_FAILED, {
          pageId: PAGE_IDS.HARDWARE_SIGN,
          inputAmount: req.amount,
          inputSymbol: 'ZEC',
          extra: { error: (raw || 'build_failed').slice(0, 200), kind: req.kind, phase: 'build' }
        })
        setStep('failed')
      }
    },
    [signer]
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
      requestRef.current = req
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

  const finalizeSignedPczt = async (signedBase64: string) => {
    const activeRequest = requestRef.current ?? request
    if (!activeRequest || !requestId) return

    setScanError(null)
    setStep('broadcasting')

    const accountKey = buildAccountKey(network, activeRequest.walletId, activeRequest.accountId)
    const wallet = useWalletStore.getState().getWallet(activeRequest.walletId)
    const account = wallet?.accounts.find(a => a.id === activeRequest.accountId)
    const isShield = activeRequest.kind === 'shield'
    const fundingSource = isShield ? 'transparent' : (activeRequest.fundingSource ?? 'shielded')

    let transactionId: string | null = null
    let broadcastHash: string | null = null
    try {
      const addResponse = await chrome.runtime.sendMessage({
        type: 'ADD_TRANSACTION',
        accountKey,
        transaction: {
          txHash: '',
          status: 'pending',
          type: activeRequest.kind,
          amount: activeRequest.amount,
          to: isShield
            ? account?.addresses.shielded || ''
            : activeRequest.displayTo || activeRequest.to,
          from: account?.addresses[fundingSource] || '',
          fromType: fundingSource,
          memo: isShield ? 'Shielding transparent funds' : activeRequest.memo || '',
          fee: feeZec,
          timestamp: Date.now(),
          network,
          notified: false,
          ...(activeRequest.quoteBinding ? { quoteBinding: activeRequest.quoteBinding } : {})
        }
      })
      if (!isValidAddTransactionResponse(addResponse)) {
        throw new Error(addResponse?.error || 'Failed to create transaction record')
      }
      const recordedTransactionId: string = addResponse.transaction.id
      transactionId = recordedTransactionId
      setRecordedTransactionId(recordedTransactionId)
      setTransactionTimestamp(addResponse.transaction.timestamp)

      const fullPczt = fullPcztRef.current
      if (!fullPczt) {
        throw new Error('Missing transaction data; please rebuild and try again')
      }
      const hash = await requestHardwarePcztFinalize(
        activeRequest,
        fullPczt,
        signedBase64,
        recordedTransactionId
      )
      broadcastHash = hash

      try {
        const updateResponse = await chrome.runtime.sendMessage({
          type: 'UPDATE_TRANSACTION',
          accountKey,
          transactionId,
          updates: {
            txHash: hash,
            status: 'pending',
            notified: false,
            ...(activeRequest.monitorParams?.depositAddress
              ? { depositAddress: activeRequest.monitorParams.depositAddress }
              : {})
          }
        })
        if (!updateResponse?.success) {
          throw new Error(updateResponse?.error || 'Failed to update transaction record')
        }
      } catch (bookkeepingError) {
        console.error('[HardwareSign] Broadcast record update failed:', bookkeepingError)
      }

      try {
        if (activeRequest.kind === 'swap' && activeRequest.monitorParams) {
          await chrome.runtime.sendMessage({
            type: 'START_TRANSACTION_MONITOR',
            swap: {
              ...activeRequest.monitorParams,
              amountIn: activeRequest.amount,
              accountKey,
              transactionId
            }
          })
        } else {
          await chrome.runtime.sendMessage({
            type: 'START_ZCASH_TX_MONITOR',
            tx: {
              txHash: hash,
              accountKey,
              transactionId,
              amount: activeRequest.amount,
              type: activeRequest.kind
            }
          })
        }
      } catch (monitorError) {
        console.error('[HardwareSign] Broadcast monitor registration failed:', monitorError)
      }

      try {
        accountManager.requestSync('transaction')
      } catch (syncError) {
        console.error('[HardwareSign] Post-broadcast sync request failed:', syncError)
      }
      let originResultPublished = false
      if (activeRequest.reportToOrigin) {
        try {
          await publishHardwareSignResult({
            requestId,
            status: 'success',
            txHash: hash,
            accountKey,
            transactionId: transactionId ?? undefined,
            amount: activeRequest.amount,
            completedAt: Date.now()
          })
          originResultPublished = true
        } catch (cause) {
          console.error('[HardwareSign] Failed to report result to the origin surface:', cause)
        }
      }
      try {
        await clearHardwareSignRequest(requestId)
      } catch (cleanupError) {
        console.error('[HardwareSign] Could not clear signing request:', cleanupError)
      }
      sendAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUCCEEDED, {
        pageId: PAGE_IDS.HARDWARE_SIGN,
        hasTransaction: 1,
        inputAmount: activeRequest.amount,
        inputSymbol: 'ZEC',
        params: { amount: activeRequest.amount, hardware: true },
        extra: { tx_hash: hash, kind: activeRequest.kind, funding_source: fundingSource }
      })

      reportDappResult(activeRequest, { success: true, txHash: hash })
      setTxHash(hash)
      setStep('success')
      if (activeRequest.reportToOrigin && originResultPublished) {
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
        reportDappResult(activeRequest, { success: true, txHash: broadcastHash })
        setTxHash(broadcastHash)
        setStep('success')
        return
      }
      const classified = classifyError(e)
      sendAnalyticsEvent(ANALYTICS_EVENTS.HW_SIGN_FAILED, {
        pageId: PAGE_IDS.HARDWARE_SIGN,
        inputAmount: activeRequest.amount,
        inputSymbol: 'ZEC',
        extra: { error: classified.technicalMessage.slice(0, 200), kind: activeRequest.kind }
      })
      reportDappResult(activeRequest, { success: false, error: classified.technicalMessage })
      setError(classified.userMessage)
      setStep('failed')
    }
  }

  const handleSignedScan = async (ur: UR) => {
    try {
      await finalizeSignedPczt(bytesToBase64(parseSignedPczt(ur)))
    } catch (cause) {
      setScanError(classifyError(cause).userMessage)
      setScannerKey(key => key + 1)
    }
  }

  const handleLedgerSign = async () => {
    let signingRequest = requestRef.current ?? request
    if (!signingRequest) return
    const redactedPczt = redactedPcztRef.current
    if (!redactedPczt) {
      setError('Missing transaction data; please rebuild and try again')
      setStep('failed')
      return
    }

    setError(null)
    setIsLedgerSigning(true)
    setDeviceMessage(
      transport === 'usb'
        ? 'Select your Ledger in the browser dialog'
        : 'Select your Ledger over Bluetooth'
    )
    try {
      // Discover the device first — must happen in the user-gesture call
      // stack so navigator.bluetooth.requestDevice() / navigator.hid.requestDevice()
      // is permitted by the browser.
      const devicePromise = discoverLedger(transport)
      const [core, hardwareData] = await Promise.all([
        accountManager.getWalletCore(signingRequest.walletId, signingRequest.accountId),
        accountManager.getHardwareWalletData(signingRequest.walletId)
      ])
      const device = await devicePromise
      let currentRedactedPczt = redactedPczt
      let refreshedAfterInputRejection = false
      let signatures: Awaited<ReturnType<typeof signLedgerPczt>>

      while (true) {
        const payload = await core.pcztLedgerPayload(
          currentRedactedPczt,
          hardwareData.accountHdIndex
        )
        try {
          signatures = await signLedgerPczt({
            transport,
            payload,
            device,
            onInteraction: interaction => {
              const lower = interaction.toLowerCase()
              setDeviceMessage(
                lower.includes('app')
                  ? 'Open the Zcash app on your Ledger'
                  : lower.includes('transaction')
                    ? refreshedAfterInputRejection
                      ? 'Transaction refreshed. Review it again on your Ledger.'
                      : 'Review and approve the transaction on your Ledger'
                    : 'Follow the instructions on your Ledger'
              )
            }
          })
          break
        } catch (cause) {
          if (refreshedAfterInputRejection || !isLedgerTransparentInputDataError(cause)) {
            throw cause
          }

          refreshedAfterInputRejection = true
          console.warn(
            '[Ledger] Transparent input was rejected; refreshing UTXOs and rebuilding once'
          )
          fullPcztRef.current = null
          redactedPcztRef.current = null
          setPcztBytes(null)
          setDeviceMessage('Refreshing transparent funds and rebuilding the transaction...')

          const rebuilt = await requestHardwarePcztBuild(signingRequest)
          signingRequest = applyBuiltDetails(signingRequest, rebuilt)
          requestRef.current = signingRequest
          setRequest(signingRequest)
          fullPcztRef.current = rebuilt.full
          redactedPcztRef.current = rebuilt.redacted
          currentRedactedPczt = rebuilt.redacted
          setPcztBytes(base64ToBytes(rebuilt.redacted))
          setFeeZats(rebuilt.feeZats ?? null)
          setDeviceMessage('Transaction refreshed. Review it again on your Ledger.')
        }
      }
      await accountManager
        .setLedgerSigningTransport(signingRequest.walletId, transport)
        .catch(cause => {
          console.warn('[HardwareSign] Failed to save Ledger signing preference:', cause)
        })
      const fullPczt = fullPcztRef.current
      if (!fullPczt) {
        throw new Error('Missing full transaction data; please rebuild and try again')
      }
      const signedPczt = await core.pcztApplyLedgerSignatures(
        fullPczt,
        hardwareData.accountHdIndex,
        signatures
      )
      await finalizeSignedPczt(signedPczt)
    } catch (cause) {
      setIsLedgerSigning(false)
      if (shouldRebuildLedgerPczt(cause)) {
        fullPcztRef.current = null
        redactedPcztRef.current = null
        setPcztBytes(null)
      }
      const classified = classifyError(cause)
      sendAnalyticsEvent(ANALYTICS_EVENTS.HW_SIGN_FAILED, {
        pageId: PAGE_IDS.HARDWARE_SIGN,
        inputAmount: signingRequest.amount,
        inputSymbol: 'ZEC',
        extra: {
          error: classified.technicalMessage.slice(0, 200),
          kind: signingRequest.kind,
          phase: 'ledger_sign'
        }
      })
      reportDappResult(signingRequest, { success: false, error: classified.technicalMessage })
      setError(classified.userMessage)
      setStep('failed')
    }
  }

  const handleLedgerTransportToggle = () => {
    const nextTransport = transport === 'usb' ? 'bluetooth' : 'usb'
    setTransport(nextTransport)
    const activeRequest = requestRef.current ?? request
    if (!activeRequest) return
    void accountManager
      .setLedgerSigningTransport(activeRequest.walletId, nextTransport)
      .catch(cause => {
        console.warn('[HardwareSign] Failed to save Ledger signing preference:', cause)
      })
  }

  const signerName = signer === 'ledger' ? 'Ledger' : 'Keystone'
  const title =
    request?.kind === 'shield'
      ? `Shield with ${signerName}`
      : request?.kind === 'swap'
        ? `Swap with ${signerName}`
        : `Send with ${signerName}`

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
        <div className="page-content flex flex-col items-center justify-center">
          <Icon
            icon="lucide:loader-2"
            width={32}
            height={32}
            className="animate-spin text-primary mb-4"
          />
          <p className="text-sm text-muted">Building transaction...</p>
        </div>
      )}

      {step === 'review-ledger' && request && (
        <>
          <div className="page-content">
            <HardwareTransactionSummary
              request={request}
              feeZec={feeZec}
              ledgerDisplayAddress={request.ledgerDisplayAddress}
            />
            <div className="mt-5 flex items-center justify-between gap-3 text-xs text-muted">
              <span className="flex min-w-0 items-center gap-2">
                <Icon
                  icon={transport === 'usb' ? 'lucide:usb' : 'lucide:bluetooth'}
                  width={15}
                  height={15}
                  className="shrink-0"
                />
                <span className="truncate">
                  {getLedgerDeviceName(ledgerDeviceModel, ledgerDeviceName)} via{' '}
                  {transport === 'usb' ? 'USB' : 'Bluetooth'}
                </span>
              </span>
              {!isLedgerSigning && ledgerSupportsBluetooth(ledgerDeviceModel) && (
                <button
                  type="button"
                  onClick={handleLedgerTransportToggle}
                  className="shrink-0 font-medium text-primary hover:text-primary/80"
                >
                  Use {transport === 'usb' ? 'Bluetooth' : 'USB'}
                </button>
              )}
            </div>
          </div>
          <div className="page-footer space-y-3">
            {isLedgerSigning && <p className="text-center text-xs text-muted">{deviceMessage}</p>}
            <Button
              onClick={handleLedgerSign}
              disabled={isLedgerSigning}
              isLoading={isLedgerSigning}
              className="w-full h-[45px]"
            >
              {isLedgerSigning ? 'Signing...' : 'Connect Ledger & Sign'}
            </Button>
            <Button
              variant="outline"
              onClick={() => window.close()}
              disabled={isLedgerSigning}
              className="w-full h-[45px]"
            >
              Cancel
            </Button>
          </div>
        </>
      )}

      {step === 'show-qr' && request && pcztBytes && (
        <>
          <div className="page-content">
            <HardwareTransactionSummary request={request} feeZec={feeZec} />
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

      {step === 'broadcasting' && (
        <div className="page-content flex flex-col items-center justify-center">
          <Icon
            icon="lucide:loader-2"
            width={32}
            height={32}
            className="animate-spin text-primary mb-4"
          />
          <p className="text-sm font-medium mb-1">Finalizing transaction</p>
          <p className="text-xs text-muted text-center">
            Generating the zero-knowledge proof and broadcasting. This can take a minute.
          </p>
        </div>
      )}

      {(step === 'success' || step === 'pending') && request && (
        <div className="flex flex-1 flex-col w-full max-w-[440px] mx-auto min-h-0">
          <StandardTransactionResult
            step={resultView.step}
            confirmed={resultView.step === 'success'}
            shield={request.kind === 'shield'}
            amount={request.amount}
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
          title={retryable ? `${signerName} Signing Failed` : `Cannot Sign with ${signerName}`}
          description={error || failedCopy.description}
          actionText={retryable ? 'Try Again' : 'Close'}
          onAction={
            retryable
              ? () =>
                  signer === 'ledger' && redactedPcztRef.current
                    ? setStep('review-ledger')
                    : request && buildPczt(request)
              : () => window.close()
          }
          secondaryText={retryable ? 'Close' : undefined}
          onSecondary={retryable ? () => window.close() : undefined}
        />
      )}
    </div>
  )
}
