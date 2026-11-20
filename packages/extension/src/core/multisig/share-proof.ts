/**
 * Verifies a "holds this share" proof made by the phone (iOS `share_scalar_prove`).
 *
 * The proof is a plain RedPallas (SpendAuth) signature made with the 32-word share scalar `s`,
 * checked against the share's public verifying value `V = s·G` — the same value the FROST public
 * key package lists for that slot. The signed bytes are `DOMAIN ‖ message`.
 *
 * RedPallas verification (Zcash protocol 5.4.7): `c = H*(R ‖ vk ‖ m)` with BLAKE2b-512 personalised
 * "Zcash_RedPallasH" reduced mod q, and the signature `(R, s)` is valid when `[s]G = R + [c]vk`.
 * Points use pasta_curves' 32-byte compression: x little-endian, bit 7 of the last byte is the
 * parity of y.
 */
import { blake2b } from '@noble/hashes/blake2b'
import { pallas } from '@noble/curves/misc'

export const SHARE_PROOF_DOMAIN = 'noir/share-proof/v1'
export const VERIFYING_SHARE_BYTES = 32
export const SHARE_PROOF_SIGNATURE_BYTES = 64

/** The SpendAuth base point G (the verifying value of scalar 1), compressed. */
const SPEND_AUTH_BASEPOINT = Uint8Array.from(
  '63c975b884721a8d0ca1707be30c7f0c5f445f3e7c188d3b06d6f128b32355b7'
    .match(/../g)!
    .map(pair => parseInt(pair, 16))
)
const CHALLENGE_PERSONALIZATION = new TextEncoder().encode('Zcash_RedPallasH')

type Point = InstanceType<typeof pallas.ProjectivePoint>

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index])
  }
  return value
}

/** Null for anything that is not a canonical, non-identity curve point. */
function decompress(bytes: Uint8Array): Point | null {
  if (bytes.length !== 32) return null
  const odd = (bytes[31] & 0x80) !== 0
  const x = Uint8Array.from(bytes)
  x[31] &= 0x7f
  const beX = x.reverse()
  const hex =
    (odd ? '03' : '02') + Array.from(beX, byte => byte.toString(16).padStart(2, '0')).join('')
  try {
    const point = pallas.ProjectivePoint.fromHex(hex)
    point.assertValidity()
    // The identity encodes as all zeros and is not a usable key or nonce commitment.
    return point.equals(pallas.ProjectivePoint.ZERO) ? null : point
  } catch {
    return null
  }
}

/** True only for a valid signature by the holder of the scalar behind `verifyingShare`. */
export function verifyShareProof(
  verifyingShare: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  if (verifyingShare.length !== VERIFYING_SHARE_BYTES) return false
  if (signature.length !== SHARE_PROOF_SIGNATURE_BYTES) return false
  const order = pallas.CURVE.n
  const rBytes = signature.subarray(0, 32)
  const s = littleEndianToBigInt(signature.subarray(32))
  if (s === 0n || s >= order) return false
  const commitment = decompress(rBytes)
  const key = decompress(verifyingShare)
  const base = decompress(SPEND_AUTH_BASEPOINT)
  if (!commitment || !key || !base) return false

  const signed = new Uint8Array([...new TextEncoder().encode(SHARE_PROOF_DOMAIN), ...message])
  const hash = blake2b(new Uint8Array([...rBytes, ...verifyingShare, ...signed]), {
    dkLen: 64,
    personalization: CHALLENGE_PERSONALIZATION
  })
  const challenge = littleEndianToBigInt(hash) % order
  try {
    const left = base.multiply(s)
    const right = challenge === 0n ? commitment : commitment.add(key.multiply(challenge))
    return left.equals(right)
  } catch {
    return false
  }
}
