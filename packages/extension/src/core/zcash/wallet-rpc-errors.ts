import { MIN_SHIELDING_BALANCE_MESSAGE } from './shielding'
import { isRpcEndpointError } from '@/lib/errors'

export const WALLET_BUSY_MESSAGE = 'Wallet is temporarily busy. Please try again in a moment.'
export const RPC_ENDPOINT_UNAVAILABLE_MESSAGE =
  'The wallet RPC endpoint is unavailable. Try again or switch RPC endpoint in Settings.'

export function isSyncBusyError(message: string): boolean {
  return message.includes('SYNC_BUSY')
}

export function isStaleWalletRpcError(message: string): boolean {
  return message.includes('STALE_WALLET_RPC')
}

export function isWalletDirtyError(message: string): boolean {
  return message.includes('WALLET_DIRTY')
}

export function isWalletNotInitializedError(message: string): boolean {
  return message.includes('Wallet not initialized:')
}

/**
 * WASM rejects creating an account whose name already exists. This surfaces when
 * concurrent unlock/sync flows both try to create the same account; the account
 * is present, so callers can safely adopt the existing one.
 */
export function isAccountAlreadyExistsError(message: string): boolean {
  return /already exists/i.test(message)
}

export function isRetryableWalletRpcError(message: string): boolean {
  return (
    isSyncBusyError(message) ||
    isStaleWalletRpcError(message) ||
    isWalletDirtyError(message) ||
    isWalletNotInitializedError(message)
  )
}

export function getRetryableWalletRpcUserMessage(message: string): string {
  if (/shield(?:ing)?[\s\S]*InsufficientFunds/i.test(message)) {
    return MIN_SHIELDING_BALANCE_MESSAGE
  }
  if (isRetryableWalletRpcError(message)) return WALLET_BUSY_MESSAGE
  return isRpcEndpointError(message) ? RPC_ENDPOINT_UNAVAILABLE_MESSAGE : message
}
