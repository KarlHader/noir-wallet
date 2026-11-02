import { createEvmWalletRuntimeError, type EvmWalletRuntimeError } from '@/core/chains/evm'
import { EvmRpcError, EvmTransactionError } from '@/infrastructure/chains/evm'

export function mapEvmWalletRuntimeError(error: unknown): EvmWalletRuntimeError {
  if (error instanceof EvmTransactionError && error.code === 'insufficient-funds') {
    const canonical = createEvmWalletRuntimeError('insufficient-funds')
    return error.insufficientFunds && BigInt(error.insufficientFunds.maximumGasCostRaw) > 0n
      ? Object.freeze({ ...canonical, shortfallRaw: error.insufficientFunds.shortfallRaw })
      : canonical
  }
  if (error instanceof EvmTransactionError && error.code === 'invalid-intent') {
    if (error.message === 'EVM transfer asset is not listed') {
      return createEvmWalletRuntimeError('asset-unavailable')
    }
    return createEvmWalletRuntimeError('invalid-request')
  }
  if (error instanceof EvmTransactionError && error.code === 'simulation-failed') {
    return createEvmWalletRuntimeError('simulation-failed')
  }
  if (error instanceof EvmTransactionError && error.code === 'nonce-recovery-required') {
    return createEvmWalletRuntimeError('nonce-recovery-required')
  }
  if (
    error instanceof EvmRpcError &&
    (error.code === 'timeout' ||
      error.code === 'network-unavailable' ||
      error.code === 'rate-limited')
  ) {
    return createEvmWalletRuntimeError('network-unavailable')
  }
  if (error instanceof Error && /no EVM ChainAccount/i.test(error.message)) {
    return createEvmWalletRuntimeError('account-unavailable')
  }
  if (error instanceof Error && /Wallet (?:is )?locked|credential session/i.test(error.message)) {
    return createEvmWalletRuntimeError('wallet-locked')
  }
  if (error instanceof Error && /expired/i.test(error.message)) {
    return createEvmWalletRuntimeError('expired')
  }
  return createEvmWalletRuntimeError('request-failed')
}
