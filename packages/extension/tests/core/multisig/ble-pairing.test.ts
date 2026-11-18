import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  createInitialSession,
  reduceCreateSession
} from '../../../src/core/multisig/create-session'
import type {
  CreateSessionEffect,
  CreateSessionEvent,
  CreateSessionState
} from '../../../src/core/multisig/create-session'
import { createEnvelopeSigner, signEnvelope } from '../../../src/core/multisig/envelope-signing'
import { createBleDriver } from '../../../src/popup/multisig/ble-driver'
import { generateNoiseStatic } from '../../../src/core/multisig/ble/noise'
import { deviceId, parseEnvelope } from '../../../src/core/multisig/messages'
import type { DeviceSlot } from '../../../src/core/multisig/types'
import { bytesToBase64 } from '../../../src/lib/bytes'
import { createFakePhone } from './helpers/ble-phone'
import { identityFromSeed } from './helpers/identity'

const DKG_SESSION_ID = bytesToBase64(new Uint8Array(16).fill(7))
const OWNER = {
  slot: 1 as const,
  role: 'owner' as const,
  name: 'Account 1',
  model: 'MacBook',
  platform: 'extension' as const
}

function run(state: CreateSessionState, ...events: readonly CreateSessionEvent[]) {
  const effects: CreateSessionEffect[] = []
  let current = state
  for (const event of events) {
    const out = reduceCreateSession(current, event)
    current = out.state
    effects.push(...out.effects)
  }
  return { state: current, effects }
}

const seed = (byte: number) => new Uint8Array(32).fill(byte)

test('Bluetooth pairing: SAS shown, nothing sent until confirmed, then invite, reply and roster lock', async () => {
  const extension = await identityFromSeed(seed(0x61))
  const phone = await identityFromSeed(seed(0x62))
  const ownerKey = bytesToBase64(extension.publicKey)
  const phoneKey = bytesToBase64(phone.publicKey)
  const noiseExtension = bytesToBase64(generateNoiseStatic().public)
  const noisePhone = bytesToBase64(generateNoiseStatic().public)

  let state = createInitialSession({
    groupId: 'group-1',
    sessionId: 'session-1',
    threshold: '2-of-2',
    transportKind: 'ble',
    owner: OWNER,
    mainnet: false,
    qrDkgSessionId: DKG_SESSION_ID
  })
  let step = run(
    state,
    { type: 'IDENTITY_READY', publicKey: ownerKey },
    { type: 'PAIR_START', slot: 2 },
    {
      type: 'PAIR_DEVICE_SELECTED',
      slot: 2,
      device: { slot: 2, role: 'guardian', name: 'x', model: 'x', platform: 'ios' }
    },
    {
      type: 'PAIR_SAS_READY',
      slot: 2,
      sas: '12345678',
      identityPublicKey: phoneKey,
      transportPublicKey: noisePhone,
      ownerTransportPublicKey: noiseExtension
    }
  )
  state = step.state
  expect(state.devices[1]).toMatchObject({
    connection: 'code_wait',
    pairingCode: '12345678',
    pairingCodeExpiresAt: null
  })
  // The channel is up but the user has not compared the codes: nothing may go to the phone.
  expect(step.effects.filter(effect => effect.type === 'sendTo')).toHaveLength(0)

  step = run(state, { type: 'PAIR_SAS_CONFIRMED', slot: 2 })
  state = step.state
  expect(state.devices[1].connection).toBe('invite_shown')
  const invite = step.effects.find(effect => effect.type === 'sendTo')
  expect(invite).toMatchObject({ messageType: 'PAIR_INVITE', slot: 2 })
  expect((invite as { payload: Record<string, unknown> }).payload).toMatchObject({
    identityPublicKey: ownerKey,
    dkgSessionId: DKG_SESSION_ID,
    participants: 2,
    threshold: 2,
    rosterSlot: 1,
    mainnet: false
  })

  // The phone's reply, signed with its identity.
  const reply = await createEnvelopeSigner({
    groupId: 'group-1',
    sessionId: 'session-1',
    senderId: deviceId(2),
    signingKey: phone.signingKeys.privateKey
  }).next('PAIR_RESPONSE', deviceId(1), {
    identityPublicKey: phoneKey,
    device: { name: 'Alex', model: 'iPhone 17', platform: 'ios' }
  })
  step = run(state, { type: 'MESSAGE_RECEIVED', slot: 2, envelope: reply, at: 1 })
  state = step.state
  expect(state.devices[1]).toMatchObject({ connection: 'connected', identityConfirmed: true })
  expect(state.devices[1].device).toMatchObject({ name: 'Alex', model: 'iPhone 17' })

  // Continue: the Worker session is opened under the id the invite named.
  step = run(state, { type: 'CONTINUE' })
  state = step.state
  expect(step.effects[0]).toMatchObject({ type: 'dkgOpen', sessionId: DKG_SESSION_ID })

  step = run(state, { type: 'DKG_OPENED', sessionId: DKG_SESSION_ID })
  const lock = step.effects.find(effect => effect.type === 'sendTo')
  expect(lock).toMatchObject({ messageType: 'ROSTER_LOCK', slot: 2 })
  const roster = (
    lock as {
      payload: { roster: { participants: { slot: number; transportPublicKey: string }[] } }
    }
  ).payload.roster
  expect(roster.participants.map(p => [p.slot, p.transportPublicKey])).toEqual([
    [0, noiseExtension],
    [1, noisePhone]
  ])
})

