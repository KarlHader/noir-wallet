import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import {
  KEYRING_COMMAND_PROTOCOL_VERSION,
  KEYRING_COMMAND_PAYLOAD_LIMITS,
  KEYRING_ERROR_DEFINITIONS,
  KEYRING_OPERATION_BINDING_KINDS,
  KEYRING_OPERATION_ENGINES,
  KeyringError,
  createKeyringCommandFailure,
  createKeyringCommandSuccess,
  createKeyringErrorEnvelope,
  isKeyringCommandExpired,
  normalizeKeyringError,
  parseKeyringCommand,
  parseKeyringCommandId,
  parseKeyringCommandResult,
  parseKeyringErrorEnvelope
} from '../../../src/core/keyring/ports/index.ts'

const commandSource = readFileSync(
  new URL('../../../src/core/keyring/ports/keyring-command.ts', import.meta.url),
  'utf8'
)
const errorSource = readFileSync(
  new URL('../../../src/core/keyring/ports/keyring-error.ts', import.meta.url),
  'utf8'
)

function createCommand(overrides = {}) {
  return {
    protocolVersion: KEYRING_COMMAND_PROTOCOL_VERSION,
    commandId: 'keyring-command:1',
    engine: 'multichain',
    operation: 'account.derive-public',
    binding: {
      kind: 'credential',
      keyDomainId: 'key-domain:1',
      credentialGenerationId: 'credential-generation:1',
      globalUnlockEpoch: 'global-unlock:1'
    },
    deadlineAt: 2_000,
    payload: {
      keyDomainId: 'key-domain:1',
      accountIndex: 0,
      derivation: {
        scheme: 'bip44',
        path: "m/44'/60'/0'/0/0"
      }
    },
    ...overrides
  }
}

