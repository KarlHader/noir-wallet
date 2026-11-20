import { test } from 'node:test'
import { expect } from '@playwright/test'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { DkgCoordinatorSession } from '../../../src/core/multisig/dkg-coordinator'
import { TEST_MNEMONIC, loadVaultWasm } from './helpers/vault-wasm'
import {
  checkRecoverRequest,
  parseRecoverRequest,
  sealRecoverReply,
  slotOfVerifyingShare
} from '../../../src/core/multisig/recover-handshake'

/** The phone's side (iOS `KGRecoverRequest.open`): opens a reply with the request's ephemeral secret. */
async function openRecoverReply(
  requestBytes: Uint8Array,
  ephemeralSecret: Uint8Array,
  reply: Uint8Array
): Promise<Uint8Array | null> {
  const headerLength = 1 + 32
  const nonceLength = 12
  if (reply.length < headerLength + nonceLength + 16 || reply[0] !== 1) return null
  try {
    const shared = x25519.getSharedSecret(ephemeralSecret, reply.slice(1, headerLength))
    const raw = hkdf(
      sha256,
      shared,
      sha256(requestBytes),
      new TextEncoder().encode('noir/recover-reply/v1'),
      32
    )
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: reply.slice(headerLength, headerLength + nonceLength),
          additionalData: reply.slice(0, headerLength),
          tagLength: 128
        },
        key,
        reply.slice(headerLength + nonceLength)
      )
    )
  } catch {
    return null
  }
}

const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map(pair => parseInt(pair, 16)))

// A 2-of-2 key package and a request the iOS core made for slot 1 (`share_proof_vector`), issued at
// 1_700_000_000 with identity 0x01 ‖ 0x22…, ephemeral key 0x33….
const PUBLIC_KEY_PACKAGE = hex(
  '00ffbdabd20201000000000000000000000000000000000000000000000000000000000000005828c83d42c0949d8adb20dc3584d6fdb48417826fe8de2efb70445a72beacb60200000000000000000000000000000000000000000000000000000000000000629208349e50fd3c5f5cc6d24aa7528e4e8b969d0481fcf4f4d5f48e0213300009bc57a70e61ca4b46272c0bb1f219b24638d4cd8734f467669aa35287c4e01a0102'
)
const REQUEST = hex(
  '01629208349e50fd3c5f5cc6d24aa7528e4e8b969d0481fcf4f4d5f48e0213300001222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222223333333333333333333333333333333333333333333333333333333333333333000000006553f100ac30e63dfd7085a32f81f6ddb0813a6831bee5b3fcde430c34d913eba54f77996f876f7fc180865589bad9d547a34c0911907f46bb55e89029dad605e0720e1f'
)
const ISSUED_AT = 1_700_000_000

const options = {
  publicKeyPackage: PUBLIC_KEY_PACKAGE,
  nowSeconds: ISSUED_AT + 30,
  expectedSlot: 1
}

test('accepts the phone request made by the core and reads its fields', () => {
  const checked = checkRecoverRequest(REQUEST, options)
  expect(checked.ok).toBe(true)
  if (!checked.ok) return
  expect(checked.slot).toBe(1)
  expect(checked.request.issuedAt).toBe(ISSUED_AT)
  expect(checked.request.ephemeralKey).toEqual(new Uint8Array(32).fill(0x33))
  expect(checked.request.identityPublicKey[0]).toBe(1)
})

test('finds the slot of a verifying share in the public key package', () => {
  const request = parseRecoverRequest(REQUEST)!
  expect(slotOfVerifyingShare(PUBLIC_KEY_PACKAGE, request.verifyingShare)).toBe(1)
  expect(slotOfVerifyingShare(PUBLIC_KEY_PACKAGE, new Uint8Array(32).fill(7))).toBeNull()
})

