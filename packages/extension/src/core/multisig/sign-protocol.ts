import type * as WalletWasm from '@/lib/wasm-pkg/zcash_wallet_wasm'
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import type { MultisigEnvelope } from './messages'

export const SIGN_ENVELOPE_BASE64_LIMIT = 65_536
export const SIGN_PCZT_BASE64_LIMIT = 262_144
// Noise caps ciphertext at 65535 bytes; its authentication tag occupies 16 bytes.
export const SIGN_BLE_PLAINTEXT_LIMIT = 65_535 - 16
const MAX_SIGN_JSON_BYTES = SIGN_PCZT_BASE64_LIMIT + SIGN_ENVELOPE_BASE64_LIMIT + 4096

export function signingBase64(value: unknown, limit: number): Uint8Array | null {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > limit ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return null
  try {
    const bytes = base64ToBytes(value)
    return bytesToBase64(bytes) === value ? bytes : null
  } catch {
    return null
  }
}

export function parseSignEnvelopePayload(value: unknown): Uint8Array | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return signingBase64((value as Record<string, unknown>).envelope, SIGN_ENVELOPE_BASE64_LIMIT)
}

export function parseSignPayload(
  value: unknown
): { envelope: Uint8Array; pczt: Uint8Array } | null {
  const envelope = parseSignEnvelopePayload(value)
  if (!envelope) return null
  const pczt = signingBase64((value as Record<string, unknown>).pczt, SIGN_PCZT_BASE64_LIMIT)
  return pczt ? { envelope, pczt } : null
}

export function assertSigningCarrierSize(
  envelope: MultisigEnvelope,
  transport: 'ble' | 'qr'
): void {
  const size = new TextEncoder().encode(JSON.stringify(envelope)).length
  if (size > (transport === 'ble' ? SIGN_BLE_PLAINTEXT_LIMIT : MAX_SIGN_JSON_BYTES)) {
    throw new Error('Signing carrier exceeds transport limit')
  }
}

export interface SigningInnerEnvelope {
  msgType: number
  round: number
  sender: number
  recipient: number
  sequence: number
  sessionId: Uint8Array
  payload: Uint8Array
}

function counter(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
}

/** Generated bindings expose any[]; keep their unchecked tuples out of the session state. */
export function readSigningInner(
  codec: typeof WalletWasm.EnvelopeCodec,
  bytes: Uint8Array
): SigningInnerEnvelope {
  const tuple: unknown = codec.readSigning(bytes)
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 7 ||
    !counter(tuple[0], 255) ||
    !counter(tuple[1], 255) ||
    !counter(tuple[2], 255) ||
    !counter(tuple[3], 255) ||
    !counter(tuple[4], 0xffffffff) ||
    !(tuple[5] instanceof Uint8Array) ||
    tuple[5].length !== 16 ||
    !(tuple[6] instanceof Uint8Array)
  ) {
    throw new Error('Invalid signing envelope')
  }
  return {
    msgType: tuple[0],
    round: tuple[1],
    sender: tuple[2],
    recipient: tuple[3],
    sequence: tuple[4],
    sessionId: tuple[5],
    payload: tuple[6]
  }
}

export function signingBatch(
  value: unknown,
  expectedSlots: readonly number[]
): Map<number, Uint8Array> {
  if (!Array.isArray(value) || value.length !== expectedSlots.length)
    throw new Error('Invalid signing batch')
  const result = new Map<number, Uint8Array>()
  for (const item of value) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== 'number' ||
      !expectedSlots.includes(item[0]) ||
      result.has(item[0]) ||
      !(item[1] instanceof Uint8Array)
    ) {
      throw new Error('Invalid signing batch')
    }
    result.set(item[0], item[1])
  }
  return result
}
