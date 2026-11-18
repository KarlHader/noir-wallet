import { openWebBluetoothLink, BLE_RX_UUID } from '../../../src/core/multisig/ble/link'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { x25519 } from '@noble/curves/ed25519'
import { pairingSas } from '../../../src/core/multisig/ble/sas'
import { ChannelError, connectSecureChannel } from '../../../src/core/multisig/ble/secure-channel'
import { generateNoiseStatic } from '../../../src/core/multisig/ble/noise'
import { createFakePhone } from './helpers/ble-phone'
import { identityFromSeed } from './helpers/identity'

const seed = (byte: number) => new Uint8Array(32).fill(byte)

async function setup(
  overrides: Parameters<typeof createFakePhone>[0] extends infer T ? Partial<T> : never = {}
) {
  const extensionIdentity = await identityFromSeed(seed(0x61))
  const phoneIdentity = await identityFromSeed(seed(0x62))
  const phoneStatic = generateNoiseStatic()
  const phone = createFakePhone({ identity: phoneIdentity, noiseStatic: phoneStatic, ...overrides })
  return { extensionIdentity, phoneIdentity, phone }
}

test('the channel completes the handshake, the identity binding and the SAS', async () => {
  const { extensionIdentity, phoneIdentity, phone } = await setup()
  const channel = await connectSecureChannel(phone.open, {
    identity: extensionIdentity,
    noiseStatic: generateNoiseStatic()
  })
  expect(channel.peerIdentity).toEqual(phoneIdentity.publicKey)
  // Both ends derive the same SAS from the same handshake hash.
  expect(channel.sas).toBe(pairingSas(phone.responder.handshakeHash()))
  expect(channel.sas).toMatch(/^\d{8}$/)
  expect(phone.state.bindingVerified).toBe(true)
})

test('application messages travel encrypted in both directions, across several frames', async () => {
  const echoed: Uint8Array[] = []
  const { extensionIdentity, phone } = await setup({
    onMessage: message => {
      echoed.push(message)
      return [new TextEncoder().encode('reply:' + message.length)]
    }
  })
  const channel = await connectSecureChannel(phone.open, {
    identity: extensionIdentity,
    noiseStatic: generateNoiseStatic()
  })
  const big = Uint8Array.from({ length: 4000 }, (_, i) => i & 0xff)
  await channel.send(big)
  expect(new TextDecoder().decode(await channel.receive())).toBe('reply:4000')
  expect([...echoed[0]]).toEqual([...big])
})

test('the phone can also speak first', async () => {
  const { extensionIdentity, phone } = await setup()
  const channel = await connectSecureChannel(phone.open, {
    identity: extensionIdentity,
    noiseStatic: generateNoiseStatic()
  })
  phone.say(new TextEncoder().encode('hello'))
  expect(new TextDecoder().decode(await channel.receive())).toBe('hello')
})

test('a phone that signs the binding with another key is refused', async () => {
  const impostor = await identityFromSeed(seed(0x63))
  const { extensionIdentity, phone } = await setup({ bindingKey: impostor.signingKeys.privateKey })
  await expect(
    connectSecureChannel(phone.open, {
      identity: extensionIdentity,
      noiseStatic: generateNoiseStatic()
    })
  ).rejects.toMatchObject({ reason: 'identity_binding' })
  expect(phone.state.closed).toBe(true)
})

test('a phone using another prologue fails the handshake', async () => {
  const { extensionIdentity, phone } = await setup({
    prologue: new TextEncoder().encode('noir/pair/v2')
  })
  await expect(
    connectSecureChannel(phone.open, {
      identity: extensionIdentity,
      noiseStatic: generateNoiseStatic(),
      handshakeTimeoutMs: 500
    })
  ).rejects.toBeInstanceOf(ChannelError)
})

test('a link that cannot be opened ends the channel as closed', async () => {
  const { extensionIdentity } = await setup()
  await expect(
    connectSecureChannel(
      async () => {
        throw new Error('no gatt')
      },
      { identity: extensionIdentity, noiseStatic: generateNoiseStatic() }
    )
  ).rejects.toMatchObject({ reason: 'closed' })
})

