/**
 * The two messages of restoring a reinstalled phone over QR (iOS `KGRecoverHandshake`).
 *
 * 1. Request, phone → extension. Proves the phone holds the share behind its 32 words and tells
 *    the extension the phone's fresh device identity and a throwaway key to answer to:
 *
 *      version(1)=1 ‖ verifyingShare(32) ‖ identityPublicKey(65) ‖ ephemeralKey(32, X25519)
 *        ‖ issuedAt(8, big-endian Unix seconds) ‖ signature(64)
 *
 *    `signature` is a RedPallas signature made with the share scalar (`share-proof.ts`) over
 *    `"noir/recover-request/v1" ‖ version ‖ identityPublicKey ‖ ephemeralKey ‖ issuedAt`, so the
 *    identity cannot be swapped by someone who does not hold the share.
 *
 * 2. Reply, extension → phone. The group config (`recover-config.ts`), encrypted so a camera
 *    that sees the screen cannot read the viewing key:
 *
 *      version(1)=1 ‖ ephemeralKey(32, X25519) ‖ nonce(12) ‖ AES-256-GCM(config) ‖ tag(16)
 *
 *    The key is HKDF-SHA256 of the X25519 secret with salt `SHA-256(request bytes)`, so a reply
 *    only opens for the request it answers. The additional data is `version ‖ ephemeralKey`.
 */
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { IDENTITY_PUBLIC_KEY_BYTES, IDENTITY_VERSION_BYTE } from './identity'
import { verifyShareProof } from './share-proof'

export const RECOVER_REQUEST_VERSION = 1
export const RECOVER_REPLY_VERSION = 1
export const RECOVER_REQUEST_PURPOSE = 'noir/recover-request/v1'
const REPLY_KEY_INFO = 'noir/recover-reply/v1'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const SIGNATURE_BYTES = 64
const ISSUED_AT_BYTES = 8
const REQUEST_BYTES =
  1 + KEY_BYTES + IDENTITY_PUBLIC_KEY_BYTES + KEY_BYTES + ISSUED_AT_BYTES + SIGNATURE_BYTES

/** How far the phone's clock may be from this one before the request counts as stale or forged. */
export const RECOVER_REQUEST_MAX_SKEW_SECONDS = 600
const PUBLIC_KEY_PACKAGE_PREFIX = Uint8Array.of(0, 0xff, 0xbd, 0xab, 0xd2)
const PUBLIC_KEY_PACKAGE_MEMBER_BYTES = 2 * KEY_BYTES
const PUBLIC_KEY_PACKAGE_TRAILER_BYTES = KEY_BYTES + 2

export type RecoverRequest = {
  verifyingShare: Uint8Array
  identityPublicKey: Uint8Array
  ephemeralKey: Uint8Array
  issuedAt: number
  signature: Uint8Array
}

const encoder = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function secondsBytes(seconds: number): Uint8Array {
  const out = new Uint8Array(ISSUED_AT_BYTES)
  new DataView(out.buffer).setBigUint64(0, BigInt(seconds))
  return out
}

