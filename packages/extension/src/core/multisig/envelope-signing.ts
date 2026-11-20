import { sha256 } from '@noble/hashes/sha2'
import { base64ToBytes, bytesToBase64, bytesToHex } from '@/lib/bytes'
import { roundOf, type MultisigEnvelope, type MultisigMessageType } from './messages'

export const ENVELOPE_DOMAIN = 'noir/envelope/v1'
export const ENVELOPE_SIGNATURE_CONTEXT = 'NoirDeviceSig v1|noir.envelope.v1|'

export type EnvelopeHead = Omit<MultisigEnvelope, 'authentication_data'>

const encoder = new TextEncoder()

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length, false)
  out.set(bytes, 4)
  return out
}

export function envelopePayloadHash(encryptedPayload: string): string {
  return bytesToHex(sha256(encoder.encode(encryptedPayload)))
}

export function canonicalEnvelopeBytes(head: EnvelopeHead): Uint8Array {
  const fields = [
    String(head.protocol_version),
    head.message_type,
    head.group_id,
    head.session_id,
    head.sender_id,
    head.recipient_id,
    String(head.round),
    String(head.sequence),
    head.payload_hash
  ]
  return concatBytes([
    encoder.encode(ENVELOPE_DOMAIN),
    ...fields.map(field => lengthPrefixed(encoder.encode(field)))
  ])
}

function signedBytes(head: EnvelopeHead): Uint8Array<ArrayBuffer> {
  return concatBytes([encoder.encode(ENVELOPE_SIGNATURE_CONTEXT), canonicalEnvelopeBytes(head)])
}

export async function signEnvelope(
  signingKey: CryptoKey,
  head: Omit<EnvelopeHead, 'payload_hash'>,
  subtle: SubtleCrypto = crypto.subtle
): Promise<MultisigEnvelope> {
  // Built field by field in wire order so JSON output matches the mock factory byte for byte.
  const full: EnvelopeHead = {
    protocol_version: head.protocol_version,
    message_type: head.message_type,
    group_id: head.group_id,
    session_id: head.session_id,
    sender_id: head.sender_id,
    recipient_id: head.recipient_id,
    round: head.round,
    sequence: head.sequence,
    payload_hash: envelopePayloadHash(head.encrypted_payload),
    encrypted_payload: head.encrypted_payload
  }
  const signature = await subtle.sign({ name: 'Ed25519' }, signingKey, signedBytes(full))
  return { ...full, authentication_data: bytesToBase64(new Uint8Array(signature)) }
}

export async function verifyEnvelope(
  envelope: MultisigEnvelope,
  ed25519PublicKey: Uint8Array,
  subtle: SubtleCrypto = crypto.subtle
): Promise<boolean> {
  try {
    if (envelope.payload_hash !== envelopePayloadHash(envelope.encrypted_payload)) return false
    const key = await subtle.importKey(
      'raw',
      new Uint8Array(ed25519PublicKey),
      { name: 'Ed25519' },
      true,
      ['verify']
    )
    return await subtle.verify(
      { name: 'Ed25519' },
      key,
      new Uint8Array(base64ToBytes(envelope.authentication_data)),
      signedBytes(envelope)
    )
  } catch {
    return false
  }
}

export interface EnvelopeSigner {
  next(
    messageType: MultisigMessageType,
    recipientId: string,
    payload?: Record<string, unknown>
  ): Promise<MultisigEnvelope>
}

export function createEnvelopeSigner(input: {
  groupId: string
  sessionId: string
  senderId: string
  signingKey: CryptoKey
}): EnvelopeSigner {
  let sequence = 0
  return {
    next(messageType, recipientId, payload) {
      // Sequence is taken synchronously so concurrent calls never share a number.
      sequence += 1
      return signEnvelope(input.signingKey, {
        protocol_version: 1,
        message_type: messageType,
        group_id: input.groupId,
        session_id: input.sessionId,
        sender_id: input.senderId,
        recipient_id: recipientId,
        round: roundOf(messageType),
        sequence,
        encrypted_payload: JSON.stringify(payload ?? {})
      })
    }
  }
}
