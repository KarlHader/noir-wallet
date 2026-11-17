import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  QR_TRANSPORT_PUBLIC_KEY,
  ROSTER_CIPHERSUITE,
  buildRoster,
  parseRosterManifest,
  rosterCanonicalBytes,
  rosterHash
} from '../../../src/core/multisig/roster'
import { bytesToBase64, bytesToHex } from '../../../src/lib/bytes'

const GROUP = '11111111-2222-4333-8444-555555555555'
const fill = (length: number, value: number) => new Uint8Array(length).fill(value)
const concat = (parts: ArrayLike<number>[]) => Uint8Array.from(parts.flatMap(part => [...part]))
const ID = (s: number) => bytesToBase64(concat([[1], fill(32, 0xa0 + s), fill(32, 0xb0 + s)]))
const TR = (s: number) => bytesToBase64(fill(32, 0xc0 + s))
const base = {
  groupId: GROUP,
  protocolVersion: 1,
  ciphersuite: ROSTER_CIPHERSUITE,
  threshold: 2
} as const
const HASH_B = '6fda07956a4bec07c197095857ce4f83a97aa42cdbd37f922b51dc282aa0ac0a'

function vectorB() {
  return {
    ...base,
    participants: [0, 1].map(s => ({
      slot: s,
      identityPublicKey: ID(s),
      transportPublicKey: QR_TRANSPORT_PUBLIC_KEY
    }))
  }
}

test.describe('multisig roster', () => {
  test('vector A: three devices over Bluetooth', () => {
    const manifest = {
      ...base,
      participants: [0, 1, 2].map(s => ({
        slot: s,
        identityPublicKey: ID(s),
        transportPublicKey: TR(s)
      }))
    }
    expect(ID(0)).toBe(
      'AaCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLA='
    )
    expect(TR(2)).toBe('wsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsI=')
    const canonical = rosterCanonicalBytes(manifest)
    expect(canonical.length).toBe(430)
    expect(bytesToHex(canonical).startsWith('6e6f69722f726f737465722f76310000002431313131')).toBe(
      true
    )
    expect(rosterHash(manifest)).toBe(
      'd99931702edb7a7500ab2980522919f455459118f3c893f4836768ed0fe2d227'
    )
  })

  test('vector B: two devices over QR', () => {
    const manifest = vectorB()
    expect(rosterCanonicalBytes(manifest).length).toBe(320)
    expect(rosterHash(manifest)).toBe(HASH_B)
  })

  test('buildRoster orders by slot and fills the QR transport key', () => {
    const roster = buildRoster({
      groupId: GROUP,
      threshold: 2,
      identities: new Map([
        [1, ID(1)],
        [0, ID(0)]
      ])
    })
    expect(roster.participants.map(p => p.slot)).toEqual([0, 1])
    expect(roster.participants.every(p => p.transportPublicKey === QR_TRANSPORT_PUBLIC_KEY)).toBe(
      true
    )
    expect(roster.rosterHash).toBe(HASH_B)
    expect(parseRosterManifest(JSON.parse(JSON.stringify(roster)))).toEqual(roster)
  })

  test('parseRosterManifest rejects a wrong hash, a missing slot, a duplicate slot and a 64-byte identity', () => {
    const good = { ...vectorB(), rosterHash: HASH_B }
    expect(parseRosterManifest(good)).toEqual(good)
    const [first, second] = good.participants
    const shortId = bytesToBase64(concat([[1], fill(63, 0xa0)]))
    for (const bad of [
      { ...good, rosterHash: '0'.repeat(64) },
      { ...good, participants: [first, { ...second, slot: 2 }] },
      { ...good, participants: [first, { ...second, slot: 0 }] },
      { ...good, participants: [first, { ...second, identityPublicKey: shortId }] },
      { ...good, protocolVersion: 2 },
      { ...good, ciphersuite: 'other' },
      { ...good, threshold: 3 },
      { ...good, participants: [first] },
      { ...good, participants: [first, { ...second, transportPublicKey: ID(1) }] }
    ])
      expect(parseRosterManifest(bad)).toBeNull()
    expect(parseRosterManifest(null)).toBeNull()
    expect(parseRosterManifest('x')).toBeNull()
  })

  test('numbers are canonical decimal: threshold 2 encodes as the single byte 0x32 after its length prefix', () => {
    const hex = bytesToHex(rosterCanonicalBytes(vectorB()))
    expect(hex.includes('0000000132')).toBe(true)
  })
})
