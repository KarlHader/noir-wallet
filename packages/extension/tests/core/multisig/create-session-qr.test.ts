import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  createInitialSession,
  reduceCreateSession,
  verifyPageDevices
} from '../../../src/core/multisig/create-session'
import type {
  CreateSessionEffect,
  CreateSessionEvent,
  CreateSessionState
} from '../../../src/core/multisig/create-session'
import type {
  VaultDkgRound1Response,
  VaultDkgRound2Response
} from '../../../src/core/multisig/dkg-rpc'
import { createEnvelopeFactory, deviceId } from '../../../src/core/multisig/messages'
import type { MultisigMessageType } from '../../../src/core/multisig/messages'
import {
  QR_TRANSPORT_PUBLIC_KEY,
  ROSTER_CIPHERSUITE,
  rosterHash
} from '../../../src/core/multisig/roster'
import type { MultisigDevice, MultisigThreshold } from '../../../src/core/multisig/types'
import type { SealedVaultRecord } from '../../../src/core/multisig/vault-record'
import { bytesToBase64 } from '../../../src/lib/bytes'

const GROUP_ID = 'group-1'
const SESSION_ID = 'session-1'
const QR_SESSION = 'AAECAwQFBgcICQoLDA0ODw=='
const OTHER_SESSION = 'EBESExQVFhcYGRobHB0eHw=='

const fill = (length: number, value: number) => new Uint8Array(length).fill(value)
// Identity key of roster slot s: version byte, then the Ed25519 and X25519 halves.
const ID = (s: number) =>
  bytesToBase64(Uint8Array.from([1, ...fill(32, 0xa0 + s), ...fill(32, 0xb0 + s)]))

const OWNER: MultisigDevice = {
  slot: 1,
  role: 'owner',
  name: 'Account 1',
  model: 'MacBook',
  platform: 'extension'
}
const PHONES: Record<2 | 3, MultisigDevice> = {
  2: { slot: 2, role: 'guardian', name: 'Alex', model: 'iPhone 17', platform: 'ios' },
  3: { slot: 3, role: 'guardian', name: 'Alex backup', model: 'Android', platform: 'android' }
}

function start(threshold: MultisigThreshold, qrDkgSessionId = QR_SESSION) {
  return createInitialSession({
    groupId: GROUP_ID,
    sessionId: SESSION_ID,
    threshold,
    transportKind: 'qr',
    owner: OWNER,
    mainnet: true,
    qrDkgSessionId
  })
}

function run(state: CreateSessionState, ...events: readonly CreateSessionEvent[]) {
  const effects: CreateSessionEffect[] = []
  let current = state
  for (const event of events) {
    const result = reduceCreateSession(current, event)
    current = result.state
    effects.push(...result.effects)
  }
  return { state: current, effects }
}

function message(
  slot: 2 | 3,
  type: MultisigMessageType,
  payload: Record<string, unknown> = {}
): CreateSessionEvent {
  const make = createEnvelopeFactory({
    groupId: GROUP_ID,
    sessionId: SESSION_ID,
    senderId: deviceId(slot)
  })
  return { type: 'MESSAGE_RECEIVED', slot, envelope: make(type, deviceId(1), payload), at: 1_000 }
}

const IDENTITY_READY: CreateSessionEvent = { type: 'IDENTITY_READY', publicKey: ID(0) }

function reply(slot: 2 | 3): CreateSessionEvent {
  const { name, model, platform } = PHONES[slot]
  return message(slot, 'PAIR_RESPONSE', {
    identityPublicKey: ID(slot - 1),
    device: { name, model, platform }
  })
}

// Invite, reply and identity check for one phone.
function pair(slot: 2 | 3): CreateSessionEvent[] {
  return [
    { type: 'PAIR_START', slot },
    { type: 'QR_PHONE_SCANNED', slot },
    reply(slot),
    { type: 'IDENTITY_CONFIRMED', slot }
  ]
}

function paired(threshold: MultisigThreshold): CreateSessionState {
  const slots: (2 | 3)[] = threshold === '2-of-2' ? [2] : [2, 3]
  return run(start(threshold), IDENTITY_READY, ...slots.flatMap(pair)).state
}

const INVITE_TO_2 = {
  identityPublicKey: ID(0),
  device: { name: 'Account 1', model: 'MacBook', platform: 'extension' },
  dkgSessionId: QR_SESSION,
  participants: 3,
  threshold: 2,
  rosterSlot: 1,
  mainnet: true
}

