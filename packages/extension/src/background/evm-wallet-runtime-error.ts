import { createEvmWalletRuntimeError, type EvmWalletRuntimeError } from '@/core/chains/evm'
import { KeyringError } from '@/core/keyring/ports'
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
  if (error instanceof KeyringError) {
    if (error.code === 'SIGNING_COMMAND_EXPIRED') return createEvmWalletRuntimeError('expired')
    if (error.code === 'SIGNING_COMMAND_NOT_FOUND' || error.code === 'SIGNING_COMMAND_CANCELLED') {
      return createEvmWalletRuntimeError('review-unavailable')
    }
  }
  if (
    error instanceof Error &&
    error.message === 'RHEA Swap quote expired. Get a new quote and review it again.'
  ) {
    return createEvmWalletRuntimeError('quote-expired')
  }
  if (error instanceof Error && /expired/i.test(error.message)) {
    return createEvmWalletRuntimeError('expired')
  }
  if (
    error instanceof Error &&
    [
      'Pending EVM transfer was not found',
      'EVM transfer is already signed; resume its broadcast instead',
      'EVM transfer is already awaiting an external signature'
    ].includes(error.message)
  ) {
    return createEvmWalletRuntimeError('review-unavailable')
  }
  return createEvmWalletRuntimeError('request-failed')
}
