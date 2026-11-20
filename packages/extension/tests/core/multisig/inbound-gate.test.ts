import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createInboundGate } from '../../../src/core/multisig/inbound-gate'
import type { MultisigEnvelope, MultisigMessageType } from '../../../src/core/multisig/messages'
import { bytesToBase64 } from '../../../src/lib/bytes'
import { identityFromSeed, signedPhoneEnvelope } from './helpers/identity'

const GROUP = '11111111-2222-4333-8444-555555555555'
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DEVICE = { name: 'iPhone', model: 'iPhone15,2', platform: 'ios' }

const own = await identityFromSeed(new Uint8Array(32).fill(0x11))
const phone2 = await identityFromSeed(new Uint8Array(32).fill(0x22))
const phone3 = await identityFromSeed(new Uint8Array(32).fill(0x33))
const ownKey = bytesToBase64(own.publicKey)
const key2 = bytesToBase64(phone2.publicKey)
const key3 = bytesToBase64(phone3.publicKey)

function newGate() {
  return createInboundGate({
    groupId: GROUP,
    sessionId: SESSION,
    ownIdentityPublicKey: ownKey,
    slots: [2, 3]
  })
}

type Options = {
  type?: MultisigMessageType
  sender?: string
  recipient?: string
  session?: string
  round?: number
  sequence?: number
  payload?: unknown
}

function phoneEnvelope(signer: typeof phone2, options: Options = {}): Promise<MultisigEnvelope> {
  const type = options.type ?? 'DKG_R1'
  const round = type === 'PAIR_RESPONSE' ? 0 : 1
  return signedPhoneEnvelope(signer, {
    protocol_version: 1,
    message_type: type,
    group_id: GROUP,
    session_id: options.session ?? SESSION,
    sender_id: options.sender ?? 'device-2',
    recipient_id: options.recipient ?? 'device-1',
    round: options.round ?? round,
    sequence: options.sequence ?? 1,
    encrypted_payload: JSON.stringify(options.payload ?? { envelope: 'AA==' })
  })
}

function pairResponse(signer: typeof phone2, key: string, options: Options = {}) {
  return phoneEnvelope(signer, {
    type: 'PAIR_RESPONSE',
    payload: { identityPublicKey: key, device: DEVICE },
    ...options
  })
}

test('accepts a self-signed PAIR_RESPONSE and registers the phone', async () => {
  const gate = newGate()
  expect(gate.peerIdentity(2)).toBeNull()
  expect(await gate.check(await pairResponse(phone2, key2))).toEqual({ kind: 'accept', slot: 2 })
  expect(gate.peerIdentity(2)).toBe(key2)
})

test('a code from another session is foreign, not invalid', async () => {
  const gate = newGate()
  const envelope = await pairResponse(phone2, key2, { session: 'other-session' })
  expect(await gate.check(envelope)).toEqual({ kind: 'foreign', reason: 'other_session' })
})

test('a message addressed to someone else is not_for_us and an unknown sender is foreign', async () => {
  const gate = newGate()
  const toOther = await pairResponse(phone2, key2, { recipient: 'device-3' })
  expect(await gate.check(toOther)).toEqual({ kind: 'foreign', reason: 'not_for_us' })
  const unknown = await pairResponse(phone2, key2, { sender: 'device-9' })
  expect(await gate.check(unknown)).toEqual({ kind: 'foreign', reason: 'unknown_sender' })
})

test('PAIR_RESPONSE with a wrong identity version byte is invalid', async () => {
  const gate = newGate()
  const bad = Uint8Array.from(phone2.publicKey)
  bad[0] = 0x02
  const envelope = await pairResponse(phone2, bytesToBase64(bad))
  expect(await gate.check(envelope)).toEqual({
    kind: 'invalid',
    slot: 2,
    reason: 'identity_key'
  })
  expect(gate.peerIdentity(2)).toBeNull()
})

test('the extension own identity or an already registered one is duplicate_identity', async () => {
  const gate = newGate()
  const asOwn = await pairResponse(phone2, ownKey)
  expect(await gate.check(asOwn)).toEqual({ kind: 'foreign', reason: 'duplicate_identity' })
  await gate.check(await pairResponse(phone2, key2))
  const clone = await pairResponse(phone2, key2, { sender: 'device-3' })
  expect(await gate.check(clone)).toEqual({ kind: 'foreign', reason: 'duplicate_identity' })
  expect(gate.peerIdentity(3)).toBeNull()
})

test('a message before registration is unregistered_sender', async () => {
  const gate = newGate()
  const envelope = await phoneEnvelope(phone3, { sender: 'device-3' })
  expect(await gate.check(envelope)).toEqual({ kind: 'foreign', reason: 'unregistered_sender' })
})

