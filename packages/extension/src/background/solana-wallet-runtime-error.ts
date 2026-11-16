import { createSolanaWalletRuntimeError, type SolanaWalletRuntimeError } from '@/core/chains/solana'
import { SolanaRpcError, SolanaTransferError } from '@/infrastructure/chains/solana'

export function mapSolanaWalletRuntimeError(error: unknown): SolanaWalletRuntimeError {
  if (error instanceof SolanaTransferError && error.code === 'insufficient-funds') {
    return createSolanaWalletRuntimeError('insufficient-funds')
  }
  if (
    error instanceof SolanaRpcError &&
    (error.code === 'timeout' ||
      error.code === 'network-unavailable' ||
      error.code === 'rate-limited')
  ) {
    return createSolanaWalletRuntimeError('network-unavailable')
  }
  if (error instanceof Error && /no Solana ChainAccount/i.test(error.message)) {
    return createSolanaWalletRuntimeError('account-unavailable')
  }
  if (error instanceof Error && /expired/i.test(error.message)) {
    return createSolanaWalletRuntimeError('expired')
  }
  if (
    error instanceof Error &&
    (/invalid Solana transfer intent/i.test(error.message) ||
      /asset does not match/i.test(error.message) ||
      /fingerprint does not match/i.test(error.message))
  ) {
    return createSolanaWalletRuntimeError('invalid-request')
  }
  return createSolanaWalletRuntimeError('request-failed')
}
