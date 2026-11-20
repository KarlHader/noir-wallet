import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createEnvelopeFactory } from '../../../src/core/multisig/messages'
import { buildRoster } from '../../../src/core/multisig/roster'
import { bytesToBase64 } from '../../../src/lib/bytes'
import { encodeEnvelopeUR } from '../../../src/lib/multisig-ur'
import { createBleSigningTransport } from '../../../src/popup/multisig/ble-signing-transport'
import { createQrSigningTransport } from '../../../src/popup/multisig/signing-transport'
import { identityFromSeed } from './helpers/identity'

const groupId = '11111111-2222-4333-8444-555555555555'
const sessionId = 'AAAAAAAAAAAAAAAAAAAAAA=='
const binding = {
  walletId: 'wallet-1',
  accountId: 'account-1',
  network: 'testnet' as const,
  groupId,
  rosterVersion: 1,
  reviewId: 'review-1',
  pcztDigest: 'a'.repeat(64),
  sessionId,
  expiresAt: 2_000,
  selectedSlots: [0, 1, 2]
}

test('QR signing carrier keeps both phone recipients and rejects foreign or repeated replies', async () => {
  const received: string[] = []
  let now = 1_000
  const transport = createQrSigningTransport({
    binding,
    now: () => now,
    async onEnvelope(envelope) {
      received.push(envelope.sender_id)
    }
  })
  const extension = createEnvelopeFactory({ groupId, sessionId, senderId: 'device-1' })
  transport.setOutbound([extension('SIGN_INIT', 'device-2'), extension('SIGN_INIT', 'device-3')])
  expect(transport.getOutbound().map(envelope => envelope.recipient_id)).toEqual([
    'device-2',
    'device-3'
  ])
  expect(() => transport.setOutbound([extension('SIGN_INIT', 'device-4')])).toThrow()
  expect(() => transport.setOutbound([extension('SIGN_RESULT', 'device-2')])).toThrow()

  const phone = createEnvelopeFactory({ groupId, sessionId, senderId: 'device-3' })
  const accepted = encodeEnvelopeUR(phone('SIGN_COMMITMENTS', 'device-1'))
  expect(await transport.ingestQr(accepted)).toBe('accepted')
  expect(await transport.ingestQr(accepted)).toBe('duplicate')
  const foreign = createEnvelopeFactory({ groupId, sessionId: 'other', senderId: 'device-2' })
  expect(await transport.ingestQr(encodeEnvelopeUR(foreign('SIGN_SHARE', 'device-1')))).toBe(
    'ignored'
  )
  expect(received).toEqual(['device-3'])
  now = binding.expiresAt
  expect(transport.getOutbound()).toEqual([])
  expect(await transport.ingestQr(encodeEnvelopeUR(phone('SIGN_SHARE', 'device-1')))).toBe(
    'ignored'
  )
  transport.dispose()
  expect(transport.getOutbound()).toEqual([])
})

test('QR signing carrier propagates cryptographic rejection without consuming the scan', async () => {
  let shouldReject = true
  let calls = 0
  const transport = createQrSigningTransport({
    binding,
    now: () => 1_000,
    async onEnvelope() {
      calls += 1
      if (shouldReject) throw new Error('signature rejected')
    }
  })
  const phone = createEnvelopeFactory({ groupId, sessionId, senderId: 'device-2' })
  const code = encodeEnvelopeUR(phone('SIGN_SHARE', 'device-1'))
  await expect(transport.ingestQr(code)).rejects.toThrow('signature rejected')
  shouldReject = false
  expect(await transport.ingestQr(code)).toBe('accepted')
  expect(calls).toBe(2)
  transport.dispose()
})

test('BLE signing reconnect requires the roster identity and confirmed SAS', async () => {
  const extension = await identityFromSeed(new Uint8Array(32).fill(0x31))
  const phone = await identityFromSeed(new Uint8Array(32).fill(0x32))
  const impostor = await identityFromSeed(new Uint8Array(32).fill(0x33))
  const roster = buildRoster({
    groupId,
    threshold: 2,
    identities: new Map([
      [0, bytesToBase64(extension.publicKey)],
      [1, bytesToBase64(phone.publicKey)]
    ])
  })
  const twoPartyBinding = { ...binding, selectedSlots: [0, 1] }
  const closed: number[] = []
  let peerIdentity = impostor.publicKey
  let hasConfirmed = true
  let sasChecks = 0
  const device = Object.assign(new EventTarget(), { id: 'phone' })
  const transport = createBleSigningTransport({
    binding: twoPartyBinding,
    roster,
    identity: extension,
    now: () => 1_000,
    onChooser: async () => ({ status: 'selected', id: 'phone', name: null, device }),
    onSas: async () => {
      sasChecks += 1
      return hasConfirmed
    },
    onEnvelope: async () => {},
    onDisconnected: () => {},
    openChannel: async () => ({
      sas: '12345678',
      peerIdentity,
      remoteStatic: new Uint8Array(32),
      send: async () => {},
      receive: () => new Promise(() => {}),
      close: () => closed.push(1)
    })
  })
  await expect(transport.connect(1)).rejects.toThrow('authentication failed')
  expect(sasChecks).toBe(0)
  expect(transport.connectedSlots()).toEqual([])
  peerIdentity = phone.publicKey
  hasConfirmed = false
  await expect(transport.connect(1)).rejects.toThrow('authentication failed')
  expect(sasChecks).toBe(1)
  hasConfirmed = true
  await transport.connect(1)
  expect(transport.connectedSlots()).toEqual([1])
  transport.dispose()
  expect(transport.connectedSlots()).toEqual([])
  expect(closed).toHaveLength(3)
})

