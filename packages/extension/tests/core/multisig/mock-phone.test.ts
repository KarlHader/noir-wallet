import { before, test } from 'node:test'
import { expect } from '@playwright/test'
import {
  DkgCoordinatorSession,
  type Round2Outcome
} from '../../../src/core/multisig/dkg-coordinator'
import { parseDkgEnvelopePayload, type VaultWasm } from '../../../src/core/multisig/dkg-protocol'
import { base64ToBytes, bytesToBase64 } from '../../../src/lib/bytes'
import {
  MockPhone,
  type MockPhoneHooks,
  type MockPhoneSignal
} from '../../../src/popup/multisig/mock/mock-phone'
import { TEST_MNEMONIC, loadVaultWasm } from './helpers/vault-wasm'
import {
  DEFAULT_MOCK_SETTINGS,
  MOCK_GUARDIANS,
  readMockSettings,
  writeMockSettings,
  type MockResponse
} from '../../../src/popup/multisig/mock/mock-settings'
import {
  createEnvelopeFactory,
  deviceId,
  type MultisigEnvelope,
  type MultisigMessageType
} from '../../../src/core/multisig/messages'

const SESSION = { groupId: 'group-1', sessionId: 'session-1' }
const CODE = '482913'

// Runs every scheduled reply on the spot so each case can assert right after receive().
const HOOKS: MockPhoneHooks = {
  now: () => 1_000,
  schedule: fn => {
    fn()
    return () => {}
  }
}

type PhoneSignal = MockPhoneSignal

const fromOwner = createEnvelopeFactory({ ...SESSION, senderId: deviceId(1) })

let wasm: VaultWasm
const loadVault = () => loadVaultWasm()

before(async () => {
  wasm = await loadVaultWasm()
})

function setNextResponse(slot: 2 | 3, response: MockResponse) {
  const nextResponse = { ...DEFAULT_MOCK_SETTINGS.nextResponse }
  nextResponse[slot] = response
  writeMockSettings({ ...DEFAULT_MOCK_SETTINGS, nextResponse })
}

function deliver(
  phone: MockPhone,
  slot: 2 | 3,
  messageType: MultisigMessageType,
  payload?: Record<string, unknown>
): PhoneSignal[] {
  const signals: PhoneSignal[] = []
  phone.receive(fromOwner(messageType, deviceId(slot), payload), signal => {
    signals.push(signal)
  })
  return signals
}

function onlyEnvelope(signals: readonly PhoneSignal[]): MultisigEnvelope {
  expect(signals).toHaveLength(1)
  const [signal] = signals
  if ('type' in signal) throw new Error('expected a reply envelope, got a disconnect signal')
  return signal
}

function payloadOf(envelope: MultisigEnvelope): unknown {
  return JSON.parse(envelope.encrypted_payload)
}

function expectFromPhone(envelope: MultisigEnvelope, slot: 2 | 3) {
  expect(envelope).toMatchObject({
    group_id: SESSION.groupId,
    session_id: SESSION.sessionId,
    sender_id: deviceId(slot),
    recipient_id: deviceId(1)
  })
}

// Ceremony replies are computed on the real WASM, so they arrive once the phone is idle again.
async function settle(
  phone: MockPhone,
  slot: 2 | 3,
  messageType: MultisigMessageType,
  payload?: Record<string, unknown>
): Promise<PhoneSignal[]> {
  const signals = deliver(phone, slot, messageType, payload)
  await phone.whenIdle()
  return signals
}

function envelopeBytes(reply: MultisigEnvelope): Uint8Array {
  const payload = parseDkgEnvelopePayload(payloadOf(reply))
  if (!payload) throw new Error(`${reply.message_type} carries no envelope`)
  return base64ToBytes(payload.envelope)
}

const TWO_OF_TWO = { participants: 2, threshold: 2 } as const