test('a phone whose reply names another key than its handshake aborts the session', async () => {
  const extension = await identityFromSeed(seed(0x61))
  const phone = await identityFromSeed(seed(0x62))
  const other = await identityFromSeed(seed(0x63))
  let state = createInitialSession({
    groupId: 'g',
    sessionId: 's',
    threshold: '2-of-2',
    transportKind: 'ble',
    owner: OWNER,
    mainnet: false,
    qrDkgSessionId: DKG_SESSION_ID
  })
  state = run(
    state,
    { type: 'IDENTITY_READY', publicKey: bytesToBase64(extension.publicKey) },
    { type: 'PAIR_START', slot: 2 },
    {
      type: 'PAIR_DEVICE_SELECTED',
      slot: 2,
      device: { slot: 2, role: 'guardian', name: 'x', model: 'x', platform: 'ios' }
    },
    {
      type: 'PAIR_SAS_READY',
      slot: 2,
      sas: '00000001',
      identityPublicKey: bytesToBase64(phone.publicKey),
      transportPublicKey: bytesToBase64(new Uint8Array(32).fill(1)),
      ownerTransportPublicKey: bytesToBase64(new Uint8Array(32).fill(2))
    },
    { type: 'PAIR_SAS_CONFIRMED', slot: 2 }
  ).state
  const reply = await createEnvelopeSigner({
    groupId: 'g',
    sessionId: 's',
    senderId: deviceId(2),
    signingKey: other.signingKeys.privateKey
  }).next('PAIR_RESPONSE', deviceId(1), {
    identityPublicKey: bytesToBase64(other.publicKey),
    device: { name: 'Alex', model: 'iPhone', platform: 'ios' }
  })
  const out = reduceCreateSession(state, {
    type: 'MESSAGE_RECEIVED',
    slot: 2,
    envelope: reply,
    at: 1
  })
  expect(out.state.phase).toBe('ABORTED')
})

