import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { scanMarked, type CreateSessionState } from '@/core/multisig/create-session'
import type { QrStep } from '@/core/multisig/qr-plan'
import type { DeviceSlot, MultisigDevice } from '@/core/multisig/types'
import { DeviceCard } from '@/popup/components/multisig/DeviceCard'
import { QrScanButton, QrScanPanel } from '@/popup/components/multisig/QrScanPanel'
import { QrShowPanel } from '@/popup/components/multisig/QrShowPanel'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { createdTeamRoute, createFlowRoute, qrStepRoute } from '@/popup/multisig/create-flow-routes'
import {
  currentQrStep,
  useCreateSessionStore,
  type PendingQrDisplay
} from '@/popup/multisig/create-session-store'
import { useNavigate } from '@/popup/provider/Router'
import { MultisigTabLayout } from './MultisigTabLayout'

type StepCounter = { current: number; total: number }
type ShowStep = Extract<QrStep, { kind: 'show' }>
type ScanStep = Extract<QrStep, { kind: 'scan' }>

interface ShowStepCopy {
  description: string
  scanLabel: string
}

const EVERY_PHONE_COPY: ShowStepCopy = {
  description: 'Every phone scans this code.',
  scanLabel: 'Scan your computer'
}

// Keyed by the plan's step titles (qr-plan.ts).
const SHOW_STEP_COPY: Readonly<Record<string, ShowStepCopy>> = {
  'Group roster': EVERY_PHONE_COPY,
  'Round 1 bundle': EVERY_PHONE_COPY,
  'Round 1 complete': EVERY_PHONE_COPY,
  Shares: {
    description: 'Only your phones can read this. Each phone scans it once.',
    scanLabel: 'Scan your computer'
  }
}
const FALLBACK_SHOW_COPY: ShowStepCopy = { description: '', scanLabel: 'Scan your computer' }

function guardianDevice(session: CreateSessionState, slot: DeviceSlot): MultisigDevice | null {
  return session.devices.find(entry => entry.slot === slot)?.device ?? null
}

function deviceTitle(device: MultisigDevice | null, slot: DeviceSlot): string {
  return device ? `${device.name} · ${device.model}` : `Device ${slot}`
}

/** "Step n of m" above the ring; the ceremony has no device line of its own. */
function StepLabel({ counter }: { counter: StepCounter }) {
  return (
    <p className="text-xs text-muted">
      Step {counter.current} of {counter.total}
    </p>
  )
}

/**
 * Holds the page while the next code is prepared or the session moves to another page; `message`
 * names a wait the user should know about.
 */
function QrStepLoading({ message }: { message?: string }) {
  return (
    <MultisigTabLayout step={3} title="Multisig" showBack={false}>
      <div
        role="status"
        aria-label={message ?? 'Loading'}
        className="flex min-h-full flex-col items-center justify-center gap-3"
      >
        <Icon
          icon="lucide:loader-2"
          width={32}
          height={32}
          className="animate-spin text-primary motion-reduce:animate-none"
        />
        {message && <p className="text-xs text-muted">{message}</p>}
      </div>
    </MultisigTabLayout>
  )
}

function ScannedMark() {
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-primary">
      <Icon icon="lucide:check" width={14} height={14} aria-hidden="true" />
      Scanned
    </span>
  )
}

interface QrStepViewProps<Step extends QrStep> {
  session: CreateSessionState
  step: Step
  counter: StepCounter
}

/** One row per phone in the step, marked once that phone is done with it. */
function StepDevices({
  session,
  slots,
  isDone
}: {
  session: CreateSessionState
  slots: readonly DeviceSlot[]
  isDone: (slot: DeviceSlot) => boolean
}) {
  return (
    <div className="mt-5 w-full space-y-3 text-left">
      {slots.map(slot => (
        <DeviceCard
          key={slot}
          slot={slot}
          role="guardian"
          title={deviceTitle(guardianDevice(session, slot), slot)}
          // The card's own status labels are about connections; here only the scan matters,
          // and an empty fragment (not null, which falls back to the label) shows nothing.
          status="connected"
          trailing={isDone(slot) ? <ScannedMark /> : <></>}
        />
      ))}
    </div>
  )
}

