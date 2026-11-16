import { createNearWalletRuntimeError, type NearWalletRuntimeError } from '@/core/chains/near'
import { NearRpcError, NearTransferError } from '@/infrastructure/chains/near'

export function mapNearWalletRuntimeError(error: unknown): NearWalletRuntimeError {
  if (error instanceof NearTransferError) {
    if (error.code === 'insufficient-funds') {
      return createNearWalletRuntimeError('insufficient-funds')
    }
    if (
      error.code === 'sender-not-found' ||
      error.code === 'access-key-not-found' ||
      error.code === 'access-key-not-full-access'
    ) {
      return createNearWalletRuntimeError('account-unavailable')
    }
    if (error.code === 'recipient-not-found') {
      return createNearWalletRuntimeError('invalid-request')
    }
  }
  if (
    error instanceof NearRpcError &&
    (error.code === 'timeout' ||
      error.code === 'network-unavailable' ||
      error.code === 'rate-limited')
  ) {
    return createNearWalletRuntimeError('network-unavailable')
  }
  if (error instanceof Error && /no (?:usable )?NEAR ChainAccount/i.test(error.message)) {
    return createNearWalletRuntimeError('account-unavailable')
  }
  if (error instanceof Error && /expired/i.test(error.message)) {
    return createNearWalletRuntimeError('expired')
  }
  if (
    error instanceof Error &&
    (/invalid NEAR transfer intent/i.test(error.message) ||
      /asset does not match/i.test(error.message) ||
      /fingerprint does not match/i.test(error.message))
  ) {
    return createNearWalletRuntimeError('invalid-request')
  }
  return createNearWalletRuntimeError('request-failed')
}
