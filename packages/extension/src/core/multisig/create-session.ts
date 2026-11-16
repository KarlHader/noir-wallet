import {
  dkgShape,
  parseDkgEnvelopePayload,
  parseDkgFinalPayload,
  parseRound1EchoPayload,
  rosterSlotOf,
  type RosterLockPayload
} from './dkg-protocol'
import type {
  VaultDkgAcceptRequest,
  VaultDkgRound1Response,
  VaultDkgRound2Response
} from './dkg-rpc'
import { deriveMockFingerprint } from './fingerprint'
import { deviceId, type MultisigEnvelope, type MultisigMessageType } from './messages'
import { buildQrCeremonySteps, type QrStep } from './qr-plan'
import { parseSealedVaultRecord, type SealedVaultRecord } from './vault-record'
import {
  PAIRING_CODE_MAX_ATTEMPTS,
  thresholdDeviceCount,
  thresholdRequiresManualR1Check,
  type AbortReason,
  type DeviceConnectionState,
  type DeviceSlot,
  type MultisigDevice,
  type MultisigGroupRecord,
  type MultisigThreshold,
  type MultisigTransportKind,
  type SessionPhase
} from './types'

export interface DeviceSessionState {
  slot: DeviceSlot
  connection: DeviceConnectionState
  device: MultisigDevice | null
  pairingCode: string | null
  pairingCodeExpiresAt: number | null
  codeAttempts: number
  codeError: 'wrong' | 'expired' | null
  r1Received: boolean
  r1Echoed: boolean
  r2Received: boolean
  finalReceived: boolean
}

export interface CreateSessionState {
  groupId: string
  sessionId: string
  threshold: MultisigThreshold
  transportKind: MultisigTransportKind
  phase: SessionPhase
  abortReason: AbortReason | null
  /** Index 0 is slot 1, the extension itself, which is always connected. */
  devices: readonly DeviceSessionState[]
  manualR1Check: boolean
  r1Fingerprint: string | null
  finalFingerprint: string | null
  ownerConfirmed: { r1: boolean; final: boolean }
  /** QR only: the current ceremony step, -1 before the ceremony starts. */
  qrCeremonyIndex: number
  /** QR only: phones the user has marked as having scanned the current 'show' step. */
  qrShownTo: readonly DeviceSlot[]
  /** Which network the keyset is derived for; the fingerprint differs between the two. */
  mainnet: boolean
  /** Bluetooth only: the Worker's DKG session (base64), from DKG_OPENED until the end. */
  dkgSessionId: string | null
  /** Bluetooth only: the extension's sealed share from round 2; ciphertext, never the share. */
  vaultRecord: SealedVaultRecord | null
  /** Bluetooth only: the record is on its way to storage and activation waits for the answer. */
  savingRecord: boolean
}

export type CreateSessionEvent =
  | { type: 'PAIR_START'; slot: DeviceSlot }
  | { type: 'PAIR_DEVICE_SELECTED'; slot: DeviceSlot; device: MultisigDevice }
  | { type: 'PAIR_SELECTION_CANCELLED'; slot: DeviceSlot }
  | { type: 'PAIR_CODE_ISSUED'; slot: DeviceSlot; code: string; expiresAt: number }
  | { type: 'PAIR_CODE_EXPIRED'; slot: DeviceSlot }
  | { type: 'PAIR_CODE_RESEND'; slot: DeviceSlot }
  | { type: 'PAIR_CANCEL'; slot: DeviceSlot }
  | { type: 'QR_INVITE_SHOWN'; slot: DeviceSlot }
  | { type: 'QR_PHONE_SCANNED'; slot: DeviceSlot }
  | { type: 'MESSAGE_RECEIVED'; slot: DeviceSlot; envelope: MultisigEnvelope; at: number }
  | { type: 'DEVICE_DISCONNECTED'; slot: DeviceSlot }
  | { type: 'CONTINUE' }
  | { type: 'FINGERPRINT_CONFIRMED'; stage: 'r1' | 'final' }
  | { type: 'FINGERPRINT_REJECTED'; stage: 'r1' | 'final' }
  | { type: 'SWITCH_TRANSPORT'; kind: MultisigTransportKind }
  | { type: 'STEP_TIMEOUT' }
  | { type: 'USER_ABORT' }
  | { type: 'DKG_OPENED'; sessionId: string }
  | { type: 'DKG_ROUND1_ACCEPTED'; slot: DeviceSlot; result: VaultDkgRound1Response }
  | { type: 'DKG_ROUND2_ACCEPTED'; slot: DeviceSlot; result: VaultDkgRound2Response }
  | { type: 'DKG_FAILED' }
  | { type: 'VAULT_RECORD_SAVED' }
  | { type: 'VAULT_RECORD_SAVE_FAILED' }

