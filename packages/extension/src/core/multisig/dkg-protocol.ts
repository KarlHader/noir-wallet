/**
 * Shared pieces of the DKG protocol as the extension runs it over its mock transport: the slice
 * of the wallet WASM the vault needs, the interim payloads of the messages the WASM leaves
 * undefined, and the two conversions every side has to agree on (threshold → DKG shape, device
 * slot → roster slot).
 */
import type * as ZcashWasm from '@/lib/wasm-pkg/zcash_wallet_wasm'
import { base64ToBytes, bytesToBase64, bytesToHex } from '@/lib/bytes'
import { parseIdentityPublicKey } from './identity'
import { parseRosterManifest, type RosterManifest } from './roster'
import type { DeviceSlot, MultisigThreshold } from './types'

export type VaultWasm = Pick<
  typeof ZcashWasm,
  'Dkg' | 'DkgRelay' | 'MessageSet' | 'EnvelopeCodec' | 'Keyset' | 'Sealed' | 'ShareBackup'
>

export type DkgShape = { participants: 2 | 3; threshold: 2 | 3 }

/** The three modes the WASM supports, keyed by the wallet's threshold label. */
const SHAPES: Record<MultisigThreshold, DkgShape> = {
  '2-of-2': { participants: 2, threshold: 2 },
  '2-of-3': { participants: 3, threshold: 2 },
  '3-of-3': { participants: 3, threshold: 3 }
}

export function dkgShape(threshold: MultisigThreshold): DkgShape {
  return SHAPES[threshold]
}

export function isDkgShape(value: {
  participants: unknown
  threshold: unknown
}): value is DkgShape {
  return Object.values(SHAPES).some(
    shape => shape.participants === value.participants && shape.threshold === value.threshold
  )
}

/** The extension is device slot 1 and roster slot 0; the WASM derives FROST identifiers from the roster slot. */
export function rosterSlotOf(slot: DeviceSlot): 0 | 1 | 2 {
  return (slot - 1) as 0 | 1 | 2
}

export function deviceSlotOf(rosterSlot: number): DeviceSlot | null {
  return rosterSlot === 0 || rosterSlot === 1 || rosterSlot === 2
    ? ((rosterSlot + 1) as DeviceSlot)
    : null
}

// Interim contents of the messages whose payload the WASM does not define yet (ROSTER_LOCK,
// DKG_R1_ECHO, KEYSET_SETUP, DKG_FINAL), plus the carrier for a real WASM envelope. Declared as
// type aliases so they fit the reducer's `payload?: Record<string, unknown>`.

export type RosterLockPayload = {
  dkgSessionId: string // base64 of 16 bytes
  participants: 2 | 3
  threshold: 2 | 3
  rosterSlot: number
  mainnet: boolean
  roster?: RosterManifest
}
export type DeviceInfo = { name: string; model: string; platform: 'ios' | 'android' | 'extension' }
export type PairInvitePayload = {
  identityPublicKey: string // base64 of 65 bytes
  device: DeviceInfo
  dkgSessionId: string // base64 of 16 bytes
  participants: 2 | 3
  threshold: 2 | 3
  rosterSlot: number
  mainnet: boolean
}
export type PairResponsePayload = { identityPublicKey: string; device: DeviceInfo }
export type DkgEnvelopePayload = { envelope: string } // base64
export type Round1EchoPayload = { round1Hash: string } // 64 lowercase hex
export type KeysetSetupPayload = { sealedQsk: string } // base64
export type DkgFinalPayload = { fingerprint: string } // 64 lowercase hex

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const BASE64_MAX_LENGTH = 65_536
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const DKG_SESSION_ID_BYTES = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Base64 text as it may appear in a multisig payload or a vault RPC: bounded, standard alphabet. */
export function isBase64Text(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= BASE64_MAX_LENGTH && BASE64_PATTERN.test(value)
  )
}

const isBase64 = isBase64Text

/**
 * A DKG session id as text: canonical base64 of exactly 16 bytes. Canonical matters because the
 * id is a table key; atob also accepts unpadded or non-zero-trailing-bit spellings of the same bytes.
 */
export function isDkgSessionIdText(value: unknown): value is string {
  if (!isBase64Text(value)) return false
  try {
    const bytes = base64ToBytes(value)
    return bytes.length === DKG_SESSION_ID_BYTES && bytesToBase64(bytes) === value
  } catch {
    return false
  }
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value)
}

function base64Length(value: string): number | null {
  try {
    return base64ToBytes(value).length
  } catch {
    return null
  }
}

const DEVICE_TEXT_MAX = 128

