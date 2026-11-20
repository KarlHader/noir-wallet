import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import type { MultisigEnvelope } from '@/core/multisig/messages'
import { createEnvelopesUREncoder } from '@/lib/multisig-ur'
import { EncoderAnimatedQR } from '@/popup/components/hardware/AnimatedQR'
import { QrPanelHeading, type QrPanelHeadingProps } from './QrPanelHeading'

const QR_SIZE = 240

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Milliseconds until `expiresAt`, re-rendered once per second; null while there is no code.
 * `onExpire` fires from the tick that finds the deadline passed, and the interval dies with the
 * effect, so leaving the page or getting a new deadline never leaves a stray timer.
 */
function useRemainingMs(expiresAt: number | null, onExpire: () => void): number | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (expiresAt === null) return
    // Catch up at once: `now` may be stale from before the deadline was set or extended.
    setNow(Date.now())
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= expiresAt) onExpire()
    }, 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt, onExpire])

  return expiresAt === null ? null : Math.max(0, expiresAt - now)
}

interface QrShowPanelProps extends QrPanelHeadingProps {
  description: string
  /** The line above the code telling the phone what to do, e.g. "Scan your computer". */
  scanLabel: string
  /** Null until the code is ready; a spinner holds its place. */
  envelopes: readonly MultisigEnvelope[] | null
  expiresAt: number | null
  /** Extends the code's expiry. Also called when it runs out, so it should be stable. */
  onRefresh: () => void
  /** Shown below the code, for example which phones have scanned it. */
  children?: ReactNode
}

/** A code on the extension's screen for the phones to scan, with its expiry countdown. */
export function QrShowPanel({
  description,
  scanLabel,
  envelopes,
  expiresAt,
  onRefresh,
  children,
  ...heading
}: QrShowPanelProps) {
  const remainingMs = useRemainingMs(expiresAt, onRefresh)
  // The encoder carries the frame cycle, so it is rebuilt only for new envelopes. A refresh that
  // merely extends the expiry keeps the same envelopes, and with them the running animation.
  const encoder = useMemo(
    () => (envelopes ? createEnvelopesUREncoder(envelopes) : null),
    [envelopes]
  )

  return (
    <div className="flex flex-col items-center text-center">
      <QrPanelHeading {...heading} />
      <p className="mt-2 text-xs text-muted">{description}</p>
      <p className="mt-5 text-sm font-medium">{scanLabel}</p>

      {/* A white quiet zone around the code is what phone cameras need to read it. */}
      <div className="mt-3 rounded-2xl bg-white p-4">
        {envelopes && encoder ? (
          <EncoderAnimatedQR
            // New envelopes are a new code: remount so the frame cycle starts from its first
            // frame.
            key={envelopes.map(envelope => envelope.sequence).join('-')}
            encoder={encoder}
            size={QR_SIZE}
          />
        ) : (
          <div
            role="status"
            aria-label="Preparing code"
            className="flex items-center justify-center"
            style={{ width: QR_SIZE, height: QR_SIZE }}
          >
            <Icon
              icon="lucide:loader-2"
              width={32}
              height={32}
              className="animate-spin text-primary motion-reduce:animate-none"
            />
          </div>
        )}
      </div>

      {remainingMs !== null && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <span className="tabular-nums">Expires in {formatCountdown(remainingMs)}</span>
          <button
            type="button"
            aria-label="Refresh code"
            onClick={onRefresh}
            className="flex size-6 cursor-pointer items-center justify-center rounded-full bg-card text-foreground transition-colors hover:bg-accent"
          >
            <Icon icon="lucide:refresh-cw" width={12} height={12} aria-hidden="true" />
          </button>
        </div>
      )}

      {children}
    </div>
  )
}
