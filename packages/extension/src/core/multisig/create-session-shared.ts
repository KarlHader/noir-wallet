import { parseDkgEnvelopePayload, rosterSlotOf, dkgShape } from './dkg-protocol'
import { buildRoster } from './roster'
import type {
  VaultDkgAcceptRequest,
  VaultDkgRound1Response,
  VaultDkgRound2Response
} from './dkg-rpc'
import type { InvalidReason } from './inbound-gate'
import { deviceId } from './messages'
import type { MultisigEnvelope, MultisigMessageType } from './messages'
import type { RosterManifest } from './roster'
import type { SealedVaultRecord } from './vault-record'
import { thresholdDeviceCount, thresholdRequiresManualR1Check } from './types'
import type {
  AbortReason,
  DeviceConnectionState,
  DeviceSlot,
  MultisigDevice,
  MultisigGroupRecord,
  MultisigThreshold,
  MultisigTransportKind,
  SessionPhase,
  VerifyStage
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
  finalEnvelope: MultisigEnvelope | null
  /** The phone's identity key (base64): from its pairing reply over QR, from the handshake over Bluetooth. */
  identityPublicKey: string | null
  /** Bluetooth only: the phone's Noise static key (base64), which the roster names as its transport key. */
  transportPublicKey: string | null
  /** QR only: the user has matched the phone's identity on both screens. */
  identityConfirmed: boolean
  /** QR only: the phone's round-1 message, kept until the bundle is built. */
  round1Envelope: MultisigEnvelope | null
}

export interface CreateSessionState {
  authenticatedDkg: boolean
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
  /** The Worker's DKG session (base64), from DKG_OPENED until the end. */
  dkgSessionId: string | null
  /** The extension's sealed share from round 2; ciphertext, never the share. */
  vaultRecord: SealedVaultRecord | null
  /** The record is on its way to storage and activation waits for the answer. */
  savingRecord: boolean
  /** The extension's identity key (base64), null until the store has loaded it. */
  ownerIdentityPublicKey: string | null
  /** Bluetooth only: the extension's Noise static key (base64) for this session's channels. */
  ownerTransportPublicKey: string | null
  /**
   * The DKG session id (base64 of 16 bytes) prepared before pairing. QR invites carry it, so the
   * Worker must open its session under this id; empty means none was prepared.
   */
  qrDkgSessionId: string
  /** QR only: the roster every phone signs up to, fixed once the Worker session is open. */
  roster: RosterManifest | null
  /** QR only: the Worker's round-2 output per roster slot, until it has been shown. */
  round2Outputs: Record<string, { inbox: string; sealedQsk: string }> | null
}

export type CreateSessionEvent =
  | { type: 'PAIR_START'; slot: DeviceSlot }
  | { type: 'PAIR_DEVICE_SELECTED'; slot: DeviceSlot; device: MultisigDevice }
  | { type: 'PAIR_SELECTION_CANCELLED'; slot: DeviceSlot }
  | { type: 'PAIR_CODE_ISSUED'; slot: DeviceSlot; code: string; expiresAt: number }
  | { type: 'PAIR_CODE_EXPIRED'; slot: DeviceSlot }
  | { type: 'PAIR_CODE_RESEND'; slot: DeviceSlot }
  | { type: 'PAIR_CANCEL'; slot: DeviceSlot }
  /**
   * Bluetooth: the encrypted channel to the phone is up and its identity is bound to it. The SAS
   * is shown on both screens for the user to compare before anything is sent over the channel.
   */
  | {
      type: 'PAIR_SAS_READY'
      slot: DeviceSlot
      sas: string
      identityPublicKey: string
      transportPublicKey: string
      ownerTransportPublicKey: string
    }
  /** Bluetooth: the user says the SAS on this screen matches the phone's. */
  | { type: 'PAIR_SAS_CONFIRMED'; slot: DeviceSlot }
  | { type: 'QR_INVITE_SHOWN'; slot: DeviceSlot }
  | { type: 'QR_PHONE_SCANNED'; slot: DeviceSlot }
  | { type: 'MESSAGE_RECEIVED'; slot: DeviceSlot; envelope: MultisigEnvelope; at: number }
  | { type: 'MESSAGE_REJECTED'; slot: DeviceSlot; reason: InvalidReason }
  | { type: 'DEVICE_DISCONNECTED'; slot: DeviceSlot }
  | { type: 'CONTINUE' }
  | { type: 'IDENTITY_READY'; publicKey: string }
  | { type: 'IDENTITY_CONFIRMED'; slot: DeviceSlot }
  | { type: 'IDENTITY_REJECTED'; slot: DeviceSlot }
  | { type: 'FINGERPRINT_CONFIRMED'; stage: VerifyStage }
  | { type: 'FINGERPRINT_REJECTED'; stage: VerifyStage }
  | { type: 'SWITCH_TRANSPORT'; kind: MultisigTransportKind }
  | { type: 'STEP_TIMEOUT' }
  | { type: 'USER_ABORT' }
  | { type: 'DKG_OPENED'; sessionId: string }
  | { type: 'DKG_ROUND1_ACCEPTED'; slot: DeviceSlot; result: VaultDkgRound1Response }
  | { type: 'DKG_ROUND1_CONFIRMED'; slot: DeviceSlot }
  | { type: 'DKG_ROUND2_ACCEPTED'; slot: DeviceSlot; result: VaultDkgRound2Response }
  | { type: 'DKG_FAILED' }
  | { type: 'VAULT_RECORD_SAVED' }
  | { type: 'VAULT_RECORD_SAVE_FAILED' }

