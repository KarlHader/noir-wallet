export const QUANTUS_WALLET_RUNTIME_ERROR_CODES = Object.freeze([
  'unavailable',
  'account-unavailable',
  'expired',
  'invalid-request',
  'network-unavailable',
  'insufficient-funds',
  'fee-limit-exceeded',
  'signature-pending',
  'request-failed'
] as const)

export type QuantusWalletRuntimeErrorCode = (typeof QUANTUS_WALLET_RUNTIME_ERROR_CODES)[number]

export interface QuantusWalletRuntimeError {
  readonly code: QuantusWalletRuntimeErrorCode
  readonly message: string
}

const ERROR_MESSAGES: Readonly<Record<QuantusWalletRuntimeErrorCode, string>> = Object.freeze({
  unavailable: 'Quantus wallet support is unavailable',
  'account-unavailable': 'The active Account has no Quantus account',
  expired: 'The Quantus signing request expired',
  'invalid-request': 'The Quantus wallet request is invalid',
  'network-unavailable': 'The Quantus network is unavailable',
  'insufficient-funds': 'The Quantus balance is insufficient',
  'fee-limit-exceeded': 'The Quantus network fee exceeded the reviewed maximum',
  'signature-pending': 'A signed Quantus transfer is still pending for this account',
  'request-failed': 'The Quantus wallet request failed'
})

export function createQuantusWalletRuntimeError(
  code: QuantusWalletRuntimeErrorCode
): QuantusWalletRuntimeError {
  return Object.freeze({ code, message: ERROR_MESSAGES[code] })
}
