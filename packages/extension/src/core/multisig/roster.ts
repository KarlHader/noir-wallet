import { sha256 } from '@noble/hashes/sha2'
import { base64ToBytes, bytesToBase64, bytesToHex } from '@/lib/bytes'
import { lengthPrefixed } from './envelope-signing'
import { parseIdentityPublicKey } from './identity'

export const ROSTER_DOMAIN = 'noir/roster/v1'
export const ROSTER_CIPHERSUITE = 'frost-redpallas-blake2b-512'
/** 32 zero bytes: the QR transport has no encrypted channel, so every slot carries this placeholder. */
export const QR_TRANSPORT_PUBLIC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

const TRANSPORT_PUBLIC_KEY_BYTES = 32

export type RosterParticipant = {
  slot: number
  identityPublicKey: string // base64 of 65 bytes
  transportPublicKey: string // base64 of 32 bytes
}

export type RosterManifest = {
  groupId: string
  protocolVersion: 1
  ciphersuite: typeof ROSTER_CIPHERSUITE
  threshold: 2 | 3
  participants: readonly RosterParticipant[]
  rosterHash: string // 64 lowercase hex
}

type UnhashedRoster = Omit<RosterManifest, 'rosterHash'>

const encoder = new TextEncoder()

function field(text: string | Uint8Array): Uint8Array {
  return lengthPrefixed(typeof text === 'string' ? encoder.encode(text) : text)
}

export function rosterCanonicalBytes(manifest: UnhashedRoster): Uint8Array {
  const parts: Uint8Array[] = [
    encoder.encode(ROSTER_DOMAIN),
    field(manifest.groupId),
    field(String(manifest.protocolVersion)),
    field(manifest.ciphersuite),
    field(String(manifest.threshold)),
    field(String(manifest.participants.length))
  ]
  const ordered = [...manifest.participants].sort((a, b) => a.slot - b.slot)
  for (const participant of ordered) {
    parts.push(
      field(Uint8Array.of(participant.slot)),
      field(base64ToBytes(participant.identityPublicKey)),
      field(base64ToBytes(participant.transportPublicKey))
    )
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function rosterHash(manifest: UnhashedRoster): string {
  return bytesToHex(sha256(rosterCanonicalBytes(manifest)))
}

export function buildRoster(input: {
  groupId: string
  threshold: 2 | 3
  identities: ReadonlyMap<number, string>
  transportPublicKeys?: ReadonlyMap<number, string>
}): RosterManifest {
  const participants = [...input.identities.keys()]
    .sort((a, b) => a - b)
    .map(slot => ({
      slot,
      identityPublicKey: input.identities.get(slot) as string,
      transportPublicKey: input.transportPublicKeys?.get(slot) ?? QR_TRANSPORT_PUBLIC_KEY
    }))
  const unhashed: UnhashedRoster = {
    groupId: input.groupId,
    protocolVersion: 1,
    ciphersuite: ROSTER_CIPHERSUITE,
    threshold: input.threshold,
    participants
  }
  return { ...unhashed, rosterHash: rosterHash(unhashed) }
}

function parseParticipant(value: unknown, expectedSlot: number): RosterParticipant | null {
  if (typeof value !== 'object' || value === null) return null
  const { slot, identityPublicKey, transportPublicKey } = value as Record<string, unknown>
  if (slot !== expectedSlot) return null
  if (typeof identityPublicKey !== 'string' || typeof transportPublicKey !== 'string') return null
  const identity = parseIdentityPublicKey(identityPublicKey)
  if (!identity || bytesToBase64(identity.bytes) !== identityPublicKey) return null
  let transport: Uint8Array
  try {
    transport = base64ToBytes(transportPublicKey)
  } catch {
    return null
  }
  if (
    transport.length !== TRANSPORT_PUBLIC_KEY_BYTES ||
    bytesToBase64(transport) !== transportPublicKey
  ) {
    return null
  }
  return { slot, identityPublicKey, transportPublicKey }
}

/** Participants must arrive in slot order 0..n-1, the order the hash is computed over. */
export function parseRosterManifest(value: unknown): RosterManifest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const {
    groupId,
    protocolVersion,
    ciphersuite,
    threshold,
    participants,
    rosterHash: claimed
  } = record
  if (typeof groupId !== 'string' || groupId.length === 0) return null
  if (protocolVersion !== 1 || ciphersuite !== ROSTER_CIPHERSUITE) return null
  if (threshold !== 2 && threshold !== 3) return null
  if (!Array.isArray(participants)) return null
  if (participants.length !== 2 && participants.length !== 3) return null
  if (participants.length < threshold) return null
  const parsed: RosterParticipant[] = []
  for (let slot = 0; slot < participants.length; slot += 1) {
    const participant = parseParticipant(participants[slot], slot)
    if (!participant) return null
    parsed.push(participant)
  }
  const unhashed: UnhashedRoster = {
    groupId,
    protocolVersion,
    ciphersuite,
    threshold,
    participants: parsed
  }
  if (typeof claimed !== 'string' || claimed !== rosterHash(unhashed)) return null
  return { ...unhashed, rosterHash: claimed }
}
