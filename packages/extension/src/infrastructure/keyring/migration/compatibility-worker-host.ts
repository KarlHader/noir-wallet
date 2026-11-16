import {
  parseCompatibilityWorkerRequest,
  parseCompatibilityWorkerResponse,
  type CompatibilityWorkerErrorCode,
  type CompatibilityWorkerRequest,
  type CompatibilityWorkerResult
} from './compatibility-worker-protocol'

const DEFAULT_TIMEOUT_MS = 120_000

export class CompatibilityWorkerError extends Error {
  constructor(readonly code: CompatibilityWorkerErrorCode) {
    super(`Credential compatibility migration failed: ${code}`)
    this.name = 'CompatibilityWorkerError'
  }
}

export class CompatibilityWorkerHost {
  async migrate(
    input: Omit<CompatibilityWorkerRequest, 'id'>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<CompatibilityWorkerResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
      throw new CompatibilityWorkerError('INVALID_REQUEST')
    }
    const request = parseCompatibilityWorkerRequest({
      id: `compatibility-migration:${crypto.randomUUID()}`,
      ...input
    })
    const worker = new Worker(new URL('./compatibility.worker.ts', import.meta.url), {
      type: 'module'
    })
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (operation: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.terminate()
        operation()
      }
      const timer = setTimeout(
        () => finish(() => reject(new CompatibilityWorkerError('TIMEOUT'))),
        timeoutMs
      )
      worker.onmessage = event => {
        try {
          const response = parseCompatibilityWorkerResponse(event.data)
          if (response.id !== request.id) {
            throw new Error('Compatibility Worker response id mismatch')
          }
          if ('error' in response) {
            finish(() => reject(new CompatibilityWorkerError(response.error)))
          } else {
            finish(() => resolve(response.result))
          }
        } catch {
          finish(() => reject(new CompatibilityWorkerError('MIGRATION_FAILED')))
        }
      }
      worker.onerror = event => {
        event.preventDefault()
        finish(() => reject(new CompatibilityWorkerError('MIGRATION_FAILED')))
      }
      worker.onmessageerror = () =>
        finish(() => reject(new CompatibilityWorkerError('MIGRATION_FAILED')))
      worker.postMessage(request)
    })
  }
}