export type CreateSessionEffect =
  | { type: 'requestDevice'; slot: DeviceSlot }
  | { type: 'issueCode'; slot: DeviceSlot }
  | {
      type: 'sendTo'
      slot: DeviceSlot
      messageType: MultisigMessageType
      payload?: Record<string, unknown>
    }
  | { type: 'awaitFrom'; slot: DeviceSlot; messageType: MultisigMessageType }
  | { type: 'display'; slots: readonly DeviceSlot[]; messageType: MultisigMessageType }
  | { type: 'awaitScan'; slot: DeviceSlot; messageType: MultisigMessageType }
  | { type: 'disconnect'; slot: DeviceSlot }
  | { type: 'persistGroup'; record: MultisigGroupRecord }
  | { type: 'dkgOpen'; participants: 2 | 3; threshold: 2 | 3; mainnet: boolean; groupId: string }
  | { type: 'dkgAcceptRound1'; slot: DeviceSlot; request: VaultDkgAcceptRequest }
  | { type: 'dkgAcceptRound2'; slot: DeviceSlot; request: VaultDkgAcceptRequest }
  | { type: 'dkgClose'; sessionId: string }
  | { type: 'saveVaultRecord'; groupId: string; record: SealedVaultRecord }

export interface CreateSessionInput {
  groupId: string
  sessionId: string
  threshold: MultisigThreshold
  transportKind: MultisigTransportKind
  owner: MultisigDevice
  mainnet: boolean
}

interface ReduceResult {
  state: CreateSessionState
  effects: readonly CreateSessionEffect[]
}

type MessageReceivedEvent = Extract<CreateSessionEvent, { type: 'MESSAGE_RECEIVED' }>

const NO_EFFECTS: readonly CreateSessionEffect[] = []
const TWO_DEVICE_GUARDIANS: readonly DeviceSlot[] = [2]
const THREE_DEVICE_GUARDIANS: readonly DeviceSlot[] = [2, 3]

function emptyDevice(slot: DeviceSlot): DeviceSessionState {
  return {
    slot,
    connection: 'empty',
    device: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    codeAttempts: 0,
    codeError: null,
    r1Received: false,
    r1Echoed: false,
    r2Received: false,
    finalReceived: false
  }
}

export function createInitialSession(input: CreateSessionInput): CreateSessionState {
  const owner: DeviceSessionState = {
    ...emptyDevice(1),
    connection: 'connected',
    device: input.owner
  }
  const slots =
    thresholdDeviceCount(input.threshold) === 2 ? TWO_DEVICE_GUARDIANS : THREE_DEVICE_GUARDIANS
  return {
    groupId: input.groupId,
    sessionId: input.sessionId,
    threshold: input.threshold,
    transportKind: input.transportKind,
    phase: 'PAIRING',
    abortReason: null,
    devices: [owner, ...slots.map(emptyDevice)],
    manualR1Check: thresholdRequiresManualR1Check(input.threshold, input.transportKind),
    r1Fingerprint: null,
    finalFingerprint: null,
    ownerConfirmed: { r1: false, final: false },
    qrCeremonyIndex: -1,
    qrShownTo: [],
    mainnet: input.mainnet,
    dkgSessionId: null,
    vaultRecord: null,
    savingRecord: false
  }
}

export function guardianSlots(state: CreateSessionState): readonly DeviceSlot[] {
  return thresholdDeviceCount(state.threshold) === 2 ? TWO_DEVICE_GUARDIANS : THREE_DEVICE_GUARDIANS
}

function guardians(state: CreateSessionState): readonly DeviceSessionState[] {
  return state.devices.filter(device => device.slot !== 1)
}

function everyGuardian(
  state: CreateSessionState,
  predicate: (device: DeviceSessionState) => boolean
): boolean {
  return guardians(state).every(predicate)
}

export function allGuardiansConnected(state: CreateSessionState): boolean {
  return everyGuardian(state, device => device.connection === 'connected')
}

export function verifyPageDevices(
  state: CreateSessionState
): readonly { slot: DeviceSlot; device: MultisigDevice; confirmed: boolean }[] {
  return guardians(state).flatMap(entry =>
    entry.device
      ? [
          {
            slot: entry.slot,
            device: entry.device,
            // Over QR the phones confirm on their own screens with no way to tell the extension,
            // so there is never a confirmation to show.
            confirmed: state.transportKind === 'ble' && entry.finalReceived
          }
        ]
      : []
  )
}

function result(
  state: CreateSessionState,
  effects: readonly CreateSessionEffect[] = NO_EFFECTS
): ReduceResult {
  return { state, effects }
}

// "Ignored" means the caller gets back the very same state object, so it can tell nothing happened.
function ignored(state: CreateSessionState): ReduceResult {
  return result(state)
}

function guardianState(state: CreateSessionState, slot: DeviceSlot): DeviceSessionState | null {
  if (slot === 1) return null
  return state.devices.find(device => device.slot === slot) ?? null
}

