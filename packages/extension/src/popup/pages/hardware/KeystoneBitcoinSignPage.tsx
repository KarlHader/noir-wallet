import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { UR } from '@/lib/keystone'
import { parseSignedBitcoinPsbt } from '@/lib/keystone'
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import {
  bitcoinWalletClient,
  type BitcoinExternalSigningRequest,
  type BitcoinTransferSubmission
} from '@/popup/services/bitcoin-wallet-client'
import { Button } from '@/popup/components/ui/button'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { BitcoinPsbtAnimatedQR } from '@/popup/components/hardware/AnimatedQR'
import { QRScanner } from '@/popup/components/hardware/QRScanner'
import { CenteredNotice } from '@/popup/components/hardware/CenteredNotice'
import { HardwareSigningProgress } from '@/popup/components/hardware/HardwareSigningProgress'
import { DetailRow } from '@/popup/components/common/DetailRow'
import { useLocation } from '@/popup/provider/Router'
import { ListSkeleton, Skeleton } from '@/popup/components/ui/skeleton'

type Step = 'loading' | 'show-qr' | 'scan' | 'broadcasting' | 'success' | 'failed' | 'invalid'

function readTransactionId(value: string | null): TransactionId | null {
  if (!value) return null
  try {
    return parseTransactionId(value)
  } catch {
    return null
  }
}

export function KeystoneBitcoinSignPage() {
  const location = useLocation()
  const transactionId = readTransactionId(new URLSearchParams(location.search).get('tx'))
  const [step, setStep] = useState<Step>('loading')
  const [request, setRequest] = useState<BitcoinExternalSigningRequest | null>(null)
  const [submission, setSubmission] = useState<BitcoinTransferSubmission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scannerKey, setScannerKey] = useState(0)
  const started = useRef(false)
  const terminal = useRef(false)
  const submitting = useRef(false)

  const expire = useCallback(() => {
    if (terminal.current || submitting.current) return
    terminal.current = true
    setStep('invalid')
    if (transactionId) void bitcoinWalletClient.rejectTransfer(transactionId).catch(() => {})
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
    void bitcoinWalletClient
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
      .catch(() => {
        if (!terminal.current) setStep('invalid')
      })
  }, [transactionId])

  const handleScan = useCallback(
    async (ur: UR) => {
      if (!transactionId || !request || terminal.current || submitting.current) return
      if (Date.now() >= request.expiresAt) {
        expire()
        return
      }
      let signedPsbtBase64: string
      try {
        signedPsbtBase64 = bytesToBase64(parseSignedBitcoinPsbt(ur))
      } catch {
        setScanError('This is not a valid signed Bitcoin transaction from Keystone.')
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
        const value = await bitcoinWalletClient.submitExternalSignature(
          transactionId,
          request.payloadFingerprint,
          signedPsbtBase64
        )
        setSubmission(value)
        terminal.current = true
        setStep('success')
      } catch {
        setError('The signed transaction could not be verified or broadcast. Start a new send.')
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
      await bitcoinWalletClient.rejectTransfer(transactionId).catch(() => {})
    }
    window.close()
  }

  return (
    <div className="page-container page-container--tab">
      <PageHeader title="Sign Bitcoin with Keystone" />

      {step === 'loading' && (
        <div
          role="status"
          aria-label="Loading Bitcoin signing request"
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
          description="This Bitcoin signing request expired, was cancelled, or belongs to another Wallet. Start a new send from Noir Wallet."
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
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Scan this PSBT with Keystone. Verify the recipient, amount, and fee again on the
                    device before signing.
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <BitcoinPsbtAnimatedQR psbtBytes={base64ToBytes(request.request.value)} size={240} />
            </div>
          </div>
          <div className="page-footer space-y-3">
            <Button className="h-[45px] w-full" onClick={() => setStep('scan')}>
              <Icon icon="lucide:camera" width={16} height={16} className="mr-2" />
              Scan Signed Transaction
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
              Scan the signed <span className="font-mono">crypto-psbt</span> QR shown by Keystone.
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
              <DetailRow label="Asset">
                <span className="text-sm">Bitcoin</span>
              </DetailRow>
            </div>
          </HardwareSigningProgress>
        </div>
      )}

      {step === 'success' && submission && (
        <CenteredNotice
          icon={submission.status === 'broadcast' ? 'lucide:check-circle-2' : 'lucide:clock-3'}
          iconClass="text-primary"
          title={submission.status === 'broadcast' ? 'Bitcoin sent' : 'Transaction signed'}
          description={
            submission.status === 'broadcast'
              ? 'The signed Bitcoin transaction was broadcast and is now awaiting confirmation.'
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
          title="Signing failed"
          description={error ?? 'The signed Bitcoin transaction could not be completed.'}
          actionText="Close"
          onAction={() => void close()}
        />
      )}
    </div>
  )
}