export type QrDisplayItem = {
  slot: DeviceSlot
  messageType: MultisigMessageType
  payload?: Record<string, unknown>
}

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
  | { type: 'display'; stepKey: string; items: readonly QrDisplayItem[] }
  | { type: 'awaitScan'; slots: readonly DeviceSlot[]; messageType: MultisigMessageType }
  | { type: 'disconnect'; slot: DeviceSlot }
  | { type: 'persistGroup'; record: MultisigGroupRecord }
  | {
      type: 'dkgOpen'
      participants: 2 | 3
      threshold: 2 | 3
      mainnet: boolean
      groupId: string
      sessionId?: string
    }
  | { type: 'dkgAcceptRound1'; slot: DeviceSlot; request: VaultDkgAcceptRequest }
  | {
      type: 'dkgConfirmRound1'
      slot: DeviceSlot
      request: { sessionId: string; signedEnvelope: MultisigEnvelope }
    }
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
  qrDkgSessionId?: string
  authenticatedDkg?: boolean
}

export interface ReduceResult {
  state: CreateSessionState
  effects: readonly CreateSessionEffect[]
}

export type MessageReceivedEvent = Extract<CreateSessionEvent, { type: 'MESSAGE_RECEIVED' }>

export const NO_EFFECTS: readonly CreateSessionEffect[] = []
const TWO_DEVICE_GUARDIANS: readonly DeviceSlot[] = [2]
const THREE_DEVICE_GUARDIANS: readonly DeviceSlot[] = [2, 3]

export function emptyDevice(slot: DeviceSlot): DeviceSessionState {
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
    finalReceived: false,
    finalEnvelope: null,
    identityPublicKey: null,
    transportPublicKey: null,
    identityConfirmed: false,
    round1Envelope: null
  }
}

export function guardianSlotsOf(threshold: MultisigThreshold): readonly DeviceSlot[] {
  return thresholdDeviceCount(threshold) === 2 ? TWO_DEVICE_GUARDIANS : THREE_DEVICE_GUARDIANS
}

export function guardianSlots(state: CreateSessionState): readonly DeviceSlot[] {
  return guardianSlotsOf(state.threshold)
}

/** Freeze the complete identity roster before the Worker seals its account binding. */
export function rosterBeforeDkg(state: CreateSessionState): RosterManifest | null {
  if (!state.ownerIdentityPublicKey) return null
  const identities = new Map<number, string>([[0, state.ownerIdentityPublicKey]])
  const transports = new Map<number, string>()
  if (state.transportKind === 'ble') {
    if (!state.ownerTransportPublicKey) return null
    transports.set(0, state.ownerTransportPublicKey)
  }
  for (const device of guardians(state)) {
    if (!device.identityPublicKey) return null
    identities.set(rosterSlotOf(device.slot), device.identityPublicKey)
    if (state.transportKind === 'ble') {
      if (!device.transportPublicKey) return null
      transports.set(rosterSlotOf(device.slot), device.transportPublicKey)
    }
  }
  return buildRoster({
    groupId: state.groupId,
    threshold: dkgShape(state.threshold).threshold,
    identities,
    ...(state.transportKind === 'ble' ? { transportPublicKeys: transports } : {})
  })
}

