import { bytesToBase64 } from '@/lib/bytes'
import { parsePairResponsePayload } from './dkg-protocol'
import { envelopePayloadHash, verifyEnvelope } from './envelope-signing'
import { parseIdentityPublicKey } from './identity'
import { deviceId, roundOf, type MultisigEnvelope } from './messages'
import type { DeviceSlot } from './types'

export type ForeignReason =
  | 'other_session'
  | 'not_for_us'
  | 'unknown_sender'
  | 'unregistered_sender'
  | 'duplicate_identity'

export type InvalidReason =
  | 'payload_hash'
  | 'signature'
  | 'round'
  | 'sequence'
  | 'identity_key'
  | 'identity_replaced'

export type GateResult =
  | { kind: 'accept'; slot: DeviceSlot }
  | { kind: 'duplicate'; slot: DeviceSlot }
  | { kind: 'foreign'; reason: ForeignReason }
  | { kind: 'invalid'; slot: DeviceSlot; reason: InvalidReason }

export interface InboundGate {
  registerPeer(slot: DeviceSlot, identityPublicKey: string): void
  forgetPeer(slot: DeviceSlot): void
  peerIdentity(slot: DeviceSlot): string | null
  check(envelope: MultisigEnvelope): Promise<GateResult>
}

interface PeerState {
  identity: string | null
  lastSequence: number
  // Full JSON of each accepted envelope by sequence, to recognise byte-identical resends.
  accepted: Map<number, string>
}

const EXTENSION_ID = deviceId(1)

function freshState(): PeerState {
  return { identity: null, lastSequence: 0, accepted: new Map() }
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function canonicalIdentity(value: string): string | null {
  const parsed = parseIdentityPublicKey(value)
  return parsed ? bytesToBase64(parsed.bytes) : null
}

export function createInboundGate(input: {
  groupId: string
  sessionId: string
  ownIdentityPublicKey: string
  slots: readonly DeviceSlot[]
  subtle?: SubtleCrypto
}): InboundGate {
  const ownIdentity = canonicalIdentity(input.ownIdentityPublicKey) ?? input.ownIdentityPublicKey
  const peers = new Map<DeviceSlot, PeerState>(input.slots.map(slot => [slot, freshState()]))

  function registeredElsewhere(identity: string, slot: DeviceSlot): boolean {
    for (const [other, state] of peers) {
      if (other !== slot && state.identity === identity) return true
    }
    return false
  }

  return {
    registerPeer(slot, identityPublicKey) {
      const state = peers.get(slot)
      if (state) state.identity = canonicalIdentity(identityPublicKey) ?? identityPublicKey
    },
    forgetPeer(slot) {
      if (peers.has(slot)) peers.set(slot, freshState())
    },
    peerIdentity(slot) {
      return peers.get(slot)?.identity ?? null
    },
    async check(envelope) {
      if (envelope.group_id !== input.groupId || envelope.session_id !== input.sessionId) {
        return { kind: 'foreign', reason: 'other_session' }
      }
      if (envelope.recipient_id !== EXTENSION_ID) return { kind: 'foreign', reason: 'not_for_us' }
      const slot = input.slots.find(candidate => deviceId(candidate) === envelope.sender_id)
      const state = slot === undefined ? undefined : peers.get(slot)
      if (slot === undefined || !state) return { kind: 'foreign', reason: 'unknown_sender' }
      const invalid = (reason: InvalidReason): GateResult => ({ kind: 'invalid', slot, reason })

      if (envelope.round !== roundOf(envelope.message_type)) return invalid('round')
      if (envelope.payload_hash !== envelopePayloadHash(envelope.encrypted_payload)) {
        return invalid('payload_hash')
      }
      const previous = state.accepted.get(envelope.sequence)
      if (previous !== undefined && previous === JSON.stringify(envelope)) {
        return { kind: 'duplicate', slot }
      }
      if (envelope.sequence <= state.lastSequence) return invalid('sequence')

      let signerIdentity: string
      if (envelope.message_type === 'PAIR_RESPONSE') {
        // A phone introduces itself: the envelope is verified against the key it announces.
        const payload = parsePairResponsePayload(parsePayload(envelope.encrypted_payload))
        const announced = payload ? canonicalIdentity(payload.identityPublicKey) : null
        if (!announced) return invalid('identity_key')
        // Only forgetPeer may change a slot's identity; a new self-signed key must not take it over.
        if (state.identity && state.identity !== announced) return invalid('identity_replaced')
        if (announced === ownIdentity || registeredElsewhere(announced, slot)) {
          return { kind: 'foreign', reason: 'duplicate_identity' }
        }
        signerIdentity = announced
      } else {
        if (!state.identity) return { kind: 'foreign', reason: 'unregistered_sender' }
        signerIdentity = state.identity
      }

      const key = parseIdentityPublicKey(signerIdentity)
      if (!key || !(await verifyEnvelope(envelope, key.ed25519, input.subtle))) {
        return invalid('signature')
      }
      if (envelope.message_type === 'PAIR_RESPONSE') state.identity = signerIdentity
      state.lastSequence = envelope.sequence
      state.accepted.set(envelope.sequence, JSON.stringify(envelope))
      return { kind: 'accept', slot }
    }
  }
}