test('losing the link makes a waiting receive fail', async () => {
  const { extensionIdentity, phone } = await setup()
  const channel = await connectSecureChannel(phone.open, {
    identity: extensionIdentity,
    noiseStatic: generateNoiseStatic()
  })
  const pending = channel.receive()
  phone.drop()
  await expect(pending).rejects.toMatchObject({ reason: 'closed' })
  expect(x25519.getPublicKey(seed(1))).toHaveLength(32)
})

test('cancellation closes an unfinished handshake without sending a late invite', async () => {
  const { extensionIdentity } = await setup()
  const controller = new AbortController()
  let isClosed = false
  let hasWritten = false
  const pending = connectSecureChannel(
    async handlers => ({
      async send() {
        hasWritten = true
      },
      close() {
        isClosed = true
        handlers.onClosed()
      }
    }),
    {
      identity: extensionIdentity,
      noiseStatic: generateNoiseStatic(),
      signal: controller.signal
    }
  )
  // Cancellation races with GATT connection resolution, before the handshake can start.
  controller.abort()
  await expect(pending).rejects.toMatchObject({ reason: 'closed' })
  expect(isClosed).toBe(true)
  expect(hasWritten).toBe(false)
})

for (const pendingStage of ['service', 'notifications']) {
  for (const cancellation of ['abort', 'deadline']) {
    test(`${cancellation} releases GATT while ${pendingStage} acquisition is pending`, async () => {
      const { extensionIdentity } = await setup()
      const controller = new AbortController()
      class TrackedTarget extends EventTarget {
        listeners = new Set<EventListenerOrEventListenerObject>()
        addEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions
        ) {
          if (listener) this.listeners.add(listener)
          super.addEventListener(type, listener, options)
        }
        removeEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | EventListenerOptions
        ) {
          if (listener) this.listeners.delete(listener)
          super.removeEventListener(type, listener, options)
        }
      }
      let markPending: () => void = () => {}
      const isPending = new Promise<void>(resolve => {
        markPending = resolve
      })
      const pending = () => {
        markPending()
        return new Promise<never>(() => {})
      }
      const notifications = Object.assign(new TrackedTarget(), {
        startNotifications: pending,
        writeValue: async () => {}
      })
      const receiver = Object.assign(new TrackedTarget(), {
        startNotifications: async () => {},
        writeValue: async () => {}
      })
      let disconnects = 0
      const device = Object.assign(new TrackedTarget(), {
        id: 'synthetic-phone',
        gatt: {
          connected: false,
          async connect() {
            this.connected = true
            return this
          },
          disconnect() {
            this.connected = false
            disconnects += 1
          },
          getPrimaryService:
            pendingStage === 'service'
              ? pending
              : async () => ({
                  getCharacteristic: async (uuid: string) =>
                    uuid === BLE_RX_UUID ? receiver : notifications
                })
        }
      })
      const connection = connectSecureChannel(handlers => openWebBluetoothLink(device, handlers), {
        identity: extensionIdentity,
        noiseStatic: generateNoiseStatic(),
        signal: controller.signal,
        handshakeTimeoutMs: cancellation === 'deadline' ? 30 : 1000
      })
      // Install the rejection handler before either cancellation source fires.
      const rejected = expect(connection).rejects.toMatchObject({
        reason: cancellation === 'deadline' ? 'timeout' : 'closed'
      })
      await isPending
      if (cancellation === 'abort') controller.abort()
      await rejected
      expect(device.gatt.connected).toBe(false)
      expect(disconnects).toBe(1)
      expect(device.listeners.size).toBe(0)
      expect(notifications.listeners.size).toBe(0)
    })
  }
}

test('the caller abort signal retains ownership after the channel connects', async () => {
  const { extensionIdentity, phone } = await setup()
  const controller = new AbortController()
  const channel = await connectSecureChannel(phone.open, {
    identity: extensionIdentity,
    noiseStatic: generateNoiseStatic(),
    signal: controller.signal
  })
  const received = channel.receive().then(
    () => 'message',
    error => error.reason
  )
  controller.abort()
  // A broken cancellation must fail this regression without leaving its receive unresolved.
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      received,
      new Promise<string>(resolve => {
        deadline = setTimeout(() => resolve('pending'), 100)
      })
    ])
    expect(outcome).toBe('closed')
    expect(phone.state.closed).toBe(true)
  } finally {
    clearTimeout(deadline)
    channel.close()
  }
})
