import type { UR } from '@ngraveio/bc-ur'
import { create } from 'zustand'
import {
  createInitialSession,
  guardianSlots,
  reduceCreateSession
} from '@/core/multisig/create-session'
import type {
  CreateSessionEffect,
  CreateSessionEvent,
  CreateSessionState,
  DeviceSessionState
} from '@/core/multisig/create-session'
import { multisigDebug } from '@/core/multisig/debug-log'
import type { SessionDriver } from '@/core/multisig/driver'
import type { DeviceIdentity } from '@/core/multisig/identity'
import { buildQrCeremonySteps, buildQrPairingSteps, qrStepCounter } from '@/core/multisig/qr-plan'
import type { QrStep } from '@/core/multisig/qr-plan'
import { QR_DISPLAY_TTL_MS } from '@/core/multisig/types'
import type {
  DeviceSlot,
  MultisigGroupRecord,
  MultisigThreshold,
  MultisigTransportKind,
  SessionPhase
} from '@/core/multisig/types'
import { createLazyDkgPort } from '@/core/multisig/dkg-port'
import type { DkgPort } from '@/core/multisig/dkg-port'
import type { VaultWasm } from '@/core/multisig/dkg-protocol'
import { bytesToBase64 } from '@/lib/bytes'
import { BLE_DEVICE_QUERY } from '@/core/multisig/ble/link'
import { chooseBluetoothDevice } from '@/lib/multisig-bluetooth'
import type { BluetoothSelection } from '@/lib/multisig-bluetooth'
import { writeMultisigGroup } from '@/lib/multisig-group-storage'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import type { MultisigCreationOperation } from '@/lib/multisig-creation-storage'
import { decodeEnvelopeUR } from '@/lib/multisig-ur'
import { toast } from '@/store/toast-store'
import {
  defaultLoadIdentity,
  forgetSharedIdentity,
  loadSharedIdentity,
  peekSharedIdentity
} from './device-identity-cache'
import { useMultisigGroupStore } from './group-store'
import { createBleDriver } from './ble-driver'
import type { BleChooserRejection, BleDriverOptions } from './ble-driver'
import { createMockBleDriver } from './mock/mock-ble-driver'
import type { ChooserRejection } from './mock/mock-ble-driver'
import { MOCK_BLUETOOTH_QUERY, readMockSettings } from './mock/mock-settings'
import { loadMockVaultWasm } from './mock/mock-vault-wasm'
import { createQrMockHooks } from './mock/qr-mock-hooks'
import { createQrDriver } from './qr-driver'
import type { QrDisplay, QrDriver, QrDriverOptions, QrScanRequest, ScanOutcome } from './qr-driver'

/** What a simulated set of phones needs to play the other side of a QR session. */
export interface QrMockContext {
  loadVault: () => Promise<VaultWasm>
  slots: readonly DeviceSlot[]
}

/** The store's hooks into simulated phones; real phones are driven only by what they scan. */
export interface QrMockHooks {
  phoneScanned(slot: DeviceSlot, display: QrDisplay): Promise<void>
  simulateScan(slot: DeviceSlot): Promise<void>
  identityConfirmed(slot: DeviceSlot): void
  dispose(): void
}

export interface CreateSessionDependencies {
  dkgPort: DkgPort
  loadPhoneVault: () => Promise<VaultWasm>
  /** The extension's long-lived device identity, which signs every QR code it shows. */
  loadIdentity: () => Promise<DeviceIdentity>
  createQrDriver: (options: QrDriverOptions) => QrDriver
  createBleDriver: (options: BleDriverOptions) => SessionDriver
  createQrMock: ((driver: QrDriver, context: QrMockContext) => QrMockHooks) | null
}

// The Worker client and the IndexedDB identity store are imported on first use only, so Node
// tests that inject their own never load them.
const defaultDependencies: CreateSessionDependencies = {
  dkgPort: createLazyDkgPort(() =>
    import('@/core/multisig/worker-dkg-port').then(module => module.createWorkerDkgPort())
  ),
  loadPhoneVault: loadMockVaultWasm,
  loadIdentity: defaultLoadIdentity,
  createQrDriver,
  createBleDriver,
  createQrMock: createQrMockHooks
}

