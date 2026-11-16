import { parseStorageV2GenerationId } from '@/infrastructure/persistence/schema'
import type { StorageV2GenerationId } from '@/ports/repositories'

type RuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

export interface NativeHardwareWalletMutationResult {
  readonly status: 'renamed' | 'already-renamed'
  readonly generationId: StorageV2GenerationId
}

export class NativeHardwareWalletClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeHardwareWalletClientError'
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NativeHardwareWalletClientError(`${label} is invalid`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NativeHardwareWalletClientError(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function runtimeError(response: Record<string, unknown>, fallback: string): never {
  if (
    typeof response.error === 'string' &&
    response.error.length > 0 &&
    response.error.length <= 512
  ) {
    throw new NativeHardwareWalletClientError(response.error)
  }
  throw new NativeHardwareWalletClientError(fallback)
}

export function createNativeHardwareWalletClient(
  send: RuntimeMessenger = message => chrome.runtime.sendMessage(message)
) {
  return Object.freeze({
    async renameWallet(
      walletId: string,
      displayName: string
    ): Promise<NativeHardwareWalletMutationResult> {
      const response = readRecord(
        await send({ type: 'RENAME_WALLET', walletId, displayName }),
        'Wallet rename response'
      )
      if (response.success !== true) runtimeError(response, 'Wallet rename failed')
      if (
        Object.keys(response).length !== 2 ||
        !Object.prototype.hasOwnProperty.call(response, 'result')
      ) {
        throw new NativeHardwareWalletClientError('Wallet rename response is invalid')
      }
      const result = readRecord(response.result, 'Wallet rename result')
      if (
        Object.keys(result).length !== 2 ||
        (result.status !== 'renamed' && result.status !== 'already-renamed')
      ) {
        throw new NativeHardwareWalletClientError('Wallet rename result is invalid')
      }
      const generationId = parseStorageV2GenerationId(result.generationId)
      if (!/^storage-v2:wallet-metadata:[a-f0-9]{64}$/.test(generationId)) {
        throw new NativeHardwareWalletClientError('Wallet rename result is invalid')
      }
      return Object.freeze({ status: result.status, generationId })
    },

    async removeWallet(walletId: string): Promise<void> {
      const response = readRecord(
        await send({ type: 'REMOVE_WALLET', walletId }),
        'Wallet removal response'
      )
      if (response.success !== true) runtimeError(response, 'Wallet removal failed')
      if (Object.keys(response).length !== 1) {
        throw new NativeHardwareWalletClientError('Wallet removal response is invalid')
      }
    }
  })
}

export const nativeHardwareWalletClient = createNativeHardwareWalletClient()