test('finds the phone share in a package produced by the current wallet WASM', async () => {
  const wasm = await loadVaultWasm()
  const session = DkgCoordinatorSession.open(
    wasm,
    { participants: 2, threshold: 2, mainnet: false, walletId: 'wallet', groupId: 'group' },
    () => TEST_MNEMONIC
  )
  try {
    const phone = new wasm.Dkg(2, 2, 1, session.sessionId)
    const part1 = phone.part1()
    const round1 = await session.acceptRound1(1, part1.broadcast_envelope(session.sessionId, 1, 1))
    if (!round1.complete) throw new Error('Expected round 1')
    const broadcasts = wasm.MessageSet.from_bytes(
      wasm.EnvelopeCodec.decode(round1.bundles.get(1)!)[6] as Uint8Array
    )
    const part2 = phone.part2(part1.secret(), broadcasts)
    const round2 = await session.acceptRound2(1, part2.outgoing_envelope(session.sessionId, 2, 1))
    if (!round2.complete) throw new Error('Expected round 2')
    const incoming = wasm.MessageSet.from_bytes(
      wasm.EnvelopeCodec.decode(round2.inboxes.get(1)!)[6] as Uint8Array
    )
    const part3 = phone.part3(part2.secret(), broadcasts, incoming)
    const packageBytes = part3.public_key_package()
    const phoneVerifyingShare = packageBytes.slice(6 + 64 + 32, 6 + 128)
    expect(packageBytes).toHaveLength(PUBLIC_KEY_PACKAGE.length)
    expect(slotOfVerifyingShare(packageBytes, phoneVerifyingShare)).toBe(1)
  } finally {
    session.close()
  }
})

test('does not mistake bytes outside a declared participant for a verifying share', () => {
  const request = parseRecoverRequest(REQUEST)!
  const hostile = Uint8Array.from([
    ...PUBLIC_KEY_PACKAGE,
    2,
    ...new Uint8Array(31),
    ...request.verifyingShare
  ])
  // Replace the real member share, then append a plausible identifier and share outside the package.
  hostile.fill(0, 102, 134)
  expect(slotOfVerifyingShare(hostile, request.verifyingShare)).toBeNull()
  expect(slotOfVerifyingShare(PUBLIC_KEY_PACKAGE.slice(0, -1), request.verifyingShare)).toBeNull()
})

test('rejects invalid local time rather than treating the request as current', () => {
  for (const nowSeconds of [NaN, Infinity, -Infinity, -1, ISSUED_AT + 0.5]) {
    expect(checkRecoverRequest(REQUEST, { ...options, nowSeconds })).toEqual({
      ok: false,
      reason: 'stale'
    })
  }
})

test('refuses a request that is stale, for another wallet, for the browser slot or tampered', () => {
  expect(checkRecoverRequest(REQUEST, { ...options, nowSeconds: ISSUED_AT + 601 })).toEqual({
    ok: false,
    reason: 'stale'
  })
  expect(checkRecoverRequest(REQUEST, { ...options, nowSeconds: ISSUED_AT - 601 })).toEqual({
    ok: false,
    reason: 'stale'
  })
  expect(checkRecoverRequest(REQUEST, { ...options, expectedSlot: 0 })).toEqual({
    ok: false,
    reason: 'wrong-device'
  })
  expect(
    checkRecoverRequest(REQUEST, {
      ...options,
      publicKeyPackage: new Uint8Array(PUBLIC_KEY_PACKAGE).fill(1, 40)
    })
  ).toEqual({ ok: false, reason: 'not-this-wallet' })
  expect(checkRecoverRequest(REQUEST.slice(0, 200), options)).toEqual({
    ok: false,
    reason: 'format'
  })

  // Swapping the identity (bytes 33...97) without the share cannot be signed.
  const swapped = REQUEST.slice()
  swapped[40] ^= 1
  expect(checkRecoverRequest(swapped, options)).toEqual({ ok: false, reason: 'proof' })
  // Neither can the throwaway key or the time.
  const rekeyed = REQUEST.slice()
  rekeyed[100] ^= 1
  expect(checkRecoverRequest(rekeyed, options)).toEqual({ ok: false, reason: 'proof' })
})

test('the reply opens only for the phone that made the request', async () => {
  const secret = x25519.utils.randomPrivateKey()
  const request = REQUEST.slice()
  request.set(x25519.getPublicKey(secret), 1 + 32 + 65)
  const config = Uint8Array.from({ length: 300 }, (_, index) => index % 251)

  const reply = await sealRecoverReply(request, config)
  expect(await openRecoverReply(request, secret, reply)).toEqual(config)

  // A reply is bound to its request, to the key and to its own bytes.
  const other = request.slice()
  other[1] ^= 1
  expect(await openRecoverReply(other, secret, reply)).toBeNull()
  expect(await openRecoverReply(request, x25519.utils.randomPrivateKey(), reply)).toBeNull()
  const flipped = reply.slice()
  flipped[flipped.length - 1] ^= 1
  expect(await openRecoverReply(request, secret, flipped)).toBeNull()
  expect(await openRecoverReply(request, secret, reply.slice(0, 40))).toBeNull()
})