function updateDevice(
  state: CreateSessionState,
  slot: DeviceSlot,
  patch: Partial<Omit<DeviceSessionState, 'slot'>>
): CreateSessionState {
  return {
    ...state,
    devices: state.devices.map(device => (device.slot === slot ? { ...device, ...patch } : device))
  }
}

function resetDevice(state: CreateSessionState, slot: DeviceSlot): ReduceResult {
  const devices = state.devices.map(d => (d.slot === slot ? emptyDevice(slot) : d))
  return result({ ...state, devices }, [{ type: 'disconnect', slot }])
}

function toEachGuardian(
  state: CreateSessionState,
  sendType: MultisigMessageType,
  awaitType: MultisigMessageType
): CreateSessionEffect[] {
  const slots = guardianSlots(state)
  return [
    ...slots.map((slot): CreateSessionEffect => ({ type: 'sendTo', slot, messageType: sendType })),
    ...slots.map(
      (slot): CreateSessionEffect => ({ type: 'awaitFrom', slot, messageType: awaitType })
    )
  ]
}

function abort(state: CreateSessionState, reason: AbortReason): ReduceResult {
  // Any failure voids the whole group: no guardian may keep a half-finished pairing or share.
  const devices = state.devices.map(d => (d.slot === 1 ? d : emptyDevice(d.slot)))
  // Over Bluetooth every phone already involved is told before its link goes, so none stays on a
  // setup that no longer exists. QR has no channel back to the phones, so nothing can be sent.
  const effects: CreateSessionEffect[] =
    state.transportKind === 'ble'
      ? guardians(state)
          .filter(device => device.connection !== 'empty')
          .flatMap((device): CreateSessionEffect[] => [
            { type: 'sendTo', slot: device.slot, messageType: 'SESSION_ABORT' },
            { type: 'disconnect', slot: device.slot }
          ])
      : []
  // The Worker's half of the ceremony must not outlive the session it belonged to.
  if (state.dkgSessionId !== null) {
    effects.push({ type: 'dkgClose', sessionId: state.dkgSessionId })
  }
  // An aborted session has no save in flight any more; a late save answer is ignored anyway.
  return result(
    { ...state, phase: 'ABORTED', abortReason: reason, devices, savingRecord: false },
    effects
  )
}

function parsePayload(envelope: MultisigEnvelope): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(envelope.encrypted_payload)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

// Slot and role come from the slot being paired, never from the phone's reply, so the stored
// roster cannot end up with two devices claiming one slot.
function asGuardian(slot: DeviceSlot, value: unknown): MultisigDevice | null {
  if (typeof value !== 'object' || value === null) return null
  const { name, model, platform } = value as Record<string, unknown>
  if (!isFilledString(name) || !isFilledString(model)) return null
  // Guardians are always phones; only the owner runs as the extension.
  if (platform !== 'ios' && platform !== 'android') return null
  return { slot, role: 'guardian', name, model, platform }
}

function buildGroupRecord(state: CreateSessionState, fingerprint: string): MultisigGroupRecord {
  return {
    groupId: state.groupId,
    threshold: state.threshold,
    transportKind: state.transportKind,
    devices: state.devices.flatMap(entry => (entry.device ? [entry.device] : [])),
    fingerprint,
    // The reducer never reads the clock; the store stamps the real time when it persists.
    createdAt: 0,
    mock: true
  }
}

function activate(state: CreateSessionState): ReduceResult {
  const fingerprint = state.finalFingerprint
  if (fingerprint === null) return ignored(state)
  const persist: CreateSessionEffect = {
    type: 'persistGroup',
    record: buildGroupRecord(state, fingerprint)
  }
  // Only Bluetooth has a channel back to the phones; over QR each device activates locally once
  // its user has matched the fingerprint, so there is nothing to send.
  const announce: CreateSessionEffect[] =
    state.transportKind === 'ble'
      ? guardianSlots(state).map(slot => ({ type: 'sendTo', slot, messageType: 'DKG_ACTIVATE' }))
      : []
  // A Worker session exists only on the Bluetooth path, which activates once Background has
  // confirmed the sealed record is stored: the share now lives in that record, so the session
  // holds nothing that is still needed.
  const release: CreateSessionEffect[] =
    state.dkgSessionId !== null ? [{ type: 'dkgClose', sessionId: state.dkgSessionId }] : []
  return result({ ...state, phase: 'ACTIVATED' }, [...announce, persist, ...release])
}

