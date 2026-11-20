import { test } from 'node:test'
import { expect } from '@playwright/test'
import { URDecoder } from '@ngraveio/bc-ur'
import {
  buildRestoreConfig,
  encodeGroupConfig,
  RestoreUnsupportedError,
  parseGroupConfig,
  GROUP_CONFIG_VERSION
} from '../../../src/core/multisig/recover-config'
import { bytesToBase64, bytesToHex } from '../../../src/lib/bytes'
import { createBytesUREncoder, decodeBytesUR } from '../../../src/lib/multisig-ur'
import { identityFromSeed } from './helpers/identity'

const UFVK = 'uviewtest1' + 'q'.repeat(150)

const extension = await identityFromSeed(new Uint8Array(32).fill(0x11))
const newPhone = await identityFromSeed(new Uint8Array(32).fill(0x33))

test('group config encodes and parses back, and refuses anything that is not exact', () => {
  const config = {
    publicKeyPackage: Uint8Array.from({ length: 70 }, (_, index) => index),
    ufvk: UFVK,
    fingerprint: Uint8Array.from({ length: 32 }, (_, index) => index * 3),
    roster: [
      { slot: 0, identityPublicKey: extension.publicKey, name: 'This browser' },
      { slot: 1, identityPublicKey: newPhone.publicKey, name: 'Mon téléphone' }
    ]
  }
  const bytes = encodeGroupConfig(config)
  expect(bytes[0]).toBe(GROUP_CONFIG_VERSION)
  const parsed = parseGroupConfig(bytes)
  expect(parsed?.ufvk).toBe(UFVK)
  expect(parsed?.roster[1].name).toBe('Mon téléphone')
  expect(Array.from(parsed!.publicKeyPackage)).toEqual(Array.from(config.publicKeyPackage))

  expect(parseGroupConfig(bytes.subarray(0, bytes.length - 1))).toBeNull()
  expect(parseGroupConfig(Uint8Array.from([...bytes, 0]))).toBeNull()
  expect(parseGroupConfig(Uint8Array.from([1, ...bytes.subarray(1)]))).toBeNull()
  expect(() =>
    encodeGroupConfig({ ...config, roster: [config.roster[0], config.roster[0]] })
  ).toThrow()
  expect(() => encodeGroupConfig({ ...config, fingerprint: new Uint8Array(31) })).toThrow()
})

test('a name longer than 255 bytes is cut at a character boundary', () => {
  const longName = '€'.repeat(100) // 300 bytes
  const bytes = encodeGroupConfig({
    publicKeyPackage: new Uint8Array(4).fill(1),
    ufvk: 'uview1abc',
    fingerprint: new Uint8Array(32),
    roster: [
      { slot: 0, identityPublicKey: extension.publicKey, name: longName },
      { slot: 1, identityPublicKey: newPhone.publicKey, name: 'p' }
    ]
  })
  const name = parseGroupConfig(bytes)!.roster[0].name
  expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255)
  expect(name).toBe('€'.repeat(85))
})

// Built by an independent Python script and parsed by the iOS tests (KGGroupConfigInteropTests), so
// the two ends agree on the bytes of the version 2 group config.
const INTEROP_VECTOR =
  '020a00000102030405060708090d0075766965777465737431616263000306090c0f1215181b1e2124272a2d303336393c3f4245484b4e5154575a5d020001111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111110742726f777365720101222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222220b54c3a96cc3a970686f6e65'

test('group config is byte-identical to the vector the iOS side parses', () => {
  const identity = (byte: number) => Uint8Array.of(1, ...new Uint8Array(64).fill(byte))
  const bytes = encodeGroupConfig({
    publicKeyPackage: Uint8Array.from({ length: 10 }, (_, index) => index),
    ufvk: 'uviewtest1abc',
    fingerprint: Uint8Array.from({ length: 32 }, (_, index) => (index * 3) % 256),
    roster: [
      { slot: 0, identityPublicKey: identity(0x11), name: 'Browser' },
      { slot: 1, identityPublicKey: identity(0x22), name: 'Téléphone' }
    ]
  })
  expect(bytesToHex(bytes)).toBe(INTEROP_VECTOR)
})

const RESTORE_INTEROP_VECTOR =
  '020a00000102030405060708090d007576696577746573743161626301060b10151a1f24292e33383d42474c51565b60656a6f74797e83888d92979c020001111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111110c546869732062726f77736572010100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000094d79206950686f6e65'

// The identity the restored phone sent in its request. The interop vector below carries it as is.
const PHONE_IDENTITY = Uint8Array.of(1, ...new Uint8Array(64))

function restoreInput(overrides: Partial<Parameters<typeof buildRestoreConfig>[0]> = {}) {
  return {
    publicKeyPackage: bytesToBase64(Uint8Array.from({ length: 10 }, (_, index) => index)),
    ufvk: 'uviewtest1abc',
    fingerprint: bytesToHex(Uint8Array.from({ length: 32 }, (_, index) => (index * 5 + 1) % 256)),
    participants: 2,
    owner: {
      identityPublicKey: Uint8Array.of(1, ...new Uint8Array(64).fill(0x11)),
      name: 'This browser'
    },
    phoneName: 'My iPhone',
    phoneIdentityPublicKey: PHONE_IDENTITY,
    ...overrides
  }
}

test('the restore config puts the extension and the phone from its request in the roster', () => {
  const bytes = buildRestoreConfig(restoreInput())
  const parsed = parseGroupConfig(bytes)!
  expect(parsed.roster.map(member => [member.slot, member.name])).toEqual([
    [0, 'This browser'],
    [1, 'My iPhone']
  ])
  expect(Array.from(parsed.roster[0].identityPublicKey)).toEqual(
    Array.from(Uint8Array.of(1, ...new Uint8Array(64).fill(0x11)))
  )
  expect(Array.from(parsed.roster[1].identityPublicKey)).toEqual(Array.from(PHONE_IDENTITY))
})

test('the restore config is byte-identical to the vector the iOS side parses', () => {
  expect(bytesToHex(buildRestoreConfig(restoreInput()))).toBe(RESTORE_INTEROP_VECTOR)
})

test('only 2-of-2 groups can be restored, and a bad fingerprint is refused', () => {
  expect(() => buildRestoreConfig(restoreInput({ participants: 3 }))).toThrow(
    RestoreUnsupportedError
  )
  expect(() => buildRestoreConfig(restoreInput({ fingerprint: 'AB'.repeat(32) }))).toThrow()
})

test('the config survives being shown as a ur:bytes QR and scanned back', () => {
  const bytes = buildRestoreConfig(restoreInput())
  // A small fragment size forces several frames, so a broken multipart path cannot pass unnoticed.
  const encoder = createBytesUREncoder(bytes, 60)
  expect(encoder.fragmentsLength).toBeGreaterThan(1)
  const decoder = new URDecoder()
  for (let i = 0; i < encoder.fragmentsLength * 3 && !decoder.isComplete(); i++) {
    // The page shows frames in upper case; the scanner lower-cases them again.
    decoder.receivePart(encoder.nextPart().toUpperCase().toLowerCase())
  }
  expect(decoder.isSuccess()).toBe(true)
  const scanned = decodeBytesUR(decoder.resultUR())
  expect(scanned && Array.from(scanned)).toEqual(Array.from(bytes))
  expect(parseGroupConfig(scanned!)).not.toBeNull()
  expect(() => createBytesUREncoder(new Uint8Array(0))).toThrow()
})
