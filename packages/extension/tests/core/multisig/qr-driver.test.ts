import { test } from 'node:test'
import { expect } from '@playwright/test'
import type { CreateSessionEvent } from '../../../src/core/multisig/create-session'
import type { CreateSessionEffect } from '../../../src/core/multisig/create-session-shared'
import {
  roundOf,
  type MultisigEnvelope,
  type MultisigMessageType
} from '../../../src/core/multisig/messages'
import type { DeviceSlot } from '../../../src/core/multisig/types'
import { bytesToBase64 } from '../../../src/lib/bytes'
import {
  createQrDriver,
  type QrDisplay,
  type QrScanRequest,
  type TimeHooks
} from '../../../src/popup/multisig/qr-driver'
import { identityFromSeed, signedPhoneEnvelope } from './helpers/identity'

const GROUP = '11111111-2222-4333-8444-555555555555'
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DEVICE = { name: 'Alex', model: 'iPhone 17', platform: 'ios' }
const IDLE_MS = 1_000

const own = await identityFromSeed(new Uint8Array(32).fill(0x11))
const phone2 = await identityFromSeed(new Uint8Array(32).fill(0x22))
const phone3 = await identityFromSeed(new Uint8Array(32).fill(0x33))

function manualHooks() {
  let clock = 1_000_000
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  const hooks: TimeHooks = {
    now: () => clock,
    schedule(fn, delayMs) {
      const timer = { at: clock + delayMs, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  }
  return {
    hooks,
    live: () => timers.filter(timer => !timer.cancelled).length,
    advance(ms: number) {
      clock += ms
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= clock) {
          timer.cancelled = true
          timer.fn()
        }
      }
    }
  }
}

function setup(slots: readonly DeviceSlot[] = [2, 3], identity = own) {
  const time = manualHooks()
  const displays: QrDisplay[] = []
  const scans: QrScanRequest[] = []
  const events: CreateSessionEvent[] = []
  let waiting: (() => void) | null = null
  const driver = createQrDriver({
    session: { groupId: GROUP, sessionId: SESSION },
    identity,
    slots,
    onDisplay(display) {
      displays.push(display)
      waiting?.()
      waiting = null
    },
    onAwaitScan: scan => scans.push(scan),
    hooks: time.hooks,
    idleMs: IDLE_MS
  })
  const dispatch = (event: CreateSessionEvent) => events.push(event)
  return {
    driver,
    time,
    displays,
    scans,
    events,
    run: (effect: CreateSessionEffect) => driver.execute(effect, dispatch),
    nextDisplay: () => new Promise<void>(resolve => (waiting = resolve))
  }
}

function invite(slot: DeviceSlot, stepKey = `invite-${slot}`): CreateSessionEffect {
  return {
    type: 'display',
    stepKey,
    items: [{ slot, messageType: 'PAIR_INVITE', payload: { dkgSessionId: 'AAAA' } }]
  }
}

type PhoneOptions = {
  type?: MultisigMessageType
  sender?: string
  session?: string
  sequence?: number
  payload?: unknown
}

function phoneEnvelope(
  signer: typeof phone2,
  options: PhoneOptions = {}
): Promise<MultisigEnvelope> {
  const type = options.type ?? 'PAIR_RESPONSE'
  return signedPhoneEnvelope(signer, {
    protocol_version: 1,
    message_type: type,
    group_id: GROUP,
    session_id: options.session ?? SESSION,
    sender_id: options.sender ?? 'device-2',
    recipient_id: 'device-1',
    round: roundOf(type),
    sequence: options.sequence ?? 1,
    encrypted_payload: JSON.stringify(options.payload ?? {})
  })
}

function pairResponse(signer: typeof phone2, key: Uint8Array, options: PhoneOptions = {}) {
  return phoneEnvelope(signer, {
    payload: { identityPublicKey: bytesToBase64(key), device: DEVICE },
    ...options
  })
}

test('signs one envelope per item and reuses it for the same key', async () => {
  const { driver, displays, run, nextDisplay } = setup()
  let shown = nextDisplay()
  run(invite(2))
  // A repeat of the same step while it is still signing is coalesced, not signed again.
  run(invite(2))
  await shown
  expect(displays).toHaveLength(1)
  expect(displays[0].stepKey).toBe('invite-2')
  expect(displays[0].slots).toEqual([2])
  expect(displays[0].messageTypes).toEqual(['PAIR_INVITE'])
  expect(displays[0].envelopes).toHaveLength(1)
  expect(displays[0].envelopes[0].sender_id).toBe('device-1')
  expect(displays[0].envelopes[0].sequence).toBe(1)
  expect(JSON.parse(displays[0].envelopes[0].encrypted_payload)).toEqual({ dkgSessionId: 'AAAA' })

  shown = nextDisplay()
  run(invite(2))
  await shown
  expect(displays).toHaveLength(2)
  expect(JSON.stringify(displays[1].envelopes[0])).toBe(JSON.stringify(displays[0].envelopes[0]))
  expect(displays[1].envelopes[0].sequence).toBe(1)
  expect(driver.currentDisplay()).toBe(displays[1])
  driver.dispose()
})

