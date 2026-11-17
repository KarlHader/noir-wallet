import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  guardianSlots,
  type CreateSessionState,
  type DeviceSessionState
} from '@/core/multisig/create-session'
import { identityFingerprint } from '@/core/multisig/identity'
import { qrStepCounter } from '@/core/multisig/qr-plan'
import { base64ToBytes } from '@/lib/bytes'
import { FingerprintBlock } from '@/popup/components/multisig/FingerprintBlock'
import { Pill } from '@/popup/components/multisig/Pill'
import { QrPanelHeading } from '@/popup/components/multisig/QrPanelHeading'
import { QrScanButton, QrScanPanel } from '@/popup/components/multisig/QrScanPanel'
import { QrShowPanel } from '@/popup/components/multisig/QrShowPanel'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { Button } from '@/popup/components/ui/button'
import { useDialog } from '@/popup/hooks/useDialog'
import {
  currentQrStep,
  useCreateSessionStore,
  type PendingQrDisplay
} from '@/popup/multisig/create-session-store'
import { useNavigate } from '@/popup/provider/Router'
import { toast } from '@/store/toast-store'
import { MultisigTabLayout } from './MultisigTabLayout'

type PairSlot = 2 | 3
type PairStep = 1 | 2 | 3

const CREATE_ROUTE = '/multisig/create'
const CONNECT_ROUTE = `${CREATE_ROUTE}/connect`
// Long enough to read "Checking device and setup…" before the page moves on.
const VERIFY_HOLD_MS = 800

function pairRoute(slot: PairSlot, step: PairStep): string {
  return `${CREATE_ROUTE}/pair/${slot}/${step}`
}

function parsePairSlot(value: string | undefined): PairSlot | null {
  if (value === '2') return 2
  if (value === '3') return 3
  return null
}

function parsePairStep(value: string | undefined): PairStep | null {
  if (value === '1') return 1
  if (value === '2') return 2
  if (value === '3') return 3
  return null
}

/**
 * The ring's "n of m". The store's current QR step is the source when it has one; otherwise the
 * page's own step maps to the same pairing counter.
 */
function usePairCounter(session: CreateSessionState, step: PairStep) {
  const pendingDisplay = useCreateSessionStore(state => state.pendingDisplay)
  const pendingScan = useCreateSessionStore(state => state.pendingScan)
  // currentQrStep builds a new object on every call, so it is computed here from the three
  // fields instead of being handed to the store as a selector.
  return useMemo(
    () =>
      currentQrStep({ session, pendingDisplay, pendingScan })?.counter ??
      qrStepCounter(session.threshold, 'pairing', step - 1),
    [session, pendingDisplay, pendingScan, step]
  )
}

/**
 * Back arrow for every step: drop this phone's pairing and return to the device list.
 * `leaving` is raised before the cancel is dispatched. The cancel empties the guardian, and the
 * reply step answers an empty guardian by going back to the invite; without the flag that second
 * navigation would land after this one and win.
 */
function usePairBack(slot: PairSlot) {
  const dispatch = useCreateSessionStore(state => state.dispatch)
  const { navigate } = useNavigate()
  const leaving = useRef(false)

  const handleBack = () => {
    leaving.current = true
    dispatch({ type: 'PAIR_CANCEL', slot })
    navigate(CONNECT_ROUTE)
  }

  return { leaving, handleBack }
}

/** The phone being paired, shown under the progress ring. */
function PairDeviceLine({ slot }: { slot: PairSlot }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span>Device {slot}</span>
      <Pill tone="warning">Guardians</Pill>
    </div>
  )
}

interface PairStepProps {
  session: CreateSessionState
  slot: PairSlot
  guardian: DeviceSessionState
}