export function guardians(state: CreateSessionState): readonly DeviceSessionState[] {
  return state.devices.filter(device => device.slot !== 1)
}

export function everyGuardian(
  state: CreateSessionState,
  predicate: (device: DeviceSessionState) => boolean
): boolean {
  return guardians(state).every(predicate)
}

export function allGuardiansConnected(state: CreateSessionState): boolean {
  return everyGuardian(state, device => device.connection === 'connected')
}

export function result(
  state: CreateSessionState,
  effects: readonly CreateSessionEffect[] = NO_EFFECTS
): ReduceResult {
  return { state, effects }
}

// "Ignored" means the caller gets back the very same state object, so it can tell nothing happened.
export function ignored(state: CreateSessionState): ReduceResult {
  return result(state)
}

export function guardianState(
  state: CreateSessionState,
  slot: DeviceSlot
): DeviceSessionState | null {
  if (slot === 1) return null
  return state.devices.find(device => device.slot === slot) ?? null
}

export function updateDevice(
  state: CreateSessionState,
  slot: DeviceSlot,
  patch: Partial<Omit<DeviceSessionState, 'slot'>>
): CreateSessionState {
  return {
    ...state,
    devices: state.devices.map(device => (device.slot === slot ? { ...device, ...patch } : device))
  }
}

export function resetDevice(state: CreateSessionState, slot: DeviceSlot): ReduceResult {
  const devices = state.devices.map(d => (d.slot === slot ? emptyDevice(slot) : d))
  return result({ ...state, devices }, [{ type: 'disconnect', slot }])
}

export function abort(state: CreateSessionState, reason: AbortReason): ReduceResult {
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

export function parsePayload(envelope: MultisigEnvelope): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(envelope.encrypted_payload)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
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

export function activate(state: CreateSessionState): ReduceResult {
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
  // Activation happens once Background has confirmed the sealed record is stored: the share now
  // lives in that record, so the Worker session holds nothing that is still needed.
  const release: CreateSessionEffect[] =
    state.dkgSessionId !== null ? [{ type: 'dkgClose', sessionId: state.dkgSessionId }] : []
  return result({ ...state, phase: 'ACTIVATED' }, [...announce, persist, ...release])
}

// Accepts a message only from this session, from a guardian slot that is actually in the flow,
// and from the phone that slot belongs to. Whether its type is expected is decided per phase.
export function messageSender(
  state: CreateSessionState,
  event: MessageReceivedEvent
): DeviceSessionState | null {
  if (event.envelope.session_id !== state.sessionId) return null
  if (event.envelope.sender_id !== deviceId(event.slot)) return null
  const sender = guardianState(state, event.slot)
  return sender && sender.connection !== 'empty' ? sender : null
}

export function switchTransport(
  state: CreateSessionState,
  kind: MultisigTransportKind
): ReduceResult {
  if (kind === state.transportKind) return ignored(state)
  // The two transports never mix within one group, so a started pairing cannot carry over.
  if (!everyGuardian(state, device => device.connection === 'empty')) {
    return abort(state, 'transport_switched')
  }
  const manualR1Check = thresholdRequiresManualR1Check(state.threshold, kind)
  return result({ ...state, transportKind: kind, manualR1Check })
}

export function acceptRequest(
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
    envelope: payload.envelope,
    ...(state.authenticatedDkg ? { signedEnvelope: envelope } : {})
  }
}

// The Worker keys its per-phone output by roster slot; every phone in the roster must be there.
export function perGuardian(
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

export function markEveryGuardian(
  state: CreateSessionState,
  patch: Partial<Omit<DeviceSessionState, 'slot'>>
): CreateSessionState {
  return {
    ...state,
    devices: state.devices.map(device => (device.slot === 1 ? device : { ...device, ...patch }))
  }
}
