import { sha256 } from '@noble/hashes/sha2'

const SAS_LABEL = new TextEncoder().encode('noir.transport.sas.v1')
const SAS_DIGITS = 8

/**
 * The pairing code both screens show after the Noise handshake. The user compares the two; if
 * they differ, someone is in the middle and the pairing must be abandoned.
 */
export function pairingSas(handshakeHash: Uint8Array): string {
  const input = new Uint8Array(SAS_LABEL.length + handshakeHash.length)
  input.set(SAS_LABEL)
  input.set(handshakeHash, SAS_LABEL.length)
  const digest = sha256(input)
  const value = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0, false)
  return (value % 10n ** BigInt(SAS_DIGITS)).toString().padStart(SAS_DIGITS, '0')
}
