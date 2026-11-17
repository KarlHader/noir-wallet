import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import {
  createInitialSession,
  guardianSlots,
  reduceCreateSession,
  verifyPageDevices,
  type CreateSessionEffect,
  type CreateSessionEvent,
  type CreateSessionState
} from '../../../src/core/multisig/create-session'
import type {
  VaultDkgRound1Response,
  VaultDkgRound2Response
} from '../../../src/core/multisig/dkg-rpc'
import {
  createEnvelopeFactory,
  deviceId,
  type MultisigMessageType
} from '../../../src/core/multisig/messages'
import type {
  MultisigDevice,
  MultisigThreshold,
  MultisigTransportKind
} from '../../../src/core/multisig/types'
import type { SealedVaultRecord } from '../../../src/core/multisig/vault-record'

const GROUP_ID = 'group-1'
const SESSION_ID = 'session-1'
const CODE = '482913'
const CODE_EXPIRES_AT = 60_000

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

function start(threshold: MultisigThreshold, transportKind: MultisigTransportKind) {
  return createInitialSession({
    groupId: GROUP_ID,
    sessionId: SESSION_ID,
    threshold,
    transportKind,
    owner: OWNER,
    mainnet: true
  })
}

// Reduces the events in order and collects every effect they produced.
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

type MessageReceivedEvent = Extract<CreateSessionEvent, { type: 'MESSAGE_RECEIVED' }>

function message(
  slot: 2 | 3,
  type: MultisigMessageType,
  payload: Record<string, unknown> = {},
  at = 1_000,
  sessionId = SESSION_ID
): MessageReceivedEvent {
  const make = createEnvelopeFactory({ groupId: GROUP_ID, sessionId, senderId: deviceId(slot) })
  return { type: 'MESSAGE_RECEIVED', slot, envelope: make(type, deviceId(1), payload), at }
}

function blePairing(slot: 2 | 3): CreateSessionEvent[] {
  return [
    { type: 'PAIR_START', slot },
    { type: 'PAIR_DEVICE_SELECTED', slot, device: PHONES[slot] },
    { type: 'PAIR_CODE_ISSUED', slot, code: CODE, expiresAt: CODE_EXPIRES_AT }
  ]
}

function blePair(slot: 2 | 3): CreateSessionEvent[] {
  return [...blePairing(slot), message(slot, 'PAIR_RESPONSE', { code: CODE, device: PHONES[slot] })]
}

function each(
  slots: readonly (2 | 3)[],
  type: MultisigMessageType,
  payload?: Record<string, unknown>
): CreateSessionEvent[] {
  return slots.map(slot => message(slot, type, payload))
}

// Stand-ins for what the Worker returns: the reducer only routes these values, never reads them.
const SID = btoa('0123456789abcdef')
const H1 = '1'.repeat(64)
const FP = 'f'.repeat(64)
const ENV = 'AAEC'
const BUNDLE: Record<number, string> = { 1: 'QjE=', 2: 'QjI=' }
const INBOX: Record<number, string> = { 1: 'STE=', 2: 'STI=' }
const QSK: Record<number, string> = { 1: 'UTE=', 2: 'UTI=' }

// A real sealed record, relabelled for this file's mainnet sessions and group; the reducer only
// carries it, so the ciphertext not matching the new labels does not matter here.
const FIXTURE_RECORD = (
  JSON.parse(
    await readFile(new URL('./fixtures/vault-record-v1.json', import.meta.url), 'utf8')
  ) as { record: SealedVaultRecord }
).record
const RECORD: SealedVaultRecord = { ...FIXTURE_RECORD, groupId: GROUP_ID, network: 'mainnet' }

function bySlot(slots: readonly (2 | 3)[], values: Record<number, string>): Record<string, string> {
  return Object.fromEntries(slots.map(slot => [String(slot - 1), values[slot - 1]]))
}

function completeRound1(slots: readonly (2 | 3)[]): VaultDkgRound1Response {
  return { complete: true, round1Hash: H1, bundles: bySlot(slots, BUNDLE) }
}

function completeRound2(slots: readonly (2 | 3)[]): VaultDkgRound2Response {
  return {
    complete: true,
    fingerprint: FP,
    inboxes: bySlot(slots, INBOX),
    sealedQsk: bySlot(slots, QSK),
    record: RECORD
  }
}

type BleStage = 'opened' | 'bundled' | 'verified'

// Every event of a Bluetooth ceremony up to the given stage, with the Worker's answers faked.
function bleCeremonyEvents(threshold: MultisigThreshold, stage: BleStage): CreateSessionEvent[] {
  const slots: readonly (2 | 3)[] = threshold === '2-of-2' ? [2] : [2, 3]
  const last = slots.length - 1
  const events: CreateSessionEvent[] = [
    ...slots.flatMap(blePair),
    { type: 'CONTINUE' },
    { type: 'DKG_OPENED', sessionId: SID }
  ]
  if (stage === 'opened') return events
  events.push(
    ...each(slots, 'DKG_R1', { envelope: ENV }),
    ...slots.map(
      (slot, index): CreateSessionEvent => ({
        type: 'DKG_ROUND1_ACCEPTED',
        slot,
        result: index === last ? completeRound1(slots) : { complete: false }
      })
    )
  )
  if (stage === 'bundled') return events
  events.push(
    ...each(slots, 'DKG_R1_ECHO', { round1Hash: H1 }),
    ...each(slots, 'DKG_R2_BATCH', { envelope: ENV }),
    ...slots.map(
      (slot, index): CreateSessionEvent => ({
        type: 'DKG_ROUND2_ACCEPTED',
        slot,
        result: index === last ? completeRound2(slots) : { complete: false }
      })
    )
  )
  return events
}

