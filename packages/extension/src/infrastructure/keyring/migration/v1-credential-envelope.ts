export interface V1EncryptedCredentialEnvelope {
  readonly encryptedData: string
  readonly salt: string
  readonly iv: string
}

const MAX_V1_ENCRYPTED_DATA_BYTES = 4_096

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => keys.includes(key))
}

function parseBase64(value: unknown, label: string, exactBytes?: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`Invalid V1 credential ${label}`)
  }
  const decodedBytes =
    (value.length * 3) / 4 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  if (
    (exactBytes !== undefined && decodedBytes !== exactBytes) ||
    (exactBytes === undefined && (decodedBytes < 16 || decodedBytes > MAX_V1_ENCRYPTED_DATA_BYTES))
  ) {
    throw new Error(`Invalid V1 credential ${label} length`)
  }
  return value
}

export function parseV1EncryptedCredentialEnvelope(value: unknown): V1EncryptedCredentialEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, ['encryptedData', 'salt', 'iv'])) {
    throw new Error('Invalid V1 encrypted credential envelope')
  }
  return Object.freeze({
    encryptedData: parseBase64(value.encryptedData, 'encryptedData'),
    salt: parseBase64(value.salt, 'salt', 16),
    iv: parseBase64(value.iv, 'iv', 12)
  })
}

export function encodeV1EncryptedCredentialEnvelope(
  value: V1EncryptedCredentialEnvelope
): Uint8Array {
  const envelope = parseV1EncryptedCredentialEnvelope(value)
  return new TextEncoder().encode(
    JSON.stringify({
      encryptedData: envelope.encryptedData,
      salt: envelope.salt,
      iv: envelope.iv
    })
  )
}

export function decodeV1EncryptedCredentialEnvelope(
  value: Uint8Array
): V1EncryptedCredentialEnvelope {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 16_384) {
    throw new Error('Invalid encoded V1 credential envelope')
  }
  try {
    return parseV1EncryptedCredentialEnvelope(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value))
    )
  } catch {
    throw new Error('Invalid encoded V1 credential envelope')
  }
}
