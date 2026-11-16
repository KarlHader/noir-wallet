import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Buffer } from 'buffer'
import type { UR } from '@/lib/keystone'
import { parseKeystoneEthereumSignature } from '@/lib/keystone'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  evmWalletClient,
  type EvmExternalSigningRequest,
  type EvmTransferSubmission
} from '@/popup/services/evm-wallet-client'
import { Button } from '@/popup/components/ui/button'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { EthereumSignRequestAnimatedQR } from '@/popup/components/hardware/AnimatedQR'
import { QRScanner } from '@/popup/components/hardware/QRScanner'
import { CenteredNotice } from '@/popup/components/hardware/CenteredNotice'
import { HardwareSigningProgress } from '@/popup/components/hardware/HardwareSigningProgress'
import { DetailRow } from '@/popup/components/common/DetailRow'
import { useLocation } from '@/popup/provider/Router'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { ListSkeleton, Skeleton } from '@/popup/components/ui/skeleton'
import { formatHardwareSigningError } from '@/lib/hardware-signing-error'
import { logger } from '@/lib/logger'

type Step = 'loading' | 'show-qr' | 'scan' | 'broadcasting' | 'success' | 'failed' | 'invalid'

function readTransactionId(value: string | null): TransactionId | null {
  if (!value) return null
  try {
    return parseTransactionId(value)
  } catch {
    return null
  }
}

export function KeystoneEvmSignPage() {
  const location = useLocation()
  const transactionId = readTransactionId(new URLSearchParams(location.search).get('tx'))
  const [step, setStep] = useState<Step>('loading')
  const [request, setRequest] = useState<EvmExternalSigningRequest | null>(null)
  const [submission, setSubmission] = useState<EvmTransferSubmission | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scannerKey, setScannerKey] = useState(0)
  const started = useRef(false)
  const terminal = useRef(false)
  const submitting = useRef(false)
  const network = request
    ? resolveEvmNetworkCatalog(DEFAULT_NETWORK, getActiveChainEndpointSettings()).find(
        candidate => candidate.chainId === request.chainId
      )
    : undefined
  const networkName = network?.displayName ?? 'EVM network'

  const expire = useCallback(() => {
    if (terminal.current || submitting.current) return
    terminal.current = true
    setStep('invalid')
    if (transactionId) void evmWalletClient.rejectTransfer(transactionId).catch(() => {})
  }, [transactionId])

  useEffect(() => {
    if (!request || (step !== 'show-qr' && step !== 'scan')) return
    const timer = window.setTimeout(expire, Math.max(0, request.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [request, step, expire])

  useEffect(() => {
    if (started.current) return
    started.current = true
    if (!transactionId) {
      setStep('invalid')
      return
    }
    void evmWalletClient
      .getExternalSigningRequest(transactionId)
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
          logger.error(`[Hardware signing] Keystone EVM request loading failed: ${message}`)
          setError(message)
          setStep('invalid')
        }
      })
  }, [transactionId])

  const handleScan = useCallback(
    async (ur: UR) => {
      if (!transactionId || !request || terminal.current || submitting.current) return
      if (Date.now() >= request.expiresAt) {
        expire()
        return
      }
      let signatureCborBase64: string
      try {
        parseKeystoneEthereumSignature(ur)
        signatureCborBase64 = Buffer.from(ur.cbor).toString('base64')
      } catch (cause) {
        const message = formatHardwareSigningError(cause)
        logger.error(`[Hardware signing] Keystone EVM QR decoding failed: ${message}`)
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
      setStep('broadcasting')
      try {
        const value = await evmWalletClient.submitExternalSignature(
          transactionId,
          request.payloadFingerprint,
          signatureCborBase64
        )
        setSubmission(value)
        terminal.current = true
        setStep('success')
      } catch (cause) {
        const message = formatHardwareSigningError(cause)
        logger.error(`[Hardware signing] Keystone EVM submission failed: ${message}`)
        setError(message)
        setStep('failed')
      } finally {
        submitting.current = false
      }
    },
    [request, transactionId, expire]
  )

  const close = async () => {
    const shouldReject = !terminal.current
    terminal.current = true
    if (transactionId && shouldReject) {
      await evmWalletClient.rejectTransfer(transactionId).catch(() => {})
    }
    window.close()
  }

  return (
    <div className="page-container page-container--tab">
      <PageHeader title="Sign with Keystone" />

      {step === 'loading' && (
        <div
          role="status"
          aria-label="Loading EVM signing request"
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
            'This EVM signing request expired, was cancelled, or belongs to another Wallet. Start a new send from Noir Wallet.'
          }
          actionText="Close"
          onAction={() => void close()}
        />
      )}

      {step === 'show-qr' && request && (
        <>
          <div className="page-content flex flex-col items-center">
            <div className="mb-5 w-full rounded-xl border border-border/60 bg-card/60 p-4">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-primary/10 p-2 text-primary">
                  <Icon icon="lucide:shield-check" width={18} height={18} />
                </div>
                <div>
                  <p className="text-sm font-medium">Approved in Noir Wallet</p>
                  <p className="mt-1 text-xs font-medium text-foreground">{networkName}</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Scan this request with Keystone. Verify the recipient, amount, network, and fee
                    again on the device before signing.
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <EthereumSignRequestAnimatedQR
                cborBytes={new Uint8Array(Buffer.from(request.request.value, 'base64'))}
                size={240}
              />
            </div>
          </div>
          <div className="page-footer space-y-3">
            <Button className="h-[45px] w-full" onClick={() => setStep('scan')}>
              <Icon icon="lucide:camera" width={16} height={16} className="mr-2" />
              Scan Signature
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
              Scan the signed <span className="font-mono">eth-signature</span> QR shown by Keystone.
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

      {step === 'broadcasting' && request && (
        <div className="page-content space-y-5 pt-5">
          <HardwareSigningProgress title="Verifying signed transaction">
            <div className="space-y-3 rounded-lg bg-card p-4">
              <DetailRow label="Signature">
                <span className="text-sm">Received from Keystone</span>
              </DetailRow>
              <DetailRow label="Network">
                <span className="text-sm">{networkName}</span>
              </DetailRow>
            </div>
          </HardwareSigningProgress>
        </div>
      )}

      {step === 'success' && submission && (
        <CenteredNotice
          icon={submission.status === 'broadcast' ? 'lucide:check-circle-2' : 'lucide:clock-3'}
          iconClass="text-primary"
          title={submission.status === 'broadcast' ? 'Transaction sent' : 'Transaction signed'}
          description={
            submission.status === 'broadcast'
              ? `The signed transaction was broadcast on ${networkName} and is now awaiting confirmation.`
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
          title="Signature rejected"
          description={
            error ??
            'The signature did not match the approved request or active Keystone Account. Start a new send.'
          }
          actionText="Close"
          onAction={() => void close()}
        />
      )}
    </div>
  )
}