test.describe('Keyring command protocol', () => {
  test('parses a bounded product command without exposing engine handles', () => {
    const command = parseKeyringCommand(createCommand())

    expect(command.commandId).toBe('keyring-command:1')
    expect(command.engine).toBe('multichain')
    expect(command.operation).toBe('account.derive-public')
    expect(isKeyringCommandExpired(command, 1_999)).toBe(false)
    expect(isKeyringCommandExpired(command, 2_000)).toBe(true)
  })

  test('rejects malformed envelopes and engine-operation mismatches', () => {
    expect(KEYRING_COMMAND_PROTOCOL_VERSION).toBe(2)
    expect(() => parseKeyringCommand(createCommand({ extra: true }))).toThrow(KeyringError)
    expect(() => parseKeyringCommand(createCommand({ protocolVersion: 1 }))).toThrow(
      /protocol version/i
    )
    expect(() => parseKeyringCommand(createCommand({ engine: 'zcash' }))).toThrow(/operation/i)
    expect(() =>
      parseKeyringCommand(createCommand({ deadlineAt: Number.POSITIVE_INFINITY }))
    ).toThrow(/invalid/i)
  })

  test('requires the binding scope declared by each operation', () => {
    expect(() =>
      parseKeyringCommand(
        createCommand({
          operation: 'credential.import',
          payload: {
            mnemonic: 'test test test test test test test test test test test junk',
            password: 'test-password'
          }
        })
      )
    ).not.toThrow()
    expect(() =>
      parseKeyringCommand(
        createCommand({
          operation: 'capabilities.get',
          binding: { kind: 'unbound' },
          payload: {}
        })
      )
    ).not.toThrow()
    expect(() =>
      parseKeyringCommand(
        createCommand({
          operation: 'credential.lock-all',
          binding: { kind: 'global', globalUnlockEpoch: 'global-unlock:1' },
          payload: {}
        })
      )
    ).not.toThrow()
    expect(() =>
      parseKeyringCommand(
        createCommand({
          operation: 'account.derive-public',
          binding: { kind: 'unbound' }
        })
      )
    ).toThrow(/invalid/i)
    expect(() =>
      parseKeyringCommand(
        createCommand({
          operation: 'capabilities.get',
          payload: {}
        })
      )
    ).toThrow(/invalid/i)
  })

  test('rejects raw transport handles, cycles, and unsupported payload values', () => {
    expect(() =>
      parseKeyringCommand(
        createCommand({
          payload: {
            signing: {
              requestId: 'raw-worker-request'
            }
          }
        })
      )
    ).toThrow(/invalid/i)
    expect(() =>
      parseKeyringCommand(
        createCommand({
          payload: {
            globalUnlockEpoch: 'payload-must-not-override-binding'
          }
        })
      )
    ).toThrow(/invalid/i)
    expect(() =>
      parseKeyringCommand(
        createCommand({
          payload: {
            sessionId: 'raw-wasm-session'
          }
        })
      )
    ).toThrow(/invalid/i)
    expect(() =>
      parseKeyringCommand(
        createCommand({
          payload: {
            invalid: () => undefined
          }
        })
      )
    ).toThrow(/invalid/i)

    const cyclicPayload = {}
    cyclicPayload.self = cyclicPayload
    expect(() => parseKeyringCommand(createCommand({ payload: cyclicPayload }))).toThrow(/invalid/i)
  })

  test('copies binary payloads in the structured-clone subset', () => {
    const value = new Uint8Array([1, 2, 3])
    const command = parseKeyringCommand(
      createCommand({
        operation: 'signing.prepare',
        payload: {
          format: 'evm-transaction',
          value
        }
      })
    )

    value[0] = 9
    expect(command.payload.value).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('rejects payloads that exceed command resource limits before transport', () => {
    expect(() =>
      parseKeyringCommand(
        createCommand({
          payload: {
            values: Array.from({ length: KEYRING_COMMAND_PAYLOAD_LIMITS.maxNodes }, () => null)
          }
        })
      )
    ).toThrow(/payload exceeds/i)

    expect(() =>
      parseKeyringCommand(
        createCommand({
          payload: {
            value: 'a'.repeat(KEYRING_COMMAND_PAYLOAD_LIMITS.maxStringBytes)
          }
        })
      )
    ).toThrow(/payload exceeds/i)
  })

  test('correlates success and failure results with the product command', () => {
    const commandId = parseKeyringCommandId('keyring-command:result')
    const success = createKeyringCommandSuccess(commandId, 'derived-address')
    const parsedSuccess = parseKeyringCommandResult(success, commandId, value => {
      if (typeof value !== 'string') throw new Error('invalid')
      return value
    })
    expect(parsedSuccess).toEqual(success)

    const failure = createKeyringCommandFailure(commandId, 'CREDENTIAL_LOCKED')
    expect(parseKeyringCommandResult(failure, commandId, value => value)).toEqual(failure)
    expect(() =>
      parseKeyringCommandResult(
        success,
        parseKeyringCommandId('keyring-command:other'),
        value => value
      )
    ).toThrow(/response/i)
    expect(() =>
      parseKeyringCommandResult({ ...success, protocolVersion: 1 }, commandId, value => value)
    ).toThrow(/protocol version/i)
  })

  test('serializes stable safe errors without leaking unknown engine messages', () => {
    const timeout = createKeyringErrorEnvelope('COMMAND_TIMEOUT')
    expect(JSON.parse(JSON.stringify(timeout))).toEqual(timeout)
    expect(timeout.retry).toBe('status-check')

    const locked = new KeyringError('CREDENTIAL_LOCKED')
    expect(JSON.parse(JSON.stringify(locked))).toEqual(
      createKeyringErrorEnvelope('CREDENTIAL_LOCKED')
    )
    expect(locked.retry).toBe('after-unlock')

    const secret = 'seed phrase abandon abandon abandon'
    const normalized = normalizeKeyringError(new Error(secret))
    expect(normalized.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(normalized)).not.toContain(secret)
  })

  test('rejects forged messages and retry policies for known error codes', () => {
    const error = createKeyringErrorEnvelope('WORKER_CRASHED')

    expect(() =>
      parseKeyringErrorEnvelope({
        ...error,
        message: 'raw wasm panic: seed phrase'
      })
    ).toThrow(/response/i)
    expect(() =>
      parseKeyringErrorEnvelope({
        ...error,
        protocolVersion: 1
      })
    ).toThrow(/protocol version/i)
    expect(() =>
      parseKeyringErrorEnvelope({
        ...error,
        retry: 'new-command'
      })
    ).toThrow(/response/i)
  })

  test('keeps the V2 protocol independent from V1 worker and browser transports', () => {
    const source = `${commandSource}\n${errorSource}`

    expect(source).not.toMatch(/chrome\.|postMessage|WORKER_RPC|wasm-pkg/i)
    expect(source).not.toMatch(/readonly (?:requestId|sessionId)\s*:/)
    expect(source).not.toMatch(/console\.(?:log|warn|error)/)
  })

  test('freezes protocol operation and error definitions at runtime', () => {
    expect(Object.isFrozen(KEYRING_OPERATION_ENGINES)).toBe(true)
    expect(Object.isFrozen(KEYRING_OPERATION_ENGINES['signing.prepare'])).toBe(true)
    expect(Object.isFrozen(KEYRING_OPERATION_BINDING_KINDS)).toBe(true)
    expect(Object.isFrozen(KEYRING_OPERATION_BINDING_KINDS['signing.prepare'])).toBe(true)
    expect(Object.isFrozen(KEYRING_COMMAND_PAYLOAD_LIMITS)).toBe(true)
    expect(Object.isFrozen(KEYRING_ERROR_DEFINITIONS)).toBe(true)
    expect(Object.isFrozen(KEYRING_ERROR_DEFINITIONS.COMMAND_TIMEOUT)).toBe(true)
  })
})
