import type { CreateSessionEvent } from '@/core/multisig/create-session'
import type { CreateSessionEffect } from '@/core/multisig/create-session-shared'
import { multisigDebug } from '@/core/multisig/debug-log'
import type { SessionDriver } from '@/core/multisig/driver'
import { createEnvelopeSigner } from '@/core/multisig/envelope-signing'
import { generateNoiseStatic } from '@/core/multisig/ble/noise'
import { openWebBluetoothLink } from '@/core/multisig/ble/link'
import type { BluetoothDeviceLike, FrameLink, FrameLinkHandlers } from '@/core/multisig/ble/link'
import { ChannelError, connectSecureChannel } from '@/core/multisig/ble/secure-channel'
import type { SecureChannel } from '@/core/multisig/ble/secure-channel'
import type { DeviceIdentity } from '@/core/multisig/identity'
import { createInboundGate } from '@/core/multisig/inbound-gate'
import { deviceId, parseEnvelope } from '@/core/multisig/messages'
import type { MultisigEnvelope, MultisigMessageType } from '@/core/multisig/messages'
import { SESSION_STEP_TIMEOUT_MS } from '@/core/multisig/types'
import type { DeviceSlot, MultisigDevice } from '@/core/multisig/types'
import { bytesToBase64 } from '@/lib/bytes'
import type { BluetoothSelection } from '@/lib/multisig-bluetooth'

type Dispatch = (event: CreateSessionEvent) => void

export type BleChooserRejection = 'unavailable' | 'duplicate' | 'connect_failed' | 'wrong_device'

export interface BleDriverOptions {
  session: { groupId: string; sessionId: string }
  identity: DeviceIdentity
  /** The guardian slots of this session. */
  slots: readonly DeviceSlot[]
  /** Shows the browser's Bluetooth chooser and resolves with what became of it. */
  onChooser: (slot: DeviceSlot) => Promise<BluetoothSelection>
  /** Pairing could not start or finish for a reason the user cannot see in the chooser itself. */
  onRejected: (reason: BleChooserRejection) => void
  openLink?: (device: BluetoothDeviceLike, handlers: FrameLinkHandlers) => Promise<FrameLink>
  stepTimeoutMs?: number
}

const UNNAMED_DEVICE = 'Unknown device'

// Only labels the pairing in progress: the phone states who it is in PAIR_RESPONSE.
function chooserDevice(slot: DeviceSlot, name: string | null): MultisigDevice {
  const label = name ?? UNNAMED_DEVICE
  return { slot, role: 'guardian', name: label, model: label, platform: 'ios' }
}

interface Peer {
  channel: SecureChannel | null
  bluetoothId: string
  isFlushing: boolean
  abortController: AbortController
  /** Sends to one phone go out in the order they were asked for. */
  outbound: Promise<void>
}

/**
 * Real Bluetooth transport. The extension is the GATT Central: it connects to the phone the user
 * picked, builds the Noise channel, and from then on every session message is a signed envelope
 * sent as one encrypted channel message. Inbound envelopes pass the same gate as scanned QR codes.
 */
/** Longest dispose() waits for queued messages (the DKG_ACTIVATE) before closing the link. */
const DISPOSE_FLUSH_MS = 3000