test('the same phone cannot take two slots', async () => {
  const extension = await identityFromSeed(seed(0x61))
  const phone = await identityFromSeed(seed(0x62))
  const key = bytesToBase64(phone.publicKey)
  const ready = (slot: 2 | 3) => [
    { type: 'PAIR_START', slot } as const,
    {
      type: 'PAIR_DEVICE_SELECTED',
      slot,
      device: { slot, role: 'guardian', name: 'x', model: 'x', platform: 'ios' }
    } as const,
    {
      type: 'PAIR_SAS_READY',
      slot,
      sas: '00000001',
      identityPublicKey: key,
      transportPublicKey: bytesToBase64(new Uint8Array(32).fill(1)),
      ownerTransportPublicKey: bytesToBase64(new Uint8Array(32).fill(2))
    } as const
  ]
  const state = run(
    createInitialSession({
      groupId: 'g',
      sessionId: 's',
      threshold: '2-of-3',
      transportKind: 'ble',
      owner: OWNER,
      mainnet: false,
      qrDkgSessionId: DKG_SESSION_ID
    }),
    { type: 'IDENTITY_READY', publicKey: bytesToBase64(extension.publicKey) },
    ...ready(2),
    ...ready(3)
  ).state
  expect(state.devices.find(d => d.slot === 2)?.connection).toBe('code_wait')
  expect(state.devices.find(d => d.slot === 3)?.connection).toBe('empty')
})

// ---- the driver, against a simulated phone on a frame link ----

async function driverHarness() {
  const extension = await identityFromSeed(seed(0x61))
  const phoneIdentity = await identityFromSeed(seed(0x62))
  const phoneStatic = generateNoiseStatic()
  const inbound: unknown[] = []
  const phone = createFakePhone({
    identity: phoneIdentity,
    noiseStatic: phoneStatic,
    onMessage: message => {
      inbound.push(JSON.parse(new TextDecoder().decode(message)))
    }
  })
  const events: CreateSessionEvent[] = []
  const rejections: string[] = []
  const driver = createBleDriver({
    session: { groupId: 'g', sessionId: 's' },
    identity: extension,
    slots: [2],
    onChooser: async () => ({
      status: 'selected',
      id: 'device-id',
      name: null,
      device: {
        id: 'device-id',
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true
      } as never
    }),
    onRejected: reason => rejections.push(reason),
    openLink: (_device, handlers) => phone.open(handlers),
    stepTimeoutMs: 60_000
  })
  const dispatch = (event: CreateSessionEvent) => events.push(event)
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 400 && !predicate(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    expect(predicate()).toBe(true)
  }
  return { extension, phoneIdentity, phone, driver, events, inbound, rejections, dispatch, until }
}

test('the driver picks a phone, builds the channel and reports the SAS', async () => {
  const h = await driverHarness()
  h.driver.execute({ type: 'requestDevice', slot: 2 }, h.dispatch)
  await h.until(() => h.events.some(event => event.type === 'PAIR_SAS_READY'))
  expect(h.events[0]).toMatchObject({ type: 'PAIR_DEVICE_SELECTED', slot: 2 })
  const ready = h.events.find(event => event.type === 'PAIR_SAS_READY') as Extract<
    CreateSessionEvent,
    { type: 'PAIR_SAS_READY' }
  >
  expect(ready.sas).toMatch(/^\d{8}$/)
  expect(ready.identityPublicKey).toBe(bytesToBase64(h.phoneIdentity.publicKey))
  h.driver.dispose()
})

test('the driver sends signed envelopes over the channel and gates the replies', async () => {
  const h = await driverHarness()
  h.driver.execute({ type: 'requestDevice', slot: 2 }, h.dispatch)
  await h.until(() => h.events.some(event => event.type === 'PAIR_SAS_READY'))

  h.driver.execute(
    { type: 'sendTo', slot: 2, messageType: 'PAIR_INVITE', payload: { hello: 1 } },
    h.dispatch
  )
  await h.until(() => h.inbound.length === 1)
  const sent = parseEnvelope(h.inbound[0])!
  expect(sent).toMatchObject({
    message_type: 'PAIR_INVITE',
    sender_id: 'device-1',
    recipient_id: 'device-2',
    round: 0
  })

  // A reply signed by the phone's identity passes the gate.
  const good = await signEnvelope(h.phoneIdentity.signingKeys.privateKey, {
    protocol_version: 1,
    message_type: 'PAIR_RESPONSE',
    group_id: 'g',
    session_id: 's',
    sender_id: 'device-2',
    recipient_id: 'device-1',
    round: 0,
    sequence: 1,
    encrypted_payload: JSON.stringify({
      identityPublicKey: bytesToBase64(h.phoneIdentity.publicKey),
      device: { name: 'Alex', model: 'iPhone', platform: 'ios' }
    })
  })
  h.phone.say(new TextEncoder().encode(JSON.stringify(good)))
  await h.until(() => h.events.some(event => event.type === 'MESSAGE_RECEIVED'))

  // One signed by another key is rejected, and that ends the session.
  const impostor = await identityFromSeed(seed(0x63))
  const bad = await signEnvelope(impostor.signingKeys.privateKey, {
    protocol_version: 1,
    message_type: 'DKG_R1',
    group_id: 'g',
    session_id: 's',
    sender_id: 'device-2',
    recipient_id: 'device-1',
    round: 1,
    sequence: 2,
    encrypted_payload: '{}'
  })
  h.phone.say(new TextEncoder().encode(JSON.stringify(bad)))
  await h.until(() => h.events.some(event => event.type === 'MESSAGE_REJECTED'))
  h.driver.dispose()
})

