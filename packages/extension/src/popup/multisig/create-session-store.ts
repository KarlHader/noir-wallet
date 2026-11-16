import type { UR } from '@ngraveio/bc-ur'
import { create } from 'zustand'
import {
  createInitialSession,
  reduceCreateSession,
  type CreateSessionEffect,
  type CreateSessionEvent,
  type CreateSessionState,
  type DeviceSessionState
} from '@/core/multisig/create-session'
import type { SessionDriver } from '@/core/multisig/driver'
import type { MultisigEnvelope, MultisigMessageType } from '@/core/multisig/messages'
import {
  buildQrCeremonySteps,
  buildQrPairingSteps,
  qrStepCounter,
  type QrStep
} from '@/core/multisig/qr-plan'
import {
  QR_DISPLAY_TTL_MS,
  type DeviceSlot,
  type MultisigGroupRecord,
  type MultisigThreshold,
  type MultisigTransportKind,
  type SessionPhase
} from '@/core/multisig/types'
import { createLazyDkgPort, type DkgPort } from '@/core/multisig/dkg-port'
import type { VaultWasm } from '@/core/multisig/dkg-protocol'
import { chooseBluetoothDevice, type BluetoothSelection } from '@/lib/multisig-bluetooth'
import { writeMultisigGroup, type MultisigGroupScope } from '@/lib/multisig-group-storage'
import { decodeEnvelopeUR } from '@/lib/multisig-ur'
import { toast } from '@/store/toast-store'
import { useMultisigGroupStore } from './group-store'
import { createMockBleDriver, type ChooserRejection } from './mock/mock-ble-driver'
import { createMockQrDriver, type MockQrDriver } from './mock/mock-qr-driver'
import { MOCK_BLUETOOTH_QUERY, readMockSettings } from './mock/mock-settings'
import { loadMockVaultWasm } from './mock/mock-vault-wasm'

/** The two things a Bluetooth ceremony computes on: the Worker's DKG side and the phones' WASM. */
export interface CreateSessionDependencies {
  dkgPort: DkgPort
  loadPhoneVault: () => Promise<VaultWasm>
}

// The Worker client is imported on first use only, so Node tests that inject a port never load it.
const defaultDependencies: CreateSessionDependencies = {
  dkgPort: createLazyDkgPort(() =>
    import('@/core/multisig/worker-dkg-port').then(module => module.createWorkerDkgPort())
  ),
  loadPhoneVault: loadMockVaultWasm
}

let dependencies: CreateSessionDependencies = defaultDependencies

/** Swaps dependencies for tests; returns a function that restores the previous ones. */
export function setCreateSessionDependencies(
  overrides: Partial<CreateSessionDependencies>
): () => void {
  const previous = dependencies
  dependencies = { ...previous, ...overrides }
  return () => {
    dependencies = previous
  }
}

type DkgEffect = Extract<
  CreateSessionEffect,
  { type: 'dkgOpen' | 'dkgAcceptRound1' | 'dkgAcceptRound2' | 'dkgClose' | 'saveVaultRecord' }
>

function isDkgEffect(effect: CreateSessionEffect): effect is DkgEffect {
  return (
    effect.type === 'dkgOpen' ||
    effect.type === 'dkgAcceptRound1' ||
    effect.type === 'dkgAcceptRound2' ||
    effect.type === 'dkgClose' ||
    effect.type === 'saveVaultRecord'
  )
}

/** QR: the code on screen and the phones that should scan it. */
export interface PendingQrDisplay {
  slots: readonly DeviceSlot[]
  messageType: MultisigMessageType
  envelope: MultisigEnvelope
  expiresAt: number
}

/** QR: the phone reply the camera is waiting for. */
export interface PendingQrScan {
  slot: DeviceSlot
  messageType: MultisigMessageType
}

/** Bluetooth: the open simulated chooser. The browser's own never shows up here. */
export interface PendingChooser {
  slot: 2 | 3
  resolve: (selection: BluetoothSelection) => void
}

