import {
  KEYRING_ERROR_PROTOCOL_VERSION,
  KeyringError,
  type KeyringErrorCode,
  type KeyringErrorEnvelope,
  createKeyringErrorEnvelope,
  parseKeyringErrorEnvelope
} from './errors'
import { parseKeyringCommandBinding, type KeyringCommandBinding } from './session'

export const KEYRING_COMMAND_PROTOCOL_VERSION = KEYRING_ERROR_PROTOCOL_VERSION

declare const keyringCommandIdBrand: unique symbol

export type KeyringCommandId = string & { readonly [keyringCommandIdBrand]: true }
export type KeyringEngine = 'zcash' | 'multichain'

function engines(...values: KeyringEngine[]): readonly KeyringEngine[] {
  return Object.freeze(values)
}

export const KEYRING_OPERATION_ENGINES = Object.freeze({
  'capabilities.get': engines('zcash', 'multichain'),
  'credential.create': engines('multichain'),
  'credential.import': engines('multichain'),
  'credential.import-private-key': engines('multichain'),
  'credential.export-private-key': engines('multichain'),
  'credential.rewrap-private-key': engines('multichain'),
  'credential.unlock': engines('zcash', 'multichain'),
  'credential.lock': engines('zcash', 'multichain'),
  'credential.lock-all': engines('zcash', 'multichain'),
  'credential.get-state': engines('zcash', 'multichain'),
  'account.derive-public': engines('multichain'),
  'identity.get-public': engines('zcash'),
  'signing.prepare': engines('zcash', 'multichain'),
  'signing.confirm': engines('zcash', 'multichain'),
  'signing.verify': engines('multichain'),
  'signing.cancel': engines('zcash', 'multichain'),
  'signing.cancel-all': engines('zcash', 'multichain'),
  'command.cancel': engines('zcash', 'multichain')
}) satisfies Readonly<Record<string, readonly KeyringEngine[]>>

export type KeyringOperation = keyof typeof KEYRING_OPERATION_ENGINES
export type KeyringCommandPayload = Readonly<Record<string, unknown>>

export type KeyringCommandBindingKind = KeyringCommandBinding['kind']

function bindingKinds(
  ...values: KeyringCommandBindingKind[]
): readonly KeyringCommandBindingKind[] {
  return Object.freeze(values)
}

export const KEYRING_OPERATION_BINDING_KINDS = Object.freeze({
  'capabilities.get': bindingKinds('unbound'),
  'credential.create': bindingKinds('credential'),
  'credential.import': bindingKinds('credential'),
  'credential.import-private-key': bindingKinds('credential'),
  'credential.export-private-key': bindingKinds('credential'),
  'credential.rewrap-private-key': bindingKinds('credential'),
  'credential.unlock': bindingKinds('credential'),
  'credential.lock': bindingKinds('credential'),
  'credential.lock-all': bindingKinds('global'),
  'credential.get-state': bindingKinds('credential'),
  'account.derive-public': bindingKinds('credential'),
  'identity.get-public': bindingKinds('credential'),
  'signing.prepare': bindingKinds('credential'),
  'signing.confirm': bindingKinds('credential'),
  'signing.verify': bindingKinds('unbound'),
  'signing.cancel': bindingKinds('credential'),
  'signing.cancel-all': bindingKinds('credential'),
  'command.cancel': bindingKinds('unbound', 'global', 'credential')
}) satisfies Readonly<Record<KeyringOperation, readonly KeyringCommandBindingKind[]>>

export interface KeyringCommand<TPayload extends KeyringCommandPayload = KeyringCommandPayload> {
  readonly protocolVersion: typeof KEYRING_COMMAND_PROTOCOL_VERSION
  readonly commandId: KeyringCommandId
  readonly engine: KeyringEngine
  readonly operation: KeyringOperation
  readonly binding: KeyringCommandBinding
  readonly deadlineAt: number
  readonly payload: TPayload
}