export function reduceCreateSession(
  state: CreateSessionState,
  event: CreateSessionEvent
): { state: CreateSessionState; effects: readonly CreateSessionEffect[] } {
  // Both outcomes are final: a new attempt starts a new session.
  if (state.phase === 'ABORTED' || state.phase === 'ACTIVATED') return ignored(state)

  switch (event.type) {
    case 'USER_ABORT':
      return abort(state, 'user_cancelled')
    case 'STEP_TIMEOUT':
      return abort(state, 'session_expired')
    case 'DKG_FAILED':
      // A DKG error is never retried: the Worker has already voided its session.
      return abort(state, 'verification_failed')
    case 'FINGERPRINT_REJECTED':
      return abort(state, 'fingerprint_mismatch')
    case 'VAULT_RECORD_SAVED':
      // Only a save this session asked for can activate it; anything else is a stale answer.
      if (state.phase !== 'KEYSET_VERIFIED' || !state.savingRecord) return ignored(state)
      return activate({ ...state, savingRecord: false })
    case 'VAULT_RECORD_SAVE_FAILED':
      // A share that is not on disk cannot back a group, so the ceremony is void.
      return state.savingRecord ? abort(state, 'save_failed') : ignored(state)
    case 'MESSAGE_RECEIVED': {
      const sender = messageSender(state, event)
      if (!sender) return ignored(state)
      if (event.envelope.message_type === 'SESSION_ABORT') return abort(state, 'phone_rejected')
      break
    }
    case 'DEVICE_DISCONNECTED':
      // Once the roster is locked every guardian is required, so losing one ends the session.
      if (state.phase !== 'PAIRING') {
        return guardianState(state, event.slot)
          ? abort(state, 'device_disconnected')
          : ignored(state)
      }
      break
    default:
      break
  }

  if (state.phase === 'PAIRING') return reducePairing(state, event)
  return state.transportKind === 'ble'
    ? reduceBleCeremony(state, event)
    : reduceQrCeremony(state, event)
}

// Accepts a message only from this session, from a guardian slot that is actually in the flow,
// and from the phone that slot belongs to. Whether its type is expected is decided per phase.
function messageSender(
  state: CreateSessionState,
  event: MessageReceivedEvent
): DeviceSessionState | null {
  if (event.envelope.session_id !== state.sessionId) return null
  if (event.envelope.sender_id !== deviceId(event.slot)) return null
  const sender = guardianState(state, event.slot)
  return sender && sender.connection !== 'empty' ? sender : null
}

function reducePairing(state: CreateSessionState, event: CreateSessionEvent): ReduceResult {
  switch (event.type) {
    case 'SWITCH_TRANSPORT':
      return switchTransport(state, event.kind)
    case 'CONTINUE':
      return lockRoster(state)
    case 'PAIR_CANCEL':
    case 'DEVICE_DISCONNECTED': {
      const device = guardianState(state, event.slot)
      return device && device.connection !== 'empty'
        ? resetDevice(state, event.slot)
        : ignored(state)
    }
    default:
      return state.transportKind === 'ble'
        ? reduceBlePairing(state, event)
        : reduceQrPairing(state, event)
  }
}

function switchTransport(state: CreateSessionState, kind: MultisigTransportKind): ReduceResult {
  if (kind === state.transportKind) return ignored(state)
  // The two transports never mix within one group, so a started pairing cannot carry over.
  if (!everyGuardian(state, device => device.connection === 'empty')) {
    return abort(state, 'transport_switched')
  }
  const manualR1Check = thresholdRequiresManualR1Check(state.threshold, kind)
  return result({ ...state, transportKind: kind, manualR1Check })
}

function lockRoster(state: CreateSessionState): ReduceResult {
  if (!allGuardiansConnected(state)) return ignored(state)

  // Bluetooth: the Worker opens the DKG session first; ROSTER_LOCK goes out once its id is known.
  if (state.transportKind === 'ble') {
    const shape = dkgShape(state.threshold)
    return result({ ...state, phase: 'DKG_R1' }, [
      { type: 'dkgOpen', ...shape, mainnet: state.mainnet, groupId: state.groupId }
    ])
  }

  // QR: every phone's round-1 package arrived with its pairing reply, so the round-1 set is
  // already complete. With two devices nothing needs cross-checking and the ceremony starts at
  // round 2; with three the user must compare the round-1 fingerprint first.
  const next: CreateSessionState = {
    ...state,
    phase: state.manualR1Check ? 'DKG_R1' : 'DKG_R2',
    r1Fingerprint: deriveMockFingerprint(state.groupId, 'r1'),
    qrCeremonyIndex: 0,
    qrShownTo: []
  }
  return result(next, qrStepEffects(buildQrCeremonySteps(state.threshold)[0]))
}

