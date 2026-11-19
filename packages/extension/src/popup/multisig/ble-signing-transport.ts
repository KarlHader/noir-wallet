import { bytesToBase64 } from '@/lib/bytes'
import { BLE_DEVICE_QUERY, openWebBluetoothLink } from '@/core/multisig/ble/link'
import type { BluetoothDeviceLike, FrameLink, FrameLinkHandlers } from '@/core/multisig/ble/link'
import { generateNoiseStatic } from '@/core/multisig/ble/noise'
import { connectSecureChannel } from '@/core/multisig/ble/secure-channel'
import type { SecureChannel } from '@/core/multisig/ble/secure-channel'
import { assertSigningCarrierSize } from '@/core/multisig/sign-protocol'
import type { DeviceIdentity } from '@/core/multisig/identity'
import { deviceId, parseEnvelope, roundOf } from '@/core/multisig/messages'
import type { MultisigEnvelope } from '@/core/multisig/messages'
import type { DeviceSlot } from '@/core/multisig/types'
import type { RosterManifest } from '@/core/multisig/roster'
import { parseRosterManifest } from '@/core/multisig/roster'
import type { SigningReviewBinding } from '@/core/multisig/signing-coordinator'
import { chooseBluetoothDevice } from '@/lib/multisig-bluetooth'
import type { BluetoothSelection } from '@/lib/multisig-bluetooth'

interface BleSigningPeer {
  channel: SecureChannel
  abort: AbortController
  outbound: Promise<void>
}

export interface BleSigningTransport {
  connect(slot: number): Promise<void>
  send(envelopes: readonly MultisigEnvelope[]): Promise<void>
  connectedSlots(): number[]
  dispose(): void
}

