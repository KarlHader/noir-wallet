import {
  createBitcoinWalletRuntimeError,
  type BitcoinWalletRuntimeError
} from '@/core/chains/bitcoin'
import {
  BitcoinDiscoveryError,
  BitcoinRpcError,
  BitcoinTransactionBuildError
} from '@/infrastructure/chains/bitcoin'

export function mapBitcoinWalletRuntimeError(error: unknown): BitcoinWalletRuntimeError {
  if (error instanceof BitcoinTransactionBuildError) {
    if (error.code === 'invalid-intent') {
      return createBitcoinWalletRuntimeError('invalid-request')
    }
    if (error.code === 'insufficient-funds') {
      return createBitcoinWalletRuntimeError('insufficient-funds')
    }
  }
  if (
    (error instanceof BitcoinRpcError &&
      (error.code === 'timeout' ||
        error.code === 'network-unavailable' ||
        error.code === 'rate-limited')) ||
    (error instanceof BitcoinDiscoveryError && error.code === 'rpc-failure')
  ) {
    return createBitcoinWalletRuntimeError('network-unavailable')
  }
  if (error instanceof Error && /no Bitcoin ChainAccount/i.test(error.message)) {
    return createBitcoinWalletRuntimeError('account-unavailable')
  }
  if (error instanceof Error && /expired/i.test(error.message)) {
    return createBitcoinWalletRuntimeError('expired')
  }
  return createBitcoinWalletRuntimeError('request-failed')
}