type Phone = 2 | 3

// Stand-ins for what the phones and the Worker produce: the reducer only routes these values.
const R1_ENVELOPE = 'AAEC'
const H1 = '1'.repeat(64)
const FP = 'f'.repeat(64)
const ROUND1_DONE: VaultDkgRound1Response = {
  complete: true,
  round1Hash: H1,
  bundles: { '1': 'AAAA', '2': 'BBBB' }
}
const RECORD: SealedVaultRecord = {
  version: 1,
  network: 'mainnet',
  groupId: GROUP_ID,
  salt: bytesToBase64(fill(32, 1)),
  iv: bytesToBase64(fill(12, 2)),
  ciphertext: bytesToBase64(fill(17, 3))
}
const ROUND2_DONE: VaultDkgRound2Response = {
  complete: true,
  fingerprint: FP,
  inboxes: { '1': 'SU5C', '2': 'SU5D' },
  sealedQsk: { '1': 'UVNL', '2': 'UVNM' },
  record: RECORD
}

const phonesOf = (threshold: MultisigThreshold): Phone[] => (threshold === '2-of-2' ? [2] : [2, 3])
const scanned = (slot: Phone): CreateSessionEvent => ({ type: 'QR_PHONE_SCANNED', slot })
const round1 = (slot: Phone) => message(slot, 'DKG_R1', { envelope: R1_ENVELOPE })
const echo = (slot: Phone, round1Hash = H1) => message(slot, 'DKG_R1_ECHO', { round1Hash })
const batch = (slot: Phone) => message(slot, 'DKG_R2_BATCH', { envelope: R1_ENVELOPE })
const final = (slot: Phone, fingerprint = FP) => message(slot, 'DKG_FINAL', { fingerprint })
const round1Accepted = (slot: Phone, complete: boolean): CreateSessionEvent => ({
  type: 'DKG_ROUND1_ACCEPTED',
  slot,
  result: complete ? ROUND1_DONE : { complete: false }
})
const round2Accepted = (slot: Phone, complete: boolean): CreateSessionEvent => ({
  type: 'DKG_ROUND2_ACCEPTED',
  slot,
  result: complete ? ROUND2_DONE : { complete: false }
})

function opened(threshold: MultisigThreshold): CreateSessionState {
  return run(paired(threshold), { type: 'CONTINUE' }, { type: 'DKG_OPENED', sessionId: QR_SESSION })
    .state
}

// Every event from the roster code to the Worker's last round-2 answer; the last phone completes.
function untilSave(threshold: MultisigThreshold): CreateSessionEvent[] {
  const phones = phonesOf(threshold)
  const last = phones.at(-1)
  const confirm = (stage: 'roster' | 'r1'): CreateSessionEvent[] =>
    threshold === '2-of-2' ? [] : [{ type: 'FINGERPRINT_CONFIRMED', stage }]
  return [
    ...phones.map(scanned),
    ...confirm('roster'),
    ...phones.map(round1),
    ...phones.map(slot => round1Accepted(slot, slot === last)),
    ...phones.map(scanned),
    ...confirm('r1'),
    ...phones.map(slot => echo(slot)),
    ...phones.map(scanned),
    ...phones.map(batch),
    ...phones.map(slot => round2Accepted(slot, slot === last))
  ]
}

function displayed(effects: readonly CreateSessionEffect[]): MultisigMessageType[] {
  return effects.flatMap(effect =>
    effect.type === 'display' ? effect.items.map(item => item.messageType) : []
  )
}

