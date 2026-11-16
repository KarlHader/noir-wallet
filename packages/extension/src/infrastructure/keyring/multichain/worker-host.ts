import {
  KEYRING_ERROR_DEFINITIONS,
  createKeyringCommandFailure,
  parseKeyringCommand,
  parseKeyringCommandResult,
  type KeyringCommand,
  type KeyringCommandId,
  type KeyringCommandResult,
  type KeyringErrorCode
} from '@/core/keyring/ports'

const MAX_PENDING_COMMANDS = 64

interface PendingCommand {
  readonly command: KeyringCommand
  readonly resolve: (value: KeyringCommandResult) => void
  readonly timer: ReturnType<typeof setTimeout>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKeyringErrorCode(value: unknown): value is KeyringErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(KEYRING_ERROR_DEFINITIONS, value)
  )
}

export class MultichainWorkerHost {
  private worker: Worker | undefined
  private readonly pending = new Map<KeyringCommandId, PendingCommand>()
  private destroyed = false

  execute(input: unknown): Promise<KeyringCommandResult> {
    let command: KeyringCommand
    try {
      command = parseKeyringCommand(input)
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.destroyed) {
      return Promise.resolve(createKeyringCommandFailure(command.commandId, 'WORKER_UNAVAILABLE'))
    }
    if (command.deadlineAt <= Date.now()) {
      return Promise.resolve(createKeyringCommandFailure(command.commandId, 'COMMAND_TIMEOUT'))
    }
    if (this.pending.size >= MAX_PENDING_COMMANDS) {
      return Promise.resolve(createKeyringCommandFailure(command.commandId, 'CAPACITY_EXCEEDED'))
    }
    if (this.pending.has(command.commandId)) {
      return Promise.resolve(
        createKeyringCommandFailure(command.commandId, 'SIGNING_COMMAND_CONFLICT')
      )
    }

    const worker = this.ensureWorker()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.failWorker(command.commandId, 'COMMAND_TIMEOUT')
      }, command.deadlineAt - Date.now())
      this.pending.set(command.commandId, { command, resolve, timer })
      worker.postMessage({ id: command.commandId, command })
    })
  }

  abort(commandId: unknown): boolean {
    if (typeof commandId !== 'string') return false
    const pending = this.pending.get(commandId as KeyringCommandId)
    if (!pending) return false
    this.failWorker(pending.command.commandId, 'SIGNING_COMMAND_CANCELLED')
    return true
  }

  restart(): void {
    this.failAll('WORKER_CRASHED')
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.failAll('WORKER_UNAVAILABLE')
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./multichain.worker.ts', import.meta.url), {
      type: 'module'
    })
    worker.onmessage = event => this.handleMessage(event.data)
    worker.onerror = event => {
      event.preventDefault()
      this.failAll('WORKER_CRASHED')
    }
    worker.onmessageerror = () => this.failAll('WORKER_CRASHED')
    this.worker = worker
    return worker
  }

  private handleMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.id !== 'string') {
      this.failAll('WORKER_CRASHED')
      return
    }
    const pending = this.pending.get(value.id as KeyringCommandId)
    if (!pending) return
    const keys = Object.keys(value)
    if (
      keys.length !== 2 ||
      (!Object.prototype.hasOwnProperty.call(value, 'result') &&
        !Object.prototype.hasOwnProperty.call(value, 'error'))
    ) {
      this.failAll('WORKER_CRASHED')
      return
    }

    let result: KeyringCommandResult
    if (Object.prototype.hasOwnProperty.call(value, 'error')) {
      if (!isKeyringErrorCode(value.error)) {
        this.failAll('WORKER_CRASHED')
        return
      }
      result = createKeyringCommandFailure(pending.command.commandId, value.error)
    } else {
      try {
        result = parseKeyringCommandResult(
          value.result,
          pending.command.commandId,
          response => response
        )
      } catch {
        this.failAll('WORKER_CRASHED')
        return
      }
    }
    clearTimeout(pending.timer)
    this.pending.delete(pending.command.commandId)
    pending.resolve(result)
  }

  private failWorker(commandId: KeyringCommandId, targetCode: KeyringErrorCode): void {
    const target = this.pending.get(commandId)
    this.terminateWorker()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(
        createKeyringCommandFailure(
          pending.command.commandId,
          pending === target ? targetCode : 'WORKER_CRASHED'
        )
      )
    }
    this.pending.clear()
  }

  private failAll(code: KeyringErrorCode): void {
    this.terminateWorker()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(createKeyringCommandFailure(pending.command.commandId, code))
    }
    this.pending.clear()
  }

  private terminateWorker(): void {
    this.worker?.terminate()
    this.worker = undefined
  }
}