function bleState(threshold: MultisigThreshold, stage: BleStage): CreateSessionState {
  return run(start(threshold, 'ble'), ...bleCeremonyEvents(threshold, stage)).state
}

// A Bluetooth session that has just reached KEYSET_VERIFIED.
function bleToKeysetVerified(threshold: MultisigThreshold): CreateSessionState {
  return bleState(threshold, 'verified')
}

const BLE_ABORT_NOTICES: readonly CreateSessionEffect[] = [
  { type: 'sendTo', slot: 2, messageType: 'SESSION_ABORT' },
  { type: 'disconnect', slot: 2 },
  { type: 'sendTo', slot: 3, messageType: 'SESSION_ABORT' },
  { type: 'disconnect', slot: 3 }
]

function expectGuardiansEmpty(state: CreateSessionState) {
  expect(state.devices[0]).toMatchObject({ slot: 1, connection: 'connected', device: OWNER })
  for (const device of state.devices.slice(1)) {
    expect(device).toEqual({
      slot: device.slot,
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
      identityPublicKey: null,
      identityConfirmed: false,
      round1Envelope: null
    })
  }
}

test.describe('multisig create-session', () => {
  test('ble: full 2-of-3 happy path reaches ACTIVATED and persists the group', () => {
    const initial = start('2-of-3', 'ble')
    expect(initial.phase).toBe('PAIRING')
    expect(initial.devices.map(d => d.connection)).toEqual(['connected', 'empty', 'empty'])
    expect(guardianSlots(initial)).toEqual([2, 3])

    const paired = run(initial, ...blePairing(2))
    expect(paired.effects).toEqual([
      { type: 'requestDevice', slot: 2 },
      { type: 'issueCode', slot: 2 },
      { type: 'sendTo', slot: 2, messageType: 'PAIR_INVITE' },
      { type: 'awaitFrom', slot: 2, messageType: 'PAIR_RESPONSE' }
    ])
    expect(paired.state.devices[1]).toMatchObject({
      connection: 'code_wait',
      device: PHONES[2],
      pairingCode: CODE,
      pairingCodeExpiresAt: CODE_EXPIRES_AT
    })

    const connected = run(
      paired.state,
      message(2, 'PAIR_RESPONSE', { code: CODE, device: PHONES[2] }),
      ...blePair(3)
    ).state
    expect(connected.devices[1]).toMatchObject({
      connection: 'connected',
      pairingCode: null,
      pairingCodeExpiresAt: null
    })

    // Continue only asks the Worker for a DKG session; nothing reaches the phones yet.
    const locked = run(connected, { type: 'CONTINUE' })
    expect(locked.state.phase).toBe('DKG_R1')
    expect(locked.state.dkgSessionId).toBeNull()
    expect(locked.effects).toEqual([
      { type: 'dkgOpen', participants: 3, threshold: 2, mainnet: true, groupId: GROUP_ID }
    ])

    const opened = run(locked.state, { type: 'DKG_OPENED', sessionId: SID })
    expect(opened.state.dkgSessionId).toBe(SID)
    expect(opened.effects).toEqual([
      {
        type: 'sendTo',
        slot: 2,
        messageType: 'ROSTER_LOCK',
        payload: { dkgSessionId: SID, participants: 3, threshold: 2, rosterSlot: 1, mainnet: true }
      },
      {
        type: 'sendTo',
        slot: 3,
        messageType: 'ROSTER_LOCK',
        payload: { dkgSessionId: SID, participants: 3, threshold: 2, rosterSlot: 2, mainnet: true }
      },
      { type: 'awaitFrom', slot: 2, messageType: 'DKG_R1' },
      { type: 'awaitFrom', slot: 3, messageType: 'DKG_R1' }
    ])

    // Each phone's round-1 envelope goes to the Worker as it arrives.
    const r1Messages = run(
      opened.state,
      message(2, 'DKG_R1', { envelope: ENV }),
      message(3, 'DKG_R1', { envelope: 'AAED' })
    )
    expect(r1Messages.effects).toEqual([
      {
        type: 'dkgAcceptRound1',
        slot: 2,
        request: { sessionId: SID, senderSlot: 1, envelope: ENV }
      },
      {
        type: 'dkgAcceptRound1',
        slot: 3,
        request: { sessionId: SID, senderSlot: 2, envelope: 'AAED' }
      }
    ])
    expect(r1Messages.state.devices.map(d => d.r1Received)).toEqual([false, false, false])

    const r1 = run(
      r1Messages.state,
      { type: 'DKG_ROUND1_ACCEPTED', slot: 2, result: { complete: false } },
      { type: 'DKG_ROUND1_ACCEPTED', slot: 3, result: completeRound1([2, 3]) }
    )
    expect(r1.state.phase).toBe('DKG_R1')
    expect(r1.state.r1Fingerprint).toBe(H1)
    expect(r1.state.devices.map(d => d.r1Received)).toEqual([false, true, true])
    expect(r1.effects).toEqual([
      { type: 'sendTo', slot: 2, messageType: 'DKG_R1_BUNDLE', payload: { envelope: BUNDLE[1] } },
      { type: 'sendTo', slot: 3, messageType: 'DKG_R1_BUNDLE', payload: { envelope: BUNDLE[2] } },
      { type: 'awaitFrom', slot: 2, messageType: 'DKG_R1_ECHO' },
      { type: 'awaitFrom', slot: 3, messageType: 'DKG_R1_ECHO' }
    ])

    const echoed = run(r1.state, ...each([2, 3], 'DKG_R1_ECHO', { round1Hash: H1 }))
    expect(echoed.state.phase).toBe('DKG_R2')
    expect(echoed.effects).toEqual([
      { type: 'sendTo', slot: 2, messageType: 'DKG_R1_CERT' },
      { type: 'sendTo', slot: 3, messageType: 'DKG_R1_CERT' },
      { type: 'awaitFrom', slot: 2, messageType: 'DKG_R2_BATCH' },
      { type: 'awaitFrom', slot: 3, messageType: 'DKG_R2_BATCH' }
    ])

    const r2Messages = run(echoed.state, ...each([2, 3], 'DKG_R2_BATCH', { envelope: ENV }))
    expect(r2Messages.effects).toEqual([
      {
        type: 'dkgAcceptRound2',
        slot: 2,
        request: { sessionId: SID, senderSlot: 1, envelope: ENV }
      },
      {
        type: 'dkgAcceptRound2',
        slot: 3,
        request: { sessionId: SID, senderSlot: 2, envelope: ENV }
      }
    ])

    const r2 = run(
      r2Messages.state,
      { type: 'DKG_ROUND2_ACCEPTED', slot: 2, result: { complete: false } },
      { type: 'DKG_ROUND2_ACCEPTED', slot: 3, result: completeRound2([2, 3]) }
    )
    expect(r2.state.phase).toBe('KEYSET_VERIFIED')
    expect(r2.state.finalFingerprint).toBe(FP)
    expect(r2.state.devices.map(d => d.r2Received)).toEqual([false, true, true])
    expect(r2.effects).toEqual([
      { type: 'sendTo', slot: 2, messageType: 'DKG_R2_INBOX', payload: { envelope: INBOX[1] } },
      { type: 'sendTo', slot: 2, messageType: 'KEYSET_SETUP', payload: { sealedQsk: QSK[1] } },
      { type: 'sendTo', slot: 3, messageType: 'DKG_R2_INBOX', payload: { envelope: INBOX[2] } },
      { type: 'sendTo', slot: 3, messageType: 'KEYSET_SETUP', payload: { sealedQsk: QSK[2] } },
      { type: 'awaitFrom', slot: 2, messageType: 'DKG_FINAL' },
      { type: 'awaitFrom', slot: 3, messageType: 'DKG_FINAL' }
    ])

    const saving = run(
      r2.state,
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
      ...each([2, 3], 'DKG_FINAL', { fingerprint: FP })
    )
    expect(saving.state.phase).toBe('KEYSET_VERIFIED')
    expect(saving.effects).toEqual([{ type: 'saveVaultRecord', groupId: GROUP_ID, record: RECORD }])

    const done = run(saving.state, { type: 'VAULT_RECORD_SAVED' })
    expect(done.state.phase).toBe('ACTIVATED')
    expect(done.effects).toEqual([
      { type: 'sendTo', slot: 2, messageType: 'DKG_ACTIVATE' },
      { type: 'sendTo', slot: 3, messageType: 'DKG_ACTIVATE' },
      {
        type: 'persistGroup',
        record: {
          groupId: GROUP_ID,
          threshold: '2-of-3',
          transportKind: 'ble',
          devices: [OWNER, PHONES[2], PHONES[3]],
          fingerprint: FP,
          createdAt: 0,
          mock: true
        }
      },
      { type: 'dkgClose', sessionId: SID }
    ])

    // The pairing code is read off the extension screen; no message on the way may carry it.
    const whole = run(
      initial,
      ...bleCeremonyEvents('2-of-3', 'verified'),
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
      ...each([2, 3], 'DKG_FINAL', { fingerprint: FP }),
      { type: 'VAULT_RECORD_SAVED' }
    )
    expect(whole.state.phase).toBe('ACTIVATED')
    const sends = whole.effects.filter(
      (effect): effect is Extract<CreateSessionEffect, { type: 'sendTo' }> =>
        effect.type === 'sendTo'
    )
    expect(sends.length).toBeGreaterThan(0)
    for (const effect of sends) expect(effect.payload ?? {}).not.toHaveProperty('code')
  })

  test('ble: wrong code five times resets only that device', () => {
    const waiting = run(start('2-of-3', 'ble'), ...blePair(3), ...blePairing(2)).state
    const wrong = message(2, 'PAIR_RESPONSE', { code: '000000' })

    const fourTimes = run(waiting, wrong, wrong, wrong, wrong)
    expect(fourTimes.state.devices[1]).toMatchObject({
      connection: 'code_wait',
      codeAttempts: 4,
      codeError: 'wrong'
    })
    expect(fourTimes.effects).toHaveLength(4)
    expect(fourTimes.effects[0]).toEqual({
      type: 'sendTo',
      slot: 2,
      messageType: 'PAIR_INVITE',
      payload: { rejected: true }
    })

    const fifth = run(fourTimes.state, wrong)
    expect(fifth.effects).toEqual([{ type: 'disconnect', slot: 2 }])
    expect(fifth.state.devices[1]).toMatchObject({
      connection: 'empty',
      device: null,
      pairingCode: null,
      codeAttempts: 0,
      codeError: null
    })
    expect(fifth.state.devices[2].connection).toBe('connected')
    expect(fifth.state.phase).toBe('PAIRING')
  })

  test('ble: expired code is rejected and resend issues a new one', () => {
    const waiting = run(start('2-of-2', 'ble'), ...blePairing(2)).state
    const late = run(waiting, message(2, 'PAIR_RESPONSE', { code: CODE }, CODE_EXPIRES_AT))
    expect(late.effects).toEqual([])
    expect(late.state.devices[1]).toMatchObject({
      connection: 'code_wait',
      codeError: 'expired',
      codeAttempts: 0
    })

    const timerExpired = run(waiting, { type: 'PAIR_CODE_EXPIRED', slot: 2 })
    expect(timerExpired.state.devices[1].codeError).toBe('expired')

    const resend = run(
      waiting,
      message(2, 'PAIR_RESPONSE', { code: '111111' }),
      { type: 'PAIR_CODE_EXPIRED', slot: 2 },
      { type: 'PAIR_CODE_RESEND', slot: 2 }
    )
    expect(resend.effects).toEqual([
      { type: 'sendTo', slot: 2, messageType: 'PAIR_INVITE', payload: { rejected: true } },
      { type: 'issueCode', slot: 2 }
    ])
    expect(resend.state.devices[1]).toMatchObject({ codeAttempts: 1, codeError: 'expired' })

    const reissued = run(resend.state, {
      type: 'PAIR_CODE_ISSUED',
      slot: 2,
      code: '654321',
      expiresAt: 200_000
    })
    expect(reissued.state.devices[1]).toMatchObject({
      connection: 'code_wait',
      pairingCode: '654321',
      pairingCodeExpiresAt: 200_000,
      codeAttempts: 0,
      codeError: null
    })
    const accepted = run(
      reissued.state,
      message(2, 'PAIR_RESPONSE', { code: '654321', device: PHONES[2] }, CODE_EXPIRES_AT)
    )
    expect(accepted.state.devices[1].connection).toBe('connected')
  })

  test('ble: owner Matches before all DKG_FINAL does not activate', () => {
    const verified = bleToKeysetVerified('2-of-3')
    expect(verifyPageDevices(verified).map(d => d.confirmed)).toEqual([false, false])

    const confirmed = run(verified, { type: 'FINGERPRINT_CONFIRMED', stage: 'final' })
    expect(confirmed.state.phase).toBe('KEYSET_VERIFIED')
    expect(confirmed.state.ownerConfirmed.final).toBe(true)
    expect(confirmed.effects).toEqual([])

    const oneFinal = run(confirmed.state, message(2, 'DKG_FINAL', { fingerprint: FP }))
    expect(oneFinal.state.phase).toBe('KEYSET_VERIFIED')
    expect(oneFinal.effects).toEqual([])
    expect(verifyPageDevices(oneFinal.state)).toEqual([
      { slot: 2, device: PHONES[2], confirmed: true },
      { slot: 3, device: PHONES[3], confirmed: false }
    ])

    const allFinal = run(oneFinal.state, message(3, 'DKG_FINAL', { fingerprint: FP }), {
      type: 'VAULT_RECORD_SAVED'
    })
    expect(allFinal.state.phase).toBe('ACTIVATED')
    expect(allFinal.effects.map(e => e.type)).toEqual([
      'saveVaultRecord',
      'sendTo',
      'sendTo',
      'persistGroup',
      'dkgClose'
    ])

    // Phones confirming first still wait for the owner.
    const phonesFirst = run(verified, ...each([2, 3], 'DKG_FINAL', { fingerprint: FP }))
    expect(phonesFirst.state.phase).toBe('KEYSET_VERIFIED')
    const ownerLast = run(
      phonesFirst.state,
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
      { type: 'VAULT_RECORD_SAVED' }
    )
    expect(ownerLast.state.phase).toBe('ACTIVATED')
  })

  test('round 2 keeps the sealed record', () => {
    const initial = start('2-of-3', 'ble')
    expect(initial.vaultRecord).toBeNull()
    expect(initial.savingRecord).toBe(false)

    const verified = bleToKeysetVerified('2-of-3')
    expect(verified.phase).toBe('KEYSET_VERIFIED')
    expect(verified.vaultRecord).toEqual(RECORD)
    expect(verified.savingRecord).toBe(false)
  })

  test('a round-2 result with no valid record, or one for another group or network, aborts', () => {
    const events = bleCeremonyEvents('2-of-3', 'verified')
    const beforeLast = run(start('2-of-3', 'ble'), ...events.slice(0, -1)).state
    expect(beforeLast.phase).toBe('DKG_R2')
    const records: unknown[] = [
      undefined,
      { ...RECORD, version: 2 },
      { ...RECORD, groupId: 'other' },
      { ...RECORD, network: 'testnet' }
    ]
    for (const record of records) {
      const result = reduceCreateSession(beforeLast, {
        type: 'DKG_ROUND2_ACCEPTED',
        slot: 3,
        result: { ...completeRound2([2, 3]), record } as VaultDkgRound2Response
      })
      expect(result.state.phase).toBe('ABORTED')
      expect(result.state.abortReason).toBe('verification_failed')
      expect(result.state.vaultRecord).toBeNull()
      expect(result.effects).toEqual([...BLE_ABORT_NOTICES, { type: 'dkgClose', sessionId: SID }])
    }

    // A testnet session must get a testnet record, so a mainnet one is refused there too.
    const testnet = run(
      createInitialSession({
        groupId: GROUP_ID,
        sessionId: SESSION_ID,
        threshold: '2-of-3',
        transportKind: 'ble',
        owner: OWNER,
        mainnet: false
      }),
      ...events
    ).state
    expect(testnet.phase).toBe('ABORTED')
    expect(testnet.abortReason).toBe('verification_failed')
  })

  test('Bluetooth saves before it activates', () => {
    for (const threshold of ['2-of-2', '2-of-3', '3-of-3'] as const) {
      const slots: readonly (2 | 3)[] = threshold === '2-of-2' ? [2] : [2, 3]
      const whole = run(
        start(threshold, 'ble'),
        ...bleCeremonyEvents(threshold, 'verified'),
        { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
        ...each(slots, 'DKG_FINAL', { fingerprint: FP })
      )
      expect(whole.state.phase).toBe('KEYSET_VERIFIED')
      expect(whole.state.savingRecord).toBe(true)
      expect(whole.effects.at(-1)).toEqual({
        type: 'saveVaultRecord',
        groupId: GROUP_ID,
        record: RECORD
      })

      const last = reduceCreateSession(
        run(
          bleToKeysetVerified(threshold),
          { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
          ...each(slots.slice(0, -1), 'DKG_FINAL', { fingerprint: FP })
        ).state,
        message(slots[slots.length - 1], 'DKG_FINAL', { fingerprint: FP })
      )
      expect(last.effects).toEqual([{ type: 'saveVaultRecord', groupId: GROUP_ID, record: RECORD }])

      expect(whole.effects.some(effect => effect.type === 'persistGroup')).toBe(false)
      expect(
        whole.effects.some(
          effect => effect.type === 'sendTo' && effect.messageType === 'DKG_ACTIVATE'
        )
      ).toBe(false)
    }
  })

  test('VAULT_RECORD_SAVED activates with the usual effects', () => {
    const saving = run(
      bleToKeysetVerified('2-of-3'),
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
      ...each([2, 3], 'DKG_FINAL', { fingerprint: FP })
    ).state
    const saved = reduceCreateSession(saving, { type: 'VAULT_RECORD_SAVED' })
    expect(saved.state.phase).toBe('ACTIVATED')
    expect(saved.state.savingRecord).toBe(false)
    expect(saved.effects).toEqual([
      { type: 'sendTo', slot: 2, messageType: 'DKG_ACTIVATE' },
      { type: 'sendTo', slot: 3, messageType: 'DKG_ACTIVATE' },
      {
        type: 'persistGroup',
        record: {
          groupId: GROUP_ID,
          threshold: '2-of-3',
          transportKind: 'ble',
          devices: [OWNER, PHONES[2], PHONES[3]],
          fingerprint: FP,
          createdAt: 0,
          mock: true
        }
      },
      { type: 'dkgClose', sessionId: SID }
    ])
  })

  test('VAULT_RECORD_SAVE_FAILED aborts with save_failed and tells the phones', () => {
    const saving = run(
      bleToKeysetVerified('2-of-3'),
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
      ...each([2, 3], 'DKG_FINAL', { fingerprint: FP })
    ).state
    const failed = reduceCreateSession(saving, { type: 'VAULT_RECORD_SAVE_FAILED' })
    expect(failed.state.phase).toBe('ABORTED')
    expect(failed.state.abortReason).toBe('save_failed')
    expect(failed.state.savingRecord).toBe(false)
    expect(failed.effects).toEqual([...BLE_ABORT_NOTICES, { type: 'dkgClose', sessionId: SID }])
    expect(failed.effects.some(effect => effect.type === 'persistGroup')).toBe(false)
    expectGuardiansEmpty(failed.state)
  })

  test('a save report outside saving is ignored', () => {
    const verified = bleToKeysetVerified('2-of-3')
    const ownerOnly = run(verified, { type: 'FINGERPRINT_CONFIRMED', stage: 'final' }).state
    const phonesOnly = run(verified, ...each([2, 3], 'DKG_FINAL', { fingerprint: FP })).state
    const activated = run(
      verified,
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
      ...each([2, 3], 'DKG_FINAL', { fingerprint: FP }),
      { type: 'VAULT_RECORD_SAVED' }
    ).state
    expect(activated.phase).toBe('ACTIVATED')
    const aborted = run(verified, { type: 'USER_ABORT' }).state
    for (const state of [verified, ownerOnly, phonesOnly, activated, aborted]) {
      for (const type of ['VAULT_RECORD_SAVED', 'VAULT_RECORD_SAVE_FAILED'] as const) {
        const result = reduceCreateSession(state, { type })
        expect(result.state).toBe(state)
        expect(result.effects).toEqual([])
      }
    }
  })

  test('a repeated DKG_FINAL while saving starts no second save', () => {
    const saving = run(
      bleToKeysetVerified('2-of-3'),
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
      ...each([2, 3], 'DKG_FINAL', { fingerprint: FP })
    ).state
    expect(saving.savingRecord).toBe(true)
    const again = run(
      saving,
      message(2, 'DKG_FINAL', { fingerprint: FP }),
      message(3, 'DKG_FINAL', { fingerprint: FP }),
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' }
    )
    expect(again.effects).toEqual([])
    expect(again.state.phase).toBe('KEYSET_VERIFIED')
    expect(again.state.savingRecord).toBe(true)
  })

  test('USER_ABORT while saving aborts', () => {
    const saving = run(
      bleToKeysetVerified('2-of-3'),
      { type: 'FINGERPRINT_CONFIRMED', stage: 'final' },
      ...each([2, 3], 'DKG_FINAL', { fingerprint: FP })
    ).state
    const aborted = reduceCreateSession(saving, { type: 'USER_ABORT' })
    expect(aborted.state.phase).toBe('ABORTED')
    expect(aborted.state.abortReason).toBe('user_cancelled')
    expect(aborted.effects).toEqual([...BLE_ABORT_NOTICES, { type: 'dkgClose', sessionId: SID }])
    expect(aborted.state.savingRecord).toBe(false)

    // The save answer that arrives afterwards changes nothing.
    const late = reduceCreateSession(aborted.state, { type: 'VAULT_RECORD_SAVED' })
    expect(late.state).toBe(aborted.state)
    expect(late.effects).toEqual([])
  })

  test('disconnect during ceremony aborts and clears every guardian', () => {
    const ceremony = run(start('2-of-3', 'ble'), ...blePair(2), ...blePair(3), {
      type: 'CONTINUE'
    }).state
    const aborted = run(ceremony, { type: 'DEVICE_DISCONNECTED', slot: 3 })
    expect(aborted.state.phase).toBe('ABORTED')
    expect(aborted.state.abortReason).toBe('device_disconnected')
    expectGuardiansEmpty(aborted.state)

    // A terminal session ignores everything, including late messages.
    const late = reduceCreateSession(aborted.state, message(2, 'DKG_R1'))
    expect(late.state).toBe(aborted.state)
    expect(late.effects).toEqual([])
  })

  test('a Bluetooth abort tells each involved phone, then drops its link', () => {
    const ceremony = run(start('2-of-3', 'ble'), ...blePair(2), ...blePair(3), {
      type: 'CONTINUE'
    }).state
    // Once the Worker holds a DKG session, the abort also closes it, after the phones are told.
    const aborts: [CreateSessionState, CreateSessionEvent, readonly CreateSessionEffect[]][] = [
      [ceremony, { type: 'DEVICE_DISCONNECTED', slot: 3 }, BLE_ABORT_NOTICES],
      [
        bleToKeysetVerified('2-of-3'),
        { type: 'FINGERPRINT_REJECTED', stage: 'final' },
        [...BLE_ABORT_NOTICES, { type: 'dkgClose', sessionId: SID }]
      ],
      [ceremony, { type: 'USER_ABORT' }, BLE_ABORT_NOTICES]
    ]
    for (const [state, event, expected] of aborts) {
      const result = reduceCreateSession(state, event)
      expect(result.state.phase).toBe('ABORTED')
      expect(result.effects).toEqual(expected)
    }
  })

  test('ble: a mismatched echo or fingerprint, a bad payload or a DKG failure aborts with verification_failed', () => {
    const cases: [CreateSessionState, CreateSessionEvent][] = [
      [bleState('2-of-3', 'bundled'), message(2, 'DKG_R1_ECHO', { round1Hash: '2'.repeat(64) })],
      [bleToKeysetVerified('2-of-3'), message(2, 'DKG_FINAL', { fingerprint: '0'.repeat(64) })],
      [bleState('2-of-3', 'opened'), message(2, 'DKG_R1', {})],
      [bleState('2-of-3', 'opened'), { type: 'DKG_FAILED' }],
      [bleToKeysetVerified('2-of-3'), { type: 'DKG_FAILED' }]
    ]
    for (const [state, event] of cases) {
      const result = reduceCreateSession(state, event)
      expect(result.state.phase).toBe('ABORTED')
      expect(result.state.abortReason).toBe('verification_failed')
      expect(result.effects).toEqual([...BLE_ABORT_NOTICES, { type: 'dkgClose', sessionId: SID }])
      expectGuardiansEmpty(result.state)
    }
  })

  test('ble: round results that leave out a phone abort', () => {
    const awaitingRound1 = run(
      bleState('2-of-3', 'opened'),
      ...each([2, 3], 'DKG_R1', { envelope: ENV }),
      { type: 'DKG_ROUND1_ACCEPTED', slot: 2, result: { complete: false } }
    ).state
    const shortRound1 = reduceCreateSession(awaitingRound1, {
      type: 'DKG_ROUND1_ACCEPTED',
      slot: 3,
      result: { complete: true, round1Hash: H1, bundles: { '1': ENV } }
    })
    expect(shortRound1.state.phase).toBe('ABORTED')
    expect(shortRound1.state.abortReason).toBe('verification_failed')

    const awaitingRound2 = run(
      bleState('2-of-3', 'bundled'),
      ...each([2, 3], 'DKG_R1_ECHO', { round1Hash: H1 }),
      ...each([2, 3], 'DKG_R2_BATCH', { envelope: ENV }),
      { type: 'DKG_ROUND2_ACCEPTED', slot: 2, result: { complete: false } }
    ).state
    const shortRound2 = reduceCreateSession(awaitingRound2, {
      type: 'DKG_ROUND2_ACCEPTED',
      slot: 3,
      result: {
        complete: true,
        fingerprint: FP,
        inboxes: { '1': ENV, '2': ENV },
        sealedQsk: { '1': ENV }
      }
    })
    expect(shortRound2.state.phase).toBe('ABORTED')
    expect(shortRound2.state.abortReason).toBe('verification_failed')
  })

  test('ble: an abort after the DKG session opened closes it', () => {
    const beforeOpen = run(start('2-of-3', 'ble'), ...blePair(2), ...blePair(3), {
      type: 'CONTINUE'
    }).state
    expect(run(beforeOpen, { type: 'USER_ABORT' }).effects).toEqual(BLE_ABORT_NOTICES)

    const afterOpen = run(beforeOpen, { type: 'DKG_OPENED', sessionId: SID })
    expect(run(afterOpen.state, { type: 'USER_ABORT' }).effects).toEqual([
      ...BLE_ABORT_NOTICES,
      { type: 'dkgClose', sessionId: SID }
    ])
  })

  test('ble: a DKG session id that arrives late is ignored', () => {
    const pairing = run(start('2-of-3', 'ble'), ...blePair(2)).state
    const tooEarly = reduceCreateSession(pairing, { type: 'DKG_OPENED', sessionId: SID })
    expect(tooEarly.state).toBe(pairing)
    expect(tooEarly.effects).toEqual([])

    const opened = bleState('2-of-3', 'opened')
    const twice = reduceCreateSession(opened, { type: 'DKG_OPENED', sessionId: 'other' })
    expect(twice.state).toBe(opened)
    expect(twice.effects).toEqual([])

    const aborted = run(opened, { type: 'USER_ABORT' }).state
    const afterAbort = reduceCreateSession(aborted, { type: 'DKG_OPENED', sessionId: SID })
    expect(afterAbort.state).toBe(aborted)
    expect(afterAbort.effects).toEqual([])
  })

  test('disconnect while pairing only resets that device', () => {
    const state = run(start('2-of-3', 'ble'), ...blePair(2), ...blePairing(3)).state
    const result = run(state, { type: 'DEVICE_DISCONNECTED', slot: 2 })
    expect(result.state.phase).toBe('PAIRING')
    expect(result.effects).toEqual([{ type: 'disconnect', slot: 2 }])
    expect(result.state.devices.map(d => d.connection)).toEqual(['connected', 'empty', 'code_wait'])

    const cancelled = run(result.state, { type: 'PAIR_CANCEL', slot: 3 })
    expect(cancelled.effects).toEqual([{ type: 'disconnect', slot: 3 }])
    expectGuardiansEmpty(cancelled.state)

    const chooserClosed = run(
      start('2-of-2', 'ble'),
      { type: 'PAIR_START', slot: 2 },
      { type: 'PAIR_SELECTION_CANCELLED', slot: 2 }
    )
    expect(chooserClosed.effects).toEqual([
      { type: 'requestDevice', slot: 2 },
      { type: 'disconnect', slot: 2 }
    ])
    expectGuardiansEmpty(chooserClosed.state)
  })

  test('a Bluetooth name is only a label until the phone identifies itself', () => {
    const label: MultisigDevice = { ...PHONES[2], name: 'Headphones', model: 'Headphones' }
    const picked = run(
      start('2-of-2', 'ble'),
      { type: 'PAIR_START', slot: 2 },
      { type: 'PAIR_DEVICE_SELECTED', slot: 2, device: label },
      { type: 'PAIR_CODE_ISSUED', slot: 2, code: CODE, expiresAt: CODE_EXPIRES_AT }
    ).state
    expect(picked.devices[1].device).toEqual(label)

    const noIdentity = run(picked, message(2, 'PAIR_RESPONSE', { code: CODE }))
    expect(noIdentity.state).toBe(picked)

    const paired = run(picked, message(2, 'PAIR_RESPONSE', { code: CODE, device: PHONES[2] }))
    expect(paired.state.devices[1]).toMatchObject({ connection: 'connected', device: PHONES[2] })
  })

  test('a second Bluetooth chooser waits for the open one', () => {
    const { state, effects } = run(
      start('2-of-3', 'ble'),
      { type: 'PAIR_START', slot: 2 },
      { type: 'PAIR_START', slot: 3 }
    )

    expect(effects).toEqual([{ type: 'requestDevice', slot: 2 }])
    expect(state.devices.map(d => d.connection)).toEqual(['connected', 'choosing', 'empty'])
  })

  test('switching transport resets once any guardian is connected', () => {
    const idle = start('2-of-3', 'ble')
    const switched = run(idle, { type: 'SWITCH_TRANSPORT', kind: 'qr' })
    expect(switched.state.phase).toBe('PAIRING')
    expect(switched.state.transportKind).toBe('qr')
    expect(switched.state.manualR1Check).toBe(true)
    expect(switched.effects).toEqual([])

    const same = reduceCreateSession(idle, { type: 'SWITCH_TRANSPORT', kind: 'ble' })
    expect(same.state).toBe(idle)

    const connected = run(idle, ...blePair(2)).state
    const aborted = run(connected, { type: 'SWITCH_TRANSPORT', kind: 'qr' })
    expect(aborted.state.phase).toBe('ABORTED')
    expect(aborted.state.abortReason).toBe('transport_switched')
    expectGuardiansEmpty(aborted.state)
  })

  test('continue is ignored until every guardian is connected', () => {
    const halfway = run(start('2-of-3', 'ble'), ...blePair(2), ...blePairing(3)).state
    const result = reduceCreateSession(halfway, { type: 'CONTINUE' })
    expect(result.state).toBe(halfway)
    expect(result.effects).toEqual([])
  })

  test('ignores foreign or out-of-order messages', () => {
    const waiting = run(start('2-of-3', 'ble'), ...blePairing(2)).state
    const answer = { code: CODE, device: PHONES[2] }
    const reply = message(2, 'PAIR_RESPONSE', answer)
    const ignored: CreateSessionEvent[] = [
      // Another session's reply, even with the right code.
      message(2, 'PAIR_RESPONSE', answer, 1_000, 'other-session'),
      // A message from a later round while still pairing.
      message(2, 'DKG_R2_BATCH'),
      // A reply from a slot that is not pairing.
      message(3, 'PAIR_RESPONSE', { code: CODE, device: PHONES[3] }),
      // A reply that claims to come from a different phone than its slot.
      { ...reply, envelope: { ...reply.envelope, sender_id: deviceId(3) } },
      // Replies whose payload carries no usable code.
      message(2, 'PAIR_RESPONSE'),
      { ...reply, envelope: { ...reply.envelope, encrypted_payload: '{not json' } }
    ]
    for (const event of ignored) {
      const result = reduceCreateSession(waiting, event)
      expect(result.state).toBe(waiting)
      expect(result.effects).toEqual([])
    }

    const twoOfTwo = run(start('2-of-2', 'qr'), { type: 'PAIR_START', slot: 2 }).state
    const nonGuardian = reduceCreateSession(twoOfTwo, message(3, 'PAIR_RESPONSE'))
    expect(nonGuardian.state).toBe(twoOfTwo)
    const badDevice = reduceCreateSession(
      twoOfTwo,
      message(2, 'PAIR_RESPONSE', { device: { name: 'Alex', model: 7, platform: 'ios' } })
    )
    expect(badDevice.state).toBe(twoOfTwo)
  })

  test('a phone abort, step timeout or user abort ends the session with its reason', () => {
    const ceremony = run(start('2-of-2', 'ble'), ...blePair(2), { type: 'CONTINUE' }).state
    const cases: [CreateSessionEvent, string][] = [
      [message(2, 'SESSION_ABORT'), 'phone_rejected'],
      [{ type: 'STEP_TIMEOUT' }, 'session_expired'],
      [{ type: 'USER_ABORT' }, 'user_cancelled']
    ]
    for (const [event, reason] of cases) {
      const result = reduceCreateSession(ceremony, event)
      expect(result.state.phase).toBe('ABORTED')
      expect(result.state.abortReason).toBe(reason)
      expectGuardiansEmpty(result.state)
    }
  })

  test('fingerprint rejected aborts', () => {
    const final = reduceCreateSession(bleToKeysetVerified('2-of-3'), {
      type: 'FINGERPRINT_REJECTED',
      stage: 'final'
    })
    expect(final.state.phase).toBe('ABORTED')
    expect(final.state.abortReason).toBe('fingerprint_mismatch')
    expectGuardiansEmpty(final.state)
  })
})