function reduceBlePairing(state: CreateSessionState, event: CreateSessionEvent): ReduceResult {
  switch (event.type) {
    case 'PAIR_START':
      if (guardianState(state, event.slot)?.connection !== 'empty') return ignored(state)
      // The browser's chooser cannot be closed from the page, so a second one has to wait for it.
      if (state.devices.some(device => device.connection === 'choosing')) return ignored(state)
      return result(updateDevice(state, event.slot, { connection: 'choosing' }), [
        { type: 'requestDevice', slot: event.slot }
      ])
    case 'PAIR_DEVICE_SELECTED': {
      if (guardianState(state, event.slot)?.connection !== 'choosing') return ignored(state)
      // The slot being paired decides slot and role, whichever phone the chooser returned.
      const device: MultisigDevice = { ...event.device, slot: event.slot, role: 'guardian' }
      return result(updateDevice(state, event.slot, { connection: 'pending', device }), [
        { type: 'issueCode', slot: event.slot }
      ])
    }
    case 'PAIR_SELECTION_CANCELLED':
      if (guardianState(state, event.slot)?.connection !== 'choosing') return ignored(state)
      return resetDevice(state, event.slot)
    case 'PAIR_CODE_ISSUED': {
      const connection = guardianState(state, event.slot)?.connection
      if (connection !== 'pending' && connection !== 'code_wait') return ignored(state)
      return {
        // A fresh code (first issue or a resend) also gets a fresh set of attempts.
        state: updateDevice(state, event.slot, {
          connection: 'code_wait',
          pairingCode: event.code,
          pairingCodeExpiresAt: event.expiresAt,
          codeAttempts: 0,
          codeError: null
        }),
        // The code is shown on the extension only and never sent: its whole value is that the
        // phone's user must read it off this screen.
        effects: [
          { type: 'sendTo', slot: event.slot, messageType: 'PAIR_INVITE' },
          { type: 'awaitFrom', slot: event.slot, messageType: 'PAIR_RESPONSE' }
        ]
      }
    }
    case 'PAIR_CODE_EXPIRED': {
      const device = guardianState(state, event.slot)
      if (device?.connection !== 'code_wait' || device.codeError === 'expired') {
        return ignored(state)
      }
      return result(updateDevice(state, event.slot, { codeError: 'expired' }))
    }
    case 'PAIR_CODE_RESEND':
      if (guardianState(state, event.slot)?.connection !== 'code_wait') return ignored(state)
      return result(state, [{ type: 'issueCode', slot: event.slot }])
    case 'MESSAGE_RECEIVED':
      return event.envelope.message_type === 'PAIR_RESPONSE'
        ? checkPairingCode(state, event)
        : ignored(state)
    default:
      return ignored(state)
  }
}

function checkPairingCode(state: CreateSessionState, event: MessageReceivedEvent): ReduceResult {
  const device = guardianState(state, event.slot)
  if (device?.connection !== 'code_wait' || device.codeError === 'expired') return ignored(state)
  const { pairingCode, pairingCodeExpiresAt } = device
  const payload = parsePayload(event.envelope)
  const code = payload?.code
  if (pairingCode === null || pairingCodeExpiresAt === null || typeof code !== 'string') {
    return ignored(state)
  }

  // An expired code is void whatever the phone typed, and does not count as an attempt.
  if (event.at >= pairingCodeExpiresAt) {
    return result(updateDevice(state, event.slot, { codeError: 'expired' }))
  }

  if (code === pairingCode) {
    // Any nearby device can advertise any name, so the phone's own reply replaces the chooser's.
    const identity = asGuardian(event.slot, payload?.device)
    if (!identity) return ignored(state)
    return result(
      updateDevice(state, event.slot, {
        connection: 'connected',
        device: identity,
        pairingCode: null,
        pairingCodeExpiresAt: null,
        codeAttempts: 0,
        codeError: null
      })
    )
  }

  const codeAttempts = device.codeAttempts + 1
  // Too many wrong codes drops this phone only; the rest of the roster is unaffected.
  if (codeAttempts >= PAIRING_CODE_MAX_ATTEMPTS) return resetDevice(state, event.slot)
  // The retry invite says only that the code was wrong; the code itself never leaves the screen.
  return result(updateDevice(state, event.slot, { codeAttempts, codeError: 'wrong' }), [
    { type: 'sendTo', slot: event.slot, messageType: 'PAIR_INVITE', payload: { rejected: true } }
  ])
}

function reduceQrPairing(state: CreateSessionState, event: CreateSessionEvent): ReduceResult {
  switch (event.type) {
    case 'PAIR_START':
    case 'QR_INVITE_SHOWN': {
      const connection = guardianState(state, event.slot)?.connection
      // Re-entering the invite page shows the invite again; tapping the card only starts once.
      const canShow =
        connection === 'empty' ||
        (event.type === 'QR_INVITE_SHOWN' && connection === 'invite_shown')
      if (!canShow) return ignored(state)
      return result(updateDevice(state, event.slot, { connection: 'invite_shown' }), [
        { type: 'display', slots: [event.slot], messageType: 'PAIR_INVITE' }
      ])
    }
    case 'QR_PHONE_SCANNED':
      if (guardianState(state, event.slot)?.connection !== 'invite_shown') return ignored(state)
      return result(state, [{ type: 'awaitScan', slot: event.slot, messageType: 'PAIR_RESPONSE' }])
    case 'MESSAGE_RECEIVED': {
      if (event.envelope.message_type !== 'PAIR_RESPONSE') return ignored(state)
      if (guardianState(state, event.slot)?.connection !== 'invite_shown') return ignored(state)
      const device = asGuardian(event.slot, parsePayload(event.envelope)?.device)
      if (!device) return ignored(state)
      // The reply also carries the phone's round-1 package, so round 1 is in hand already.
      return result(
        updateDevice(state, event.slot, { connection: 'connected', device, r1Received: true })
      )
    }
    default:
      return ignored(state)
  }
}