export interface CreateSessionStore {
  scope: MultisigGroupScope | null
  session: CreateSessionState | null
  pendingDisplay: PendingQrDisplay | null
  pendingScan: PendingQrScan | null
  chooser: PendingChooser | null
  /** Starts a new session and its driver, replacing any earlier one. */
  start(
    scope: MultisigGroupScope,
    threshold: MultisigThreshold,
    transportKind: MultisigTransportKind,
    ownerName: string
  ): void
  dispatch(event: CreateSessionEvent): void
  switchTransport(kind: MultisigTransportKind): void
  resolveChooser(selection: BluetoothSelection): void
  /** QR: the user reports that this phone has scanned the code on screen. */
  markPhoneScanned(slot: DeviceSlot): void
  /** QR: a UR read by the camera; 'accepted' when it moved the session on. */
  ingestScan(ur: UR): 'accepted' | 'ignored'
  /** QR dev panel: the awaited phone shows its reply and the camera reads it at once. */
  simulateScan(): void
  /** QR: restarts the on-screen code's expiry. */
  refreshDisplay(): void
  reset(): void
}

export interface CurrentQrStep {
  step: QrStep
  counter: { current: number; total: number }
}

type Dispatch = (event: CreateSessionEvent) => void

const OWNER_MODEL = 'MacBook'
const QR_CEREMONY_PHASES: readonly SessionPhase[] = ['DKG_R1', 'R1_VERIFIED', 'DKG_R2', 'FINALIZED']
const CHOOSER_CLOSED: BluetoothSelection = { status: 'cancelled' }

function reportChooserRejection(reason: ChooserRejection): void {
  if (reason === 'duplicate') toast.error('Device already added', 'Choose a different device.')
  else toast.error('Bluetooth unavailable', 'Check your Bluetooth settings or use QR code.')
}

function guardian(session: CreateSessionState, slot: DeviceSlot): DeviceSessionState | null {
  if (slot === 1) return null
  return session.devices.find(device => device.slot === slot) ?? null
}

function invitedSlots(session: CreateSessionState): DeviceSlot[] {
  return session.devices
    .filter(device => device.slot !== 1 && device.connection === 'invite_shown')
    .map(device => device.slot)
}

// Bounds-checked here so neither the pages nor qrStepCounter ever see a past-the-end index.
function qrCeremonyStep(session: CreateSessionState): { index: number; step: QrStep } | null {
  if (session.transportKind !== 'qr' || !QR_CEREMONY_PHASES.includes(session.phase)) return null
  const steps = buildQrCeremonySteps(session.threshold)
  const index = session.qrCeremonyIndex
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) return null
  return { index, step: steps[index] }
}

// The codes the session can show or scan right now. Anything pending outside this set belongs to
// a step that is over (a cancelled invite, a finished show step, a terminal phase).
function liveQrSteps(session: CreateSessionState): readonly QrStep[] {
  if (session.transportKind !== 'qr') return []
  if (session.phase === 'PAIRING') return invitedSlots(session).flatMap(buildQrPairingSteps)
  const current = qrCeremonyStep(session)
  return current ? [current.step] : []
}

function sameSlots(a: readonly DeviceSlot[], b: readonly DeviceSlot[]): boolean {
  return a.length === b.length && a.every((slot, index) => slot === b[index])
}

function liveDisplay(
  steps: readonly QrStep[],
  display: PendingQrDisplay | null
): PendingQrDisplay | null {
  if (!display) return null
  const live = steps.some(
    step =>
      step.kind === 'show' &&
      step.messageType === display.messageType &&
      sameSlots(step.slots, display.slots)
  )
  return live ? display : null
}

function liveScan(steps: readonly QrStep[], scan: PendingQrScan | null): PendingQrScan | null {
  if (!scan) return null
  const live = steps.some(
    step =>
      step.kind === 'scan' && step.messageType === scan.messageType && step.slots[0] === scan.slot
  )
  return live ? scan : null
}

/**
 * The QR step the pages should show, with its "n of m" counter. Null whenever no code is in play:
 * Bluetooth, between pairings, KEYSET_VERIFIED and the terminal phases.
 */