test('BLE signing carrier forwards only bound messages and closes on wrong session', async () => {
  const extension = await identityFromSeed(new Uint8Array(32).fill(0x41))
  const phone = await identityFromSeed(new Uint8Array(32).fill(0x42))
  const roster = buildRoster({
    groupId,
    threshold: 2,
    identities: new Map([
      [0, bytesToBase64(extension.publicKey)],
      [1, bytesToBase64(phone.publicKey)]
    ])
  })
  let deliver: ((bytes: Uint8Array) => void) | null = null
  let hasClosed = false
  let resolveReceived!: () => void
  let resolveDisconnected!: () => void
  const received = new Promise<void>(resolve => (resolveReceived = resolve))
  const disconnected = new Promise<void>(resolve => (resolveDisconnected = resolve))
  const accepted: string[] = []
  const device = Object.assign(new EventTarget(), { id: 'phone' })
  const transport = createBleSigningTransport({
    binding: { ...binding, selectedSlots: [0, 1] },
    roster,
    identity: extension,
    now: () => 1_000,
    onChooser: async () => ({ status: 'selected', id: 'phone', name: null, device }),
    onSas: async () => true,
    async onEnvelope(envelope) {
      accepted.push(envelope.message_type)
      resolveReceived()
    },
    onDisconnected: () => resolveDisconnected(),
    openChannel: async () => ({
      sas: '12345678',
      peerIdentity: phone.publicKey,
      remoteStatic: new Uint8Array(32),
      send: async () => {},
      receive: () => new Promise(resolve => (deliver = resolve)),
      close: () => {
        hasClosed = true
      }
    })
  })
  await transport.connect(1)
  const phoneMessages = createEnvelopeFactory({ groupId, sessionId, senderId: 'device-2' })
  deliver!(new TextEncoder().encode(JSON.stringify(phoneMessages('SIGN_COMMITMENTS', 'device-1'))))
  await received
  await new Promise(resolve => setImmediate(resolve))
  expect(accepted).toEqual(['SIGN_COMMITMENTS'])
  const foreign = createEnvelopeFactory({ groupId, sessionId: 'other', senderId: 'device-2' })
  deliver!(new TextEncoder().encode(JSON.stringify(foreign('SIGN_SHARE', 'device-1'))))
  await disconnected
  expect(accepted).toEqual(['SIGN_COMMITMENTS'])
  expect(hasClosed).toBe(true)
  expect(transport.connectedSlots()).toEqual([])
  await expect(transport.connect(1)).rejects.toThrow('unavailable')
  transport.dispose()
})

test('BLE signing carrier treats a repeated envelope as a terminal replay', async () => {
  const extension = await identityFromSeed(new Uint8Array(32).fill(0x51))
  const phone = await identityFromSeed(new Uint8Array(32).fill(0x52))
  const roster = buildRoster({
    groupId,
    threshold: 2,
    identities: new Map([
      [0, bytesToBase64(extension.publicKey)],
      [1, bytesToBase64(phone.publicKey)]
    ])
  })
  let deliver: ((bytes: Uint8Array) => void) | null = null
  let resolveReceived!: () => void
  let resolveDisconnected!: () => void
  const received = new Promise<void>(resolve => (resolveReceived = resolve))
  const disconnected = new Promise<void>(resolve => (resolveDisconnected = resolve))
  let count = 0
  const device = Object.assign(new EventTarget(), { id: 'phone' })
  const transport = createBleSigningTransport({
    binding: { ...binding, selectedSlots: [0, 1] },
    roster,
    identity: extension,
    now: () => 1_000,
    onChooser: async () => ({ status: 'selected', id: 'phone', name: null, device }),
    onSas: async () => true,
    async onEnvelope() {
      count += 1
      resolveReceived()
    },
    onDisconnected: () => resolveDisconnected(),
    openChannel: async () => ({
      sas: '12345678',
      peerIdentity: phone.publicKey,
      remoteStatic: new Uint8Array(32),
      send: async () => {},
      receive: () => new Promise(resolve => (deliver = resolve)),
      close: () => {}
    })
  })
  await transport.connect(1)
  const phoneMessages = createEnvelopeFactory({ groupId, sessionId, senderId: 'device-2' })
  const repeated = new TextEncoder().encode(
    JSON.stringify(phoneMessages('SIGN_COMMITMENTS', 'device-1'))
  )
  deliver!(repeated)
  await received
  await new Promise(resolve => setImmediate(resolve))
  deliver!(repeated)
  await disconnected
  expect(count).toBe(1)
  expect(transport.connectedSlots()).toEqual([])
  transport.dispose()
})