/** A code on screen for one or both phones; each phone is marked once it has scanned it. */
function QrShowStep({
  session,
  step,
  counter,
  display
}: QrStepViewProps<ShowStep> & { display: PendingQrDisplay | null }) {
  const markPhoneScanned = useCreateSessionStore(state => state.markPhoneScanned)
  const refreshDisplay = useCreateSessionStore(state => state.refreshDisplay)

  // The driver sets the code in the same dispatch that opens the step, so this is momentary.
  if (!display) return <QrStepLoading />

  const copy = SHOW_STEP_COPY[step.title] ?? FALLBACK_SHOW_COPY
  const pending = step.slots.filter(slot => !session.qrShownTo.includes(slot))
  // Every phone that still has to scan gets its own button; the reducer moves to the next step
  // once the last one is marked.
  const buttonLabel = (slot: DeviceSlot) =>
    step.slots.length === 1
      ? 'Phone scanned, continue'
      : `${guardianDevice(session, slot)?.model ?? `Device ${slot}`} scanned`

  return (
    <MultisigTabLayout
      step={3}
      title="Multisig"
      showBack={false}
      footer={
        pending.length > 0 ? (
          <div className="space-y-3">
            {/* One filled primary per screen: the next phone to scan gets it, the rest outline. */}
            {pending.map((slot, index) => (
              <FlowButton
                key={slot}
                variant={index === 0 ? 'default' : 'outline'}
                onClick={() => markPhoneScanned(slot)}
              >
                {buttonLabel(slot)}
              </FlowButton>
            ))}
          </div>
        ) : undefined
      }
    >
      <QrShowPanel
        counter={counter}
        ringLabel={<StepLabel counter={counter} />}
        title={step.title}
        description={copy.description}
        scanLabel={copy.scanLabel}
        envelopes={display.envelopes}
        expiresAt={display.expiresAt}
        onRefresh={refreshDisplay}
      >
        <StepDevices
          session={session}
          slots={step.slots}
          isDone={slot => session.qrShownTo.includes(slot)}
        />
      </QrShowPanel>
    </MultisigTabLayout>
  )
}

/**
 * Reads every phone's code for this step, in any order. The reducer moves on once it has them
 * all.
 */
function QrScanStep({ session, step, counter }: QrStepViewProps<ScanStep>) {
  const ingestScan = useCreateSessionStore(state => state.ingestScan)
  const [scanning, setScanning] = useState(false)
  const isReceived = (slot: DeviceSlot) => {
    const entry = session.devices.find(device => device.slot === slot)
    return entry !== undefined && scanMarked(entry, step.messageType)
  }
  const receivedCount = step.slots.filter(isReceived).length

  return (
    <MultisigTabLayout
      step={3}
      title="Multisig"
      showBack={false}
      footer={scanning ? undefined : <QrScanButton onClick={() => setScanning(true)} />}
    >
      <QrScanPanel
        // The scanner stops after each code, so a fresh one opens for the next phone.
        key={receivedCount}
        counter={counter}
        ringLabel={<StepLabel counter={counter} />}
        title={step.title}
        description="Scan each phone's code."
        scanning={scanning}
        onScan={ingestScan}
      />
      <StepDevices session={session} slots={step.slots} isDone={isReceived} />
    </MultisigTabLayout>
  )
}

/**
 * Step 3 over QR: `/multisig/create/qr/:index`, one code to show or scan per step. There is no
 * back arrow: the roster is locked, and leaving means aborting the session.
 */
export function QrStepPage() {
  const { index } = useParams()
  const { replace } = useNavigate()
  const session = useCreateSessionStore(state => state.session)
  const scope = useCreateSessionStore(state => state.scope)
  const pendingDisplay = useCreateSessionStore(state => state.pendingDisplay)
  const pendingScan = useCreateSessionStore(state => state.pendingScan)
  // currentQrStep builds a new object on every call, so it is computed here from the three
  // fields instead of being handed to the store as a selector.
  const current = useMemo(
    () => currentQrStep({ session, pendingDisplay, pendingScan }),
    [session, pendingDisplay, pendingScan]
  )

  // The session decides the step: a finished step moves the URL to the next index, the round-1
  // check and the final check go to the verify page, and a Bluetooth session to its ceremony.
  const activated = session?.phase === 'ACTIVATED'
  const commitStatus = useCreateSessionStore(state => state.commitStatus)
  const target = session && !activated ? createFlowRoute(session) : null
  const here = qrStepRoute(index ?? '')
  useEffect(() => {
    if (activated) {
      // The last phone's final confirmation activates the group on this page. The store has
      // saved the group already, so the team page can show it at once. Without a scope there is
      // no account to show it for.
      if (scope) replace(createdTeamRoute(scope))
      else window.close()
      return
    }
    if (target !== null && target !== here) replace(target)
  }, [activated, scope, target, here, replace])

  // The route guard already redirects when the session is missing or aborted.
  if (!session) return null
  if (commitStatus === 'saving' || commitStatus === 'failed') return <CreationCommitFeedback />

  // Round 2 is done and the share is being written; the next code waits for the save.
  if (session.phase === 'FINALIZED') return <QrStepLoading message="Saving your share…" />

  // Rendered from the session even before the URL has caught up, so the next step's content
  // replaces the finished one directly.
  const onQrStep = target !== null && target === qrStepRoute(session.qrCeremonyIndex)
  if (!onQrStep || !current || current.step.kind === 'verify') return <QrStepLoading />

  // Keyed by the step, so each code or scan starts with fresh page state (and the camera closed).
  return current.step.kind === 'show' ? (
    <QrShowStep
      key={session.qrCeremonyIndex}
      session={session}
      step={current.step}
      counter={current.counter}
      display={pendingDisplay}
    />
  ) : (
    <QrScanStep
      key={session.qrCeremonyIndex}
      session={session}
      step={current.step}
      counter={current.counter}
    />
  )
}
import { CreationCommitFeedback } from './CreationCommitFeedback'