/** Step 1 of a QR pairing: show the invite code for the phone to scan. */
function QrPairInvite({ session, slot, guardian }: PairStepProps) {
  const { navigate } = useNavigate()
  const dispatch = useCreateSessionStore(state => state.dispatch)
  const markPhoneScanned = useCreateSessionStore(state => state.markPhoneScanned)
  const refreshDisplay = useCreateSessionStore(state => state.refreshDisplay)
  const pendingDisplay = useCreateSessionStore(state => state.pendingDisplay)
  const pendingScan = useCreateSessionStore(state => state.pendingScan)
  const { handleBack } = usePairBack(slot)
  const counter = usePairCounter(session, 1)
  const { connection } = guardian

  // The store can hold another phone's code while this one is open; only this phone's counts.
  const display =
    pendingDisplay !== null && pendingDisplay.slots.includes(slot) ? pendingDisplay : null
  // Marking the phone as scanned, or cancelling, clears the store's display a render before the
  // navigation lands. The last code stays up for that moment instead of flashing the spinner.
  const [lastDisplay, setLastDisplay] = useState<PendingQrDisplay | null>(null)
  useEffect(() => {
    if (display) setLastDisplay(display)
  }, [display])
  const shown = display ?? lastDisplay
  // True once the phone has been marked as scanned, whether from the button or the dev panel.
  const phoneScanned = connection === 'invite_shown' && pendingScan?.slots.includes(slot) === true

  // Starts the invite at most once per mount. StrictMode runs effects twice, and a cancelled
  // pairing (guardian empty again, page on its way out) must not start a new one.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (connection === 'empty') dispatch({ type: 'PAIR_START', slot })
  }, [slot, connection, dispatch])

  const advanced = useRef(false)
  const goToReply = useCallback(() => {
    if (advanced.current) return
    advanced.current = true
    navigate(pairRoute(slot, 2))
  }, [navigate, slot])

  // The dev panel can mark the phone as scanned without this page's button; follow it.
  useEffect(() => {
    if (phoneScanned) goToReply()
  }, [phoneScanned, goToReply])

  const handlePhoneScanned = () => {
    markPhoneScanned(slot)
    goToReply()
  }

  return (
    <MultisigTabLayout
      step={2}
      title={`Device ${slot} Connection`}
      onBack={handleBack}
      footer={
        <FlowButton disabled={!display} onClick={handlePhoneScanned}>
          Phone scanned, continue
        </FlowButton>
      }
    >
      <QrShowPanel
        counter={counter}
        ringCaption={<PairDeviceLine slot={slot} />}
        title="Invite"
        description="Show this code to your phone. It carries your invite and this computer's identity."
        scanLabel="Scan your computer"
        envelopes={shown?.envelopes ?? null}
        expiresAt={shown?.expiresAt ?? null}
        onRefresh={refreshDisplay}
      />
    </MultisigTabLayout>
  )
}

/** Step 2 of a QR pairing: scan the phone's reply code. */
function QrPairReply({ session, slot, guardian }: PairStepProps) {
  const { navigate, replace } = useNavigate()
  const ingestScan = useCreateSessionStore(state => state.ingestScan)
  const { leaving, handleBack } = usePairBack(slot)
  const counter = usePairCounter(session, 2)
  const [scanning, setScanning] = useState(false)
  const { connection } = guardian
  // The identity check (and anything past it) means the reply was accepted.
  const replied = connection === 'identity_check' || connection === 'connected'

  // A reply with no invite behind it (the guardian is empty) has nothing to scan.
  useEffect(() => {
    if (connection === 'empty' && !leaving.current) replace(pairRoute(slot, 1))
  }, [connection, slot, replace, leaving])

  // The reducer moves the guardian to the identity check as soon as it accepts the reply, from
  // the camera or from the dev panel alike. The short hold lets the checking line register
  // before the page moves on.
  useEffect(() => {
    if (!replied) return
    const timer = window.setTimeout(() => navigate(pairRoute(slot, 3)), VERIFY_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [replied, navigate, slot])

  // Once the reply is accepted there is nothing left to start, and the camera must not open just
  // to be torn down again (a dev-panel scan answers without the scanner).
  const showFooter = !scanning && !replied

  return (
    <MultisigTabLayout
      step={2}
      title={`Device ${slot} Connection`}
      onBack={handleBack}
      footer={showFooter ? <QrScanButton onClick={() => setScanning(true)} /> : undefined}
    >
      <QrScanPanel
        counter={counter}
        ringCaption={<PairDeviceLine slot={slot} />}
        title="Reply"
        description="Your phone will show its reply next."
        scanning={scanning}
        accepted={replied}
        onScan={ingestScan}
      />
    </MultisigTabLayout>
  )
}

/** A device fingerprint under its small uppercase heading. */
function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <FingerprintBlock value={value} />
    </div>
  )
}

