export const NEAR_WALLET_RUNTIME_ERROR_CODES = Object.freeze([
  'unavailable',
  'account-unavailable',
  'expired',
  'invalid-request',
  'network-unavailable',
  'insufficient-funds',
  'request-failed'
] as const)

export type NearWalletRuntimeErrorCode = (typeof NEAR_WALLET_RUNTIME_ERROR_CODES)[number]

export interface NearWalletRuntimeError {
  readonly code: NearWalletRuntimeErrorCode
  readonly message: string
}

const ERROR_MESSAGES: Readonly<Record<NearWalletRuntimeErrorCode, string>> = Object.freeze({
  unavailable: 'NEAR wallet support is unavailable',
  'account-unavailable': 'The active Account has no usable NEAR account',
  expired: 'The NEAR signing request expired',
  'invalid-request': 'The NEAR wallet request is invalid',
  'network-unavailable': 'The NEAR network is unavailable',
  'insufficient-funds': 'The NEAR balance is insufficient',
  'request-failed': 'The NEAR wallet request failed'
})

export function createNearWalletRuntimeError(
  code: NearWalletRuntimeErrorCode
): NearWalletRuntimeError {
  return Object.freeze({ code, message: ERROR_MESSAGES[code] })
}