test.describe('multisig create-session over QR', () => {
  test('PAIR_START waits for the owner identity', () => {
    const initial = start('2-of-3')
    expect(initial.ownerIdentityPublicKey).toBeNull()
    expect(initial.qrDkgSessionId).toBe(QR_SESSION)
    expect(initial.roster).toBeNull()
    expect(initial.round2Outputs).toBeNull()
    expect(initial.devices[1]).toMatchObject({
      identityPublicKey: null,
      transportPublicKey: null,
      identityConfirmed: false,
      round1Envelope: null
    })

    const early = reduceCreateSession(initial, { type: 'PAIR_START', slot: 2 })
    expect(early.state).toBe(initial)
    expect(early.effects).toEqual([])

    // Without a prepared DKG session id there is nothing to invite into either.
    const noSession = run(start('2-of-3', ''), IDENTITY_READY).state
    expect(reduceCreateSession(noSession, { type: 'PAIR_START', slot: 2 }).state).toBe(noSession)

    const ready = reduceCreateSession(initial, IDENTITY_READY).state
    expect(ready.ownerIdentityPublicKey).toBe(ID(0))
    // The first identity is the one every invite carries; a later one cannot replace it.
    expect(reduceCreateSession(ready, { type: 'IDENTITY_READY', publicKey: ID(5) }).state).toBe(
      ready
    )

    const shown = reduceCreateSession(ready, { type: 'PAIR_START', slot: 2 })
    expect(shown.state.devices[1].connection).toBe('invite_shown')
    expect(shown.effects).toEqual([
      {
        type: 'display',
        stepKey: 'pair:2:invite',
        items: [{ slot: 2, messageType: 'PAIR_INVITE', payload: INVITE_TO_2 }]
      }
    ])
  })

  test('re-showing the invite emits the same stepKey', () => {
    const shown = run(start('2-of-3'), IDENTITY_READY, { type: 'PAIR_START', slot: 2 }).state
    expect(reduceCreateSession(shown, { type: 'PAIR_START', slot: 2 }).state).toBe(shown)

    const again = reduceCreateSession(shown, { type: 'QR_INVITE_SHOWN', slot: 2 })
    expect(again.effects).toEqual([
      {
        type: 'display',
        stepKey: 'pair:2:invite',
        items: [{ slot: 2, messageType: 'PAIR_INVITE', payload: INVITE_TO_2 }]
      }
    ])
  })

  test('a reply moves the phone to identity_check and keeps its identity', () => {
    const shown = run(start('2-of-3'), IDENTITY_READY, { type: 'PAIR_START', slot: 2 }).state

    const scanned = reduceCreateSession(shown, { type: 'QR_PHONE_SCANNED', slot: 2 })
    expect(scanned.effects).toEqual([
      { type: 'awaitScan', slots: [2], messageType: 'PAIR_RESPONSE' }
    ])

    const noIdentity = message(2, 'PAIR_RESPONSE', { device: { name: 'Alex', model: 'X' } })
    expect(reduceCreateSession(shown, noIdentity).state).toBe(shown)

    const replied = reduceCreateSession(shown, reply(2))
    expect(replied.effects).toEqual([])
    expect(replied.state.devices[1]).toMatchObject({
      connection: 'identity_check',
      identityPublicKey: ID(1),
      identityConfirmed: false,
      device: PHONES[2]
    })
    // An unchecked phone does not count as connected yet.
    expect(reduceCreateSession(replied.state, { type: 'CONTINUE' }).state).toBe(replied.state)
    // A second reply for a phone already answering is not a new pairing.
    expect(reduceCreateSession(replied.state, reply(2)).state).toBe(replied.state)
  })

  test('IDENTITY_CONFIRMED connects; IDENTITY_REJECTED aborts with fingerprint_mismatch', () => {
    const checking = run(start('2-of-3'), IDENTITY_READY, ...pair(2).slice(0, 3)).state
    expect(reduceCreateSession(checking, { type: 'IDENTITY_CONFIRMED', slot: 3 }).state).toBe(
      checking
    )

    const confirmed = reduceCreateSession(checking, { type: 'IDENTITY_CONFIRMED', slot: 2 })
    expect(confirmed.state.devices[1]).toMatchObject({
      connection: 'connected',
      identityConfirmed: true,
      identityPublicKey: ID(1)
    })
    expect(reduceCreateSession(confirmed.state, { type: 'IDENTITY_REJECTED', slot: 2 }).state).toBe(
      confirmed.state
    )

    const rejected = reduceCreateSession(checking, { type: 'IDENTITY_REJECTED', slot: 2 })
    expect(rejected.state.phase).toBe('ABORTED')
    expect(rejected.state.abortReason).toBe('fingerprint_mismatch')
    expect(rejected.state.devices[1]).toMatchObject({
      connection: 'empty',
      identityPublicKey: null,
      transportPublicKey: null
    })
    expect(rejected.effects).toEqual([])
  })

  test('CONTINUE opens the Worker session with the prepared id', () => {
    const locked = reduceCreateSession(paired('2-of-2'), { type: 'CONTINUE' })
    expect(locked.state.phase).toBe('DKG_R1')
    expect(locked.state.dkgSessionId).toBeNull()
    expect(locked.state.roster?.groupId).toBe(GROUP_ID)
    expect(locked.effects).toEqual([
      {
        type: 'dkgOpen',
        participants: 2,
        threshold: 2,
        mainnet: true,
        groupId: GROUP_ID,
        sessionId: QR_SESSION
      }
    ])
  })

  test('DKG_OPENED with another session id aborts', () => {
    const locked = run(paired('2-of-3'), { type: 'CONTINUE' }).state
    const opened = reduceCreateSession(locked, { type: 'DKG_OPENED', sessionId: OTHER_SESSION })
    expect(opened.state.phase).toBe('ABORTED')
    expect(opened.state.abortReason).toBe('verification_failed')
    expect(opened.state.roster?.groupId).toBe(GROUP_ID)
    // The Worker did open a session under the id it reported, so that one is closed.
    expect(opened.effects).toEqual([{ type: 'dkgClose', sessionId: OTHER_SESSION }])
  })

  test('DKG_OPENED builds the roster and shows ROSTER_LOCK to every phone', () => {
    const locked = run(paired('2-of-3'), { type: 'CONTINUE' }).state
    const opened = reduceCreateSession(locked, { type: 'DKG_OPENED', sessionId: QR_SESSION })

    const unhashed = {
      groupId: GROUP_ID,
      protocolVersion: 1,
      ciphersuite: ROSTER_CIPHERSUITE,
      threshold: 2,
      participants: [0, 1, 2].map(slot => ({
        slot,
        identityPublicKey: ID(slot),
        transportPublicKey: QR_TRANSPORT_PUBLIC_KEY
      }))
    } as const
    const roster = { ...unhashed, rosterHash: rosterHash(unhashed) }
    expect(QR_TRANSPORT_PUBLIC_KEY).toBe(bytesToBase64(fill(32, 0)))

    expect(opened.state.phase).toBe('DKG_R1')
    expect(opened.state.dkgSessionId).toBe(QR_SESSION)
    expect(opened.state.roster).toEqual(roster)
    expect(opened.state.qrCeremonyIndex).toBe(0)
    expect(opened.state.qrShownTo).toEqual([])
    expect(opened.effects).toEqual([
      {
        type: 'display',
        stepKey: 'ceremony:0',
        items: [
          {
            slot: 2,
            messageType: 'ROSTER_LOCK',
            payload: {
              dkgSessionId: QR_SESSION,
              participants: 3,
              threshold: 2,
              rosterSlot: 1,
              mainnet: true,
              roster
            }
          },
          {
            slot: 3,
            messageType: 'ROSTER_LOCK',
            payload: {
              dkgSessionId: QR_SESSION,
              participants: 3,
              threshold: 2,
              rosterSlot: 2,
              mainnet: true,
              roster
            }
          }
        ]
      }
    ])

    // Only the first answer to the open counts.
    expect(
      reduceCreateSession(opened.state, { type: 'DKG_OPENED', sessionId: QR_SESSION }).state
    ).toBe(opened.state)
  })

  test('PAIR_CANCEL after identity_check empties the slot and emits disconnect', () => {
    const checking = run(start('2-of-3'), IDENTITY_READY, ...pair(2).slice(0, 3)).state
    const cancelled = reduceCreateSession(checking, { type: 'PAIR_CANCEL', slot: 2 })
    expect(cancelled.effects).toEqual([{ type: 'disconnect', slot: 2 }])
    expect(cancelled.state.phase).toBe('PAIRING')
    expect(cancelled.state.devices[1]).toEqual({
      slot: 2,
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
    })
    // The owner's identity belongs to this extension, not to the cancelled phone.
    expect(cancelled.state.ownerIdentityPublicKey).toBe(ID(0))
  })

  test('a rejected message or a phone abort ends the session', () => {
    const checking = run(start('2-of-3'), IDENTITY_READY, ...pair(2).slice(0, 3)).state

    const rejected = reduceCreateSession(checking, {
      type: 'MESSAGE_REJECTED',
      slot: 2,
      reason: 'signature'
    })
    expect(rejected.state.abortReason).toBe('verification_failed')

    const phoneAbort = reduceCreateSession(checking, message(2, 'SESSION_ABORT'))
    expect(phoneAbort.state.abortReason).toBe('phone_rejected')
    expect(phoneAbort.effects).toEqual([])
  })

  test('switching to Bluetooth keeps the Bluetooth path untouched', () => {
    const switched = reduceCreateSession(start('2-of-2'), { type: 'SWITCH_TRANSPORT', kind: 'ble' })
    expect(switched.state.transportKind).toBe('ble')

    const code = '482913'
    const ble = run(
      switched.state,
      { type: 'PAIR_START', slot: 2 },
      { type: 'PAIR_DEVICE_SELECTED', slot: 2, device: PHONES[2] },
      { type: 'PAIR_CODE_ISSUED', slot: 2, code, expiresAt: 60_000 },
      message(2, 'PAIR_RESPONSE', { code, device: PHONES[2] }),
      { type: 'CONTINUE' }
    )
    expect(ble.effects.at(-1)).toEqual({
      type: 'dkgOpen',
      participants: 2,
      threshold: 2,
      mainnet: true,
      groupId: GROUP_ID
    })

    // A QR pairing already under way cannot be carried over to the other transport.
    const started = run(start('2-of-2'), IDENTITY_READY, { type: 'PAIR_START', slot: 2 }).state
    const aborted = reduceCreateSession(started, { type: 'SWITCH_TRANSPORT', kind: 'ble' })
    expect(aborted.state.abortReason).toBe('transport_switched')
  })

  test('2-of-2 walks all nine steps and activates without DKG_ACTIVATE', () => {
    const roster = reduceCreateSession(opened('2-of-2'), scanned(2))
    expect(roster.state.qrCeremonyIndex).toBe(1)
    expect(roster.state.qrShownTo).toEqual([])
    expect(roster.effects).toEqual([{ type: 'awaitScan', slots: [2], messageType: 'DKG_R1' }])

    const r1Message = round1(2)
    const r1 = reduceCreateSession(roster.state, r1Message)
    expect(r1.effects).toEqual([
      {
        type: 'dkgAcceptRound1',
        slot: 2,
        request: { sessionId: QR_SESSION, senderSlot: 1, envelope: R1_ENVELOPE }
      }
    ])
    if (r1Message.type !== 'MESSAGE_RECEIVED') throw new Error('unreachable')
    expect(r1.state.devices[1].round1Envelope).toEqual(r1Message.envelope)

    const bundle = reduceCreateSession(r1.state, round1Accepted(2, true))
    expect(bundle.state.r1Fingerprint).toBe(H1)
    expect(bundle.state.qrCeremonyIndex).toBe(2)
    expect(bundle.effects).toEqual([
      {
        type: 'display',
        stepKey: 'ceremony:2',
        items: [{ slot: 2, messageType: 'DKG_R1_BUNDLE', payload: { envelope: 'AAAA' } }]
      }
    ])

    const echoScan = reduceCreateSession(bundle.state, scanned(2))
    expect(echoScan.effects).toEqual([
      { type: 'awaitScan', slots: [2], messageType: 'DKG_R1_ECHO' }
    ])
    const cert = reduceCreateSession(echoScan.state, echo(2))
    expect(cert.state.phase).toBe('DKG_R2')
    expect(cert.state.devices[1].r1Echoed).toBe(true)
    expect(cert.effects).toEqual([
      { type: 'display', stepKey: 'ceremony:4', items: [{ slot: 2, messageType: 'DKG_R1_CERT' }] }
    ])

    const batchScan = reduceCreateSession(cert.state, scanned(2))
    expect(batchScan.effects).toEqual([
      { type: 'awaitScan', slots: [2], messageType: 'DKG_R2_BATCH' }
    ])
    const r2 = reduceCreateSession(batchScan.state, batch(2))
    expect(r2.effects).toEqual([
      {
        type: 'dkgAcceptRound2',
        slot: 2,
        request: { sessionId: QR_SESSION, senderSlot: 1, envelope: R1_ENVELOPE }
      }
    ])

    const saving = reduceCreateSession(r2.state, round2Accepted(2, true))
    expect(saving.state).toMatchObject({
      phase: 'FINALIZED',
      savingRecord: true,
      finalFingerprint: FP,
      vaultRecord: RECORD,
      round2Outputs: { '1': { inbox: 'SU5C', sealedQsk: 'UVNL' } },
      qrCeremonyIndex: 5
    })
    expect(saving.state.devices[1].r2Received).toBe(true)
    // The share must be on disk before any phone can be handed its own.
    expect(saving.effects).toEqual([{ type: 'saveVaultRecord', groupId: GROUP_ID, record: RECORD }])

    const shares = reduceCreateSession(saving.state, { type: 'VAULT_RECORD_SAVED' })
    expect(shares.state.phase).toBe('KEYSET_VERIFIED')
    expect(shares.state.savingRecord).toBe(false)
    expect(shares.state.qrCeremonyIndex).toBe(6)
    expect(shares.effects).toEqual([
      {
        type: 'display',
        stepKey: 'ceremony:6',
        items: [
          { slot: 2, messageType: 'DKG_R2_INBOX', payload: { envelope: 'SU5C' } },
          { slot: 2, messageType: 'KEYSET_SETUP', payload: { sealedQsk: 'UVNL' } }
        ]
      }
    ])
    // A second answer to the same save changes nothing.
    expect(reduceCreateSession(shares.state, { type: 'VAULT_RECORD_SAVED' }).state).toBe(
      shares.state
    )

    const verify = reduceCreateSession(shares.state, scanned(2))
    expect(verify.state.qrCeremonyIndex).toBe(7)
    expect(verify.effects).toEqual([])
    // DKG_FINAL is only read once the owner has matched the fingerprint.
    expect(reduceCreateSession(verify.state, final(2)).state).toBe(verify.state)
    expect(
      reduceCreateSession(verify.state, { type: 'FINGERPRINT_CONFIRMED', stage: 'r1' }).state
    ).toBe(verify.state)

    const finalScan = reduceCreateSession(verify.state, {
      type: 'FINGERPRINT_CONFIRMED',
      stage: 'final'
    })
    expect(finalScan.state.ownerConfirmed.final).toBe(true)
    expect(finalScan.state.qrCeremonyIndex).toBe(8)
    expect(finalScan.effects).toEqual([{ type: 'awaitScan', slots: [2], messageType: 'DKG_FINAL' }])
    expect(verifyPageDevices(finalScan.state)).toEqual([
      { slot: 2, device: PHONES[2], confirmed: false }
    ])

    const activated = reduceCreateSession(finalScan.state, final(2))
    expect(activated.state.phase).toBe('ACTIVATED')
    expect(activated.state.qrCeremonyIndex).toBe(8)
    expect(verifyPageDevices(activated.state)).toEqual([
      { slot: 2, device: PHONES[2], confirmed: true }
    ])
    expect(activated.effects).toEqual([
      {
        type: 'persistGroup',
        record: {
          groupId: GROUP_ID,
          threshold: '2-of-2',
          transportKind: 'qr',
          devices: [OWNER, PHONES[2]],
          fingerprint: FP,
          createdAt: 0,
          mock: true
        }
      },
      { type: 'dkgClose', sessionId: QR_SESSION }
    ])
  })

  test('a failed save aborts before any step-9 code exists', () => {
    const saving = run(opened('2-of-2'), ...untilSave('2-of-2'))
    expect(saving.state.phase).toBe('FINALIZED')
    expect(saving.effects.at(-1)).toEqual({
      type: 'saveVaultRecord',
      groupId: GROUP_ID,
      record: RECORD
    })

    const failed = reduceCreateSession(saving.state, { type: 'VAULT_RECORD_SAVE_FAILED' })
    expect(failed.state.phase).toBe('ABORTED')
    expect(failed.state.abortReason).toBe('save_failed')
    expect(failed.effects).toEqual([{ type: 'dkgClose', sessionId: QR_SESSION }])

    const late = run(failed.state, { type: 'VAULT_RECORD_SAVED' }, scanned(2))
    expect(late.state).toBe(failed.state)
    for (const effects of [saving.effects, failed.effects, late.effects]) {
      expect(displayed(effects)).not.toContain('DKG_R2_INBOX')
      expect(displayed(effects)).not.toContain('KEYSET_SETUP')
    }
  })

  test('an echo with another round-1 hash aborts', () => {
    const atEcho = run(
      opened('2-of-2'),
      scanned(2),
      round1(2),
      round1Accepted(2, true),
      scanned(2)
    ).state
    const wrong = reduceCreateSession(atEcho, echo(2, '2'.repeat(64)))
    expect(wrong.state.phase).toBe('ABORTED')
    expect(wrong.state.abortReason).toBe('verification_failed')
    expect(wrong.effects).toEqual([{ type: 'dkgClose', sessionId: QR_SESSION }])
  })

  test('a final fingerprint that differs aborts', () => {
    const atFinal = run(
      opened('2-of-2'),
      ...untilSave('2-of-2'),
      { type: 'VAULT_RECORD_SAVED' },
      scanned(2),
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' }
    ).state
    expect(atFinal.qrCeremonyIndex).toBe(8)
    const wrong = reduceCreateSession(atFinal, final(2, 'e'.repeat(64)))
    expect(wrong.state.phase).toBe('ABORTED')
    expect(wrong.state.abortReason).toBe('verification_failed')
    expect(wrong.effects).toEqual([{ type: 'dkgClose', sessionId: QR_SESSION }])
  })

  test('x-of-3 inserts the roster and round-1 checks and collects scans in any order', () => {
    const start = opened('2-of-3')
    const one = reduceCreateSession(start, scanned(3))
    expect(one.state.qrShownTo).toEqual([3])
    expect(one.effects).toEqual([])
    expect(reduceCreateSession(one.state, scanned(3)).state).toBe(one.state)

    const rosterCheck = reduceCreateSession(one.state, scanned(2))
    expect(rosterCheck.state.qrCeremonyIndex).toBe(1)
    expect(rosterCheck.state.phase).toBe('DKG_R1')
    expect(rosterCheck.effects).toEqual([])
    // Only the stage the page is on can be confirmed.
    expect(
      reduceCreateSession(rosterCheck.state, { type: 'FINGERPRINT_CONFIRMED', stage: 'r1' }).state
    ).toBe(rosterCheck.state)

    const r1Scan = reduceCreateSession(rosterCheck.state, {
      type: 'FINGERPRINT_CONFIRMED',
      stage: 'roster'
    })
    expect(r1Scan.state.phase).toBe('DKG_R1')
    expect(r1Scan.effects).toEqual([{ type: 'awaitScan', slots: [2, 3], messageType: 'DKG_R1' }])

    const received = run(
      r1Scan.state,
      round1(3),
      round1(2),
      round1Accepted(3, false),
      round1Accepted(2, true)
    )
    expect(received.effects).toEqual([
      {
        type: 'dkgAcceptRound1',
        slot: 3,
        request: { sessionId: QR_SESSION, senderSlot: 2, envelope: R1_ENVELOPE }
      },
      {
        type: 'dkgAcceptRound1',
        slot: 2,
        request: { sessionId: QR_SESSION, senderSlot: 1, envelope: R1_ENVELOPE }
      },
      {
        type: 'display',
        stepKey: 'ceremony:3',
        items: [
          { slot: 2, messageType: 'DKG_R1_BUNDLE', payload: { envelope: 'AAAA' } },
          { slot: 3, messageType: 'DKG_R1_BUNDLE', payload: { envelope: 'BBBB' } }
        ]
      }
    ])

    const r1Check = run(received.state, scanned(3), scanned(2)).state
    expect(r1Check.qrCeremonyIndex).toBe(4)
    // The echoes are read only after the owner has compared round 1.
    expect(reduceCreateSession(r1Check, echo(2)).state).toBe(r1Check)
    const rejected = reduceCreateSession(r1Check, { type: 'FINGERPRINT_REJECTED', stage: 'r1' })
    expect(rejected.state.abortReason).toBe('fingerprint_mismatch')
    expect(rejected.effects).toEqual([{ type: 'dkgClose', sessionId: QR_SESSION }])

    const echoScan = reduceCreateSession(r1Check, { type: 'FINGERPRINT_CONFIRMED', stage: 'r1' })
    expect(echoScan.state.ownerConfirmed.r1).toBe(true)
    expect(echoScan.effects).toEqual([
      { type: 'awaitScan', slots: [2, 3], messageType: 'DKG_R1_ECHO' }
    ])
    const halfEchoed = reduceCreateSession(echoScan.state, echo(3))
    expect(halfEchoed.state.phase).toBe('DKG_R1')
    expect(halfEchoed.effects).toEqual([])
    const cert = reduceCreateSession(halfEchoed.state, echo(2))
    expect(cert.state.phase).toBe('DKG_R2')
    expect(cert.effects).toEqual([
      {
        type: 'display',
        stepKey: 'ceremony:6',
        items: [
          { slot: 2, messageType: 'DKG_R1_CERT' },
          { slot: 3, messageType: 'DKG_R1_CERT' }
        ]
      }
    ])

    const saving = run(
      cert.state,
      scanned(2),
      scanned(3),
      batch(3),
      batch(2),
      round2Accepted(3, false),
      round2Accepted(2, true)
    ).state
    expect(saving.round2Outputs).toEqual({
      '1': { inbox: 'SU5C', sealedQsk: 'UVNL' },
      '2': { inbox: 'SU5D', sealedQsk: 'UVNM' }
    })
    const shares = reduceCreateSession(saving, { type: 'VAULT_RECORD_SAVED' })
    expect(shares.effects).toEqual([
      {
        type: 'display',
        stepKey: 'ceremony:8',
        items: [
          { slot: 2, messageType: 'DKG_R2_INBOX', payload: { envelope: 'SU5C' } },
          { slot: 2, messageType: 'KEYSET_SETUP', payload: { sealedQsk: 'UVNL' } },
          { slot: 3, messageType: 'DKG_R2_INBOX', payload: { envelope: 'SU5D' } },
          { slot: 3, messageType: 'KEYSET_SETUP', payload: { sealedQsk: 'UVNM' } }
        ]
      }
    ])

    const finals = run(
      shares.state,
      scanned(3),
      scanned(2),
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
      final(3)
    )
    expect(finals.state.phase).toBe('KEYSET_VERIFIED')
    expect(verifyPageDevices(finals.state).map(entry => entry.confirmed)).toEqual([false, true])
    const activated = reduceCreateSession(finals.state, final(2))
    expect(activated.state.phase).toBe('ACTIVATED')
    expect(activated.effects.map(effect => effect.type)).toEqual(['persistGroup', 'dkgClose'])
  })

  test('scan marks light on Worker acceptance, not on receipt', () => {
    const r1Scan = run(opened('2-of-3'), scanned(2), scanned(3), {
      type: 'FINGERPRINT_CONFIRMED',
      stage: 'roster'
    }).state

    const received = reduceCreateSession(r1Scan, round1(2))
    expect(received.state.devices[1].r1Received).toBe(false)
    // A code of another type than the step expects is not read.
    expect(reduceCreateSession(received.state, echo(2)).state).toBe(received.state)

    const accepted = reduceCreateSession(received.state, round1Accepted(2, false))
    expect(accepted.state.devices[1].r1Received).toBe(true)
    expect(accepted.state.devices[2].r1Received).toBe(false)
    expect(accepted.state.qrCeremonyIndex).toBe(2)
    expect(accepted.effects).toEqual([])
    // A marked phone's code is not read again, and its acceptance is not counted twice.
    expect(reduceCreateSession(accepted.state, round1(2)).state).toBe(accepted.state)
    expect(reduceCreateSession(accepted.state, round1Accepted(2, false)).state).toBe(accepted.state)
  })

  test('a phone SESSION_ABORT mid-ceremony aborts with phone_rejected', () => {
    const r2 = run(opened('2-of-2'), ...untilSave('2-of-2').slice(0, 6)).state
    expect(r2.phase).toBe('DKG_R2')
    const aborted = reduceCreateSession(r2, message(2, 'SESSION_ABORT'))
    expect(aborted.state.phase).toBe('ABORTED')
    expect(aborted.state.abortReason).toBe('phone_rejected')
    expect(aborted.effects).toEqual([{ type: 'dkgClose', sessionId: QR_SESSION }])
  })

  test('MESSAGE_REJECTED aborts with verification_failed and closes the Worker session', () => {
    const r1Scan = run(opened('2-of-2'), scanned(2)).state
    const rejected = reduceCreateSession(r1Scan, {
      type: 'MESSAGE_REJECTED',
      slot: 2,
      reason: 'signature'
    })
    expect(rejected.state.phase).toBe('ABORTED')
    expect(rejected.state.abortReason).toBe('verification_failed')
    expect(rejected.effects).toEqual([{ type: 'dkgClose', sessionId: QR_SESSION }])
  })
})
