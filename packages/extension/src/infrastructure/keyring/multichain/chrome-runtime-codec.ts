const BINARY_FIELD = '$noirWalletBytes'
const MAX_BINARY_BYTES = 4 * 1024 * 1024
const MAX_DEPTH = 32
const MAX_NODES = 4_096

interface CodecState {
  nodes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil((MAX_BINARY_BYTES * 4) / 3) + 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Invalid runtime binary value')
  }
  const binary = atob(value)
  if (binary.length > MAX_BINARY_BYTES || btoa(binary) !== value) {
    throw new Error('Invalid runtime binary value')
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function transform(
  value: unknown,
  direction: 'encode' | 'decode',
  state: CodecState,
  depth: number
): unknown {
  state.nodes += 1
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw new Error('Runtime command exceeds structural limits')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (direction === 'encode' && value instanceof Uint8Array) {
    if (value.byteLength > MAX_BINARY_BYTES) {
      throw new Error('Invalid runtime binary value')
    }
    return { [BINARY_FIELD]: bytesToBase64(value) }
  }
  if (Array.isArray(value)) {
    return value.map(item => transform(item, direction, state, depth + 1))
  }
  if (!isRecord(value)) throw new Error('Invalid runtime command value')
  const keys = Object.keys(value)
  if (direction === 'decode' && keys.length === 1 && keys[0] === BINARY_FIELD) {
    return base64ToBytes(value[BINARY_FIELD])
  }
  if (Object.prototype.hasOwnProperty.call(value, BINARY_FIELD)) {
    throw new Error('Invalid runtime binary envelope')
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, transform(item, direction, state, depth + 1)])
  )
}

export function encodeChromeRuntimeCommand(value: unknown): unknown {
  return transform(value, 'encode', { nodes: 0 }, 0)
}

export function decodeChromeRuntimeCommand(value: unknown): unknown {
  return transform(value, 'decode', { nodes: 0 }, 0)
}
