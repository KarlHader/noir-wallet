export const BITCOIN_WALLET_RUNTIME_ERROR_CODES = Object.freeze([
  'unavailable',
  'account-unavailable',
  'expired',
  'invalid-request',
  'network-unavailable',
  'insufficient-funds',
  'request-failed'
] as const)

export type BitcoinWalletRuntimeErrorCode = (typeof BITCOIN_WALLET_RUNTIME_ERROR_CODES)[number]

export interface BitcoinWalletRuntimeError {
  readonly code: BitcoinWalletRuntimeErrorCode
  readonly message: string
}

const ERROR_MESSAGES: Readonly<Record<BitcoinWalletRuntimeErrorCode, string>> = Object.freeze({
  unavailable: 'Bitcoin wallet support is unavailable',
  'account-unavailable': 'The active Account has no Bitcoin account',
  expired: 'The Bitcoin signing request expired',
  'invalid-request': 'The Bitcoin wallet request is invalid',
  'network-unavailable': 'The Bitcoin network is unavailable',
  'insufficient-funds': 'The Bitcoin balance is insufficient',
  'request-failed': 'The Bitcoin wallet request failed'
})

export function createBitcoinWalletRuntimeError(
  code: BitcoinWalletRuntimeErrorCode
): BitcoinWalletRuntimeError {
  return Object.freeze({ code, message: ERROR_MESSAGES[code] })
}