export function createBleDriver(options: BleDriverOptions): SessionDriver {
  const openLink = options.openLink ?? openWebBluetoothLink
  const stepTimeoutMs = options.stepTimeoutMs ?? SESSION_STEP_TIMEOUT_MS
  const signer = createEnvelopeSigner({
    groupId: options.session.groupId,
    sessionId: options.session.sessionId,
    senderId: deviceId(1),
    signingKey: options.identity.signingKeys.privateKey
  })
  const gate = createInboundGate({
    groupId: options.session.groupId,
    sessionId: options.session.sessionId,
    ownIdentityPublicKey: bytesToBase64(options.identity.publicKey),
    slots: options.slots
  })
  const peers = new Map<DeviceSlot, Peer>()
  // One Noise static key for the whole session: the roster names it as the extension's transport key.
  const noiseStatic = generateNoiseStatic()
  // Bumped whenever a slot is torn down or a new chooser opens, so a late answer to the old
  // attempt is dropped instead of acting on the new one.
  const epochs = new Map<DeviceSlot, number>()
  const waits = new Map<DeviceSlot, { type: MultisigMessageType; cancel: () => void }>()
  let disposed = false

  const epochOf = (slot: DeviceSlot) => epochs.get(slot) ?? 0
  const bump = (slot: DeviceSlot) => {
    const next = epochOf(slot) + 1
    epochs.set(slot, next)
    return next
  }

  function disarm(slot: DeviceSlot): void {
    waits.get(slot)?.cancel()
    waits.delete(slot)
  }

  function arm(slot: DeviceSlot, type: MultisigMessageType, dispatch: Dispatch): void {
    disarm(slot)
    const timer = setTimeout(() => {
      waits.delete(slot)
      if (!disposed) dispatch({ type: 'STEP_TIMEOUT' })
    }, stepTimeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    waits.set(slot, { type, cancel: () => clearTimeout(timer) })
  }

  function dropPeer(slot: DeviceSlot): void {
    const peer = peers.get(slot)
    peers.delete(slot)
    peer?.abortController.abort()
    peer?.channel?.close()
    gate.forgetPeer(slot)
    disarm(slot)
  }

  function isTakenByOtherSlot(slot: DeviceSlot, id: string): boolean {
    return [...peers].some(([other, peer]) => other !== slot && peer.bluetoothId === id)
  }

  function requestDevice(slot: DeviceSlot, dispatch: Dispatch): void {
    const epoch = bump(slot)
    const current = () => !disposed && epochOf(slot) === epoch
    const reject = (reason: BleChooserRejection) => {
      options.onRejected(reason)
      dispatch({ type: 'PAIR_SELECTION_CANCELLED', slot })
    }
    const settle = (selection: BluetoothSelection) => {
      if (!current()) return
      if (selection.status === 'cancelled') {
        dispatch({ type: 'PAIR_SELECTION_CANCELLED', slot })
        return
      }
      if (selection.status === 'unavailable' || !selection.device) {
        reject('unavailable')
        return
      }
      if (isTakenByOtherSlot(slot, selection.id)) {
        reject('duplicate')
        return
      }
      dropPeer(slot)
      peers.set(slot, {
        channel: null,
        bluetoothId: selection.id,
        isFlushing: false,
        abortController: new AbortController(),
        outbound: Promise.resolve()
      })
      dispatch({ type: 'PAIR_DEVICE_SELECTED', slot, device: chooserDevice(slot, selection.name) })
      void connect(slot, selection.device, epoch, dispatch)
    }
    // Synchronous up to onChooser: the browser's chooser needs the click that got us here. A
    // chooser that throws or rejects counts as the user closing it.
    new Promise<BluetoothSelection>(resolve => resolve(options.onChooser(slot))).then(settle, () =>
      settle({ status: 'cancelled' })
    )
  }

  async function connect(
    slot: DeviceSlot,
    device: BluetoothDeviceLike,
    epoch: number,
    dispatch: Dispatch
  ): Promise<void> {
    const current = () => !disposed && epochOf(slot) === epoch && peers.has(slot)
    let channel: SecureChannel
    try {
      channel = await connectSecureChannel(handlers => openLink(device, handlers), {
        identity: options.identity,
        noiseStatic,
        signal: peers.get(slot)?.abortController.signal
      })
    } catch (error) {
      if (!current()) return
      multisigDebug('ble', { step: 'connect', slot, result: 'failed', reason: reasonOf(error) })
      dropPeer(slot)
      options.onRejected(
        error instanceof ChannelError && error.reason === 'identity_binding'
          ? 'wrong_device'
          : 'connect_failed'
      )
      dispatch({ type: 'DEVICE_DISCONNECTED', slot })
      return
    }
    if (!current()) {
      channel.close()
      return
    }
    const peer = peers.get(slot)!
    peer.channel = channel
    // The gate verifies every later message against the key the phone proved in the handshake.
    gate.registerPeer(slot, bytesToBase64(channel.peerIdentity))
    multisigDebug('ble', { step: 'connect', slot, result: 'ok' })
    dispatch({
      type: 'PAIR_SAS_READY',
      slot,
      sas: channel.sas,
      identityPublicKey: bytesToBase64(channel.peerIdentity),
      transportPublicKey: bytesToBase64(channel.remoteStatic),
      ownerTransportPublicKey: bytesToBase64(noiseStatic.public)
    })
    void listen(slot, channel, epoch, dispatch)
  }

  async function listen(
    slot: DeviceSlot,
    channel: SecureChannel,
    epoch: number,
    dispatch: Dispatch
  ): Promise<void> {
    const current = () =>
      !disposed && epochOf(slot) === epoch && peers.get(slot)?.channel === channel
    for (;;) {
      let message: Uint8Array
      try {
        message = await channel.receive()
      } catch {
        // The phone left or the stream broke: the slot is gone, whatever step it was in.
        if (current()) {
          dropPeer(slot)
          dispatch({ type: 'DEVICE_DISCONNECTED', slot })
        }
        return
      }
      if (!current()) return
      await receive(slot, message, dispatch, current)
      if (!current()) return
    }
  }

  async function receive(
    slot: DeviceSlot,
    message: Uint8Array,
    dispatch: Dispatch,
    isCurrent: () => boolean
  ): Promise<void> {
    let envelope: MultisigEnvelope | null = null
    try {
      envelope = parseEnvelope(JSON.parse(new TextDecoder().decode(message)))
    } catch {
      envelope = null
    }
    // A decrypted message that is not an envelope came from the authenticated phone, so it is a
    // protocol failure, not noise to skip.
    if (!envelope) {
      dispatch({ type: 'MESSAGE_REJECTED', slot, reason: 'payload_hash' })
      return
    }
    if (envelope.sender_id !== deviceId(slot)) {
      dispatch({ type: 'MESSAGE_REJECTED', slot, reason: 'identity_key' })
      return
    }
    const verdict = await gate.check(envelope)
    if (!isCurrent()) return
    switch (verdict.kind) {
      case 'accept':
        if (waits.get(verdict.slot)?.type === envelope.message_type) disarm(verdict.slot)
        multisigDebug('envelope', {
          direction: 'in',
          messageType: envelope.message_type,
          slot: verdict.slot
        })
        dispatch({ type: 'MESSAGE_RECEIVED', slot: verdict.slot, envelope, at: Date.now() })
        return
      case 'duplicate':
        return
      case 'foreign':
        multisigDebug('envelope', { direction: 'in', result: 'ignored', reason: verdict.reason })
        return
      case 'invalid':
        dispatch({ type: 'MESSAGE_REJECTED', slot: verdict.slot, reason: verdict.reason })
        return
    }
  }

  function sendTo(
    slot: DeviceSlot,
    messageType: MultisigMessageType,
    payload: Record<string, unknown> | undefined,
    dispatch: Dispatch
  ): void {
    const peer = peers.get(slot)
    // No peer means the slot was torn down; the step timer reports the silence if it matters.
    if (!peer) return
    const epoch = epochOf(slot)
    // The sequence is taken now, so messages keep the order the session asked for them in.
    const signed = signer.next(messageType, deviceId(slot), payload)
    peer.outbound = peer.outbound.then(async () => {
      // Not gated on `disposed`: a message queued before the driver went (DKG_ACTIVATE, SESSION_ABORT)
      // still has to reach the phone; dispose() waits for the queue before it closes the link.
      if ((epochOf(slot) !== epoch && !peer.isFlushing) || !peer.channel) return
      try {
        const envelope = await signed
        multisigDebug('envelope', {
          direction: 'out',
          messageType,
          slot,
          sequence: envelope.sequence
        })
        await peer.channel.send(new TextEncoder().encode(JSON.stringify(envelope)))
      } catch {
        if (epochOf(slot) !== epoch) return
        if (disposed) return
        dropPeer(slot)
        dispatch({ type: 'DEVICE_DISCONNECTED', slot })
      }
    })
  }

  function flushAndClose(peer: Peer): void {
    peer.isFlushing = true
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, DISPOSE_FLUSH_MS)
      ;(timer as { unref?: () => void }).unref?.()
    })
    void Promise.race([peer.outbound, deadline]).finally(() => {
      clearTimeout(timer)
      peer.abortController.abort()
      peer.channel?.close()
    })
  }

  return {
    kind: 'ble',
    execute(effect: CreateSessionEffect, dispatch) {
      if (disposed) return
      switch (effect.type) {
        case 'requestDevice':
          if (effect.slot !== 1) requestDevice(effect.slot, dispatch)
          break
        case 'sendTo':
          if (effect.slot !== 1) sendTo(effect.slot, effect.messageType, effect.payload, dispatch)
          break
        case 'awaitFrom':
          if (effect.slot !== 1) arm(effect.slot, effect.messageType, dispatch)
          break
        case 'disconnect':
          if (effect.slot !== 1) {
            bump(effect.slot)
            // Let a queued SESSION_ABORT reach the phone before the link goes.
            const peer = peers.get(effect.slot)
            const slot = effect.slot
            peers.delete(slot)
            gate.forgetPeer(slot)
            disarm(slot)
            if (peer) flushAndClose(peer)
          }
          break
        // The channel starts itself once a phone is picked; the typed-code flow is not used here.
        case 'issueCode':
        // QR effects never reach a Bluetooth session, and the store persists and runs the DKG.
        case 'display':
        case 'awaitScan':
        case 'persistGroup':
        case 'dkgOpen':
        case 'dkgAcceptRound1':
        case 'dkgAcceptRound2':
        case 'dkgClose':
        case 'saveVaultRecord':
          break
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const slot of [...peers.keys()]) {
        const peer = peers.get(slot)
        peers.delete(slot)
        disarm(slot)
        // Let queued messages out before the link goes, but never hold it open for long.
        if (!peer) continue
        flushAndClose(peer)
      }
    }
  }
}

function reasonOf(error: unknown): string {
  return error instanceof ChannelError ? error.reason : 'error'
}
