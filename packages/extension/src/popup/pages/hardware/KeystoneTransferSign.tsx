import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { UR } from '@/lib/keystone'
import { base64ToBytes } from '@/lib/bytes'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  keystoneEvmDeviceSigningAdapter,
  keystoneTransferAdapters,
  type KeystoneTransferAdapter,
  type KeystoneTransferFamily
} from '@/popup/services/keystone-transfer-adapters'
import { Button } from '@/popup/components/ui/button'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { AnimatedQR } from '@/popup/components/hardware/AnimatedQR'
import { QRScanner } from '@/popup/components/hardware/QRScanner'
import { CenteredNotice } from '@/popup/components/hardware/CenteredNotice'
import { HardwareSigningProgress } from '@/popup/components/hardware/HardwareSigningProgress'
import { DetailRow } from '@/popup/components/common/DetailRow'
import { useLocation } from '@/popup/provider/Router'
import { ListSkeleton, Skeleton } from '@/popup/components/ui/skeleton'
import { formatHardwareSigningError } from '@/lib/hardware-signing-error'
import { logger } from '@/lib/logger'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'

type Step = 'loading' | 'show-qr' | 'scan' | 'verifying' | 'success' | 'failed' | 'invalid'

function readTransactionId(value: string | null): TransactionId | null {
  if (!value) return null
  try {
    return parseTransactionId(value)
  } catch {
    return null
  }
}

export function KeystoneTransferSign({ family }: { family: KeystoneTransferFamily }) {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const requestId = params.get('requestId')
  if (family === 'evm' && requestId !== null) {
    return (
      <KeystoneTransferSigning
        key={`device:${requestId}`}
        family={family}
        adapter={keystoneEvmDeviceSigningAdapter}
        signingId={requestId}
      />
    )
  }
  const transactionId = readTransactionId(params.get('tx'))
  return (
    <KeystoneTransferSigning
      key={`${family}:${transactionId}`}
      family={family}
      adapter={keystoneTransferAdapters[family]}
      signingId={transactionId}
    />
  )
}

