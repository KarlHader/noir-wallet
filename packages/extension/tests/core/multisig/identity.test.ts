import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  generateDeviceIdentity,
  identityFingerprint,
  loadOrCreateDeviceIdentity,
  parseIdentityPublicKey
} from '../../../src/core/multisig/identity'
import { bytesToBase64, bytesToHex, hexToBytes } from '../../../src/lib/bytes'
import { SPEC_SEED, createMemoryIdentityStore, identityFromSeed } from './helpers/identity'

const EXAMPLE_ED = '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8'

function concat(...parts: ArrayLike<number>[]): Uint8Array {
  return Uint8Array.from(parts.flatMap(part => Array.from(part)))
}

const exampleKey = concat([1], hexToBytes(EXAMPLE_ED), new Uint8Array(32))

test.describe('multisig device identity', () => {
  test('parses the 65-byte identity and refuses other shapes', () => {
    const parsed = parseIdentityPublicKey(bytesToBase64(exampleKey))
    expect(bytesToHex(parsed!.ed25519)).toBe(EXAMPLE_ED)
    expect(parsed!.x25519.every(b => b === 0)).toBe(true)
    expect(parseIdentityPublicKey(exampleKey.subarray(0, 64))).toBeNull()
    expect(parseIdentityPublicKey(concat([2], exampleKey.subarray(1)))).toBeNull()
    expect(parseIdentityPublicKey('not base64!')).toBeNull()
  })

  test('fingerprint matches the spec example', () => {
    expect(identityFingerprint(exampleKey)).toBe(
      'EDB4 3389 3891 10F3 E030 1E59 F4B7 51EE 6FAF DB5B'
    )
  })

  test('generates a 65-byte identity with non-extractable keys', async () => {
    const identity = await generateDeviceIdentity()
    expect(identity.publicKey.length).toBe(65)
    expect(identity.publicKey[0]).toBe(1)
    expect(identity.signingKeys.privateKey.extractable).toBe(false)
    expect(identity.agreementKeys.privateKey.extractable).toBe(false)
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', identity.signingKeys.publicKey))
    expect(bytesToHex(raw)).toBe(bytesToHex(identity.publicKey.subarray(1, 33)))
  })

  test('loadOrCreate creates once and reuses', async () => {
    const store = createMemoryIdentityStore()
    let created = 0
    const first = await loadOrCreateDeviceIdentity(store, undefined, () => (created += 1))
    const second = await loadOrCreateDeviceIdentity(store, undefined, () => (created += 1))
    expect(bytesToHex(second.publicKey)).toBe(bytesToHex(first.publicKey))
    expect(store.saves).toBe(1)
    expect(created).toBe(1)
  })

  test('identityFromSeed reproduces the spec public key', async () => {
    const identity = await identityFromSeed(SPEC_SEED)
    expect(bytesToHex(identity.publicKey.subarray(1, 33))).toBe(EXAMPLE_ED)
  })
})
