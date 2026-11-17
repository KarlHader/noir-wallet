import {
  dkgShape,
  parseDkgFinalPayload,
  parseRound1EchoPayload,
  rosterSlotOf,
  type RosterLockPayload
} from './dkg-protocol'
import type { VaultDkgRound1Response, VaultDkgRound2Response } from './dkg-rpc'
import {
  abort,
  acceptRequest,
  activate,
  allGuardiansConnected,
  emptyDevice,
  everyGuardian,
  guardians,
  guardianSlots,
  guardianSlotsOf,
  guardianState,
  ignored,
  markEveryGuardian,
  messageSender,
  parsePayload,
  perGuardian,
  resetDevice,
  result,
  switchTransport,
  updateDevice,
  type CreateSessionEffect,
  type CreateSessionEvent,
  type CreateSessionInput,
  type CreateSessionState,
  type DeviceSessionState,
  type MessageReceivedEvent,
  type ReduceResult
} from './create-session-shared'
import { reduceQrSession } from './create-session-qr'
import type { MultisigMessageType } from './messages'
import { parseSealedVaultRecord } from './vault-record'
import {
  PAIRING_CODE_MAX_ATTEMPTS,
  thresholdRequiresManualR1Check,
  type DeviceSlot,
  type MultisigDevice
} from './types'

export {
  allGuardiansConnected,
  guardianSlots,
  type CreateSessionEffect,
  type CreateSessionEvent,
  type CreateSessionInput,
  type CreateSessionState,
  type DeviceSessionState,
  type QrDisplayItem
} from './create-session-shared'
export { scanMarked } from './create-session-qr'

export function createInitialSession(input: CreateSessionInput): CreateSessionState {
  const owner: DeviceSessionState = {
    ...emptyDevice(1),
    connection: 'connected',
    device: input.owner
  }
  const slots = guardianSlotsOf(input.threshold)
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
    savingRecord: false,
    ownerIdentityPublicKey: null,
    qrDkgSessionId: input.qrDkgSessionId ?? '',
    roster: null,
    round2Outputs: null
  }
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
            confirmed: entry.finalReceived
          }
        ]
      : []
  )
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

export function reduceCreateSession(
  state: CreateSessionState,
  event: CreateSessionEvent
): { state: CreateSessionState; effects: readonly CreateSessionEffect[] } {
  // Both outcomes are final: a new attempt starts a new session.
  if (state.phase === 'ABORTED' || state.phase === 'ACTIVATED') return ignored(state)
  if (state.transportKind === 'qr') return reduceQrSession(state, event)

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
  return reduceBleCeremony(state, event)
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
      return reduceBlePairing(state, event)
  }
}

// The Worker opens the DKG session first; ROSTER_LOCK goes out once its id is known.
function lockRoster(state: CreateSessionState): ReduceResult {
  if (!allGuardiansConnected(state)) return ignored(state)
  const shape = dkgShape(state.threshold)
  return result({ ...state, phase: 'DKG_R1' }, [
    { type: 'dkgOpen', ...shape, mainnet: state.mainnet, groupId: state.groupId }
  ])
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