/** Step 3 of a QR pairing: match both devices' identities by eye before the phone joins. */
function QrPairIdentity({ session, slot, guardian }: PairStepProps) {
  const { navigate, replace } = useNavigate()
  const { confirm } = useDialog()
  const dispatch = useCreateSessionStore(state => state.dispatch)
  const confirmIdentity = useCreateSessionStore(state => state.confirmIdentity)
  const { leaving, handleBack } = usePairBack(slot)
  const counter = usePairCounter(session, 3)
  const { connection, device, identityPublicKey } = guardian
  // Raised before this page's own actions change the guardian, so the redirects below do not
  // race the navigation (or the route guard) those actions lead to.
  const settled = useRef(false)

  // Opened for a phone that is not at this step: one already confirmed goes back to the list,
  // one without a reply yet goes back to its invite.
  useEffect(() => {
    if (leaving.current || settled.current) return
    if (connection === 'connected') replace(CONNECT_ROUTE)
    else if (connection === 'empty' || connection === 'invite_shown') replace(pairRoute(slot, 1))
  }, [connection, slot, replace, leaving])

  const fingerprints = useMemo(
    () =>
      session.ownerIdentityPublicKey && identityPublicKey
        ? {
            owner: identityFingerprint(base64ToBytes(session.ownerIdentityPublicKey)),
            phone: identityFingerprint(base64ToBytes(identityPublicKey))
          }
        : null,
    [session.ownerIdentityPublicKey, identityPublicKey]
  )

  const handleMatches = () => {
    settled.current = true
    confirmIdentity(slot)
    toast.success('Device verified')
    navigate(CONNECT_ROUTE)
  }

  const handleReject = async () => {
    const confirmed = await confirm({
      title: 'Identities differ?',
      message: 'Setup will be cancelled and must start over.',
      confirmText: 'Cancel setup',
      variant: 'danger'
    })
    if (!confirmed) return
    settled.current = true
    // The route guard sends the aborted session to the failed page.
    dispatch({ type: 'IDENTITY_REJECTED', slot })
  }

  if (connection !== 'identity_check' || !device || !fingerprints) return null

  return (
    <MultisigTabLayout
      step={2}
      title={`Device ${slot} Connection`}
      onBack={handleBack}
      footer={
        <div className="space-y-2">
          <FlowButton onClick={handleMatches}>Matches</FlowButton>
          <Button variant="link" className="w-full" onClick={() => void handleReject()}>
            Doesn&apos;t match
          </Button>
        </div>
      }
    >
      <div className="flex flex-col items-center text-center">
        <QrPanelHeading
          counter={counter}
          ringCaption={<PairDeviceLine slot={slot} />}
          title="Confirm device identity"
        />
        <p className="mt-2 text-xs text-muted">
          Compare both rows with the phone&apos;s screen, then confirm on both devices.
        </p>
      </div>
      <div className="mt-5 space-y-4">
        <IdentityRow label="This computer" value={fingerprints.owner} />
        <IdentityRow label={`${device.name} · ${device.model}`} value={fingerprints.phone} />
      </div>
    </MultisigTabLayout>
  )
}

/** Pairing pages for one guardian phone over QR: `/multisig/create/pair/:slot/:step`. */
export function QrPairPage() {
  const params = useParams()
  const { replace } = useNavigate()
  const session = useCreateSessionStore(state => state.session)

  const slot = parsePairSlot(params.slot)
  const step = parsePairStep(params.step)
  const guardian =
    session !== null &&
    session.transportKind === 'qr' &&
    slot !== null &&
    guardianSlots(session).includes(slot)
      ? session.devices.find(entry => entry.slot === slot)
      : undefined

  // The route guard owns a missing session; everything else that cannot be shown (bad
  // parameters, a slot this group does not have, a Bluetooth session) goes back to the list.
  const invalid = session !== null && (step === null || guardian === undefined)
  useEffect(() => {
    if (invalid) replace(CONNECT_ROUTE)
  }, [invalid, replace])

  if (!session || slot === null || step === null || !guardian) return null

  // Keyed by slot so a different phone always starts a fresh page (and a fresh invite).
  if (step === 1) {
    return <QrPairInvite key={slot} session={session} slot={slot} guardian={guardian} />
  }
  if (step === 2) {
    return <QrPairReply key={slot} session={session} slot={slot} guardian={guardian} />
  }
  return <QrPairIdentity key={slot} session={session} slot={slot} guardian={guardian} />
}
