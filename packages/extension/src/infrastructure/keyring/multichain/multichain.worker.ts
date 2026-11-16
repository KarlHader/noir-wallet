import type { KeyringCommand, KeyringErrorCode } from '@/core/keyring/ports'
import { MultichainWorkerRuntime } from './worker-runtime'
import {
  createPinnedMultichainEngine,
  PINNED_MULTICHAIN_ABI_VERSION,
  PINNED_MULTICHAIN_CAPABILITIES,
  PINNED_MULTICHAIN_SOURCE_COMMIT
} from './pinned-wasm-engine'

interface WorkerRequest {
  readonly id: string
  readonly command: KeyringCommand
}

interface WorkerResponse {
  readonly id: string
  readonly result?: unknown
  readonly error?: KeyringErrorCode
}

interface DedicatedWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(message: WorkerResponse): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseWorkerRequest(value: unknown): WorkerRequest {
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new Error('Invalid Multichain Worker request')
  }
  if (typeof value.id !== 'string' || !isRecord(value.command)) {
    throw new Error('Invalid Multichain Worker request')
  }
  return { id: value.id, command: value.command as unknown as KeyringCommand }
}

async function createRuntime(): Promise<MultichainWorkerRuntime> {
  return new MultichainWorkerRuntime(await createPinnedMultichainEngine(), {
    abiVersion: PINNED_MULTICHAIN_ABI_VERSION,
    sourceCommit: PINNED_MULTICHAIN_SOURCE_COMMIT,
    capabilities: PINNED_MULTICHAIN_CAPABILITIES
  })
}

const scope = globalThis as unknown as DedicatedWorkerScope
const runtime = createRuntime()

scope.addEventListener('message', event => {
  let request: WorkerRequest
  try {
    request = parseWorkerRequest(event.data)
  } catch {
    return
  }
  void runtime
    .then(value => value.execute(request.command))
    .then(result => scope.postMessage({ id: request.id, result }))
    .catch(() => scope.postMessage({ id: request.id, error: 'INTEGRITY_FAILURE' }))
})