// Bluetooth: every round is a send to all phones and a wait for each one's reply. The extension's
// own share is computed by the Worker, so each phone's DKG message becomes a dkgAccept* effect and
// the Worker's answer comes back as a DKG_*_ACCEPTED event.

function reduceBleCeremony(state: CreateSessionState, event: CreateSessionEvent): ReduceResult {
  switch (event.type) {
    case 'MESSAGE_RECEIVED':
      return receiveBleMessage(state, event)
    case 'DKG_OPENED':
      return openDkg(state, event.sessionId)
    case 'DKG_ROUND1_ACCEPTED':
      return round1Accepted(state, event.slot, event.result)
    case 'DKG_ROUND2_ACCEPTED':
      return round2Accepted(state, event.slot, event.result)
    case 'FINGERPRINT_CONFIRMED': {
      if (event.stage !== 'final' || state.phase !== 'KEYSET_VERIFIED') return ignored(state)
      if (state.ownerConfirmed.final) return ignored(state)
      return activateWhenAllConfirmed({
        ...state,
        ownerConfirmed: { ...state.ownerConfirmed, final: true }
      })
    }
    default:
      return ignored(state)
  }
}

function rosterLockFor(state: CreateSessionState, slot: DeviceSlot): RosterLockPayload {
  if (state.dkgSessionId === null) throw new Error('ROSTER_LOCK needs the DKG session id')
  const shape = dkgShape(state.threshold)
  return {
    dkgSessionId: state.dkgSessionId,
    participants: shape.participants,
    threshold: shape.threshold,
    rosterSlot: rosterSlotOf(slot),
    mainnet: state.mainnet
  }
}

// Only the first id for a session that is waiting for one counts; anything else (a late reply
// after an abort, a second open) is dropped and the store closes the orphan.
function openDkg(state: CreateSessionState, sessionId: string): ReduceResult {
  if (state.phase !== 'DKG_R1' || state.dkgSessionId !== null) return ignored(state)
  const next = { ...state, dkgSessionId: sessionId }
  const slots = guardianSlots(next)
  return result(next, [
    ...slots.map(
      (slot): CreateSessionEffect => ({
        type: 'sendTo',
        slot,
        messageType: 'ROSTER_LOCK',
        payload: rosterLockFor(next, slot)
      })
    ),
    ...slots.map(
      (slot): CreateSessionEffect => ({ type: 'awaitFrom', slot, messageType: 'DKG_R1' })
    )
  ])
}

function acceptRequest(
  state: CreateSessionState,
  slot: DeviceSlot,
  envelope: MultisigEnvelope
): VaultDkgAcceptRequest | null {
  if (state.dkgSessionId === null) return null
  const payload = parseDkgEnvelopePayload(parsePayload(envelope))
  if (!payload) return null
  return {
    sessionId: state.dkgSessionId,
    senderSlot: rosterSlotOf(slot),
    envelope: payload.envelope
  }
}

// The Worker keys its per-phone output by roster slot; every phone in the roster must be there.
function perGuardian(
  state: CreateSessionState,
  values: Record<string, string>
): Map<DeviceSlot, string> | null {
  const out = new Map<DeviceSlot, string>()
  for (const slot of guardianSlots(state)) {
    const value = values[String(rosterSlotOf(slot))]
    if (typeof value !== 'string') return null
    out.set(slot, value)
  }
  return out
}

function markEveryGuardian(
  state: CreateSessionState,
  patch: Partial<Omit<DeviceSessionState, 'slot'>>
): CreateSessionState {
  return {
    ...state,
    devices: state.devices.map(device => (device.slot === 1 ? device : { ...device, ...patch }))
  }
}

function round1Accepted(
  state: CreateSessionState,
  slot: DeviceSlot,
  outcome: VaultDkgRound1Response
): ReduceResult {
  if (state.phase !== 'DKG_R1' || state.dkgSessionId === null) return ignored(state)
  const sender = guardianState(state, slot)
  if (!sender || sender.r1Received) return ignored(state)
  if (!outcome.complete) return result(updateDevice(state, slot, { r1Received: true }))

  // Complete means the Worker holds every phone's round 1, whatever order the answers came in.
  const next = markEveryGuardian(state, { r1Received: true })
  const bundles = perGuardian(next, outcome.bundles)
  if (!bundles) return abort(next, 'verification_failed')
  const slots = guardianSlots(next)
  return result({ ...next, r1Fingerprint: outcome.round1Hash }, [
    ...slots.map(
      (target): CreateSessionEffect => ({
        type: 'sendTo',
        slot: target,
        messageType: 'DKG_R1_BUNDLE',
        payload: { envelope: bundles.get(target) }
      })
    ),
    ...slots.map(
      (target): CreateSessionEffect => ({
        type: 'awaitFrom',
        slot: target,
        messageType: 'DKG_R1_ECHO'
      })
    )
  ])
}