/** Strict, like the phone: any other length or version is refused. */
export function parseRecoverRequest(bytes: Uint8Array): RecoverRequest | null {
  if (bytes.length !== REQUEST_BYTES || bytes[0] !== RECOVER_REQUEST_VERSION) return null
  let offset = 1
  const take = (length: number) => {
    const out = bytes.slice(offset, offset + length)
    offset += length
    return out
  }
  const verifyingShare = take(KEY_BYTES)
  const identityPublicKey = take(IDENTITY_PUBLIC_KEY_BYTES)
  const ephemeralKey = take(KEY_BYTES)
  const issuedAtBytes = take(ISSUED_AT_BYTES)
  const signature = take(SIGNATURE_BYTES)
  if (identityPublicKey[0] !== IDENTITY_VERSION_BYTE) return null
  const issuedAt = new DataView(issuedAtBytes.buffer).getBigUint64(0)
  if (issuedAt > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return {
    verifyingShare,
    identityPublicKey,
    ephemeralKey,
    issuedAt: Number(issuedAt),
    signature
  }
}

/** What the phone signed. */
export function recoverRequestSignedBytes(request: RecoverRequest): Uint8Array {
  return concat(
    encoder.encode(RECOVER_REQUEST_PURPOSE),
    Uint8Array.of(RECOVER_REQUEST_VERSION),
    request.identityPublicKey,
    request.ephemeralKey,
    secondsBytes(request.issuedAt)
  )
}

/**
 * The roster slot (0-based, as in the key package) whose verifying share is `verifyingShare`, or
 * null when no slot has it. The serialized package has a five-byte header, a participant count,
 * fixed-size identifier/share pairs, and a 34-byte group-key trailer. Only declared pairs count;
 * scanning arbitrary offsets could mistake attacker-controlled bytes for a member.
 */
export function slotOfVerifyingShare(
  publicKeyPackage: Uint8Array,
  verifyingShare: Uint8Array
): number | null {
  if (verifyingShare.length !== KEY_BYTES) return null
  if (!PUBLIC_KEY_PACKAGE_PREFIX.every((byte, index) => publicKeyPackage[index] === byte))
    return null
  const count = publicKeyPackage[PUBLIC_KEY_PACKAGE_PREFIX.length]
  if (count !== 2 && count !== 3) return null
  const firstMember = PUBLIC_KEY_PACKAGE_PREFIX.length + 1
  if (
    publicKeyPackage.length !==
    firstMember + count * PUBLIC_KEY_PACKAGE_MEMBER_BYTES + PUBLIC_KEY_PACKAGE_TRAILER_BYTES
  )
    return null
  const slots = new Set<number>()
  let matched: number | null = null
  for (let member = 0; member < count; member += 1) {
    const identifierStart = firstMember + member * PUBLIC_KEY_PACKAGE_MEMBER_BYTES
    const identifier = publicKeyPackage.subarray(identifierStart, identifierStart + KEY_BYTES)
    if (
      identifier[0] < 1 ||
      identifier[0] > count ||
      !identifier.subarray(1).every(byte => byte === 0)
    ) {
      return null
    }
    const slot = identifier[0] - 1
    if (slots.has(slot)) return null
    slots.add(slot)
    const offset = identifierStart + KEY_BYTES
    let same = true
    for (let index = 0; index < KEY_BYTES; index += 1) {
      if (publicKeyPackage[offset + index] !== verifyingShare[index]) {
        same = false
        break
      }
    }
    if (same) matched = slot
  }
  return matched
}

export type RecoverRequestCheck =
  | { ok: true; request: RecoverRequest; slot: number }
  | { ok: false; reason: 'format' | 'stale' | 'not-this-wallet' | 'wrong-device' | 'proof' }

/**
 * Whether the scanned bytes are a request from a phone that holds a share of this wallet.
 *
 * @param expectedSlot The slot the restored phone must hold (1 for a 2-of-2: slot 0 is this browser).
 */
export function checkRecoverRequest(
  bytes: Uint8Array,
  options: { publicKeyPackage: Uint8Array; nowSeconds: number; expectedSlot: number }
): RecoverRequestCheck {
  const request = parseRecoverRequest(bytes)
  if (!request) return { ok: false, reason: 'format' }
  if (!Number.isSafeInteger(options.nowSeconds) || options.nowSeconds < 0) {
    return { ok: false, reason: 'stale' }
  }
  if (Math.abs(options.nowSeconds - request.issuedAt) > RECOVER_REQUEST_MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'stale' }
  }
  const slot = slotOfVerifyingShare(options.publicKeyPackage, request.verifyingShare)
  if (slot === null) return { ok: false, reason: 'not-this-wallet' }
  if (slot !== options.expectedSlot) return { ok: false, reason: 'wrong-device' }
  if (
    !verifyShareProof(request.verifyingShare, recoverRequestSignedBytes(request), request.signature)
  ) {
    return { ok: false, reason: 'proof' }
  }
  return { ok: true, request, slot }
}

async function replyKey(sharedSecret: Uint8Array, requestBytes: Uint8Array): Promise<CryptoKey> {
  const raw = hkdf(sha256, sharedSecret, sha256(requestBytes), encoder.encode(REPLY_KEY_INFO), 32)
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, [
    'encrypt',
    'decrypt'
  ])
}

/** Encrypts `config` so only the phone that made `requestBytes` can read it. */
export async function sealRecoverReply(
  requestBytes: Uint8Array,
  config: Uint8Array
): Promise<Uint8Array> {
  const request = parseRecoverRequest(requestBytes)
  if (!request) throw new Error('Invalid recovery request')
  const secret = x25519.utils.randomPrivateKey()
  const publicKey = x25519.getPublicKey(secret)
  const key = await replyKey(x25519.getSharedSecret(secret, request.ephemeralKey), requestBytes)
  const nonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(NONCE_BYTES)))
  const header = concat(Uint8Array.of(RECOVER_REPLY_VERSION), publicKey)
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: GCM_TAG_BYTES * 8 },
      key,
      new Uint8Array(config)
    )
  )
  return concat(header, nonce, sealed)
}
