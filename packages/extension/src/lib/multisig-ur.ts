/**
 * BC-UR codec for FROST multisig message envelopes.
 *
 * The extension shows an envelope as an animated multi-part QR and scans the
 * phone's reply with the existing camera scanner, so both directions use the
 * same framing: UTF-8 JSON of the envelope, wrapped in a bare CBOR byte string,
 * carried as `ur:bytes`.
 */

// Must come first: installs the global Buffer required by the UR libraries.
// Imported from @ngraveio/bc-ur directly (not via @/lib/keystone/ur) so the
// multisig chunk does not pull in the Keystone registry packages.
import '@/lib/buffer-polyfill'
import { Buffer } from 'buffer'
import { UR, UREncoder } from '@ngraveio/bc-ur'
import { parseEnvelope, type MultisigEnvelope } from '@/core/multisig/messages'

/**
 * `bytes` is the registry-free UR type for an opaque byte string. The envelope
 * is already a self-describing, versioned JSON document, so a dedicated UR type
 * would only add a registry entry that both phone apps must also implement.
 */
export const MULTISIG_UR_TYPE = 'bytes'

/** Matches the Keystone fragment size: denser frames scan unreliably off a screen. */
export const MULTISIG_UR_FRAGMENT_LENGTH = 200

/**
 * CBOR-encode `bytes` as a bare byte string (major type 2) by hand.
 *
 * `UR.fromBuffer()` and the registry classes route through the library's bundled
 * cbor encoder, which emits a byte string only when the payload is `instanceof`
 * *its* copy of `Buffer`. Under Vite the library and the app resolve different
 * `buffer` modules, so that check can fail and the value silently degrades to a
 * `{type:'Buffer', data:[...]}` map, which the phone cannot parse. Writing the
 * header ourselves is bundler-independent (same approach as the Keystone PCZT
 * encoder in lib/keystone/ur.ts).
 */
export function encodeCborByteString(bytes: Uint8Array): Buffer {
  const len = bytes.length
  let header: number[]
  if (len < 0x18) {
    header = [0x40 | len]
  } else if (len < 0x100) {
    header = [0x58, len]
  } else if (len < 0x10000) {
    header = [0x59, (len >> 8) & 0xff, len & 0xff]
  } else {
    header = [0x5a, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]
  }
  return Buffer.concat([Buffer.from(header), Buffer.from(bytes)])
}

/**
 * Read a CBOR byte string that spans the whole input. Returns null for any other
 * major type, an unsupported length form (8-byte or indefinite) or a declared
 * length that does not match the remaining bytes, so a truncated or padded
 * frame is never accepted as a shorter or longer message.
 */
export function decodeCborByteString(cbor: Buffer): Uint8Array | null {
  if (cbor.length === 0 || cbor[0] >> 5 !== 2) return null
  const additionalInfo = cbor[0] & 0x1f
  let length: number
  let offset: number
  if (additionalInfo < 24) {
    length = additionalInfo
    offset = 1
  } else if (additionalInfo === 24 && cbor.length >= 2) {
    length = cbor[1]
    offset = 2
  } else if (additionalInfo === 25 && cbor.length >= 3) {
    length = (cbor[1] << 8) | cbor[2]
    offset = 3
  } else if (additionalInfo === 26 && cbor.length >= 5) {
    // Multiplication rather than `<< 24`, which would turn lengths >= 2^31 negative.
    length = cbor[1] * 0x1000000 + ((cbor[2] << 16) | (cbor[3] << 8) | cbor[4])
    offset = 5
  } else {
    return null
  }
  if (cbor.length - offset !== length) return null
  return new Uint8Array(cbor.subarray(offset))
}

/** One code carries at most this many envelopes (a 3-party round fans out to 2 peers plus slack). */
export const MAX_ENVELOPES_PER_CODE = 8

/** One envelope is a JSON object, as before; 2 to 8 are a JSON array. */
export function encodeEnvelopesUR(envelopes: readonly MultisigEnvelope[]): UR {
  if (envelopes.length < 1 || envelopes.length > MAX_ENVELOPES_PER_CODE) {
    throw new RangeError(`a code carries 1 to ${MAX_ENVELOPES_PER_CODE} envelopes`)
  }
  const value = envelopes.length === 1 ? envelopes[0] : envelopes
  const json = new TextEncoder().encode(JSON.stringify(value))
  return new UR(encodeCborByteString(json), MULTISIG_UR_TYPE)
}

export function encodeEnvelopeUR(envelope: MultisigEnvelope): UR {
  return encodeEnvelopesUR([envelope])
}

export function createEnvelopesUREncoder(
  envelopes: readonly MultisigEnvelope[],
  maxFragmentLength: number = MULTISIG_UR_FRAGMENT_LENGTH
): UREncoder {
  return new UREncoder(encodeEnvelopesUR(envelopes), maxFragmentLength)
}

export function createEnvelopeUREncoder(
  envelope: MultisigEnvelope,
  maxFragmentLength: number = MULTISIG_UR_FRAGMENT_LENGTH
): UREncoder {
  return createEnvelopesUREncoder([envelope], maxFragmentLength)
}

/** Recovery uses the same opaque ur:bytes framing as the phone. */
export function createBytesUREncoder(
  bytes: Uint8Array,
  maxFragmentLength = MULTISIG_UR_FRAGMENT_LENGTH
): UREncoder {
  if (bytes.length === 0) throw new RangeError('A code carries at least one byte')
  return new UREncoder(new UR(encodeCborByteString(bytes), MULTISIG_UR_TYPE), maxFragmentLength)
}

export function decodeBytesUR(ur: UR): Uint8Array | null {
  return ur.type === MULTISIG_UR_TYPE ? decodeCborByteString(ur.cbor) : null
}

/**
 * Decode a scanned UR back into an envelope. Scanned QR content is untrusted, so
 * every failure (wrong UR type, not a byte string, invalid UTF-8 or JSON, not an
 * envelope) yields null instead of throwing.
 */
export function decodeEnvelopeUR(ur: UR): MultisigEnvelope | null {
  if (ur.type !== MULTISIG_UR_TYPE) return null
  const bytes = decodeCborByteString(ur.cbor)
  if (!bytes) return null
  try {
    // fatal: invalid UTF-8 must fail here rather than become U+FFFD replacement text.
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return parseEnvelope(JSON.parse(json))
  } catch {
    return null
  }
}
