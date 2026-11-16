export const SOLANA_WALLET_RUNTIME_ERROR_CODES = Object.freeze([
  'unavailable',
  'account-unavailable',
  'expired',
  'invalid-request',
  'network-unavailable',
  'insufficient-funds',
  'request-failed'
] as const)

export type SolanaWalletRuntimeErrorCode = (typeof SOLANA_WALLET_RUNTIME_ERROR_CODES)[number]

export interface SolanaWalletRuntimeError {
  readonly code: SolanaWalletRuntimeErrorCode
  readonly message: string
}

const ERROR_MESSAGES: Readonly<Record<SolanaWalletRuntimeErrorCode, string>> = Object.freeze({
  unavailable: 'Solana wallet support is unavailable',
  'account-unavailable': 'The active Account has no Solana account',
  expired: 'The Solana signing request expired',
  'invalid-request': 'The Solana wallet request is invalid',
  'network-unavailable': 'The Solana network is unavailable',
  'insufficient-funds': 'The Solana balance is insufficient',
  'request-failed': 'The Solana wallet request failed'
})

export function createSolanaWalletRuntimeError(
  code: SolanaWalletRuntimeErrorCode
): SolanaWalletRuntimeError {
  return Object.freeze({ code, message: ERROR_MESSAGES[code] })
}