export function parseDeviceInfo(
  value: unknown,
  platforms: readonly DeviceInfo['platform'][]
): DeviceInfo | null {
  if (!isRecord(value)) return null
  const { name, model, platform } = value
  for (const text of [name, model]) {
    if (typeof text !== 'string' || text.length > DEVICE_TEXT_MAX || text.trim().length === 0) {
      return null
    }
  }
  if (!platforms.some(allowed => allowed === platform)) return null
  return {
    name: name as string,
    model: model as string,
    platform: platform as DeviceInfo['platform']
  }
}

function isIdentityKeyText(value: unknown): value is string {
  return typeof value === 'string' && parseIdentityPublicKey(value) !== null
}

/** The session fields shared by PAIR_INVITE and ROSTER_LOCK. */
function parseSessionFields(
  value: Record<string, unknown>
): Omit<RosterLockPayload, 'roster'> | null {
  const { dkgSessionId, participants, threshold, rosterSlot, mainnet } = value
  if (!isBase64(dkgSessionId) || base64Length(dkgSessionId) !== DKG_SESSION_ID_BYTES) return null
  const shape = { participants, threshold }
  if (!isDkgShape(shape)) return null
  if (
    typeof rosterSlot !== 'number' ||
    !Number.isInteger(rosterSlot) ||
    rosterSlot < 1 ||
    rosterSlot >= shape.participants
  ) {
    return null
  }
  if (typeof mainnet !== 'boolean') return null
  return {
    dkgSessionId,
    participants: shape.participants,
    threshold: shape.threshold,
    rosterSlot,
    mainnet
  }
}

export function parsePairInvitePayload(value: unknown): PairInvitePayload | null {
  if (!isRecord(value) || !isIdentityKeyText(value.identityPublicKey)) return null
  const device = parseDeviceInfo(value.device, ['extension'])
  const session = parseSessionFields(value)
  if (!device || !session) return null
  return { identityPublicKey: value.identityPublicKey, device, ...session }
}

export function parsePairResponsePayload(value: unknown): PairResponsePayload | null {
  if (!isRecord(value) || !isIdentityKeyText(value.identityPublicKey)) return null
  const device = parseDeviceInfo(value.device, ['ios', 'android'])
  return device ? { identityPublicKey: value.identityPublicKey, device } : null
}

/** Lenient: a lock without `roster` is the Bluetooth mock's, a lock with one must carry a valid roster. */
export function parseRosterLockPayload(value: unknown): RosterLockPayload | null {
  if (!isRecord(value)) return null
  const session = parseSessionFields(value)
  if (!session) return null
  if (value.roster === undefined) return session
  const roster = parseRosterManifest(value.roster)
  return roster ? { ...session, roster } : null
}

export function parseRosterLockPayloadStrict(
  value: unknown
): (RosterLockPayload & { roster: RosterManifest }) | null {
  const lock = parseRosterLockPayload(value)
  return lock?.roster ? { ...lock, roster: lock.roster } : null
}

export function parseDkgEnvelopePayload(value: unknown): DkgEnvelopePayload | null {
  return isRecord(value) && isBase64(value.envelope) ? { envelope: value.envelope } : null
}

export function parseRound1EchoPayload(value: unknown): Round1EchoPayload | null {
  return isRecord(value) && isSha256Hex(value.round1Hash) ? { round1Hash: value.round1Hash } : null
}

export function parseKeysetSetupPayload(value: unknown): KeysetSetupPayload | null {
  return isRecord(value) && isBase64(value.sealedQsk) ? { sealedQsk: value.sealedQsk } : null
}

export function parseDkgFinalPayload(value: unknown): DkgFinalPayload | null {
  return isRecord(value) && isSha256Hex(value.fingerprint)
    ? { fingerprint: value.fingerprint }
    : null
}

/**
 * The interim round-1 check value: SHA-256 over the packed broadcast set. Every device computes it
 * from the set it holds, and the coordinator compares the echoes with its own.
 */
export async function round1Hash(broadcastSet: Uint8Array): Promise<string> {
  // Copied first: WebCrypto refuses a view on shared WASM memory.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(broadcastSet))
  return bytesToHex(new Uint8Array(digest))
}

/**
 * The byte arrays the WASM hands back that must not outlive their session (round secrets, the
 * static secret, the qsk). Freeing a WASM object does not clear a copy already in JS memory, so
 * the owner keeps each one here and wipes them all when the session closes.
 */
export class SecretBin {
  private readonly kept: Uint8Array[] = []

  keep(bytes: Uint8Array): Uint8Array {
    this.kept.push(bytes)
    return bytes
  }

  wipe(): void {
    for (const bytes of this.kept) bytes.fill(0)
  }

  get size(): number {
    return this.kept.length
  }

  isWiped(): boolean {
    return this.kept.every(bytes => bytes.every(byte => byte === 0))
  }
}
