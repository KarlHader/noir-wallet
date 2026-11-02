export const EVM_WALLET_RUNTIME_ERROR_CODES = Object.freeze([
  'unavailable',
  'account-unavailable',
  'wallet-locked',
  'expired',
  'invalid-request',
  'asset-unavailable',
  'insufficient-funds',
  'simulation-failed',
  'network-unavailable',
  'nonce-recovery-required',
  'request-failed'
] as const)

export type EvmWalletRuntimeErrorCode = (typeof EVM_WALLET_RUNTIME_ERROR_CODES)[number]

export interface EvmWalletRuntimeError {
  readonly code: EvmWalletRuntimeErrorCode
  readonly message: string
  readonly shortfallRaw?: string
}

export type EvmWalletRuntimeResponse<T> =
  | { readonly result: T }
  | { readonly error: EvmWalletRuntimeError }

const ERROR_MESSAGES: Readonly<Record<EvmWalletRuntimeErrorCode, string>> = Object.freeze({
  unavailable: 'EVM wallet support is unavailable',
  'account-unavailable': 'The active Account has no EVM account',
  'wallet-locked': 'Wallet is locked',
  expired: 'The EVM signing request expired',
  'invalid-request': 'The EVM wallet request is invalid',
  'asset-unavailable': 'The selected EVM asset is unavailable',
  'insufficient-funds': 'The EVM balance is insufficient',
  'simulation-failed': 'The EVM transaction failed simulation',
  'network-unavailable': 'The EVM network is unavailable',
  'nonce-recovery-required': 'Resolve the current EVM nonce before sending another transaction',
  'request-failed': 'The EVM wallet request failed'
})

export function createEvmWalletRuntimeError(
  code: EvmWalletRuntimeErrorCode
): EvmWalletRuntimeError {
  return Object.freeze({ code, message: ERROR_MESSAGES[code] })
}
