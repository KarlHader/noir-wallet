import {
  createQuantusWalletRuntimeError,
  type QuantusWalletRuntimeError
} from '@/core/chains/quantus'
import { QuantusRpcError, QuantusTransferError } from '@/infrastructure/chains/quantus'

export function mapQuantusWalletRuntimeError(error: unknown): QuantusWalletRuntimeError {
  if (error instanceof QuantusTransferError) {
    if (error.code === 'insufficient-funds' || error.code === 'keep-alive-would-drain') {
      return createQuantusWalletRuntimeError('insufficient-funds')
    }
    if (error.code === 'nonce-reserved') {
      return createQuantusWalletRuntimeError('signature-pending')
    }
    if (error.code === 'stale-account-index') {
      return createQuantusWalletRuntimeError('request-failed')
    }
  }
  if (
    error instanceof QuantusRpcError &&
    (error.code === 'timeout' ||
      error.code === 'network-unavailable' ||
      error.code === 'rate-limited' ||
      error.code === 'chain-mismatch')
  ) {
    return createQuantusWalletRuntimeError('network-unavailable')
  }
  if (error instanceof Error && /no Quantus ChainAccount/i.test(error.message)) {
    return createQuantusWalletRuntimeError('account-unavailable')
  }
  if (
    error instanceof Error &&
    (/fee ceiling/i.test(error.message) || /network fee exceeded/i.test(error.message))
  ) {
    return createQuantusWalletRuntimeError('fee-limit-exceeded')
  }
  if (error instanceof Error && /expired/i.test(error.message)) {
    return createQuantusWalletRuntimeError('expired')
  }
  if (
    error instanceof Error &&
    (/invalid Quantus transfer intent/i.test(error.message) ||
      /fingerprint does not match/i.test(error.message) ||
      /does not match the reviewed/i.test(error.message) ||
      /cannot sign Quantus/i.test(error.message))
  ) {
    return createQuantusWalletRuntimeError('invalid-request')
  }
  return createQuantusWalletRuntimeError('request-failed')
}