export type KeyringCommandResult<TResult = unknown> =
  | {
      readonly protocolVersion: typeof KEYRING_COMMAND_PROTOCOL_VERSION
      readonly commandId: KeyringCommandId
      readonly ok: true
      readonly value: TResult
    }
  | {
      readonly protocolVersion: typeof KEYRING_COMMAND_PROTOCOL_VERSION
      readonly commandId: KeyringCommandId
      readonly ok: false
      readonly error: KeyringErrorEnvelope
    }

const FORBIDDEN_TRANSPORT_KEYS = new Set([
  'requestId',
  'sessionId',
  'globalUnlockEpoch',
  'credentialGenerationId',
  'offscreenInstanceId',
  'passphrase',
  'bip39Passphrase',
  '$noirWalletBytes'
])
const textEncoder = new TextEncoder()

export const KEYRING_COMMAND_PAYLOAD_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 4_096,
  maxStringBytes: 1_048_576,
  maxBinaryBytes: 16_777_216
})

interface CopyCommandState {
  nodes: number
  stringBytes: number
  binaryBytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function addStringBytes(value: string, state: CopyCommandState): void {
  if (value.length > KEYRING_COMMAND_PAYLOAD_LIMITS.maxStringBytes) {
    throw new KeyringError('PAYLOAD_TOO_LARGE')
  }
  state.stringBytes += textEncoder.encode(value).byteLength
  if (state.stringBytes > KEYRING_COMMAND_PAYLOAD_LIMITS.maxStringBytes) {
    throw new KeyringError('PAYLOAD_TOO_LARGE')
  }
}

function copyCommandValue(
  value: unknown,
  ancestors: ReadonlySet<object>,
  depth: number,
  state: CopyCommandState
): unknown {
  state.nodes += 1
  if (state.nodes > KEYRING_COMMAND_PAYLOAD_LIMITS.maxNodes) {
    throw new KeyringError('PAYLOAD_TOO_LARGE')
  }
  if (depth > KEYRING_COMMAND_PAYLOAD_LIMITS.maxDepth) {
    throw new KeyringError('PAYLOAD_TOO_LARGE')
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  if (typeof value === 'string') {
    addStringBytes(value, state)
    return value
  }
  if (value instanceof Uint8Array) {
    state.binaryBytes += value.byteLength
    if (state.binaryBytes > KEYRING_COMMAND_PAYLOAD_LIMITS.maxBinaryBytes) {
      throw new KeyringError('PAYLOAD_TOO_LARGE')
    }
    return new Uint8Array(value)
  }
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new KeyringError('INVALID_COMMAND')
  }

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  if (Array.isArray(value)) {
    return value.map(item => copyCommandValue(item, nextAncestors, depth + 1, state))
  }
  if (!isRecord(value)) {
    throw new KeyringError('INVALID_COMMAND')
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (FORBIDDEN_TRANSPORT_KEYS.has(key)) {
        throw new KeyringError('INVALID_COMMAND')
      }
      addStringBytes(key, state)
      return [key, copyCommandValue(item, nextAncestors, depth + 1, state)]
    })
  )
}

function isKeyringEngine(value: unknown): value is KeyringEngine {
  return value === 'zcash' || value === 'multichain'
}

function isKeyringOperation(value: unknown): value is KeyringOperation {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(KEYRING_OPERATION_ENGINES, value)
  )
}

export function parseKeyringCommandId(value: unknown): KeyringCommandId {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw new KeyringError('INVALID_COMMAND')
  }
  return value as KeyringCommandId
}

