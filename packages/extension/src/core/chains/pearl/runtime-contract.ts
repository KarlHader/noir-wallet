export const PEARL_WALLET_RUNTIME_ERROR_CODES = Object.freeze([
  'unavailable',
  'account-unavailable',
  'expired',
  'invalid-request',
  'network-unavailable',
  'insufficient-funds',
  'request-failed'
] as const)

export type PearlWalletRuntimeErrorCode = (typeof PEARL_WALLET_RUNTIME_ERROR_CODES)[number]

export interface PearlWalletRuntimeError {
  readonly code: PearlWalletRuntimeErrorCode
  readonly message: string
}

const ERROR_MESSAGES: Readonly<Record<PearlWalletRuntimeErrorCode, string>> = Object.freeze({
  unavailable: 'Pearl wallet support is unavailable',
  'account-unavailable': 'The active Account has no Pearl account',
  expired: 'The Pearl signing request expired',
  'invalid-request': 'The Pearl wallet request is invalid',
  'network-unavailable': 'The Pearl network is unavailable',
  'insufficient-funds': 'The Pearl balance is insufficient',
  'request-failed': 'The Pearl wallet request failed'
})

export function createPearlWalletRuntimeError(
  code: PearlWalletRuntimeErrorCode
): PearlWalletRuntimeError {
  return Object.freeze({ code, message: ERROR_MESSAGES[code] })
}
