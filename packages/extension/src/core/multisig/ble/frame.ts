/**
 * Bluetooth framing: one message (a Noise handshake message or a ciphertext) split into frames.
 * All integers are little-endian:
 *
 *   version(1) || messageId(2) || index(2) || total(2) || payload || CRC32(4)
 *
 * The CRC covers every byte before it and only detects transport damage; security comes from the
 * Noise channel. The phone's Swift `KGFrameCodec` is the reference for every rule below.
 */

export const FRAME_VERSION = 1
export const FRAME_HEADER_SIZE = 7
export const FRAME_TRAILER_SIZE = 4
export const FRAME_OVERHEAD = FRAME_HEADER_SIZE + FRAME_TRAILER_SIZE
/** A browser cannot read the negotiated MTU, so frames the extension sends are capped here. */
export const MAX_SENT_FRAME_SIZE = 180
export const MAX_MESSAGE_SIZE = 70_000
export const MAX_FRAMES = 4096
const MAX_IN_FLIGHT = 4
const RECENT_COMPLETED = 16

export type FrameErrorKind =
  | 'malformed'
  | 'corrupted'
  | 'inconsistent'
  | 'too_large'
  | 'too_many_in_flight'
  | 'frame_size_too_small'

export class FrameError extends Error {
  constructor(readonly kind: FrameErrorKind) {
    super(`frame error: ${kind}`)
    this.name = 'FrameError'
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** Standard CRC-32 (IEEE). */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Splits one message into frames of at most `frameSize` bytes each, header and CRC included. */
export function splitMessage(
  message: Uint8Array,
  messageId: number,
  frameSize: number = MAX_SENT_FRAME_SIZE
): Uint8Array[] {
  if (frameSize <= FRAME_OVERHEAD) throw new FrameError('frame_size_too_small')
  if (message.length > MAX_MESSAGE_SIZE) throw new FrameError('too_large')
  const chunk = frameSize - FRAME_OVERHEAD
  const total = Math.max(1, Math.ceil(message.length / chunk))
  if (total > MAX_FRAMES) throw new FrameError('too_large')

  const frames: Uint8Array[] = []
  for (let index = 0; index < total; index++) {
    const body = message.subarray(index * chunk, Math.min((index + 1) * chunk, message.length))
    const frame = new Uint8Array(FRAME_HEADER_SIZE + body.length + FRAME_TRAILER_SIZE)
    const view = new DataView(frame.buffer)
    frame[0] = FRAME_VERSION
    view.setUint16(1, messageId & 0xffff, true)
    view.setUint16(3, index, true)
    view.setUint16(5, total, true)
    frame.set(body, FRAME_HEADER_SIZE)
    view.setUint32(
      frame.length - FRAME_TRAILER_SIZE,
      crc32(frame.subarray(0, frame.length - 4)),
      true
    )
    frames.push(frame)
  }
  return frames
}

export type FrameProgress =
  | { kind: 'partial'; received: number; total: number }
  | { kind: 'duplicate' }
  | { kind: 'complete'; messageId: number; data: Uint8Array }

interface Partial {
  total: number
  frames: Map<number, Uint8Array>
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Puts frames back together. Frames may arrive out of order or twice, and frames of different
 * messages may interleave, but only a few messages can be in flight. Any contradiction or damage
 * throws; the caller ends the session, since a half-trusted stream is not worth repairing.
 */
export class FrameReassembler {
  private readonly inFlight = new Map<number, Partial>()
  // A late duplicate of a finished message must not take an in-flight slot as if it were new.
  private recent: number[] = []

  get pendingCount(): number {
    return this.inFlight.size
  }

  reset(): void {
    this.inFlight.clear()
    this.recent = []
  }

  accept(frame: Uint8Array): FrameProgress {
    if (frame.length < FRAME_OVERHEAD || frame[0] !== FRAME_VERSION)
      throw new FrameError('malformed')
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const bodyEnd = frame.length - FRAME_TRAILER_SIZE
    if (view.getUint32(bodyEnd, true) !== crc32(frame.subarray(0, bodyEnd))) {
      throw new FrameError('corrupted')
    }
    const id = view.getUint16(1, true)
    const index = view.getUint16(3, true)
    const total = view.getUint16(5, true)
    if (total < 1 || total > MAX_FRAMES || index >= total) throw new FrameError('malformed')
    const payload = frame.slice(FRAME_HEADER_SIZE, bodyEnd)

    let partial = this.inFlight.get(id)
    if (!partial) {
      if (this.recent.includes(id)) return { kind: 'duplicate' }
      if (this.inFlight.size >= MAX_IN_FLIGHT) throw new FrameError('too_many_in_flight')
      partial = { total, frames: new Map() }
    }
    if (partial.total !== total) {
      this.inFlight.delete(id)
      throw new FrameError('inconsistent')
    }
    const existing = partial.frames.get(index)
    if (existing) {
      if (!sameBytes(existing, payload)) {
        this.inFlight.delete(id)
        throw new FrameError('inconsistent')
      }
      return { kind: 'duplicate' }
    }
    partial.frames.set(index, payload)
    let size = 0
    for (const part of partial.frames.values()) size += part.length
    if (size > MAX_MESSAGE_SIZE) {
      this.inFlight.delete(id)
      throw new FrameError('too_large')
    }
    if (partial.frames.size < total) {
      this.inFlight.set(id, partial)
      return { kind: 'partial', received: partial.frames.size, total }
    }

    this.inFlight.delete(id)
    this.recent.push(id)
    if (this.recent.length > RECENT_COMPLETED) this.recent.shift()
    const data = new Uint8Array(size)
    let offset = 0
    for (let i = 0; i < total; i++) {
      const part = partial.frames.get(i)!
      data.set(part, offset)
      offset += part.length
    }
    return { kind: 'complete', messageId: id, data }
  }
}
