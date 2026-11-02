import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { PageHeader } from '../../components/common/PageHeader'
import { useNavigate } from '../../provider/Router'
import { Button } from '../../components/ui/button'
import { SigningSummaryReview } from '../../components/signing/SigningSummaryReview'
import { Skeleton } from '../../components/ui/skeleton'
import {
  loadLedgerSigningView,
  signLedgerDeviceRequest,
  submitLedgerSigningView,
  cancelLedgerSigningView,
  ledgerRequestDeviceApp,
  ledgerRequestAddress,
  type LedgerSigningView
} from '../../services/ledger-signing-client'
import type { LedgerTransport } from '@/lib/ledger/device'
import { swapApprovalContinuationClient } from '../../services/swap-approval-continuation-client'

export function LedgerSignPage() {
  const { navigate } = useNavigate()
  const [view, setView] = useState<LedgerSigningView | null>(null)
  const [step, setStep] = useState<
    'loading' | 'review' | 'device' | 'signing' | 'success' | 'error'
  >('loading')
  const [error, setError] = useState('')
  const [interaction, setInteraction] = useState('')
  const [swapApprovalId, setSwapApprovalId] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const terminal = useRef(false)
  const signing = useRef(false)
  useEffect(() => {
    let disposed = false
    const query = new URLSearchParams(location.hash.split('?')[1] ?? '')
    void loadLedgerSigningView({
      requestId: query.get('requestId') ?? undefined,
      transactionId: query.get('tx') ?? undefined,
      family: query.get('family') ?? undefined
    })
      .then(result => {
        if (!disposed) {
          setView(result)
          setStep('review')
        }
      })
      .catch(cause => {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : 'Request unavailable')
          setStep('error')
        }
      })
    return () => {
      disposed = true
      abort.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!view) return
    const cancel = () => {
      abort.current?.abort()
      if (!terminal.current) {
        void cancelLedgerSigningView(view).catch(() => {})
        if (view.family === 'evm' && view.transactionId)
          void swapApprovalContinuationClient.clear(view.transactionId).catch(() => {})
      }
    }
    const timer = setTimeout(
      () => {
        if (terminal.current) return
        cancel()
        setError('Request expired. Review this action again.')
        setStep('error')
      },
      Math.max(0, view.expiresAt - Date.now())
    )
    const onMessage = (message: { type?: string; requestId?: string }) => {
      if (
        !terminal.current &&
        message.type === 'LEDGER_SIGNING_CANCELLED' &&
        (message.requestId === undefined || message.requestId === view.requestId)
      ) {
        cancel()
        setError('Request cancelled. Review this action again.')
        setStep('error')
      }
    }
    window.addEventListener('pagehide', cancel)
    chrome.runtime.onMessage.addListener(onMessage)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pagehide', cancel)
      chrome.runtime.onMessage.removeListener(onMessage)
    }
  }, [view])
  const close = async () => {
    abort.current?.abort()
    if (view && !terminal.current) await cancelLedgerSigningView(view).catch(() => {})
    if (view?.family === 'evm' && view.transactionId && !terminal.current)
      await swapApprovalContinuationClient.clear(view.transactionId).catch(() => {})
    terminal.current = true
    window.close()
  }
  const sign = async (transport: LedgerTransport) => {
    if (!view || signing.current || terminal.current || Date.now() >= view.expiresAt) return
    signing.current = true
    abort.current = new AbortController()
    setInteraction(`Open the ${ledgerRequestDeviceApp(view.request)} app on your Ledger`)
    setStep('signing')
    try {
      const response = await signLedgerDeviceRequest(view.request, {
        transport,
        signal: abort.current.signal,
        onInteraction: () => setInteraction('Review and confirm on your Ledger')
      })
      abort.current.signal.throwIfAborted()
      await submitLedgerSigningView(view, response)
      terminal.current = true
      if (view.family === 'evm' && view.transactionId) {
        const continuation = await swapApprovalContinuationClient
          .get(view.transactionId)
          .catch(() => null)
        if (continuation) setSwapApprovalId(view.transactionId)
      }
      setStep('success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ledger signing failed')
      setStep('error')
    } finally {
      signing.current = false
    }
  }
  if (step === 'review' && view)
    return (
      <SigningSummaryReview
        summary={view.summary}
        chainName={ledgerRequestDeviceApp(view.request)}
        networkName={view.scope.chainId}
        accountName="Ledger"
        accountAddress={ledgerRequestAddress(view.request)}
        source={
          view.origin
            ? { kind: 'dapp', domain: new URL(view.origin).hostname, pageUrl: view.origin }
            : { kind: 'wallet' }
        }
        onReject={() => void close()}
        onConfirm={() => setStep('device')}
      />
    )
  return (
    <div className="page-container page-container--tab">
      <PageHeader title="Sign with Ledger" />
      {step === 'loading' ? (
        <div
          role="status"
          aria-label="Loading signing request"
          className="page-content space-y-5 pt-5"
        >
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="size-12 rounded-full" />
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="space-y-4 rounded-lg bg-card p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <div className="space-y-4 rounded-lg bg-card p-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      ) : (
        <div className="page-content flex flex-col items-center justify-center gap-4 text-center">
          {step === 'signing' && (
            <Icon icon="lucide:loader-2" width={32} className="animate-spin text-primary" />
          )}
          {step === 'device' && view && (
            <>
              <Icon icon="lucide:usb" width={32} />
              <p>Open the {ledgerRequestDeviceApp(view.request)} app</p>
              {view.request.kind === 'bip322-simple' && (
                <p className="text-sm text-muted">
                  Your Ledger will display a zero-amount transaction for this message signature.
                </p>
              )}
            </>
          )}
          {step === 'signing' && <p>{interaction}</p>}
          {step === 'success' && (
            <>
              <Icon icon="lucide:check-circle-2" width={32} className="text-primary" />
              <p>Signature submitted</p>
            </>
          )}
          {step === 'error' && (
            <>
              <Icon icon="lucide:alert-triangle" width={32} className="text-warning" />
              <p className="text-sm text-danger">{error}</p>
            </>
          )}
        </div>
      )}
      <div className="page-footer space-y-2">
        {step === 'success' && swapApprovalId && (
          <Button
            className="w-full"
            onClick={() => navigate(`/swap?resumeApproval=${encodeURIComponent(swapApprovalId)}`)}
          >
            Continue Swap
          </Button>
        )}
        {step === 'device' && (
          <>
            <Button className="w-full" onClick={() => void sign('usb')}>
              Connect via USB
            </Button>
            <Button className="w-full" variant="outline" onClick={() => void sign('bluetooth')}>
              Connect via Bluetooth
            </Button>
          </>
        )}
        <Button
          className="w-full"
          variant={step === 'success' ? 'default' : 'outline'}
          onClick={() => void close()}
        >
          {step === 'success' || step === 'error' ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  )
}