let dependencies: CreateSessionDependencies = defaultDependencies

/** Swaps dependencies for tests; returns a function that restores the previous ones. */
export function setCreateSessionDependencies(
  overrides: Partial<CreateSessionDependencies>
): () => void {
  const previous = dependencies
  dependencies = { ...previous, ...overrides }
  // An identity cached from the previous loader must not outlive it.
  if (overrides.loadIdentity) forgetSharedIdentity()
  return () => {
    dependencies = previous
    if (overrides.loadIdentity) forgetSharedIdentity()
  }
}

function sharedIdentity(): Promise<DeviceIdentity> {
  return loadSharedIdentity(() => dependencies.loadIdentity())
}

function cachedIdentityStatus(): IdentityStatus {
  const loaded = peekSharedIdentity()
  return loaded
    ? { status: 'ready', publicKey: bytesToBase64(loaded.publicKey) }
    : { status: 'loading' }
}

type DkgEffect = Extract<
  CreateSessionEffect,
  {
    type:
      | 'dkgOpen'
      | 'dkgAcceptRound1'
      | 'dkgConfirmRound1'
      | 'dkgAcceptRound2'
      | 'dkgClose'
      | 'saveVaultRecord'
  }
>

function isDkgEffect(effect: CreateSessionEffect): effect is DkgEffect {
  return (
    effect.type === 'dkgOpen' ||
    effect.type === 'dkgAcceptRound1' ||
    effect.type === 'dkgConfirmRound1' ||
    effect.type === 'dkgAcceptRound2' ||
    effect.type === 'dkgClose' ||
    effect.type === 'saveVaultRecord'
  )
}

/** QR: the codes on screen and the phones that should scan them. */
export type PendingQrDisplay = QrDisplay & { expiresAt: number }

/** QR: the phone replies the camera is waiting for. */
export type PendingQrScan = QrScanRequest

/** The device identity's public half; the identity itself never enters the store's state. */
export type IdentityStatus =
  | { status: 'loading' }
  | { status: 'ready'; publicKey: string }
  | { status: 'unsupported' }

/** Bluetooth: the open simulated chooser. The browser's own never shows up here. */
export interface PendingChooser {
  slot: 2 | 3
  resolve: (selection: BluetoothSelection) => void
}