/** Drives a 2-of-2 phone at device slot 2 (roster slot 1) through round 2 against a coordinator. */
async function driveToRound2(phone: MockPhone, session: DkgCoordinatorSession) {
  const dkgSessionId = bytesToBase64(session.sessionId)
  const r1Reply = onlyEnvelope(
    await settle(phone, 2, 'ROSTER_LOCK', {
      dkgSessionId,
      ...TWO_OF_TWO,
      rosterSlot: 1,
      mainnet: true
    })
  )
  expect(r1Reply.message_type).toBe('DKG_R1')
  expectFromPhone(r1Reply, 2)
  const r1 = await session.acceptRound1(1, envelopeBytes(r1Reply))
  if (!r1.complete) throw new Error('round 1 should be complete')

  const echo = onlyEnvelope(
    await settle(phone, 2, 'DKG_R1_BUNDLE', { envelope: bytesToBase64(r1.bundles.get(1)!) })
  )
  expect(echo.message_type).toBe('DKG_R1_ECHO')
  expect(payloadOf(echo)).toEqual({ round1Hash: r1.round1Hash })

  const batch = onlyEnvelope(await settle(phone, 2, 'DKG_R1_CERT'))
  expect(batch.message_type).toBe('DKG_R2_BATCH')
  const r2 = await session.acceptRound2(1, envelopeBytes(batch))
  if (!r2.complete) throw new Error('round 2 should be complete')
  return r2 as Round2Outcome
}

