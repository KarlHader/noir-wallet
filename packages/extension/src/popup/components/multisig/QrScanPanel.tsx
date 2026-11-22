import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import type { UR } from '@ngraveio/bc-ur'
import { QRScanner } from '@/popup/components/hardware/QRScanner'
import { FlowButton } from './FlowButton'
import type { ScanOutcome } from '@/popup/multisig/qr-driver'
import { toast } from '@/store/toast-store'
import { QrPanelHeading, type QrPanelHeadingProps } from './QrPanelHeading'

// How long a rejected code is left alone before the scanner starts again.
const RESCAN_DELAY_MS = 1500

interface QrScanPanelProps extends QrPanelHeadingProps {
  /** Shown until the camera opens. */
  description: string
  /** Whether the camera is open; the page's footer button opens it. */
  scanning: boolean
  /** The reply was accepted and the page is about to move on. */
  accepted?: boolean
  /** Hands a complete code to the session and reports what became of it. */
  onScan: (ur: UR) => Promise<ScanOutcome>
}

/** The footer action that opens the camera for a scan panel. */
export function QrScanButton({ onClick }: { onClick: () => void }) {
  return (
    <FlowButton onClick={onClick}>
      <Icon icon="lucide:scan" aria-hidden="true" />
      Scan your phone
    </FlowButton>
  )
}

/** Reads a phone's reply code with the camera and restarts the scanner after a wrong code. */
export function QrScanPanel({
  description,
  scanning,
  accepted = false,
  onScan,
  ...heading
}: QrScanPanelProps) {
  const [scanAttempt, setScanAttempt] = useState(0)
  const [rejected, setRejected] = useState(false)

  // The scanner stops after its first complete code and cannot be re-armed from outside, so a
  // rejected code gets a fresh scanner. The pause keeps a wrong code that stays in front of the
  // camera from toasting and restarting the camera in a tight loop.
  useEffect(() => {
    if (!rejected) return
    const timer = window.setTimeout(() => {
      setScanAttempt(attempt => attempt + 1)
      setRejected(false)
    }, RESCAN_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [rejected])

  // Only codes that leave the session where it was restart the scanner here; for the other
  // outcomes the session's new state moves the page on.
  const handleScan = async (ur: UR) => {
    // A check that throws leaves the session untouched, like a code it does not recognise.
    const outcome = await onScan(ur).catch((): ScanOutcome => 'ignored')
    if (outcome === 'duplicate') toast.info('Already scanned')
    else if (outcome === 'ignored') toast.error('Unrecognized code')
    else return
    setRejected(true)
  }

  return (
    <div className="flex flex-col items-center text-center">
      <QrPanelHeading {...heading} />
      {scanning ? (
        <>
          <p className="mt-2 text-sm text-[#BCBCC8]">
            Hold your phone&apos;s QR code up to the camera.
          </p>
          <QRScanner
            key={scanAttempt}
            onScan={ur => void handleScan(ur)}
            className="mt-4 w-full max-w-[320px]"
          />
        </>
      ) : (
        <p className="mt-2 text-sm text-[#BCBCC8]">{description}</p>
      )}
      {accepted && (
        <p role="status" className="mt-3 text-xs text-muted">
          Checking device and setup…
        </p>
      )}
    </div>
  )
}
