import { bytesToBase64 } from '@/lib/bytes'
import {
  rosterBeforeDkg,
  abort,
  acceptRequest,
  activate,
  allGuardiansConnected,
  everyGuardian,
  guardians,
  guardianSlots,
  guardianState,
  ignored,
  markEveryGuardian,
  messageSender,
  NO_EFFECTS,
  parsePayload,
  perGuardian,
  resetDevice,
  result,
  switchTransport,
  updateDevice
} from './create-session-shared'
import type {
  CreateSessionEffect,
  CreateSessionEvent,
  CreateSessionState,
  DeviceSessionState,
  MessageReceivedEvent,
  QrDisplayItem,
  ReduceResult
} from './create-session-shared'
import {
  dkgShape,
  parseDkgFinalPayload,
  parsePairResponsePayload,
  parseRound1EchoPayload,
  rosterSlotOf
} from './dkg-protocol'
import type { PairInvitePayload, RosterLockPayload } from './dkg-protocol'
import type { VaultDkgRound1Response, VaultDkgRound2Response } from './dkg-rpc'
import { parseIdentityPublicKey } from './identity'
import type { MultisigMessageType } from './messages'
import { buildQrCeremonySteps } from './qr-plan'
import type { QrStep } from './qr-plan'
import { buildRoster } from './roster'
import type { RosterManifest } from './roster'
import { parseSealedVaultRecord } from './vault-record'
import type { DeviceSlot, VerifyStage } from './types'

/**
 * The QR transport: every message travels as a code one side shows and the other scans, so the
 * extension never hears from a phone except through a scan the user makes.
 */