test('a registered phone message is accepted, SESSION_ABORT included', async () => {
  const gate = newGate()
  await gate.check(await pairResponse(phone2, key2))
  expect(await gate.check(await phoneEnvelope(phone2, { sequence: 2 }))).toEqual({
    kind: 'accept',
    slot: 2
  })
  const abort = await phoneEnvelope(phone2, { type: 'SESSION_ABORT', round: 3, sequence: 3 })
  expect(await gate.check(abort)).toEqual({ kind: 'accept', slot: 2 })
})

test('a byte-identical resend is duplicate; same sequence with other content is invalid', async () => {
  const gate = newGate()
  const first = await pairResponse(phone2, key2)
  await gate.check(first)
  expect(await gate.check({ ...first })).toEqual({ kind: 'duplicate', slot: 2 })
  const changed = await pairResponse(phone2, key2, {
    payload: { identityPublicKey: key2, device: { ...DEVICE, name: 'Other' } }
  })
  expect(await gate.check(changed)).toEqual({ kind: 'invalid', slot: 2, reason: 'sequence' })
})

test('sequence may skip but never go back', async () => {
  const gate = newGate()
  await gate.check(await pairResponse(phone2, key2))
  expect(await gate.check(await phoneEnvelope(phone2, { sequence: 3 }))).toEqual({
    kind: 'accept',
    slot: 2
  })
  expect(await gate.check(await phoneEnvelope(phone2, { sequence: 2 }))).toEqual({
    kind: 'invalid',
    slot: 2,
    reason: 'sequence'
  })
})

test('a tampered signature or payload is invalid', async () => {
  const gate = newGate()
  await gate.check(await pairResponse(phone2, key2))
  const good = await phoneEnvelope(phone2, { sequence: 2 })
  const payload = { ...good, encrypted_payload: good.encrypted_payload.replace('AA', 'AB') }
  expect(await gate.check(payload)).toEqual({ kind: 'invalid', slot: 2, reason: 'payload_hash' })
  const flipped = good.authentication_data.startsWith('A') ? 'B' : 'A'
  const forged = { ...good, authentication_data: flipped + good.authentication_data.slice(1) }
  expect(await gate.check(forged)).toEqual({ kind: 'invalid', slot: 2, reason: 'signature' })
})

test('a PAIR_RESPONSE signed by a different key than it announces is invalid', async () => {
  const gate = newGate()
  const envelope = await pairResponse(phone3, key2)
  expect(await gate.check(envelope)).toEqual({ kind: 'invalid', slot: 2, reason: 'signature' })
  expect(gate.peerIdentity(2)).toBeNull()
})

test('round must match the type', async () => {
  const gate = newGate()
  await gate.check(await pairResponse(phone2, key2))
  const envelope = await phoneEnvelope(phone2, { round: 0, sequence: 2 })
  expect(await gate.check(envelope)).toEqual({ kind: 'invalid', slot: 2, reason: 'round' })
})

test('forgetPeer makes the slot unregistered again', async () => {
  const gate = newGate()
  await gate.check(await pairResponse(phone2, key2))
  gate.forgetPeer(2)
  expect(gate.peerIdentity(2)).toBeNull()
  const next = await phoneEnvelope(phone2, { sequence: 2 })
  expect(await gate.check(next)).toEqual({ kind: 'foreign', reason: 'unregistered_sender' })
  gate.registerPeer(2, key2)
  expect(gate.peerIdentity(2)).toBe(key2)
  expect(await gate.check(next)).toEqual({ kind: 'accept', slot: 2 })
})

test('a second phone registers independently on its own slot', async () => {
  const gate = newGate()
  await gate.check(await pairResponse(phone2, key2))
  const second = await pairResponse(phone3, key3, { sender: 'device-3' })
  expect(await gate.check(second)).toEqual({ kind: 'accept', slot: 3 })
})

test('a PAIR_RESPONSE for a registered slot announcing another identity is invalid identity_replaced', async () => {
  const gate = newGate()
  await gate.check(await pairResponse(phone2, key2))
  const takeover = await pairResponse(phone3, key3, { sequence: 5 })
  expect(await gate.check(takeover)).toEqual({
    kind: 'invalid',
    slot: 2,
    reason: 'identity_replaced'
  })
  expect(gate.peerIdentity(2)).toBe(key2)
})

test('a PAIR_RESPONSE for a registered slot announcing the same identity is accepted', async () => {
  const gate = newGate()
  await gate.check(await pairResponse(phone2, key2))
  const again = await pairResponse(phone2, key2, { sequence: 2 })
  expect(await gate.check(again)).toEqual({ kind: 'accept', slot: 2 })
  expect(gate.peerIdentity(2)).toBe(key2)
})