function KeystoneTransferSigning<SigningId extends string>({
  family,
  adapter,
  signingId
}: {
  family: KeystoneTransferFamily
  adapter: KeystoneTransferAdapter<SigningId>
  signingId: SigningId | null
}) {
  const { client } = adapter
  const [step, setStep] = useState<Step>('loading')
  const [request, setRequest] =
    useState<Awaited<ReturnType<typeof client.getExternalSigningRequest>>>(null)
  const [submission, setSubmission] = useState<Awaited<
    ReturnType<typeof client.submitExternalSignature>
  > | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scannerKey, setScannerKey] = useState(0)
  const started = useRef(false)
  const terminal = useRef(false)
  const submitting = useRef(false)
  const requestBase64 = request?.request.value
  const qrBytes = useMemo(
    () => (requestBase64 ? base64ToBytes(requestBase64) : null),
    [requestBase64]
  )
  const networkName = request ? adapter.networkName(request.chainId) : ''
  const personalSign = request?.kind === 'personal-sign'

  const expire = useCallback(() => {
    if (terminal.current || submitting.current) return
    terminal.current = true
    setStep('invalid')
    if (signingId) void client.rejectTransfer(signingId).catch(() => {})
  }, [client, signingId])

  useEffect(() => {
    if (!adapter.signatureOnly || !signingId) return
    const cancel = () => {
      if (terminal.current) return
      terminal.current = true
      void client.rejectTransfer(signingId).catch(() => {})
    }
    const onMessage = (
      message: { type?: string; requestId?: string },
      sender: chrome.runtime.MessageSender
    ) => {
      if (
        !terminal.current &&
        message?.type === 'KEYSTONE_EVM_SIGNING_CANCELLED' &&
        message.requestId === signingId &&
        getOwnExtensionSenderContext(sender, chrome.runtime.id) === 'service-worker'
      ) {
        terminal.current = true
        setStep('invalid')
      }
    }
    window.addEventListener('pagehide', cancel)
    chrome.runtime.onMessage.addListener(onMessage)
    return () => {
      window.removeEventListener('pagehide', cancel)
      chrome.runtime.onMessage.removeListener(onMessage)
    }
  }, [adapter.signatureOnly, client, signingId])

  useEffect(() => {
    if (!request || (step !== 'show-qr' && step !== 'scan')) return
    const timer = window.setTimeout(expire, Math.max(0, request.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [request, step, expire])

  useEffect(() => {
    if (started.current) return
    started.current = true
    if (!signingId) {
      setStep('invalid')
      return
    }
    void client
      .getExternalSigningRequest(signingId)
      .then(value => {
        if (terminal.current) return
        if (!value || value.expiresAt <= Date.now()) {
          setStep('invalid')
          return
        }
        setRequest(value)
        setStep('show-qr')
      })
      .catch(cause => {
        if (!terminal.current) {
          const message = formatHardwareSigningError(cause)
          logger.error(
            `[Hardware signing] Keystone ${adapter.name} request loading failed: ${message}`
          )
          setError(message)
          setStep('invalid')
        }
      })
  }, [adapter.name, client, signingId])

  const handleScan = useCallback(
    async (ur: UR) => {
      if (!signingId || !request || terminal.current || submitting.current) return
      if (Date.now() >= request.expiresAt) {
        expire()
        return
      }
      let responseBase64: string
      try {
        responseBase64 = adapter.encodeResponse(ur)
      } catch (cause) {
        const message = formatHardwareSigningError(cause)
        logger.error(`[Hardware signing] Keystone ${adapter.name} QR decoding failed: ${message}`)
        setScanError(message)
        setScannerKey(value => value + 1)
        return
      }
      if (terminal.current || submitting.current) return
      if (Date.now() >= request.expiresAt) {
        expire()
        return
      }
      setScanError(null)
      submitting.current = true
      setStep('verifying')
      try {
        const value = await client.submitExternalSignature(
          signingId,
          request.payloadFingerprint,
          responseBase64
        )
        if (terminal.current) return
        setSubmission(value)
        terminal.current = true
        setStep('success')
      } catch (cause) {
        if (terminal.current) return
        const message = formatHardwareSigningError(cause)
        logger.error(`[Hardware signing] Keystone ${adapter.name} submission failed: ${message}`)
        setError(message)
        setStep('failed')
      } finally {
        submitting.current = false
      }
    },
    [adapter, client, request, signingId, expire]
  )

  const close = async () => {
    const shouldReject = !terminal.current
    terminal.current = true
    if (signingId && shouldReject) {
      await client.rejectTransfer(signingId).catch(() => {})
    }
    window.close()
  }

  return (
    <div className="page-container page-container--tab">
      <PageHeader title={adapter.title} />

      {step === 'loading' && (
        <div
          role="status"
          aria-label={`Loading ${adapter.name} signing request`}
          className="page-content space-y-5"
        >
          <Skeleton className="h-24 rounded-xl" />
          <div className="flex justify-center">
            <Skeleton className="size-60 rounded-2xl" />
          </div>
          <ListSkeleton rows={2} />
        </div>
      )}

      {step === 'invalid' && (
        <CenteredNotice
          icon="lucide:alert-triangle"
          iconClass="text-warning"
          title="Request unavailable"
          description={
            error ??
            (adapter.signatureOnly
              ? 'This signing request expired or was cancelled. Review the action again in Noir Wallet.'
              : `This ${adapter.name} signing request expired, was cancelled, or belongs to another Wallet. Start a new send from Noir Wallet.`)
          }
          actionText="Close"
          onAction={() => void close()}
        />
      )}

      {step === 'show-qr' && qrBytes && (
        <>
          <div className="page-content flex flex-col items-center">
            <div className="mb-5 w-full rounded-xl border border-border/60 bg-card/60 p-4">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-primary/10 p-2 text-primary">
                  <Icon icon="lucide:shield-check" width={18} height={18} />
                </div>
                <div>
                  <p className="text-sm font-medium">Approved in Noir Wallet</p>
                  {adapter.showNetworkInReview && !personalSign && (
                    <p className="mt-1 text-xs font-medium text-foreground">{networkName}</p>
                  )}
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {personalSign
                      ? 'Scan this request and verify the message on Keystone before signing.'
                      : adapter.reviewPrompt}
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <AnimatedQR family={family} bytes={qrBytes} size={240} />
            </div>
          </div>
          <div className="page-footer space-y-3">
            <Button className="h-[45px] w-full" onClick={() => setStep('scan')}>
              <Icon icon="lucide:camera" width={16} height={16} className="mr-2" />
              {adapter.scanAction}
            </Button>
            <Button variant="outline" className="h-[45px] w-full" onClick={() => void close()}>
              Close
            </Button>
          </div>
        </>
      )}

      {step === 'scan' && (
        <>
          <div className="page-content">
            <p className="mb-4 text-center text-sm text-muted">
              Scan the signed <span className="font-mono">{adapter.responseType}</span> QR shown by
              Keystone.
            </p>
            <QRScanner key={scannerKey} onScan={handleScan} />
            {scanError && <p className="mt-3 text-center text-xs text-danger">{scanError}</p>}
          </div>
          <div className="page-footer">
            <Button
              variant="outline"
              className="h-[45px] w-full"
              onClick={() => setStep('show-qr')}
            >
              Back to QR Code
            </Button>
          </div>
        </>
      )}

      {step === 'verifying' && request && (
        <div className="page-content space-y-5 pt-5">
          <HardwareSigningProgress
            title={personalSign ? 'Verifying signature' : 'Verifying signed transaction'}
          >
            <div className="space-y-3 rounded-lg bg-card p-4">
              <DetailRow label="Signature">
                <span className="text-sm">Received from Keystone</span>
              </DetailRow>
              {!personalSign && (
                <DetailRow label={adapter.detailLabel}>
                  <span className="text-sm">{networkName}</span>
                </DetailRow>
              )}
            </div>
          </HardwareSigningProgress>
        </div>
      )}

      {step === 'success' && submission && (
        <CenteredNotice
          icon={
            submission.status === 'signed-pending-broadcast'
              ? 'lucide:clock-3'
              : 'lucide:check-circle-2'
          }
          iconClass="text-primary"
          title={
            submission.status === 'broadcast'
              ? adapter.sentTitle
              : personalSign
                ? 'Message signed'
                : 'Transaction signed'
          }
          description={
            submission.status === 'broadcast'
              ? adapter.sentDescription(networkName)
              : submission.status === 'signed'
                ? 'Return to Noir Wallet to continue.'
                : 'The signed transaction is saved. Noir Wallet will retry broadcast when the network is available.'
          }
          actionText="Done"
          onAction={() => void close()}
        />
      )}

      {step === 'failed' && (
        <CenteredNotice
          icon="lucide:x-circle"
          iconClass="text-danger"
          title={adapter.failureTitle}
          description={error ?? adapter.failureDescription}
          actionText="Close"
          onAction={() => void close()}
        />
      )}
    </div>
  )
}
