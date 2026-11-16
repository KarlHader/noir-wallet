import type { CredentialCapsulePort } from './credential-session-host'
import {
  parseEncryptedCredentialCapsule,
  type CredentialSessionUnlockCredential,
  type EncryptedCredentialCapsule
} from './credential-session-protocol'

const TIMEOUT_MS = 120_000

type WorkerResponse =
  | Readonly<{ id: string; result: unknown }>
  | Readonly<{ id: string; error: string }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class CredentialCapsuleWorkerHost implements CredentialCapsulePort {
  seal(
    masterKey: CryptoKey,
    globalUnlockEpoch: string,
    password: string,
    credentials: readonly CredentialSessionUnlockCredential[]
  ): Promise<readonly EncryptedCredentialCapsule[]> {
    return this.execute(
      {
        operation: 'seal',
        masterKey,
        globalUnlockEpoch,
        password,
        credentials
      },
      value => {
        if (
          !Array.isArray(value) ||
          value.length !== credentials.filter(item => item.zcashEnvelope).length
        ) {
          throw new Error('Credential capsule Worker returned an incomplete result')
        }
        return Object.freeze(value.map(parseEncryptedCredentialCapsule))
      }
    )
  }

  private execute<TResult>(
    input: Readonly<Record<string, unknown>>,
    parseResult: (value: unknown) => TResult
  ): Promise<TResult> {
    const id = `credential-capsule:${crypto.randomUUID()}`
    const worker = new Worker(new URL('./credential-capsule.worker.ts', import.meta.url), {
      type: 'module'
    })
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (operation: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        worker.terminate()
        operation()
      }
      const timeout = setTimeout(
        () => finish(() => reject(new Error('Credential capsule Worker timeout'))),
        TIMEOUT_MS
      )
      worker.onmessage = event => {
        const response: unknown = event.data
        if (!isRecord(response) || response.id !== id) {
          finish(() => reject(new Error('Invalid credential capsule Worker response')))
          return
        }
        const keys = Object.keys(response)
        if (
          keys.length !== 2 ||
          (!Object.prototype.hasOwnProperty.call(response, 'result') &&
            !Object.prototype.hasOwnProperty.call(response, 'error'))
        ) {
          finish(() => reject(new Error('Invalid credential capsule Worker response')))
          return
        }
        if (typeof (response as WorkerResponse & { error?: unknown }).error === 'string') {
          finish(() => reject(new Error('Credential capsule operation failed')))
          return
        }
        try {
          const result = parseResult(response.result)
          finish(() => resolve(result))
        } catch {
          finish(() => reject(new Error('Invalid credential capsule Worker response')))
        }
      }
      worker.onerror = event => {
        event.preventDefault()
        finish(() => reject(new Error('Credential capsule Worker failed')))
      }
      worker.onmessageerror = () =>
        finish(() => reject(new Error('Credential capsule Worker failed')))
      worker.postMessage({ id, ...input })
    })
  }
}