test('a message queued just before dispose still reaches the phone (DKG_ACTIVATE)', async () => {
  const h = await driverHarness()
  h.driver.execute({ type: 'requestDevice', slot: 2 }, h.dispatch)
  await h.until(() => h.events.some(event => event.type === 'PAIR_SAS_READY'))

  // The store drops the driver in the same turn that the activation message is queued.
  h.driver.execute({ type: 'sendTo', slot: 2, messageType: 'DKG_ACTIVATE' }, h.dispatch)
  h.driver.dispose()
  await h.until(() => h.inbound.length === 1)
  expect(parseEnvelope(h.inbound[0])).toMatchObject({
    message_type: 'DKG_ACTIVATE',
    recipient_id: 'device-2'
  })
})

test('disconnect flushes SESSION_ABORT before closing the authenticated channel', async () => {
  const h = await driverHarness()
  h.driver.execute({ type: 'requestDevice', slot: 2 }, h.dispatch)
  await h.until(() => h.events.some(event => event.type === 'PAIR_SAS_READY'))
  h.driver.execute({ type: 'sendTo', slot: 2, messageType: 'SESSION_ABORT' }, h.dispatch)
  h.driver.execute({ type: 'disconnect', slot: 2 }, h.dispatch)
  await h.until(() => h.inbound.length === 1)
  expect(parseEnvelope(h.inbound[0])).toMatchObject({ message_type: 'SESSION_ABORT' })
  h.driver.dispose()
})

test('losing the phone reports a disconnect for its slot', async () => {
  const h = await driverHarness()
  h.driver.execute({ type: 'requestDevice', slot: 2 }, h.dispatch)
  await h.until(() => h.events.some(event => event.type === 'PAIR_SAS_READY'))
  h.phone.drop()
  await h.until(() => h.events.some(event => event.type === 'DEVICE_DISCONNECTED'))
  expect(h.events.at(-1)).toMatchObject({ type: 'DEVICE_DISCONNECTED', slot: 2 as DeviceSlot })
  h.driver.dispose()
})

test('a phone that cannot be reached is reported, and the slot is released', async () => {
  const extension = await identityFromSeed(seed(0x61))
  const events: CreateSessionEvent[] = []
  const rejections: string[] = []
  const driver = createBleDriver({
    session: { groupId: 'g', sessionId: 's' },
    identity: extension,
    slots: [2],
    onChooser: async () => ({
      status: 'selected',
      id: 'd',
      name: null,
      device: { id: 'd' } as never
    }),
    onRejected: reason => rejections.push(reason),
    openLink: async () => {
      throw new Error('gatt failed')
    }
  })
  driver.execute({ type: 'requestDevice', slot: 2 }, event => events.push(event))
  for (let i = 0; i < 200 && !events.some(e => e.type === 'DEVICE_DISCONNECTED'); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(rejections).toEqual(['connect_failed'])
  expect(events.map(e => e.type)).toEqual(['PAIR_DEVICE_SELECTED', 'DEVICE_DISCONNECTED'])
  driver.dispose()
})
