import { MIN_SHIELDING_BALANCE_MESSAGE } from './shielding'
import { isRpcEndpointError } from '@/lib/errors'

export const WALLET_BUSY_MESSAGE = 'Wallet is temporarily busy. Please try again in a moment.'
export const RPC_ENDPOINT_UNAVAILABLE_MESSAGE =
  'The wallet RPC endpoint is unavailable. Try again or switch RPC endpoint in Settings.'
export const ZCASH_SPENDABILITY_UNVERIFIED =
  'Unable to verify Zcash spendable balance. Please try again.'

export function classifyZcashInsufficientFunds(
  message: string,
  scanned: number | undefined,
  tip: number | undefined,
  walletTip: number | undefined
): string {
  if (
    !scanned ||
    !Number.isSafeInteger(scanned) ||
    scanned < 0 ||
    !tip ||
    !Number.isSafeInteger(tip) ||
    tip < 0 ||
    !walletTip ||
    !Number.isSafeInteger(walletTip) ||
    walletTip < 0
  ) {
    return ZCASH_SPENDABILITY_UNVERIFIED
  }
  return scanned < Math.max(tip, walletTip) ? 'SYNC_BUSY: wallet sync in progress' : message
}

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
  if (isSyncBusyError(message)) return 'Wallet is syncing. Please try again after sync completes.'
  if (/shield(?:ing)?[\s\S]*InsufficientFunds/i.test(message)) {
    return MIN_SHIELDING_BALANCE_MESSAGE
  }
  if (isRetryableWalletRpcError(message)) return WALLET_BUSY_MESSAGE
  return isRpcEndpointError(message) ? RPC_ENDPOINT_UNAVAILABLE_MESSAGE : message
}