test('a code for two phones carries two envelopes with distinct recipients', async () => {
  const { driver, displays, run, nextDisplay } = setup()
  const shown = nextDisplay()
  run({
    type: 'display',
    stepKey: 'roster',
    items: [
      { slot: 2, messageType: 'ROSTER_LOCK' },
      { slot: 3, messageType: 'ROSTER_LOCK' }
    ]
  })
  await shown
  const [display] = displays
  expect(display.slots).toEqual([2, 3])
  expect(display.messageTypes).toEqual(['ROSTER_LOCK'])
  expect(display.envelopes.map(envelope => envelope.recipient_id)).toEqual(['device-2', 'device-3'])
  expect(display.envelopes.map(envelope => envelope.sequence)).toEqual([1, 2])
  driver.dispose()
})

test('disconnect drops the slot cache so the next invite has a new sequence', async () => {
  const { driver, displays, run, nextDisplay } = setup()
  let shown = nextDisplay()
  run(invite(2))
  await shown
  const first = displays[0].envelopes[0]

  run({ type: 'disconnect', slot: 2 })
  expect(driver.currentDisplay()).toBeNull()

  shown = nextDisplay()
  run(invite(2))
  await shown
  const second = displays[1].envelopes[0]
  expect(second.sequence).toBe(2)
  expect(JSON.stringify(second)).not.toBe(JSON.stringify(first))

  // A disconnect that lands while a code is still being signed drops that code.
  run({ type: 'disconnect', slot: 2 })
  run(invite(2, 'invite-2-again'))
  run({ type: 'disconnect', slot: 2 })
  shown = nextDisplay()
  run(invite(3))
  await shown
  expect(displays.map(display => display.stepKey)).toEqual(['invite-2', 'invite-2', 'invite-3'])
  driver.dispose()
})

test('an accepted scan dispatches MESSAGE_RECEIVED; foreign is ignored; duplicate is duplicate', async () => {
  const { driver, events, run, time } = setup()
  run({ type: 'awaitScan', slots: [2], messageType: 'PAIR_RESPONSE' })

  const response = await pairResponse(phone2, phone2.publicKey)
  expect(await driver.deliverScan(response)).toBe('accepted')
  expect(events).toEqual([
    { type: 'MESSAGE_RECEIVED', slot: 2, envelope: response, at: time.hooks.now() }
  ])

  const otherSession = await pairResponse(phone3, phone3.publicKey, {
    sender: 'device-3',
    session: 'other-session'
  })
  expect(await driver.deliverScan(otherSession)).toBe('ignored')
  expect(await driver.deliverScan(response)).toBe('duplicate')

  // Once paired, the phone's later messages pass the gate on its registered identity.
  run({ type: 'awaitScan', slots: [2, 3], messageType: 'DKG_R1' })
  const round1 = await phoneEnvelope(phone2, { type: 'DKG_R1', sequence: 2 })
  expect(await driver.deliverScan(round1)).toBe('accepted')
  expect(events.map(event => event.type)).toEqual(['MESSAGE_RECEIVED', 'MESSAGE_RECEIVED'])
  driver.dispose()
})

test('a PAIR_RESPONSE carrying an already registered identity returns duplicate_identity and dispatches nothing', async () => {
  const { driver, events, run } = setup()
  run({ type: 'awaitScan', slots: [2, 3], messageType: 'PAIR_RESPONSE' })
  expect(await driver.deliverScan(await pairResponse(phone2, phone2.publicKey))).toBe('accepted')

  const sameIdentity = await pairResponse(phone2, phone2.publicKey, { sender: 'device-3' })
  expect(await driver.deliverScan(sameIdentity)).toBe('duplicate_identity')
  expect(events).toHaveLength(1)
  driver.dispose()
})

test('an invalid scan dispatches MESSAGE_REJECTED with the gate reason', async () => {
  const { driver, events, run } = setup()
  run({ type: 'awaitScan', slots: [2], messageType: 'PAIR_RESPONSE' })
  // Announces phone 2's key but is signed by another key.
  const forged = await pairResponse(phone3, phone2.publicKey)
  expect(await driver.deliverScan(forged)).toBe('rejected')
  expect(events).toEqual([{ type: 'MESSAGE_REJECTED', slot: 2, reason: 'signature' }])
  driver.dispose()
})

