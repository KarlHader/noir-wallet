import { getNoirWallet } from '@noir-wallet/sdk'
import { shieldErrorFromProviderFailure } from './provider-error'
import { ShieldError, type ShieldErrorCode } from './types'

interface ShieldRequestArguments {
  readonly method: string
  readonly params?: Readonly<Record<string, unknown>>
}

interface RawShieldWallet {
  readonly shield?: {
    readonly request?: (args: ShieldRequestArguments) => Promise<unknown>
  }
}

function providerError(error: unknown): ShieldError {
  if (error instanceof ShieldError) return error
  const code =
    error && typeof error === 'object' && 'code' in error ? Reflect.get(error, 'code') : undefined
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'Noir Wallet could not complete the Shield request.'
  return shieldErrorFromProviderFailure(code, message)
}

/** Send a Shield request through the injected wallet discovered by getNoirWallet(). */
export async function sendShieldRequest<T>(method: string, params?: object): Promise<T> {
  if (getNoirWallet() === null) {
    throw new ShieldError('NOT_INSTALLED', 'Noir Wallet is not installed.')
  }
  const raw =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { noirwallet?: RawShieldWallet }).noirwallet
  if (!raw?.shield || typeof raw.shield.request !== 'function') {
    throw new ShieldError('UNSUPPORTED', 'This Noir Wallet build does not support Shield requests.')
  }
  try {
    return (await raw.shield.request({
      method,
      ...(params === undefined ? {} : { params: params as Readonly<Record<string, unknown>> })
    })) as T
  } catch (error) {
    throw providerError(error)
  }
}

export function shieldErrorCode(error: unknown): ShieldErrorCode | undefined {
  return error instanceof ShieldError ? error.code : undefined
}