export function parseKeyringCommand(value: unknown): KeyringCommand {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'protocolVersion',
      'commandId',
      'engine',
      'operation',
      'binding',
      'deadlineAt',
      'payload'
    ])
  ) {
    throw new KeyringError('INVALID_COMMAND')
  }
  if (value.protocolVersion !== KEYRING_COMMAND_PROTOCOL_VERSION) {
    throw new KeyringError('UNSUPPORTED_PROTOCOL_VERSION')
  }
  if (typeof value.commandId !== 'string') {
    throw new KeyringError('INVALID_COMMAND')
  }

  const commandId = parseKeyringCommandId(value.commandId)
  if (!isKeyringEngine(value.engine) || !isKeyringOperation(value.operation)) {
    throw new KeyringError('UNSUPPORTED_OPERATION')
  }
  const supportedEngines = KEYRING_OPERATION_ENGINES[value.operation] as readonly KeyringEngine[]
  if (!supportedEngines.includes(value.engine)) {
    throw new KeyringError('UNSUPPORTED_OPERATION')
  }
  const binding = parseKeyringCommandBinding(value.binding)
  const supportedBindings = KEYRING_OPERATION_BINDING_KINDS[
    value.operation
  ] as readonly KeyringCommandBindingKind[]
  if (!supportedBindings.includes(binding.kind)) {
    throw new KeyringError('INVALID_COMMAND')
  }
  if (!Number.isSafeInteger(value.deadlineAt) || (value.deadlineAt as number) <= 0) {
    throw new KeyringError('INVALID_COMMAND')
  }
  if (!isRecord(value.payload)) {
    throw new KeyringError('INVALID_COMMAND')
  }
  const payload = copyCommandValue(value.payload, new Set<object>(), 0, {
    nodes: 0,
    stringBytes: 0,
    binaryBytes: 0
  })
  if (!isRecord(payload)) {
    throw new KeyringError('INVALID_COMMAND')
  }

  return {
    protocolVersion: KEYRING_COMMAND_PROTOCOL_VERSION,
    commandId,
    engine: value.engine,
    operation: value.operation,
    binding,
    deadlineAt: value.deadlineAt as number,
    payload
  }
}

export function isKeyringCommandExpired(command: KeyringCommand, now = Date.now()): boolean {
  return now >= command.deadlineAt
}

export function createKeyringCommandSuccess<TResult>(
  commandId: KeyringCommandId,
  value: TResult
): KeyringCommandResult<TResult> {
  return {
    protocolVersion: KEYRING_COMMAND_PROTOCOL_VERSION,
    commandId,
    ok: true,
    value
  }
}

export function createKeyringCommandFailure(
  commandId: KeyringCommandId,
  code: KeyringErrorCode
): KeyringCommandResult<never> {
  return {
    protocolVersion: KEYRING_COMMAND_PROTOCOL_VERSION,
    commandId,
    ok: false,
    error: createKeyringErrorEnvelope(code)
  }
}

export function parseKeyringCommandResult<TResult>(
  value: unknown,
  expectedCommandId: KeyringCommandId,
  parseValue: (value: unknown) => TResult
): KeyringCommandResult<TResult> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new KeyringError('INVALID_RESPONSE')
  }
  const expectedKeys =
    value.ok === true
      ? ['protocolVersion', 'commandId', 'ok', 'value']
      : ['protocolVersion', 'commandId', 'ok', 'error']
  if (!hasExactKeys(value, expectedKeys)) {
    throw new KeyringError('INVALID_RESPONSE')
  }
  if (value.protocolVersion !== KEYRING_COMMAND_PROTOCOL_VERSION) {
    throw new KeyringError('UNSUPPORTED_PROTOCOL_VERSION')
  }
  if (typeof value.commandId !== 'string') {
    throw new KeyringError('INVALID_RESPONSE')
  }

  let commandId: KeyringCommandId
  try {
    commandId = parseKeyringCommandId(value.commandId)
  } catch {
    throw new KeyringError('INVALID_RESPONSE')
  }
  if (commandId !== expectedCommandId) {
    throw new KeyringError('INVALID_RESPONSE')
  }

  if (value.ok === false) {
    return {
      protocolVersion: KEYRING_COMMAND_PROTOCOL_VERSION,
      commandId,
      ok: false,
      error: parseKeyringErrorEnvelope(value.error)
    }
  }

  let parsedValue: TResult
  try {
    parsedValue = parseValue(value.value)
  } catch {
    throw new KeyringError('INVALID_RESPONSE')
  }
  return createKeyringCommandSuccess(commandId, parsedValue)
}