test('the session idles out after idleMs without any accepted scan', async () => {
  const { driver, events, run, time } = setup()
  run({ type: 'awaitScan', slots: [2], messageType: 'PAIR_RESPONSE' })
  time.advance(IDLE_MS - 1)
  expect(events).toEqual([])

  expect(await driver.deliverScan(await pairResponse(phone2, phone2.publicKey))).toBe('accepted')
  time.advance(IDLE_MS - 1)
  expect(events.map(event => event.type)).toEqual(['MESSAGE_RECEIVED'])
  expect(time.live()).toBe(1)

  time.advance(1)
  expect(events.map(event => event.type)).toEqual(['MESSAGE_RECEIVED', 'STEP_TIMEOUT'])
  driver.dispose()
})

test('nothing is reported after dispose', async () => {
  const { driver, displays, events, run, time } = setup()
  const response = await pairResponse(phone2, phone2.publicKey)
  // Before any effect there is no dispatch to report through.
  expect(await driver.deliverScan(response)).toBe('ignored')

  run({ type: 'awaitScan', slots: [2], messageType: 'PAIR_RESPONSE' })
  run(invite(2))
  driver.dispose()
  expect(time.live()).toBe(0)
  expect(driver.currentDisplay()).toBeNull()

  // Signing has no hook to await, so give the in-flight sign time to finish.
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(displays).toEqual([])
  expect(await driver.deliverScan(response)).toBe('ignored')
  run(invite(3))
  time.advance(IDLE_MS * 2)
  expect(events).toEqual([])
})

test('a valid envelope that is not awaited is ignored and leaves the gate untouched', async () => {
  const { driver, events, run } = setup()
  run({ type: 'awaitScan', slots: [2], messageType: 'PAIR_RESPONSE' })
  const fromPhone3 = await pairResponse(phone3, phone3.publicKey, { sender: 'device-3' })
  expect(await driver.deliverScan(fromPhone3)).toBe('ignored')
  // The right sender with a type the session is not waiting for is ignored too.
  const early = await phoneEnvelope(phone2, { type: 'DKG_R1' })
  expect(await driver.deliverScan(early)).toBe('ignored')
  expect(events).toEqual([])

  // Had the gate recorded the first scan, this would now be a duplicate.
  run({ type: 'awaitScan', slots: [3], messageType: 'PAIR_RESPONSE' })
  expect(await driver.deliverScan(fromPhone3)).toBe('accepted')
  expect(events.map(event => event.type)).toEqual(['MESSAGE_RECEIVED'])

  // A disconnected slot is no longer awaited.
  run({ type: 'awaitScan', slots: [2, 3], messageType: 'DKG_R1' })
  run({ type: 'disconnect', slot: 3 })
  const round1 = await phoneEnvelope(phone3, { type: 'DKG_R1', sender: 'device-3', sequence: 2 })
  expect(await driver.deliverScan(round1)).toBe('ignored')
  driver.dispose()
})

test('SESSION_ABORT is delivered to the gate even when not awaited', async () => {
  const { driver, events, run } = setup()
  run({ type: 'awaitScan', slots: [2], messageType: 'PAIR_RESPONSE' })
  expect(await driver.deliverScan(await pairResponse(phone2, phone2.publicKey))).toBe('accepted')

  run({ type: 'awaitScan', slots: [3], messageType: 'DKG_R1' })
  const abort = await phoneEnvelope(phone2, { type: 'SESSION_ABORT', sequence: 2 })
  expect(await driver.deliverScan(abort)).toBe('accepted')
  expect(events.map(event => event.type)).toEqual(['MESSAGE_RECEIVED', 'MESSAGE_RECEIVED'])
  driver.dispose()
})

test('a failed signature aborts the session instead of stalling', async () => {
  // A public key cannot sign, so every signature the driver attempts is refused.
  const unusable = {
    ...own,
    signingKeys: { ...own.signingKeys, privateKey: own.signingKeys.publicKey }
  }
  const { driver, displays, events, run } = setup([2, 3], unusable)
  run(invite(2))
  const deadline = Date.now() + 1_000
  while (events.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(events).toEqual([{ type: 'DKG_FAILED' }])
  expect(displays).toEqual([])
  driver.dispose()
})

test('the display cache is keyed by payload as well as slot and type', async () => {
  const { driver, displays, run, nextDisplay } = setup()
  let shown = nextDisplay()
  run(invite(2))
  await shown
  shown = nextDisplay()
  run({
    type: 'display',
    stepKey: 'invite-2-new',
    items: [{ slot: 2, messageType: 'PAIR_INVITE', payload: { dkgSessionId: 'BBBB' } }]
  })
  await shown
  expect(displays[1].envelopes[0].sequence).toBe(2)
  expect(JSON.parse(displays[1].envelopes[0].encrypted_payload)).toEqual({ dkgSessionId: 'BBBB' })
  driver.dispose()
})
