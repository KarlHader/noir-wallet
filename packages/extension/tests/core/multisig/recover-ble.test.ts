import { test } from 'node:test'
import { expect } from '@playwright/test'
import type { SecureChannel } from '../../../src/core/multisig/ble/secure-channel'
import { serveRecoverOverChannel } from '../../../src/core/multisig/recover-ble'

const PHONE_IDENTITY = Uint8Array.of(1, ...new Uint8Array(64).fill(0x22))
const REQUEST = new Uint8Array(1 + 32 + 65 + 32 + 8 + 64)
REQUEST[0] = 1
REQUEST.set(PHONE_IDENTITY, 33)
const REPLY = Uint8Array.of(1, 2, 3, 4)

function fakeChannel(incoming: Uint8Array | null, peerIdentity = PHONE_IDENTITY) {
  const sent: Uint8Array[] = []
  let reads = 0
  let closed = 0
  const channel: SecureChannel = {
    sas: '12345678',
    peerIdentity,
    remoteStatic: new Uint8Array(32),
    async send(message) {
      sent.push(message)
    },
    async receive() {
      reads += 1
      if (!incoming) throw new Error('closed')
      return incoming
    },
    close() {
      closed += 1
    }
  }
  return { channel, sent, reads: () => reads, closed: () => closed }
}

function options(confirm: boolean, prepareReply: (request: Uint8Array) => Promise<Uint8Array>) {
  return { confirmSas: async () => confirm, prepareReply }
}

test('confirmed channel sends exactly the opaque Worker reply', async () => {
  const { channel, sent, closed } = fakeChannel(REQUEST)
  const prepared: Uint8Array[] = []
  const result = await serveRecoverOverChannel(
    channel,
    options(true, async request => {
      prepared.push(request)
      return REPLY
    })
  )
  expect(result).toEqual({ ok: true })
  expect(prepared).toEqual([REQUEST])
  expect(sent).toEqual([REPLY])
  expect(closed()).toBe(1)
})

test('SAS rejection does not receive, prepare or send', async () => {
  const { channel, reads, sent, closed } = fakeChannel(REQUEST)
  let prepared = 0
  const result = await serveRecoverOverChannel(
    channel,
    options(false, async () => {
      prepared += 1
      return REPLY
    })
  )
  expect(result).toEqual({ ok: false, reason: 'sas' })
  expect(reads()).toBe(0)
  expect(prepared).toBe(0)
  expect(sent).toHaveLength(0)
  expect(closed()).toBe(1)
})

test('malformed request never reaches the Worker callback', async () => {
  const { channel, sent, closed } = fakeChannel(REQUEST.slice(0, -1))
  let prepared = 0
  const result = await serveRecoverOverChannel(
    channel,
    options(true, async () => {
      prepared += 1
      return REPLY
    })
  )
  expect(result).toEqual({ ok: false, reason: 'format' })
  expect(prepared).toBe(0)
  expect(sent).toHaveLength(0)
  expect(closed()).toBe(1)
})

test('request identity must match the identity proved by the channel', async () => {
  const other = Uint8Array.of(1, ...new Uint8Array(64).fill(0x55))
  const { channel, sent, closed } = fakeChannel(REQUEST, other)
  let prepared = 0
  const result = await serveRecoverOverChannel(
    channel,
    options(true, async () => {
      prepared += 1
      return REPLY
    })
  )
  expect(result).toEqual({ ok: false, reason: 'identity' })
  expect(prepared).toBe(0)
  expect(sent).toHaveLength(0)
  expect(closed()).toBe(1)
})

test('Worker failure closes the channel without sending a reply', async () => {
  const { channel, sent, closed } = fakeChannel(REQUEST)
  await expect(
    serveRecoverOverChannel(
      channel,
      options(true, async () => {
        throw new Error('prepare failed')
      })
    )
  ).rejects.toThrow('prepare failed')
  expect(sent).toHaveLength(0)
  expect(closed()).toBe(1)
})

test('a disconnected phone closes the channel', async () => {
  const { channel, closed } = fakeChannel(null)
  await expect(
    serveRecoverOverChannel(
      channel,
      options(true, async () => REPLY)
    )
  ).rejects.toThrow('closed')
  expect(closed()).toBe(1)
})