export interface CreateSessionStore {
  reservation: MultisigCreationOperation | null
  commitStatus: 'idle' | 'saving' | 'failed' | 'ready'
  retryCommit(): void
  scope: MultisigGroupScope | null
  session: CreateSessionState | null
  pendingDisplay: PendingQrDisplay | null
  pendingScan: PendingQrScan | null
  chooser: PendingChooser | null
  identity: IdentityStatus
  /** Starts a new session and its driver, replacing any earlier one. */
  start(
    scope: MultisigGroupScope,
    threshold: MultisigThreshold,
    transportKind: MultisigTransportKind,
    ownerName: string,
    reservation?: MultisigCreationOperation
  ): void
  dispatch(event: CreateSessionEvent): void
  switchTransport(kind: MultisigTransportKind): void
  resolveChooser(selection: BluetoothSelection): void
  /** QR: the user reports that this phone has scanned the code on screen. */
  markPhoneScanned(slot: DeviceSlot): void
  /** QR: a UR read by the camera, checked by the driver before the session sees it. */
  ingestScan(ur: UR): Promise<ScanOutcome>
  /** QR with simulated phones: this phone shows its reply and the camera reads it at once. */
  simulateScan(slot: DeviceSlot): Promise<void>
  /** QR: the user has matched this phone's identity on both screens. */
  confirmIdentity(slot: DeviceSlot): void
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
const QR_CEREMONY_PHASES: readonly SessionPhase[] = [
  'DKG_R1',
  'R1_VERIFIED',
  'DKG_R2',
  'FINALIZED',
  'KEYSET_VERIFIED'
]
const CHOOSER_CLOSED: BluetoothSelection = { status: 'cancelled' }

function reportChooserRejection(reason: ChooserRejection | BleChooserRejection): void {
  if (reason === 'duplicate') toast.error('Device already added', 'Choose a different device.')
  else if (reason === 'connect_failed') {
    toast.error('Could not connect', 'Keep the phone on its waiting screen and try again.')
  } else if (reason === 'wrong_device') {
    toast.error('Device not verified', 'The phone could not prove its identity. Try again.')
  } else toast.error('Bluetooth unavailable', 'Check your Bluetooth settings or use QR code.')
}

function useRealBluetooth(): boolean {
  return readMockSettings().blePhones === 'real'
}

function guardian(session: CreateSessionState, slot: DeviceSlot): DeviceSessionState | null {
  if (slot === 1) return null
  return session.devices.find(device => device.slot === slot) ?? null
}

function slotsIn(
  session: CreateSessionState,
  connections: readonly DeviceSessionState['connection'][]
): DeviceSlot[] {
  return session.devices
    .filter(device => device.slot !== 1 && connections.includes(device.connection))
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
  if (session.phase === 'PAIRING') {
    return slotsIn(session, ['invite_shown']).flatMap(buildQrPairingSteps)
  }
  const current = qrCeremonyStep(session)
  return current ? [current.step] : []
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function isLiveDisplay(steps: readonly QrStep[], display: QrDisplay): boolean {
  return steps.some(
    step =>
      step.kind === 'show' &&
      sameItems(step.slots, display.slots) &&
      sameItems(step.messageTypes, display.messageTypes)
  )
}

function liveDisplay(
  steps: readonly QrStep[],
  display: PendingQrDisplay | null
): PendingQrDisplay | null {
  return display && isLiveDisplay(steps, display) ? display : null
}

function liveScan(steps: readonly QrStep[], scan: PendingQrScan | null): PendingQrScan | null {
  if (!scan) return null
  const live = steps.some(
    step =>
      step.kind === 'scan' &&
      step.messageType === scan.messageType &&
      sameItems(step.slots, scan.slots)
  )
  return live ? scan : null
}

/**
 * The QR step the pages should show, with its "n of m" counter. Null whenever no step is in
 * play: Bluetooth, between pairings, while the Worker session opens and the terminal phases.
 */
export function currentQrStep(
  snapshot: Pick<CreateSessionStore, 'session' | 'pendingDisplay' | 'pendingScan'>
): CurrentQrStep | null {
  const { session, pendingDisplay, pendingScan } = snapshot
  if (!session || session.transportKind !== 'qr') return null

  if (session.phase === 'PAIRING') {
    const pairing = slotsIn(session, ['invite_shown', 'identity_check'])
    // Several pairings can be open at once; the one the store is working on wins.
    const slot =
      [pendingScan?.slots[0], pendingDisplay?.slots[0]].find(
        (candidate): candidate is DeviceSlot =>
          candidate !== undefined && pairing.includes(candidate)
      ) ?? pairing[0]
    if (slot === undefined) return null
    const index =
      guardian(session, slot)?.connection === 'identity_check'
        ? 2
        : pendingScan?.slots.includes(slot)
          ? 1
          : 0
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
  reservation: null,
  commitStatus: 'idle',
  scope: null,
  session: null,
  pendingDisplay: null,
  pendingScan: null,
  chooser: null,
  identity: { status: 'loading' }
} as const

export const useCreateSessionStore = create<CreateSessionStore>()((set, get) => {
  let driver: SessionDriver | null = null
  let qrDriver: QrDriver | null = null
  let qrMock: QrMockHooks | null = null
  // Bumped by every start and reset, so an identity that loads for a replaced
  // session is dropped.
  let identityGeneration = 0
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
    if (before.commitStatus === 'saving' || before.commitStatus === 'failed') return
    const { state, effects } = reduceCreateSession(session, event)
    if (state !== session) {
      if (state.phase !== session.phase) multisigDebug('phase', { phase: state.phase })
      const steps = liveQrSteps(state)
      set({
        session: state.phase === 'ACTIVATED' ? { ...state, phase: 'KEYSET_VERIFIED' } : state,
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
    // Successful disposal follows the durable commit acknowledgement. While it is pending,
    // incoming ceremony events are ignored and cannot start a second commit.
    const ended = state.phase === 'ABORTED'
    if (ended && state !== session) dropDriver()
  }

  function persistGroup(record: MultisigGroupRecord): void {
    const { scope, reservation, session: currentSession } = get()
    if (!scope) return
    // The reducer never reads the clock, so the activation time is stamped here.
    const stamped: MultisigGroupRecord = { ...record, createdAt: Date.now() }
    const confirmations =
      currentSession?.devices.flatMap(device =>
        device.finalEnvelope ? [device.finalEnvelope] : []
      ) ?? []
    if (
      reservation &&
      (!currentSession || confirmations.length !== guardianSlots(currentSession).length)
    ) {
      set({ commitStatus: 'failed' })
      dropDriver()
      return
    }
    set({ commitStatus: 'saving' })
    const complete = reservation
      ? import('@/core/worker/client')
          .then(({ requestVaultGroup }) =>
            requestVaultGroup('vault.group.commit', {
              scope,
              operationId: reservation.operationId,
              group: stamped,
              evidence: { sessionId: currentSession!.sessionId, confirmations }
            })
          )
          .then(async reply => {
            if (reply.phase !== 'ready') throw new Error('Account is not ready')
            await (await import('@/store/wallet-store')).rehydrateWalletStore()
            return { ...stamped, mock: false }
          })
      : writeMultisigGroup(scope, stamped).then(() => stamped)
    complete.then(
      group => {
        if (get().scope !== scope || get().reservation !== reservation) return
        useMultisigGroupStore.getState().setGroup(scope, group)
        const session = get().session
        if (session) set({ session: { ...session, phase: 'ACTIVATED' }, commitStatus: 'ready' })
        dropDriver()
      },
      () => {
        if (get().scope === scope && get().reservation === reservation) {
          set({ commitStatus: 'failed' })
          dropDriver()
        }
      }
    )
  }

  function closeChooser(): void {
    const { chooser } = get()
    if (!chooser) return
    set({ chooser: null })
    chooser.resolve(CHOOSER_CLOSED)
  }

  function openChooser(slot: DeviceSlot, isCurrent: () => boolean): Promise<BluetoothSelection> {
    if (slot === 1 || !isCurrent()) return Promise.resolve(CHOOSER_CLOSED)
    // Real phones advertise only the wallet's service, so the chooser lists just those.
    if (useRealBluetooth()) return chooseBluetoothDevice(BLE_DEVICE_QUERY)
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
    const settled = (result: 'ok' | 'failed') => multisigDebug('dkg', { step: effect.type, result })
    const failed = () => {
      settled('failed')
      report({ type: 'DKG_FAILED' })
    }
    switch (effect.type) {
      case 'dkgOpen': {
        // The share is sealed under the scope's wallet; without a scope there is no wallet to name.
        const { scope, session, reservation } = get()
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
            groupId: effect.groupId,
            ...(reservation && session?.roster
              ? {
                  operationId: reservation.operationId,
                  outerSessionId: session.sessionId,
                  binding: {
                    accountId: scope.accountId,
                    birthdayHeight: reservation.birthdayHeight,
                    rosterVersion: 1 as const,
                    roster: session.roster
                  }
                }
              : {}),
            // QR invites already named this id, so the Worker must open under it.
            ...(effect.sessionId !== undefined ? { sessionId: effect.sessionId } : {})
          })
          .then(({ sessionId }) => {
            settled('ok')
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
        port.acceptRound1(effect.request).then(result => {
          settled('ok')
          report({ type: 'DKG_ROUND1_ACCEPTED', slot: effect.slot, result })
        }, failed)
        break
      case 'dkgConfirmRound1':
        port.confirmRound1(effect.request).then(() => {
          settled('ok')
          report({ type: 'DKG_ROUND1_CONFIRMED', slot: effect.slot })
        }, failed)
        break
      case 'dkgAcceptRound2':
        port.acceptRound2(effect.request).then(result => {
          settled('ok')
          report({ type: 'DKG_ROUND2_ACCEPTED', slot: effect.slot, result })
        }, failed)
        break
      case 'dkgClose':
        port.close({ sessionId: effect.sessionId }).then(
          () => settled('ok'),
          () => settled('failed')
        )
        break
      case 'saveVaultRecord': {
        const saveFailed = () => {
          settled('failed')
          report({ type: 'VAULT_RECORD_SAVE_FAILED' })
        }
        // Background files the record under the scope's account; with no scope there is none.
        const { scope, reservation } = get()
        if (!scope) {
          saveFailed()
          break
        }
        port
          .save({
            scope,
            groupId: effect.groupId,
            record: effect.record,
            ...(reservation ? { operationId: reservation.operationId } : {})
          })
          .then(() => {
            settled('ok')
            report({ type: 'VAULT_RECORD_SAVED' })
          }, saveFailed)
        break
      }
    }
  }

  function dropDriver(): void {
    generation += 1
    qrMock?.dispose()
    qrMock = null
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
    if (session.transportKind === 'ble' && useRealBluetooth()) {
      // Every message is signed with the device identity, so a real session waits for it.
      const identity = peekSharedIdentity()
      if (!identity) return
      driver = dependencies.createBleDriver({
        session: ids,
        identity,
        slots: guardianSlots(session),
        onChooser: slot => openChooser(slot, isCurrent),
        onRejected: reason => {
          if (isCurrent()) reportChooserRejection(reason)
        }
      })
      dispatch({ type: 'IDENTITY_READY', publicKey: bytesToBase64(identity.publicKey) })
      return
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
    // Every QR code is signed with the device identity, so a QR session waits for it.
    const identity = peekSharedIdentity()
    if (!identity) return
    const slots = guardianSlots(session)
    const created = dependencies.createQrDriver({
      session: ids,
      identity,
      slots,
      onDisplay: display => {
        if (!isCurrent()) return
        // Codes are signed asynchronously; one for a step that has ended meanwhile is not shown.
        const current = get().session
        if (!current || !isLiveDisplay(liveQrSteps(current), display)) return
        const expiresAt = Date.now() + QR_DISPLAY_TTL_MS
        set({ pendingDisplay: { ...display, expiresAt }, pendingScan: null })
      },
      onAwaitScan: scan => {
        if (!isCurrent()) return
        set({ pendingScan: scan, pendingDisplay: null })
      }
    })
    driver = created
    qrDriver = created
    qrMock =
      readMockSettings().qrPhones === 'simulated'
        ? (dependencies.createQrMock?.(created, {
            loadVault: dependencies.loadPhoneVault,
            slots
          }) ?? null)
        : null
    dispatch({ type: 'IDENTITY_READY', publicKey: bytesToBase64(identity.publicKey) })
  }

  function loadIdentity(): void {
    const owned = ++identityGeneration
    const isCurrent = () => owned === identityGeneration
    sharedIdentity().then(
      loaded => {
        if (!isCurrent()) return
        // Forgotten while loading (the dev panel's reset): 'ready' would name a key nobody holds.
        if (!peekSharedIdentity()) {
          loadIdentity()
          return
        }
        set({ identity: { status: 'ready', publicKey: bytesToBase64(loaded.publicKey) } })
        // A QR session started while the identity was loading gets its driver only now.
        const { session } = get()
        if (
          (session?.transportKind === 'qr' || useRealBluetooth()) &&
          session?.phase === 'PAIRING' &&
          !driver
        ) {
          attachDriver(session)
        }
      },
      () => {
        if (!isCurrent()) return
        multisigDebug('identity', { result: 'failed' })
        set({ identity: { status: 'unsupported' } })
      }
    )
  }

  return {
    ...IDLE,

    start: (scope, threshold, transportKind, name, reservation) => {
      dropDriver()
      ownerName = name
      // Late answers to an earlier session's load must not reach this one.
      identityGeneration += 1
      const session = createInitialSession({
        groupId: reservation?.groupId ?? crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        threshold,
        transportKind,
        owner: { slot: 1, role: 'owner', name, model: OWNER_MODEL, platform: 'extension' },
        mainnet: scope.network === 'mainnet',
        authenticatedDkg: reservation !== undefined,
        qrDkgSessionId: bytesToBase64(crypto.getRandomValues(new Uint8Array(16)))
      })
      // Published first: a QR driver reports the identity to this session as it attaches.
      set({
        ...IDLE,
        scope,
        session,
        reservation: reservation ?? null,
        identity: cachedIdentityStatus()
      })
      attachDriver(session)
      if (!peekSharedIdentity()) loadIdentity()
    },

    dispatch,
    retryCommit: () => {
      const { session, commitStatus } = get()
      if (session && commitStatus === 'failed' && session.finalFingerprint)
        persistGroup({
          groupId: session.groupId,
          threshold: session.threshold,
          transportKind: session.transportKind,
          devices: session.devices.flatMap(d => (d.device ? [d.device] : [])),
          fingerprint: session.finalFingerprint,
          createdAt: 0,
          mock: true
        })
    },

    switchTransport: kind => {
      const { scope, session, identity: status } = get()
      if (!scope || !session) return
      // The page keeps QR disabled until the identity that signs its codes is ready. The cache is
      // the source of truth: it can be cleared (the dev panel's reset) under a published 'ready'.
      if ((kind === 'qr' || (kind === 'ble' && useRealBluetooth())) && !peekSharedIdentity()) {
        if (status.status === 'ready') {
          set({ identity: { status: 'loading' } })
          loadIdentity()
        }
        return
      }
      const { state, effects } = reduceCreateSession(session, { type: 'SWITCH_TRANSPORT', kind })
      if (state.phase === 'ABORTED' && state.abortReason === 'transport_switched') {
        // A pairing already under way cannot move to the other transport, so the reducer voids
        // the session. Changing transport is a choice, not a failure, so instead of showing that
        // abort the store starts over on the new transport in a single update. The abort's
        // effects still go out first, on the old transport, so its phones learn the setup ended.
        runOnCurrentDriver(effects)
        get().start(scope, session.threshold, kind, ownerName, get().reservation ?? undefined)
        return
      }
      if (state.transportKind === session.transportKind) return
      // Nothing paired yet: the same session simply continues on the other transport.
      dropDriver()
      set({ session: state, pendingDisplay: null, pendingScan: null })
      attachDriver(state)
    },

    resolveChooser: selection => {
      const { chooser } = get()
      if (!chooser) return
      set({ chooser: null })
      chooser.resolve(selection)
    },

    markPhoneScanned: slot => {
      const { session, pendingScan, pendingDisplay } = get()
      if (!session || !qrDriver) return
      // A second tap must not re-arm the reply scan or count the phone twice.
      if (session.phase === 'PAIRING') {
        if (guardian(session, slot)?.connection !== 'invite_shown') return
        if (pendingScan?.slots.includes(slot)) return
      } else {
        const step = qrCeremonyStep(session)?.step
        if (step?.kind === 'show' && session.qrShownTo.includes(slot)) return
      }
      if (qrMock && pendingDisplay?.slots.includes(slot)) {
        qrMock
          .phoneScanned(slot, pendingDisplay)
          .catch(() => multisigDebug('mock', { step: 'phone_scanned', slot, result: 'failed' }))
      }
      dispatch({ type: 'QR_PHONE_SCANNED', slot })
    },

    ingestScan: async ur => {
      const scanner = qrDriver
      if (!scanner) return 'ignored'
      // Camera input is untrusted: anything that is not a single envelope stops here.
      const envelope = decodeEnvelopeUR(ur)
      if (!envelope) return 'ignored'
      const outcome = await scanner.deliverScan(envelope)
      // A transport replaced while the scan was checked no longer owns the slot it was for.
      if (outcome === 'duplicate_identity' && scanner === qrDriver) {
        toast.error('Device already added', 'Choose a different device.')
        // The phone's identity already fills another slot, so this pairing starts over.
        const { pendingScan } = get()
        if (pendingScan) dispatch({ type: 'PAIR_CANCEL', slot: pendingScan.slots[0] })
      }
      return outcome
    },

    simulateScan: async slot => {
      await qrMock?.simulateScan(slot)
    },

    confirmIdentity: slot => {
      dispatch({ type: 'IDENTITY_CONFIRMED', slot })
      qrMock?.identityConfirmed(slot)
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
      // A load still in flight belongs to the session that just ended. The identity itself
      // outlives sessions, so it stays cached.
      identityGeneration += 1
      set({ ...IDLE, identity: cachedIdentityStatus() })
    }
  }
})