/** One new authenticated channel per selected phone, scoped to one reviewed signing session. */
export function createBleSigningTransport(options: {
  binding: SigningReviewBinding
  roster: RosterManifest
  identity: DeviceIdentity
  onChooser?: () => Promise<BluetoothSelection>
  onSas: (slot: number, sas: string) => Promise<boolean>
  onEnvelope: (envelope: MultisigEnvelope) => Promise<void>
  onDisconnected: (slot: number) => void
  openLink?: (device: BluetoothDeviceLike, handlers: FrameLinkHandlers) => Promise<FrameLink>
  openChannel?: typeof connectSecureChannel
  now?: () => number
}): BleSigningTransport {
  const binding = { ...options.binding, selectedSlots: [...options.binding.selectedSlots] }
  const roster = parseRosterManifest(options.roster)
  if (
    !roster ||
    !Number.isSafeInteger(binding.expiresAt) ||
    roster.groupId !== binding.groupId ||
    roster.participants[0]?.identityPublicKey !== bytesToBase64(options.identity.publicKey) ||
    binding.selectedSlots.length !== roster.threshold ||
    !binding.selectedSlots.includes(0) ||
    new Set(binding.selectedSlots).size !== binding.selectedSlots.length ||
    binding.selectedSlots.some(
      slot => !Number.isInteger(slot) || slot < 0 || slot >= roster.participants.length
    )
  ) {
    throw new Error('Invalid signing roster')
  }
  const phones = new Set(binding.selectedSlots.filter(slot => slot !== 0))
  const peers = new Map<number, BleSigningPeer>()
  const connecting = new Map<number, AbortController>()
  const closedSlots = new Set<number>()
  const lastSequences = new Map<number, number>()
  const now = options.now ?? Date.now
  let disposed = false
  const isCurrent = () => !disposed && now() < binding.expiresAt
  const isSigningEnvelope = (envelope: MultisigEnvelope) =>
    envelope.group_id === binding.groupId &&
    envelope.session_id === binding.sessionId &&
    envelope.round === roundOf(envelope.message_type)

  function drop(slot: number, notify: boolean): void {
    const peer = peers.get(slot)
    peers.delete(slot)
    if (peer) closedSlots.add(slot)
    peer?.abort.abort()
    peer?.channel.close()
    if (notify && !disposed) options.onDisconnected(slot)
  }

  const expiry = setTimeout(
    () => {
      for (const slot of [...peers.keys()]) drop(slot, true)
      for (const abort of connecting.values()) abort.abort()
    },
    Math.max(0, binding.expiresAt - now())
  )
  ;(expiry as { unref?: () => void }).unref?.()

  async function listen(slot: number, peer: BleSigningPeer): Promise<void> {
    try {
      while (isCurrent() && peers.get(slot) === peer) {
        const bytes = await peer.channel.receive()
        if (!isCurrent() || peers.get(slot) !== peer) break
        let envelope: MultisigEnvelope | null = null
        try {
          envelope = parseEnvelope(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          )
        } catch {
          // A decrypted malformed message is a protocol error from this authenticated peer.
        }
        if (
          !envelope ||
          !isSigningEnvelope(envelope) ||
          envelope.sender_id !== deviceId((slot + 1) as DeviceSlot) ||
          envelope.recipient_id !== deviceId(1) ||
          !['SIGN_COMMITMENTS', 'SIGN_SHARE', 'SIGN_REJECT', 'SESSION_ABORT'].includes(
            envelope.message_type
          ) ||
          envelope.sequence <= (lastSequences.get(slot) ?? -1)
        ) {
          throw new Error('Invalid signing message')
        }
        assertSigningCarrierSize(envelope, 'ble')
        await options.onEnvelope(envelope)
        if (!isCurrent() || peers.get(slot) !== peer) break
        lastSequences.set(slot, envelope.sequence)
      }
    } catch {
      if (peers.get(slot) === peer) drop(slot, true)
    }
  }

  return {
    async connect(slot) {
      if (
        !isCurrent() ||
        !phones.has(slot) ||
        closedSlots.has(slot) ||
        peers.has(slot) ||
        connecting.has(slot)
      ) {
        throw new Error('Signing device is unavailable')
      }
      const abort = new AbortController()
      connecting.set(slot, abort)
      let channel: SecureChannel | null = null
      try {
        // Chooser invocation remains in the caller's click gesture.
        const selection = await (
          options.onChooser ?? (() => chooseBluetoothDevice(BLE_DEVICE_QUERY))
        )()
        if (
          selection.status !== 'selected' ||
          !selection.device ||
          abort.signal.aborted ||
          !isCurrent()
        ) {
          throw new Error('Signing device is unavailable')
        }
        channel = await (options.openChannel ?? connectSecureChannel)(
          handlers => (options.openLink ?? openWebBluetoothLink)(selection.device!, handlers),
          { identity: options.identity, noiseStatic: generateNoiseStatic(), signal: abort.signal }
        )
        if (
          abort.signal.aborted ||
          !isCurrent() ||
          bytesToBase64(channel.peerIdentity) !== roster.participants[slot].identityPublicKey ||
          !(await options.onSas(slot, channel.sas)) ||
          abort.signal.aborted ||
          !isCurrent()
        ) {
          throw new Error('Signing device authentication failed')
        }
        const peer: BleSigningPeer = { channel, abort, outbound: Promise.resolve() }
        peers.set(slot, peer)
        void listen(slot, peer)
      } catch (error) {
        abort.abort()
        channel?.close()
        throw error
      } finally {
        connecting.delete(slot)
      }
    },
    async send(envelopes) {
      if (!isCurrent()) throw new Error('Signing session is unavailable')
      for (const raw of envelopes) {
        const envelope = parseEnvelope(raw)
        if (
          !envelope ||
          !isSigningEnvelope(envelope) ||
          envelope.sender_id !== deviceId(1) ||
          !['SIGN_INIT', 'SIGN_PAYLOAD', 'SIGN_RESULT', 'SESSION_ABORT'].includes(
            envelope.message_type
          )
        ) {
          throw new Error('Invalid signing carrier')
        }
        const slot = binding.selectedSlots.find(
          value => deviceId((value + 1) as DeviceSlot) === envelope.recipient_id
        )
        const peer = slot === undefined ? null : peers.get(slot)
        if (slot === undefined || !peer) throw new Error('Signing device is disconnected')
        assertSigningCarrierSize(envelope, 'ble')
        const job = peer.outbound.then(async () => {
          if (!isCurrent() || peers.get(slot) !== peer)
            throw new Error('Signing device is disconnected')
          await peer.channel.send(new TextEncoder().encode(JSON.stringify(envelope)))
        })
        peer.outbound = job.catch(() => {})
        try {
          await job
        } catch (error) {
          drop(slot, true)
          throw error
        }
      }
    },
    connectedSlots: () => (isCurrent() ? [...peers.keys()].sort() : []),
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(expiry)
      for (const abort of connecting.values()) abort.abort()
      connecting.clear()
      for (const slot of [...peers.keys()]) drop(slot, false)
    }
  }
}
