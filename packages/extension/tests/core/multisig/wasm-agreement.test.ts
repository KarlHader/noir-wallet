/**
 * The extension keeps its own copies of two protocol tables that the shared wasm also defines: the
 * round each message type is fixed to, and the roster encoding. These tests compare the two
 * implementations directly, so a drift on either side fails here instead of in a peer's
 * rejection mid-ceremony.
 */
import { before, test } from 'node:test'
import { expect } from '@playwright/test'
import { roundOf, type MultisigMessageType } from '../../../src/core/multisig/messages'
import {
  QR_TRANSPORT_PUBLIC_KEY,
  ROSTER_CIPHERSUITE,
  rosterCanonicalBytes,
  rosterHash,
  type RosterParticipant
} from '../../../src/core/multisig/roster'
import { base64ToBytes, bytesToBase64, bytesToHex } from '../../../src/lib/bytes'
import { loadWalletWasm, type WalletWasmModule } from './helpers/vault-wasm'

// The wasm name of each extension message type. A Record keeps the list exhaustive.
const WASM_NAME: Record<MultisigMessageType, string> = {
  PAIR_INVITE: 'pairInvite',
  PAIR_RESPONSE: 'pairResponse',
  ROSTER_LOCK: 'rosterLock',
  DKG_R1: 'dkgR1',
  DKG_R1_BUNDLE: 'dkgR1Bundle',
  DKG_R1_ECHO: 'dkgR1Echo',
  DKG_R1_CERT: 'dkgR1Cert',
  DKG_R2_BATCH: 'dkgR2Batch',
  DKG_R2_INBOX: 'dkgR2Inbox',
  KEYSET_SETUP: 'keysetSetup',
  DKG_FINAL: 'dkgFinal',
  DKG_ACTIVATE: 'dkgActivate',
  SESSION_ABORT: 'sessionAbort'
}

type Roster = Parameters<typeof rosterHash>[0]

const GROUP = '11111111-2222-4333-8444-555555555555'
const fill = (length: number, value: number) => new Uint8Array(length).fill(value)
const pattern = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 37 + seed * 101) & 0xff)
const identity = (body: Uint8Array) => bytesToBase64(Uint8Array.of(1, ...body))

function roster(
  threshold: 2 | 3,
  participants: RosterParticipant[],
  groupId: string = GROUP
): Roster {
  return { groupId, protocolVersion: 1, ciphersuite: ROSTER_CIPHERSUITE, threshold, participants }
}

let wasm: WalletWasmModule

before(async () => {
  wasm = await loadWalletWasm()
})

function wasmRoster(manifest: Roster): { canonical: string; hash: string } {
  const built = new wasm.RosterManifest(
    manifest.groupId,
    manifest.protocolVersion,
    manifest.ciphersuite,
    manifest.threshold,
    manifest.participants.length
  )
  try {
    for (const participant of [...manifest.participants].sort((a, b) => a.slot - b.slot)) {
      built.add_participant(
        participant.slot,
        base64ToBytes(participant.identityPublicKey),
        base64ToBytes(participant.transportPublicKey)
      )
    }
    return { canonical: bytesToHex(built.canonical_bytes()), hash: built.hash_hex() }
  } finally {
    built.free()
  }
}

function expectSameRoster(manifest: Roster) {
  expect(wasmRoster(manifest)).toEqual({
    canonical: bytesToHex(rosterCanonicalBytes(manifest)),
    hash: rosterHash(manifest)
  })
}

test.describe('multisig tables agree with the shared wasm', () => {
  test('every message type carries the round the wasm fixes for it', () => {
    for (const [type, name] of Object.entries(WASM_NAME) as [MultisigMessageType, string][]) {
      expect(roundOf(type), type).toBe(wasm.EnvelopeCodec.round_of(name))
    }
  })

  test('the wasm has no ceremony message type the extension lacks', () => {
    const names: string[] = [
      ...wasm.EnvelopeCodec.defined_msg_types(),
      ...wasm.EnvelopeCodec.reserved_msg_types()
    ]
    // Signing messages arrive with the signing round, which the extension does not speak yet.
    const ceremony = names.filter(name => !name.startsWith('sign'))
    expect(ceremony.sort()).toEqual(Object.values(WASM_NAME).sort())
  })

  test('roster vector A (three devices, Bluetooth transport keys) encodes identically', () => {
    expectSameRoster(
      roster(
        2,
        [0, 1, 2].map(slot => ({
          slot,
          identityPublicKey: identity(
            Uint8Array.of(...fill(32, 0xa0 + slot), ...fill(32, 0xb0 + slot))
          ),
          transportPublicKey: bytesToBase64(fill(32, 0xc0 + slot))
        }))
      )
    )
  })

  test('roster vector B (two devices over QR) encodes identically', () => {
    expectSameRoster(
      roster(
        2,
        [0, 1].map(slot => ({
          slot,
          identityPublicKey: identity(
            Uint8Array.of(...fill(32, 0xa0 + slot), ...fill(32, 0xb0 + slot))
          ),
          transportPublicKey: QR_TRANSPORT_PUBLIC_KEY
        }))
      )
    )
  })

  test('a 3-of-3 roster with varied key bytes and a long group id encodes identically', () => {
    expectSameRoster(
      roster(
        3,
        [2, 0, 1].map(slot => ({
          slot,
          identityPublicKey: identity(pattern(64, slot + 1)),
          transportPublicKey: bytesToBase64(pattern(32, slot + 7))
        })),
        'group-' + 'a1b2c3d4-'.repeat(13)
      )
    )
  })
})
