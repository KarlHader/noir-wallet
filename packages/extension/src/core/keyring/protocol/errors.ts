export const KEYRING_ERROR_PROTOCOL_VERSION = 2 as const

export type KeyringRetryStrategy =
  | 'never'
  | 'new-command'
  | 'after-unlock'
  | 'after-worker-restart'
  | 'status-check'

function defineError(message: string, retry: KeyringRetryStrategy) {
  return Object.freeze({ message, retry })
}

export const KEYRING_ERROR_DEFINITIONS = Object.freeze({
  INVALID_COMMAND: defineError('The keyring command is invalid.', 'never'),
  INVALID_RESPONSE: defineError('The keyring response is invalid.', 'never'),
  UNSUPPORTED_PROTOCOL_VERSION: defineError(
    'The keyring protocol version is not supported.',
    'never'
  ),
  UNSUPPORTED_OPERATION: defineError('The keyring operation is not supported.', 'never'),
  UNSUPPORTED_CHAIN: defineError('The requested chain is not supported.', 'never'),
  UNSUPPORTED_PAYLOAD: defineError('The signing payload is not supported.', 'new-command'),
  PAYLOAD_TOO_LARGE: defineError('The signing payload exceeds the allowed size.', 'new-command'),
  INVALID_CREDENTIAL: defineError('The wallet credential is invalid.', 'never'),
  CREDENTIAL_LOCKED: defineError('The wallet credential is locked.', 'after-unlock'),
  SIGNER_MISMATCH: defineError(
    'The signing payload does not match the selected account.',
    'new-command'
  ),
  SIGNING_COMMAND_NOT_FOUND: defineError('The signing command is not available.', 'new-command'),
  SIGNING_COMMAND_EXPIRED: defineError('The signing command has expired.', 'new-command'),
  SIGNING_COMMAND_CANCELLED: defineError('The signing command was cancelled.', 'never'),
  SIGNING_COMMAND_CONFLICT: defineError('The signing command state is uncertain.', 'status-check'),
  CAPACITY_EXCEEDED: defineError('The keyring has reached its pending command limit.', 'never'),
  USER_REJECTED: defineError('The operation was rejected by the user.', 'never'),
  INTEGRITY_FAILURE: defineError('The keyring integrity check failed.', 'never'),
  WORKER_UNAVAILABLE: defineError('The keyring worker is unavailable.', 'after-worker-restart'),
  WORKER_CRASHED: defineError('The keyring worker stopped unexpectedly.', 'after-worker-restart'),
  COMMAND_TIMEOUT: defineError(
    'The keyring command timed out with an unknown outcome.',
    'status-check'
  ),
  INTERNAL_ERROR: defineError('The keyring operation failed.', 'never')
}) satisfies Readonly<
  Record<
    string,
    {
      readonly message: string
      readonly retry: KeyringRetryStrategy
    }
  >
>

export type KeyringErrorCode = keyof typeof KEYRING_ERROR_DEFINITIONS

export interface KeyringErrorEnvelope {
  readonly protocolVersion: typeof KEYRING_ERROR_PROTOCOL_VERSION
  readonly code: KeyringErrorCode
  readonly message: string
  readonly retry: KeyringRetryStrategy
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function isKeyringErrorCode(value: unknown): value is KeyringErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(KEYRING_ERROR_DEFINITIONS, value)
  )
}

export function createKeyringErrorEnvelope(code: KeyringErrorCode): KeyringErrorEnvelope {
  const definition = KEYRING_ERROR_DEFINITIONS[code]
  return {
    protocolVersion: KEYRING_ERROR_PROTOCOL_VERSION,
    code,
    message: definition.message,
    retry: definition.retry
  }
}

export class KeyringError extends Error {
  readonly code: KeyringErrorCode
  readonly retry: KeyringRetryStrategy

  constructor(code: KeyringErrorCode) {
    const definition = KEYRING_ERROR_DEFINITIONS[code]
    super(definition.message)
    this.name = 'KeyringError'
    this.code = code
    this.retry = definition.retry
  }

  toJSON(): KeyringErrorEnvelope {
    return createKeyringErrorEnvelope(this.code)
  }
}

export function parseKeyringErrorEnvelope(value: unknown): KeyringErrorEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, ['protocolVersion', 'code', 'message', 'retry'])) {
    throw new KeyringError('INVALID_RESPONSE')
  }
  if (value.protocolVersion !== KEYRING_ERROR_PROTOCOL_VERSION) {
    throw new KeyringError('UNSUPPORTED_PROTOCOL_VERSION')
  }
  if (!isKeyringErrorCode(value.code)) {
    throw new KeyringError('INVALID_RESPONSE')
  }

  const definition = KEYRING_ERROR_DEFINITIONS[value.code]
  if (value.message !== definition.message || value.retry !== definition.retry) {
    throw new KeyringError('INVALID_RESPONSE')
  }

  return createKeyringErrorEnvelope(value.code)
}

export function isKeyringErrorEnvelope(value: unknown): value is KeyringErrorEnvelope {
  try {
    parseKeyringErrorEnvelope(value)
    return true
  } catch {
    return false
  }
}

export function normalizeKeyringError(error: unknown): KeyringErrorEnvelope {
  if (error instanceof KeyringError) {
    return error.toJSON()
  }
  if (isKeyringErrorEnvelope(error)) {
    return parseKeyringErrorEnvelope(error)
  }
  return createKeyringErrorEnvelope('INTERNAL_ERROR')
}