function round2Accepted(
  state: CreateSessionState,
  slot: DeviceSlot,
  outcome: VaultDkgRound2Response
): ReduceResult {
  if (state.phase !== 'DKG_R2' || state.dkgSessionId === null) return ignored(state)
  const sender = guardianState(state, slot)
  if (!sender || sender.r2Received) return ignored(state)
  if (!outcome.complete) return result(updateDevice(state, slot, { r2Received: true }))

  const next = markEveryGuardian(state, { r2Received: true })
  const inboxes = perGuardian(next, outcome.inboxes)
  const sealedQsk = perGuardian(next, outcome.sealedQsk)
  if (!inboxes || !sealedQsk) return abort(next, 'verification_failed')
  // The record crossed chrome.runtime, so it is checked again; one sealed for another group or
  // network would later be stored under the wrong account.
  const vaultRecord = parseSealedVaultRecord(outcome.record)
  const network = state.mainnet ? 'mainnet' : 'testnet'
  if (!vaultRecord || vaultRecord.groupId !== state.groupId || vaultRecord.network !== network) {
    return abort(next, 'verification_failed')
  }
  // FINALIZED and KEYSET_SETUP have no screen of their own this round, so the session goes
  // straight to the final fingerprint check once the phones have what they need to reach it.
  const slots = guardianSlots(next)
  const verified: CreateSessionState = {
    ...next,
    phase: 'KEYSET_VERIFIED',
    finalFingerprint: outcome.fingerprint,
    vaultRecord
  }
  return result(verified, [
    ...slots.flatMap((target): CreateSessionEffect[] => [
      {
        type: 'sendTo',
        slot: target,
        messageType: 'DKG_R2_INBOX',
        payload: { envelope: inboxes.get(target) }
      },
      {
        type: 'sendTo',
        slot: target,
        messageType: 'KEYSET_SETUP',
        payload: { sealedQsk: sealedQsk.get(target) }
      }
    ]),
    ...slots.map(
      (target): CreateSessionEffect => ({
        type: 'awaitFrom',
        slot: target,
        messageType: 'DKG_FINAL'
      })
    )
  ])
}

function receiveBleMessage(state: CreateSessionState, event: MessageReceivedEvent): ReduceResult {
  const sender = guardianState(state, event.slot)
  if (!sender) return ignored(state)
  const type = event.envelope.message_type

  if (state.phase === 'DKG_R1' && type === 'DKG_R1' && !sender.r1Received) {
    const request = acceptRequest(state, event.slot, event.envelope)
    if (!request) return abort(state, 'verification_failed')
    return result(state, [{ type: 'dkgAcceptRound1', slot: event.slot, request }])
  }

  // An echo only means something once the bundle went out, i.e. after every round-1 package.
  if (
    state.phase === 'DKG_R1' &&
    type === 'DKG_R1_ECHO' &&
    !sender.r1Echoed &&
    everyGuardian(state, device => device.r1Received)
  ) {
    const echo = parseRound1EchoPayload(parsePayload(event.envelope))
    // A phone that saw a different round-1 set cannot be allowed into round 2.
    if (!echo || echo.round1Hash !== state.r1Fingerprint) {
      return abort(state, 'verification_failed')
    }
    const next = updateDevice(state, event.slot, { r1Echoed: true })
    if (!everyGuardian(next, device => device.r1Echoed)) return result(next)
    return result({ ...next, phase: 'DKG_R2' }, toEachGuardian(next, 'DKG_R1_CERT', 'DKG_R2_BATCH'))
  }

  if (state.phase === 'DKG_R2' && type === 'DKG_R2_BATCH' && !sender.r2Received) {
    const request = acceptRequest(state, event.slot, event.envelope)
    if (!request) return abort(state, 'verification_failed')
    return result(state, [{ type: 'dkgAcceptRound2', slot: event.slot, request }])
  }

  // A phone sends DKG_FINAL when its user matches the fingerprint, which can happen before or
  // after the owner does. Its fingerprint must be the one this side derived.
  if (state.phase === 'KEYSET_VERIFIED' && type === 'DKG_FINAL' && !sender.finalReceived) {
    const final = parseDkgFinalPayload(parsePayload(event.envelope))
    if (!final || final.fingerprint !== state.finalFingerprint) {
      return abort(state, 'verification_failed')
    }
    return activateWhenAllConfirmed(updateDevice(state, event.slot, { finalReceived: true }))
  }

  return ignored(state)
}