export function currentQrStep(
  snapshot: Pick<CreateSessionStore, 'session' | 'pendingDisplay' | 'pendingScan'>
): CurrentQrStep | null {
  const { session, pendingDisplay, pendingScan } = snapshot
  if (!session || session.transportKind !== 'qr') return null

  if (session.phase === 'PAIRING') {
    const invited = invitedSlots(session)
    // Several invites can be open at once; the one the store is working on wins.
    const slot =
      [pendingScan?.slot, pendingDisplay?.slots[0]].find(
        (candidate): candidate is DeviceSlot =>
          candidate !== undefined && invited.includes(candidate)
      ) ?? invited[0]
    if (slot === undefined) return null
    const index = pendingScan?.slot === slot ? 1 : 0
    return {
      step: buildQrPairingSteps(slot)[index],
      counter: qrStepCounter(session.threshold, 'pairing', index)
    }
  }

  const current = qrCeremonyStep(session)
  if (!current) return null
  return {
    step: current.step,
    counter: qrStepCounter(session.threshold, 'ceremony', current.index)
  }
}

const IDLE = {
  scope: null,
  session: null,
  pendingDisplay: null,
  pendingScan: null,
  chooser: null
} as const

export const useCreateSessionStore = create<CreateSessionStore>()((set, get) => {
  let driver: SessionDriver | null = null
  let qrDriver: MockQrDriver | null = null
  // Handed to the driver as its dispatch. Drivers report asynchronously (phone replies, timers,
  // chooser answers), so each one gets a dispatch tied to its generation; once the driver is
  // replaced or dropped, anything it still reports is discarded instead of reaching a newer
  // session.
  let driverDispatch: Dispatch = () => {}
  let generation = 0
  let ownerName = ''

  // Effects must run synchronously and in order, but a driver may dispatch from inside execute
  // (issueCode reports PAIR_CODE_ISSUED at once). Running that nested event straight away would
  // reduce it before the rest of the outer batch's effects. So events go through one queue, and
  // only the outermost dispatch drains it; a nested dispatch only enqueues.
  const queue: CreateSessionEvent[] = []
  let draining = false

  function dispatch(event: CreateSessionEvent): void {
    queue.push(event)
    if (draining) return
    draining = true
    try {
      for (let next = queue.shift(); next; next = queue.shift()) apply(next)
    } finally {
      draining = false
      // Only non-empty after a throw: those events were meant for a state that never settled.
      queue.length = 0
    }
  }

  function apply(event: CreateSessionEvent): void {
    const before = get()
    const session = before.session
    if (!session) return
    const { state, effects } = reduceCreateSession(session, event)
    if (state !== session) {
      const steps = liveQrSteps(state)
      set({
        session: state,
        pendingDisplay: liveDisplay(steps, before.pendingDisplay),
        pendingScan: liveScan(steps, before.pendingScan)
      })
      const chooser = get().chooser
      // A pairing cancelled while its chooser is open takes the chooser down with it.
      if (chooser && guardian(state, chooser.slot)?.connection !== 'choosing') closeChooser()
    }
    for (const effect of effects) {
      if (effect.type === 'persistGroup') persistGroup(effect.record)
      else if (isDkgEffect(effect)) runDkgEffect(effect, driverDispatch)
      else driver?.execute(effect, driverDispatch)
    }
    // Both outcomes are final, so the transport goes once the last effects (the DKG_ACTIVATE
    // sends, the persist) are out. The session stays so the result pages can read it, including
    // abortReason.
    const ended = state.phase === 'ABORTED' || state.phase === 'ACTIVATED'
    if (ended && state !== session) dropDriver()
  }

  function persistGroup(record: MultisigGroupRecord): void {
    const { scope } = get()
    if (!scope) return
    // The reducer never reads the clock, so the activation time is stamped here.
    const stamped: MultisigGroupRecord = { ...record, createdAt: Date.now() }
    // Not awaited: the dispatch loop stays synchronous. The cache is updated right away so the
    // team page, which this tab opens next, shows the group without waiting for storage.
    writeMultisigGroup(scope, stamped).catch(error => {
      console.error('Failed to save the multisig group', error)
    })
    useMultisigGroupStore.getState().setGroup(scope, stamped)
  }

  function closeChooser(): void {
    const { chooser } = get()
    if (!chooser) return
    set({ chooser: null })
    chooser.resolve(CHOOSER_CLOSED)
  }

  function openChooser(slot: DeviceSlot, isCurrent: () => boolean): Promise<BluetoothSelection> {
    if (slot === 1 || !isCurrent()) return Promise.resolve(CHOOSER_CLOSED)
    if (readMockSettings().chooser === 'native') return chooseBluetoothDevice(MOCK_BLUETOOTH_QUERY)
    return new Promise(resolve => set({ chooser: { slot, resolve } }))
  }

  // Runs the effects of an abort the store never publishes on the driver the session ran on.
  // The store still holds the session from before the abort, so anything the driver reports
  // back is discarded rather than reduced against it.
  function runOnCurrentDriver(effects: readonly CreateSessionEffect[]): void {
    const discard: Dispatch = () => {}
    for (const effect of effects) {
      // Both write for a session that is being thrown away.
      if (effect.type === 'persistGroup' || effect.type === 'saveVaultRecord') continue
      if (isDkgEffect(effect)) runDkgEffect(effect, discard)
      else driver?.execute(effect, discard)
    }
  }

  // The Worker's side of the ceremony. `report` is generation-bound, so an answer to a session
  // that has since been replaced or ended is dropped rather than reduced. Nothing here is logged:
  // the requests and answers carry the ceremony's envelopes.
  function runDkgEffect(effect: DkgEffect, report: Dispatch): void {
    const port = dependencies.dkgPort
    const failed = () => report({ type: 'DKG_FAILED' })
    switch (effect.type) {
      case 'dkgOpen': {
        // The share is sealed under the scope's wallet; without a scope there is no wallet to name.
        const { scope } = get()
        if (!scope) {
          failed()
          break
        }
        port
          .open({
            participants: effect.participants,
            threshold: effect.threshold,
            mainnet: effect.mainnet,
            scope,
            groupId: effect.groupId
          })
          .then(({ sessionId }) => {
            report({ type: 'DKG_OPENED', sessionId })
            // Not adopted (the session ended, was replaced, or already had an id): the Worker
            // must not keep a ceremony nobody is running.
            if (get().session?.dkgSessionId !== sessionId) {
              void port.close({ sessionId }).catch(() => {})
            }
          }, failed)
        break
      }
      case 'dkgAcceptRound1':
        port
          .acceptRound1(effect.request)
          .then(
            result => report({ type: 'DKG_ROUND1_ACCEPTED', slot: effect.slot, result }),
            failed
          )
        break
      case 'dkgAcceptRound2':
        port
          .acceptRound2(effect.request)
          .then(
            result => report({ type: 'DKG_ROUND2_ACCEPTED', slot: effect.slot, result }),
            failed
          )
        break
      case 'dkgClose':
        void port.close({ sessionId: effect.sessionId }).catch(() => {})
        break
      case 'saveVaultRecord': {
        const saveFailed = () => report({ type: 'VAULT_RECORD_SAVE_FAILED' })
        // Background files the record under the scope's account; with no scope there is none.
        const { scope } = get()
        if (!scope) {
          saveFailed()
          break
        }
        port
          .save({ scope, groupId: effect.groupId, record: effect.record })
          .then(() => report({ type: 'VAULT_RECORD_SAVED' }), saveFailed)
        break
      }
    }
  }

  function dropDriver(): void {
    generation += 1
    driver?.dispose()
    driver = null
    qrDriver = null
    driverDispatch = () => {}
    // Anything still queued was meant for the transport being dropped.
    queue.length = 0
    // After dispose, so the driver discards the cancellation instead of reporting it.
    closeChooser()
  }

  function attachDriver(session: CreateSessionState): void {
    const owned = generation
    const isCurrent = () => owned === generation
    const ids = { groupId: session.groupId, sessionId: session.sessionId }
    driverDispatch = event => {
      if (isCurrent()) dispatch(event)
    }
    if (session.transportKind === 'ble') {
      driver = createMockBleDriver({
        session: ids,
        onChooser: slot => openChooser(slot, isCurrent),
        onChooserRejected: reportChooserRejection,
        loadVault: dependencies.loadPhoneVault
      })
      return
    }
    qrDriver = createMockQrDriver({
      session: ids,
      onDisplay: ({ slots, messageType, envelope }) => {
        if (!isCurrent()) return
        const expiresAt = Date.now() + QR_DISPLAY_TTL_MS
        set({ pendingDisplay: { slots, messageType, envelope, expiresAt }, pendingScan: null })
      },
      onAwaitScan: ({ slot, messageType }) => {
        if (!isCurrent()) return
        set({ pendingScan: { slot, messageType }, pendingDisplay: null })
      }
    })
    driver = qrDriver
  }

  // Shared by camera and simulated scans: the QR driver dispatches MESSAGE_RECEIVED itself (and
  // stops the scan's watchdog), so success shows up as a new session object.
  function settleScan(before: CreateSessionState, scan: PendingQrScan): 'accepted' | 'ignored' {
    if (get().session === before) return 'ignored'
    // The scan may have opened the next scan step already; only the answered scan is cleared.
    if (get().pendingScan === scan) set({ pendingScan: null })
    return 'accepted'
  }

  return {
    ...IDLE,

    start: (scope, threshold, transportKind, name) => {
      dropDriver()
      ownerName = name
      const session = createInitialSession({
        groupId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        threshold,
        transportKind,
        owner: { slot: 1, role: 'owner', name, model: OWNER_MODEL, platform: 'extension' },
        mainnet: scope.network === 'mainnet'
      })
      attachDriver(session)
      set({ ...IDLE, scope, session })
    },

    dispatch,

    switchTransport: kind => {
      const { scope, session } = get()
      if (!scope || !session) return
      const { state, effects } = reduceCreateSession(session, { type: 'SWITCH_TRANSPORT', kind })
      if (state.phase === 'ABORTED' && state.abortReason === 'transport_switched') {
        // A pairing already under way cannot move to the other transport, so the reducer voids
        // the session. Changing transport is a choice, not a failure, so instead of showing that
        // abort the store starts over on the new transport in a single update. The abort's
        // effects still go out first, on the old transport, so its phones learn the setup ended.
        runOnCurrentDriver(effects)
        get().start(scope, session.threshold, kind, ownerName)
        return
      }
      if (state.transportKind === session.transportKind) return
      // Nothing paired yet: the same session simply continues on the other transport.
      dropDriver()
      attachDriver(state)
      set({ session: state, pendingDisplay: null, pendingScan: null })
    },

    resolveChooser: selection => {
      const { chooser } = get()
      if (!chooser) return
      set({ chooser: null })
      chooser.resolve(selection)
    },

    markPhoneScanned: slot => {
      const { session, pendingScan } = get()
      if (!session || !qrDriver) return
      // A second tap must not re-arm the reply scan or count the phone twice.
      if (session.phase === 'PAIRING') {
        const waitingForReply = pendingScan !== null && pendingScan.slot === slot
        if (guardian(session, slot)?.connection === 'invite_shown' && waitingForReply) return
      } else {
        const step = qrCeremonyStep(session)?.step
        if (step?.kind === 'show' && session.qrShownTo.includes(slot)) return
      }
      qrDriver.phoneScanned(slot)
      dispatch({ type: 'QR_PHONE_SCANNED', slot })
    },

    ingestScan: ur => {
      const { session, pendingScan } = get()
      if (!session || !pendingScan || !qrDriver) return 'ignored'
      // Camera input is untrusted: anything that is not an envelope stops here.
      const envelope = decodeEnvelopeUR(ur)
      if (!envelope) return 'ignored'
      qrDriver.deliverScan(pendingScan.slot, envelope)
      return settleScan(session, pendingScan)
    },

    simulateScan: () => {
      const { session, pendingScan } = get()
      if (!session || !pendingScan || !qrDriver) return
      qrDriver.simulateScan(pendingScan.slot)
      settleScan(session, pendingScan)
    },

    refreshDisplay: () => {
      const { pendingDisplay } = get()
      if (!pendingDisplay) return
      set({ pendingDisplay: { ...pendingDisplay, expiresAt: Date.now() + QR_DISPLAY_TTL_MS } })
    },

    reset: () => {
      // Leaving a setup that is still running (the connect page's back arrow, a fresh threshold
      // page) ends it for the phones too; a finished session yields no effects. The abort is not
      // published because the store goes idle right after.
      const { session } = get()
      if (session) runOnCurrentDriver(reduceCreateSession(session, { type: 'USER_ABORT' }).effects)
      dropDriver()
      ownerName = ''
      set(IDLE)
    }
  }
})