test.describe('multisig mock phone', () => {
  test.afterEach(() => {
    writeMockSettings(DEFAULT_MOCK_SETTINGS)
  })

  test('approve replies to PAIR_INVITE with the code it was handed and its device', () => {
    const phone = new MockPhone(2, SESSION, HOOKS)
    // Without a code from the screen there is nothing to type, so the invite goes unanswered.
    expect(deliver(phone, 2, 'PAIR_INVITE')).toEqual([])

    phone.setPairingCode(CODE)
    const reply = onlyEnvelope(deliver(phone, 2, 'PAIR_INVITE'))
    expect(reply.message_type).toBe('PAIR_RESPONSE')
    expectFromPhone(reply, 2)
    expect(payloadOf(reply)).toEqual({ code: CODE, device: MOCK_GUARDIANS[2] })
  })

  test('wrong_code replies once with a different code, then approve replies correctly', () => {
    setNextResponse(2, 'wrong_code')
    const phone = new MockPhone(2, SESSION, HOOKS)
    phone.setPairingCode(CODE)

    const wrong = onlyEnvelope(deliver(phone, 2, 'PAIR_INVITE'))
    const wrongPayload = payloadOf(wrong) as { code: string; device: unknown }
    expect(wrong.message_type).toBe('PAIR_RESPONSE')
    expect(wrongPayload.code).toMatch(/^\d{6}$/)
    expect(wrongPayload.code).not.toBe(CODE)
    expect(wrongPayload.device).toEqual(MOCK_GUARDIANS[2])
    // The setting is one-shot: the slot is back to approve as soon as the phone used it.
    expect(readMockSettings().nextResponse[2]).toBe('approve')

    const retry = onlyEnvelope(deliver(phone, 2, 'PAIR_INVITE', { rejected: true }))
    expect(payloadOf(retry)).toEqual({ code: CODE, device: MOCK_GUARDIANS[2] })
  })

  test('timeout produces no reply; disconnect emits a disconnect signal', () => {
    setNextResponse(2, 'timeout')
    const silent = new MockPhone(2, SESSION, HOOKS)
    silent.setPairingCode(CODE)
    expect(deliver(silent, 2, 'PAIR_INVITE')).toEqual([])

    setNextResponse(3, 'disconnect')
    const dropping = new MockPhone(3, SESSION, HOOKS)
    dropping.setPairingCode(CODE)
    expect(deliver(dropping, 3, 'PAIR_INVITE')).toEqual([{ type: 'disconnect' }])
  })

  test('reject answers ROSTER_LOCK with SESSION_ABORT', () => {
    setNextResponse(3, 'reject')
    const reply = onlyEnvelope(deliver(new MockPhone(3, SESSION, HOOKS), 3, 'ROSTER_LOCK'))
    expect(reply.message_type).toBe('SESSION_ABORT')
    expectFromPhone(reply, 3)
  })

  test('approve walks the ceremony with real wasm and replies with the fingerprint', async () => {
    const session = DkgCoordinatorSession.open(
      wasm,
      { ...TWO_OF_TWO, mainnet: true, walletId: 'wallet-1', groupId: 'group-1' },
      () => TEST_MNEMONIC
    )
    const phone = new MockPhone(2, SESSION, HOOKS, loadVault)
    const r2 = await driveToRound2(phone, session)

    expect(
      await settle(phone, 2, 'DKG_R2_INBOX', { envelope: bytesToBase64(r2.inboxes.get(1)!) })
    ).toEqual([])
    const final = onlyEnvelope(
      await settle(phone, 2, 'KEYSET_SETUP', { sealedQsk: bytesToBase64(r2.sealedQsk.get(1)!) })
    )
    expect(final.message_type).toBe('DKG_FINAL')
    expectFromPhone(final, 2)
    expect(payloadOf(final)).toEqual({ fingerprint: r2.fingerprint })

    expect(await settle(phone, 2, 'DKG_ACTIVATE')).toEqual([])
    // The extension's abort is taken in silently; nothing answers it.
    expect(await settle(phone, 2, 'SESSION_ABORT')).toEqual([])
    phone.dispose()
    session.close()
  })

  test('DKG_R2_INBOX is processed without using the dev-panel response', async () => {
    const session = DkgCoordinatorSession.open(
      wasm,
      { ...TWO_OF_TWO, mainnet: true, walletId: 'wallet-1', groupId: 'group-1' },
      () => TEST_MNEMONIC
    )
    const phone = new MockPhone(2, SESSION, HOOKS, loadVault)
    const r2 = await driveToRound2(phone, session)

    setNextResponse(2, 'reject')
    expect(
      await settle(phone, 2, 'DKG_R2_INBOX', { envelope: bytesToBase64(r2.inboxes.get(1)!) })
    ).toEqual([])
    expect(readMockSettings().nextResponse[2]).toBe('reject')
    const abort = onlyEnvelope(
      await settle(phone, 2, 'KEYSET_SETUP', { sealedQsk: bytesToBase64(r2.sealedQsk.get(1)!) })
    )
    expect(abort.message_type).toBe('SESSION_ABORT')
    expect(readMockSettings().nextResponse[2]).toBe('approve')
    phone.dispose()
    session.close()
  })

  test('reports failed when its wasm cannot load', async () => {
    const phone = new MockPhone(2, SESSION, HOOKS, () => Promise.reject(new Error('no wasm')))
    const lock = {
      dkgSessionId: btoa('0123456789abcdef'),
      ...TWO_OF_TWO,
      rosterSlot: 1,
      mainnet: true
    }
    expect(await settle(phone, 2, 'ROSTER_LOCK', lock)).toEqual([{ type: 'failed' }])
    // Failed is reported once; later ceremony messages are swallowed.
    expect(await settle(phone, 2, 'DKG_R1_CERT')).toEqual([])
    phone.dispose()
  })

  test('reports failed for a malformed ceremony payload', async () => {
    const phone = new MockPhone(2, SESSION, HOOKS, loadVault)
    expect(await settle(phone, 2, 'ROSTER_LOCK', {})).toEqual([{ type: 'failed' }])
    phone.dispose()

    // A phone built without a WASM loader cannot take part in a ceremony at all.
    const lock = {
      dkgSessionId: btoa('0123456789abcdef'),
      ...TWO_OF_TWO,
      rosterSlot: 2,
      mainnet: true
    }
    const offline = new MockPhone(3, SESSION, HOOKS)
    expect(await settle(offline, 3, 'ROSTER_LOCK', lock)).toEqual([{ type: 'failed' }])
    offline.dispose()
  })

  test('produce builds the scanned reply with the phone ids and honors reject', () => {
    const phone = new MockPhone(3, SESSION, HOOKS)
    const final = phone.produce('DKG_FINAL')
    expect(final.message_type).toBe('DKG_FINAL')
    expectFromPhone(final, 3)

    // Over QR the pairing reply carries the phone identity only; there is no code to type.
    expect(payloadOf(phone.produce('PAIR_RESPONSE'))).toEqual({ device: MOCK_GUARDIANS[3] })

    setNextResponse(3, 'reject')
    const abort = phone.produce('DKG_R2_BATCH')
    expect(abort.message_type).toBe('SESSION_ABORT')
    expectFromPhone(abort, 3)
  })
})