// Bluetooth activates only once the extension's share is stored: a group the phones activate
// while this side has nothing on disk could never sign. The phase stays KEYSET_VERIFIED, so the
// page does not move, until VAULT_RECORD_SAVED or VAULT_RECORD_SAVE_FAILED arrives.
function activateWhenAllConfirmed(state: CreateSessionState): ReduceResult {
  const ready = state.ownerConfirmed.final && everyGuardian(state, device => device.finalReceived)
  if (!ready) return result(state)
  if (state.savingRecord) return result(state)
  if (state.vaultRecord === null) return abort(state, 'verification_failed')
  return result({ ...state, savingRecord: true }, [
    { type: 'saveVaultRecord', groupId: state.groupId, record: state.vaultRecord }
  ])
}

// QR: walks the step plan from qr-plan.ts. Phases move as data arrives rather than by step
// number, so 2-of-2 and x-of-3 share one path.

function reduceQrCeremony(state: CreateSessionState, event: CreateSessionEvent): ReduceResult {
  if (state.phase === 'KEYSET_VERIFIED') {
    // No message reaches the extension after the last code, so the owner's match activates.
    if (event.type !== 'FINGERPRINT_CONFIRMED' || event.stage !== 'final') return ignored(state)
    return activate({ ...state, ownerConfirmed: { ...state.ownerConfirmed, final: true } })
  }

  const steps = buildQrCeremonySteps(state.threshold)
  if (state.qrCeremonyIndex < 0 || state.qrCeremonyIndex >= steps.length) return ignored(state)
  const step = steps[state.qrCeremonyIndex]

  switch (event.type) {
    case 'QR_PHONE_SCANNED':
      return step.kind === 'show' ? markPhoneScanned(state, step, event.slot) : ignored(state)
    case 'FINGERPRINT_CONFIRMED': {
      if (step.kind !== 'verify' || event.stage !== 'r1') return ignored(state)
      // Round 2 may only start after the user has compared the round-1 fingerprint by eye.
      return completeQrStep({
        ...state,
        phase: 'DKG_R2',
        ownerConfirmed: { ...state.ownerConfirmed, r1: true }
      })
    }
    case 'MESSAGE_RECEIVED':
      return step.kind === 'scan' ? receiveQrScan(state, step, event) : ignored(state)
    default:
      return ignored(state)
  }
}

function markPhoneScanned(state: CreateSessionState, step: QrStep, slot: DeviceSlot): ReduceResult {
  if (!step.slots.includes(slot) || state.qrShownTo.includes(slot)) return ignored(state)
  const next: CreateSessionState = { ...state, qrShownTo: [...state.qrShownTo, slot] }
  return step.slots.every(s => next.qrShownTo.includes(s)) ? completeQrStep(next) : result(next)
}

function receiveQrScan(
  state: CreateSessionState,
  step: QrStep,
  event: MessageReceivedEvent
): ReduceResult {
  if (event.slot !== step.slots[0]) return ignored(state)
  const type = event.envelope.message_type
  // The 2-of-2 4/4 code carries the phone's round-2 batch and its final result together, so
  // either name on the envelope is the same answer.
  const finalStep = step.messageType === 'DKG_FINAL'
  const accepted = type === step.messageType || (finalStep && type === 'DKG_R2_BATCH')
  if (!accepted) return ignored(state)
  const received = finalStep ? { r2Received: true, finalReceived: true } : { r2Received: true }
  return completeQrStep(updateDevice(state, event.slot, received))
}

function completeQrStep(state: CreateSessionState): ReduceResult {
  const steps = buildQrCeremonySteps(state.threshold)
  let next = state
  // With every round-2 batch in hand the extension computes its own share right away.
  if (next.phase === 'DKG_R2' && everyGuardian(next, device => device.r2Received)) {
    next = {
      ...next,
      phase: 'FINALIZED',
      finalFingerprint: deriveMockFingerprint(state.groupId, 'final')
    }
  }
  const index = next.qrCeremonyIndex + 1
  // The index stays on the last real step so step counters never see a past-the-end value;
  // KEYSET_VERIFIED is what tells the pages the codes are done.
  if (index >= steps.length) return result({ ...next, phase: 'KEYSET_VERIFIED' })
  return result({ ...next, qrCeremonyIndex: index, qrShownTo: [] }, qrStepEffects(steps[index]))
}

function qrStepEffects(step: QrStep): readonly CreateSessionEffect[] {
  if (step.messageType === null) return NO_EFFECTS
  switch (step.kind) {
    case 'show':
      return [{ type: 'display', slots: step.slots, messageType: step.messageType }]
    case 'scan':
      return [{ type: 'awaitScan', slot: step.slots[0], messageType: step.messageType }]
    case 'verify':
      return NO_EFFECTS
  }
}