export function reduceQrSession(
  state: CreateSessionState,
  event: CreateSessionEvent
): ReduceResult {
  switch (event.type) {
    case 'USER_ABORT':
      return abort(state, 'user_cancelled')
    case 'STEP_TIMEOUT':
      return abort(state, 'session_expired')
    case 'DKG_FAILED':
      // A DKG error is never retried: the Worker has already voided its session.
      return abort(state, 'verification_failed')
    case 'MESSAGE_REJECTED':
      // A code that fails its signature, hash or ordering check could be anyone's.
      return abort(state, 'verification_failed')
    case 'FINGERPRINT_REJECTED':
      return abort(state, 'fingerprint_mismatch')
    case 'VAULT_RECORD_SAVED':
      // Only a save this session asked for counts; anything else is a stale answer. The phones'
      // shares are shown only now, so no phone can hold a share of a group this side lost.
      if (state.phase !== 'FINALIZED' || !state.savingRecord) return ignored(state)
      return advance({ ...state, phase: 'KEYSET_VERIFIED', savingRecord: false })
    case 'VAULT_RECORD_SAVE_FAILED':
      // A share that is not on disk cannot back a group, so the ceremony is void.
      return state.savingRecord ? abort(state, 'save_failed') : ignored(state)
    case 'MESSAGE_RECEIVED': {
      if (!messageSender(state, event)) return ignored(state)
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
  if (event.type === 'DKG_OPENED') return openDkg(state, event.sessionId)
  return reduceCeremony(state, event)
}

function reducePairing(state: CreateSessionState, event: CreateSessionEvent): ReduceResult {
  switch (event.type) {
    case 'IDENTITY_READY':
      // Every invite already shown carries the first identity, so it can never change.
      if (state.ownerIdentityPublicKey !== null) return ignored(state)
      return result({ ...state, ownerIdentityPublicKey: event.publicKey })
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
    case 'PAIR_START':
    case 'QR_INVITE_SHOWN': {
      // The invite names the extension's identity and the DKG session; without both there is
      // nothing a phone could pair with.
      if (state.ownerIdentityPublicKey === null || state.qrDkgSessionId === '') {
        return ignored(state)
      }
      const connection = guardianState(state, event.slot)?.connection
      // Re-entering the invite page shows the invite again; tapping the card only starts once.
      const canShow =
        connection === 'empty' ||
        (event.type === 'QR_INVITE_SHOWN' && connection === 'invite_shown')
      if (!canShow) return ignored(state)
      return result(updateDevice(state, event.slot, { connection: 'invite_shown' }), [
        {
          type: 'display',
          stepKey: `pair:${event.slot}:invite`,
          items: [
            {
              slot: event.slot,
              messageType: 'PAIR_INVITE',
              payload: pairInvitePayload(state, event.slot)
            }
          ]
        }
      ])
    }
    case 'QR_PHONE_SCANNED':
      if (guardianState(state, event.slot)?.connection !== 'invite_shown') return ignored(state)
      return result(state, [
        { type: 'awaitScan', slots: [event.slot], messageType: 'PAIR_RESPONSE' }
      ])
    case 'MESSAGE_RECEIVED': {
      if (event.envelope.message_type !== 'PAIR_RESPONSE') return ignored(state)
      if (guardianState(state, event.slot)?.connection !== 'invite_shown') return ignored(state)
      const reply = parsePairResponsePayload(parsePayload(event.envelope))
      const identity = reply ? parseIdentityPublicKey(reply.identityPublicKey) : null
      if (!reply || !identity) return ignored(state)
      // Slot and role come from the slot being paired, never from the phone's reply. The key is
      // stored in canonical base64 so the roster and the inbound gate name it the same way.
      return result(
        updateDevice(state, event.slot, {
          connection: 'identity_check',
          identityPublicKey: bytesToBase64(identity.bytes),
          device: { slot: event.slot, role: 'guardian', ...reply.device }
        })
      )
    }
    case 'IDENTITY_CONFIRMED':
      if (guardianState(state, event.slot)?.connection !== 'identity_check') return ignored(state)
      return result(
        updateDevice(state, event.slot, { connection: 'connected', identityConfirmed: true })
      )
    case 'IDENTITY_REJECTED':
      if (guardianState(state, event.slot)?.connection !== 'identity_check') return ignored(state)
      return abort(state, 'fingerprint_mismatch')
    default:
      return ignored(state)
  }
}

// The Worker must open its session under the id the invites already carried, so the phones'
// round-1 messages name the session that will accept them.
function lockRoster(state: CreateSessionState): ReduceResult {
  if (!allGuardiansConnected(state)) return ignored(state)
  return result({ ...state, phase: 'DKG_R1', roster: rosterBeforeDkg(state) }, [
    {
      type: 'dkgOpen',
      ...dkgShape(state.threshold),
      mainnet: state.mainnet,
      groupId: state.groupId,
      sessionId: state.qrDkgSessionId
    }
  ])
}

// The roster is fixed only once the Worker session exists, and ROSTER_LOCK is shown only then:
// a phone that scans it answers with DKG_R1, which needs that session to land in.
function openDkg(state: CreateSessionState, sessionId: string): ReduceResult {
  if (state.phase !== 'DKG_R1' || state.dkgSessionId !== null) return ignored(state)
  // Any other id means the phones were invited into a session the Worker does not have.
  if (sessionId !== state.qrDkgSessionId) {
    return abort({ ...state, dkgSessionId: sessionId }, 'verification_failed')
  }
  if (state.ownerIdentityPublicKey === null) return abort(state, 'verification_failed')
  const identities = new Map<number, string>([[rosterSlotOf(1), state.ownerIdentityPublicKey]])
  for (const device of guardians(state)) {
    if (device.identityPublicKey === null) return abort(state, 'verification_failed')
    identities.set(rosterSlotOf(device.slot), device.identityPublicKey)
  }
  const roster = buildRoster({
    groupId: state.groupId,
    threshold: dkgShape(state.threshold).threshold,
    identities
  })
  const next: CreateSessionState = {
    ...state,
    dkgSessionId: sessionId,
    roster,
    qrCeremonyIndex: 0,
    qrShownTo: []
  }
  return result(next, qrStepEffects(next, 0))
}

export function pairInvitePayload(state: CreateSessionState, slot: DeviceSlot): PairInvitePayload {
  const owner = state.devices.find(device => device.slot === 1)?.device
  if (!owner || state.ownerIdentityPublicKey === null) {
    throw new Error('PAIR_INVITE needs the owner device and identity')
  }
  return {
    identityPublicKey: state.ownerIdentityPublicKey,
    device: { name: owner.name, model: owner.model, platform: 'extension' },
    dkgSessionId: state.qrDkgSessionId,
    ...dkgShape(state.threshold),
    rosterSlot: rosterSlotOf(slot),
    mainnet: state.mainnet
  }
}

export function rosterLockPayload(
  state: CreateSessionState,
  slot: DeviceSlot
): RosterLockPayload & { roster: RosterManifest } {
  if (state.dkgSessionId === null || state.roster === null) {
    throw new Error('ROSTER_LOCK needs the DKG session and the roster')
  }
  return {
    dkgSessionId: state.dkgSessionId,
    ...dkgShape(state.threshold),
    rosterSlot: rosterSlotOf(slot),
    mainnet: state.mainnet,
    roster: state.roster
  }
}

function round2Output(
  state: CreateSessionState,
  slot: DeviceSlot
): { inbox: string; sealedQsk: string } {
  const output = state.round2Outputs?.[String(rosterSlotOf(slot))]
  if (!output) throw new Error('The shares step needs the round-2 output of every phone')
  return output
}

// Round-1 bundles are shown once, straight from the Worker's answer, so they are never kept.
function showPayload(
  state: CreateSessionState,
  slot: DeviceSlot,
  messageType: MultisigMessageType,
  bundles: ReadonlyMap<DeviceSlot, string> | null
): Record<string, unknown> | undefined {
  switch (messageType) {
    case 'ROSTER_LOCK':
      return rosterLockPayload(state, slot)
    case 'DKG_R1_BUNDLE': {
      const envelope = bundles?.get(slot)
      if (envelope === undefined) throw new Error('DKG_R1_BUNDLE needs the Worker bundles')
      return { envelope }
    }
    case 'DKG_R2_INBOX':
      return { envelope: round2Output(state, slot).inbox }
    case 'KEYSET_SETUP':
      return { sealedQsk: round2Output(state, slot).sealedQsk }
    default:
      return undefined
  }
}

function qrStepEffects(
  state: CreateSessionState,
  index: number,
  bundles: ReadonlyMap<DeviceSlot, string> | null = null
): readonly CreateSessionEffect[] {
  const step = buildQrCeremonySteps(state.threshold)[index]
  if (!step) return NO_EFFECTS
  switch (step.kind) {
    case 'show': {
      // Grouped per phone, so each phone's codes sit next to each other on the page.
      const items = step.slots.flatMap(slot =>
        step.messageTypes.map((messageType): QrDisplayItem => {
          const payload = showPayload(state, slot, messageType, bundles)
          return payload ? { slot, messageType, payload } : { slot, messageType }
        })
      )
      return [{ type: 'display', stepKey: `ceremony:${index}`, items }]
    }
    case 'scan':
      return [{ type: 'awaitScan', slots: step.slots, messageType: step.messageType }]
    case 'verify':
      return NO_EFFECTS
  }
}

// The ceremony is a fixed list of steps (qr-plan). Each event may complete the current step only;
// anything aimed at another step is ignored, so a stray scan cannot skip a check.

function reduceCeremony(state: CreateSessionState, event: CreateSessionEvent): ReduceResult {
  const step = buildQrCeremonySteps(state.threshold)[state.qrCeremonyIndex]
  if (!step || state.dkgSessionId === null) return ignored(state)
  switch (event.type) {
    case 'QR_PHONE_SCANNED':
      return step.kind === 'show' ? phoneScanned(state, step.slots, event.slot) : ignored(state)
    case 'FINGERPRINT_CONFIRMED':
      return step.kind === 'verify' && step.stage === event.stage
        ? fingerprintConfirmed(state, event.stage)
        : ignored(state)
    case 'MESSAGE_RECEIVED':
      return step.kind === 'scan' ? codeScanned(state, step, event) : ignored(state)
    case 'DKG_ROUND1_ACCEPTED':
      return isScanFor(step, 'DKG_R1', event.slot)
        ? round1Accepted(state, event.slot, event.result)
        : ignored(state)
    case 'DKG_ROUND1_CONFIRMED': {
      if (
        !state.authenticatedDkg ||
        !isScanFor(step, 'DKG_R1_ECHO', event.slot) ||
        guardianState(state, event.slot)?.r1Echoed !== false
      )
        return ignored(state)
      const next = updateDevice(state, event.slot, { r1Echoed: true })
      return everyGuardian(next, d => d.r1Echoed)
        ? advance({ ...next, phase: 'DKG_R2' })
        : result(next)
    }
    case 'DKG_ROUND2_ACCEPTED':
      return isScanFor(step, 'DKG_R2_BATCH', event.slot)
        ? round2Accepted(state, event.slot, event.result)
        : ignored(state)
    default:
      return ignored(state)
  }
}

function advance(
  state: CreateSessionState,
  bundles: ReadonlyMap<DeviceSlot, string> | null = null
): ReduceResult {
  const next = { ...state, qrCeremonyIndex: state.qrCeremonyIndex + 1, qrShownTo: [] }
  return result(next, qrStepEffects(next, next.qrCeremonyIndex, bundles))
}

function isScanFor(step: QrStep, messageType: MultisigMessageType, slot: DeviceSlot): boolean {
  return step.kind === 'scan' && step.messageType === messageType && step.slots.includes(slot)
}

/** Whether a scan step already has this phone's code, read from the per-phone flag it sets. */
export function scanMarked(device: DeviceSessionState, messageType: MultisigMessageType): boolean {
  switch (messageType) {
    case 'DKG_R1':
      return device.r1Received
    case 'DKG_R1_ECHO':
      return device.r1Echoed
    case 'DKG_R2_BATCH':
      return device.r2Received
    case 'DKG_FINAL':
      return device.finalReceived
    case 'PAIR_RESPONSE':
      // A pairing reply moves the phone past invite_shown (to the identity check).
      return device.connection !== 'invite_shown'
    default:
      // No other type is ever collected on a scan step, so treat it as already read.
      return true
  }
}

function phoneScanned(
  state: CreateSessionState,
  slots: readonly DeviceSlot[],
  slot: DeviceSlot
): ReduceResult {
  if (!slots.includes(slot) || state.qrShownTo.includes(slot)) return ignored(state)
  const qrShownTo = [...state.qrShownTo, slot]
  const next = { ...state, qrShownTo }
  return slots.every(each => qrShownTo.includes(each)) ? advance(next) : result(next)
}

function fingerprintConfirmed(state: CreateSessionState, stage: VerifyStage): ReduceResult {
  if (stage === 'r1' || stage === 'final') {
    return advance({ ...state, ownerConfirmed: { ...state.ownerConfirmed, [stage]: true } })
  }
  return advance(state)
}

// The inbound gate has already checked session, signature and order; this only decides whether
// the code belongs to the step on screen and, for the check values, whether it agrees.
function codeScanned(
  state: CreateSessionState,
  step: Extract<QrStep, { kind: 'scan' }>,
  event: MessageReceivedEvent
): ReduceResult {
  if (!isScanFor(step, event.envelope.message_type, event.slot)) return ignored(state)
  const sender = guardianState(state, event.slot)
  if (!sender || scanMarked(sender, step.messageType)) return ignored(state)

  switch (step.messageType) {
    case 'DKG_R1':
    case 'DKG_R2_BATCH': {
      // Marked only once the Worker accepts it: it may still refuse the envelope.
      const request = acceptRequest(state, event.slot, event.envelope)
      if (!request) return abort(state, 'verification_failed')
      if (step.messageType === 'DKG_R2_BATCH') {
        return result(state, [{ type: 'dkgAcceptRound2', slot: event.slot, request }])
      }
      return result(updateDevice(state, event.slot, { round1Envelope: event.envelope }), [
        { type: 'dkgAcceptRound1', slot: event.slot, request }
      ])
    }
    case 'DKG_R1_ECHO': {
      const echo = parseRound1EchoPayload(parsePayload(event.envelope))
      // A phone that saw a different round-1 set cannot be allowed into round 2.
      if (!echo || echo.round1Hash !== state.r1Fingerprint) {
        return abort(state, 'verification_failed')
      }
      if (state.authenticatedDkg && state.dkgSessionId)
        return result(state, [
          {
            type: 'dkgConfirmRound1',
            slot: event.slot,
            request: { sessionId: state.dkgSessionId, signedEnvelope: event.envelope }
          }
        ])
      const next = updateDevice(state, event.slot, { r1Echoed: true })
      if (!everyGuardian(next, device => device.r1Echoed)) return result(next)
      return advance({ ...next, phase: 'DKG_R2' })
    }
    case 'DKG_FINAL': {
      const final = parseDkgFinalPayload(parsePayload(event.envelope))
      if (!final || final.fingerprint !== state.finalFingerprint) {
        return abort(state, 'verification_failed')
      }
      const next = updateDevice(state, event.slot, {
        finalReceived: true,
        finalEnvelope: event.envelope
      })
      // The owner confirms on the verify step before this one; activation still requires it, so a
      // reordered plan cannot activate an unconfirmed group.
      if (!everyGuardian(next, device => device.finalReceived) || !next.ownerConfirmed.final) {
        return result(next)
      }
      return activate(next)
    }
    default:
      return ignored(state)
  }
}

function round1Accepted(
  state: CreateSessionState,
  slot: DeviceSlot,
  outcome: VaultDkgRound1Response
): ReduceResult {
  if (guardianState(state, slot)?.r1Received !== false) return ignored(state)
  if (!outcome.complete) return result(updateDevice(state, slot, { r1Received: true }))

  // Complete means the Worker holds every phone's round 1, whatever order the answers came in.
  const next = markEveryGuardian(state, { r1Received: true })
  const bundles = perGuardian(next, outcome.bundles)
  if (!bundles) return abort(next, 'verification_failed')
  return advance({ ...next, r1Fingerprint: outcome.round1Hash }, bundles)
}

function round2Accepted(
  state: CreateSessionState,
  slot: DeviceSlot,
  outcome: VaultDkgRound2Response
): ReduceResult {
  if (guardianState(state, slot)?.r2Received !== false) return ignored(state)
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
  const round2Outputs: Record<string, { inbox: string; sealedQsk: string }> = {}
  for (const target of guardianSlots(next)) {
    round2Outputs[String(rosterSlotOf(target))] = {
      inbox: inboxes.get(target) as string,
      sealedQsk: sealedQsk.get(target) as string
    }
  }
  // Nothing is shown until the save succeeds: the next step hands the phones their shares.
  return result(
    {
      ...next,
      phase: 'FINALIZED',
      finalFingerprint: outcome.fingerprint,
      vaultRecord,
      round2Outputs,
      savingRecord: true
    },
    [{ type: 'saveVaultRecord', groupId: state.groupId, record: vaultRecord }]
  )
}
