import {
  KEYRING_COMMAND_PROTOCOL_VERSION,
  parseKeyringCommand,
  parseKeyringCommandId,
  parseKeyringCommandResult,
  type KeyringCommandPayload,
  type KeyringOperation
} from '@/core/keyring/protocol/commands'
import type { KeyringCommandBinding } from '@/core/keyring/protocol/session'
import { KeyringError } from '@/core/keyring/protocol/errors'
import type { KeyringTransport } from '@/core/keyring/ports/keyring-transport'

export const MULTICHAIN_OPERATIONS = Object.freeze([
  'capabilities.get',
  'credential.create',
  'credential.import',
  'credential.import-private-key',
  'credential.export-private-key',
  'credential.rewrap-private-key',
  'credential.unlock',
  'credential.lock',
  'credential.lock-all',
  'credential.get-state',
  'account.derive-public',
  'signing.prepare',
  'signing.confirm',
  'signing.verify',
  'signing.cancel',
  'signing.cancel-all',
  'command.cancel'
] as const satisfies readonly KeyringOperation[])

export type MultichainOperation = (typeof MULTICHAIN_OPERATIONS)[number]

export interface MultichainCommandRequest<TPayload extends KeyringCommandPayload> {
  readonly operation: MultichainOperation
  readonly binding: KeyringCommandBinding
  readonly payload: TPayload
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface MultichainCommandClientOptions {
  readonly defaultTimeoutMs?: number
  readonly maxTimeoutMs?: number
  readonly maxPendingCommands?: number
  readonly now?: () => number
  readonly createCommandId?: () => string
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_PENDING_COMMANDS = 64

function isCommandRequest(
  value: unknown
): value is MultichainCommandRequest<KeyringCommandPayload> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const request = value as Record<string, unknown>
  const keys = Object.keys(request)
  if (
    !Object.prototype.hasOwnProperty.call(request, 'operation') ||
    !Object.prototype.hasOwnProperty.call(request, 'binding') ||
    !Object.prototype.hasOwnProperty.call(request, 'payload') ||
    !keys.every(key => ['operation', 'binding', 'payload', 'timeoutMs', 'signal'].includes(key))
  ) {
    return false
  }
  if (
    request.signal !== undefined &&
    (typeof request.signal !== 'object' ||
      request.signal === null ||
      typeof (request.signal as AbortSignal).aborted !== 'boolean' ||
      typeof (request.signal as AbortSignal).addEventListener !== 'function' ||
      typeof (request.signal as AbortSignal).removeEventListener !== 'function')
  ) {
    return false
  }
  return true
}

function defaultCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new KeyringError('INTERNAL_ERROR')
  }
  return `keyring-command:${globalThis.crypto.randomUUID()}`
}

function readPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new KeyringError('INVALID_COMMAND')
  }
  return resolved
}

export class MultichainCommandClient {
  private readonly defaultTimeoutMs: number
  private readonly maxTimeoutMs: number
  private readonly maxPendingCommands: number
  private readonly now: () => number
  private readonly createCommandId: () => string
  private readonly pending = new Map<string, AbortController>()
  private destroyed = false

  constructor(
    private readonly transport: KeyringTransport,
    options: MultichainCommandClientOptions = {}
  ) {
    this.maxTimeoutMs = readPositiveInteger(
      options.maxTimeoutMs,
      MAX_TIMEOUT_MS,
      Number.MAX_SAFE_INTEGER
    )
    this.defaultTimeoutMs = readPositiveInteger(
      options.defaultTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      this.maxTimeoutMs
    )
    this.maxPendingCommands = readPositiveInteger(
      options.maxPendingCommands,
      MAX_PENDING_COMMANDS,
      10_000
    )
    this.now = options.now ?? Date.now
    this.createCommandId = options.createCommandId ?? defaultCommandId
  }

  async execute<TResult, TPayload extends KeyringCommandPayload>(
    request: MultichainCommandRequest<TPayload>,
    parseResult: (value: unknown) => TResult
  ): Promise<TResult> {
    if (this.destroyed) {
      throw new KeyringError('WORKER_UNAVAILABLE')
    }
    if (typeof parseResult !== 'function') {
      throw new KeyringError('INVALID_COMMAND')
    }
    if (!isCommandRequest(request)) {
      throw new KeyringError('INVALID_COMMAND')
    }
    if (request.signal?.aborted) {
      throw new KeyringError('SIGNING_COMMAND_CANCELLED')
    }
    if (this.pending.size >= this.maxPendingCommands) {
      throw new KeyringError('CAPACITY_EXCEEDED')
    }

    const timeoutMs = readPositiveInteger(
      request.timeoutMs,
      this.defaultTimeoutMs,
      this.maxTimeoutMs
    )
    const now = this.now()
    const deadlineAt = now + timeoutMs
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(deadlineAt)) {
      throw new KeyringError('INVALID_COMMAND')
    }
    const commandId = parseKeyringCommandId(this.createCommandId())
    if (this.pending.has(commandId)) {
      throw new KeyringError('SIGNING_COMMAND_CONFLICT')
    }
    const command = parseKeyringCommand({
      protocolVersion: KEYRING_COMMAND_PROTOCOL_VERSION,
      commandId,
      engine: 'multichain',
      operation: request.operation,
      binding: request.binding,
      deadlineAt,
      payload: request.payload
    })

    const controller = new AbortController()
    let abortCode: 'SIGNING_COMMAND_CANCELLED' | 'COMMAND_TIMEOUT' = 'SIGNING_COMMAND_CANCELLED'
    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new KeyringError(abortCode)), {
        once: true
      })
    })
    const onCallerAbort = () => {
      abortCode = 'SIGNING_COMMAND_CANCELLED'
      controller.abort()
    }
    request.signal?.addEventListener('abort', onCallerAbort, { once: true })
    const timeout = setTimeout(() => {
      abortCode = 'COMMAND_TIMEOUT'
      controller.abort()
    }, timeoutMs)
    this.pending.set(commandId, controller)

    try {
      const response = await Promise.race([
        Promise.resolve().then(() =>
          this.transport.execute(command, { signal: controller.signal })
        ),
        abortPromise
      ])
      const result = parseKeyringCommandResult(response, commandId, parseResult)
      if (!result.ok) {
        throw new KeyringError(result.error.code)
      }
      return result.value
    } catch (error) {
      if (error instanceof KeyringError) {
        throw error
      }
      throw new KeyringError('INTERNAL_ERROR')
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onCallerAbort)
      this.pending.delete(commandId)
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    for (const controller of this.pending.values()) {
      controller.abort()
    }
    this.pending.clear()
    await this.transport.destroy?.()
  }
}
