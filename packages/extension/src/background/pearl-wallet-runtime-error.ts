import { createPearlWalletRuntimeError, type PearlWalletRuntimeError } from '@/core/chains/pearl'
import { KeyringError } from '@/core/keyring/protocol/errors'
import {
  PearlDiscoveryError,
  PearlRpcError,
  PearlTransactionBuildError
} from '@/infrastructure/chains/pearl'

export function mapPearlWalletRuntimeError(error: unknown): PearlWalletRuntimeError {
  if (error instanceof PearlTransactionBuildError) {
    if (error.code === 'invalid-intent') {
      return createPearlWalletRuntimeError('invalid-request')
    }
    if (error.code === 'insufficient-funds') {
      return createPearlWalletRuntimeError('insufficient-funds')
    }
  }
  if (
    (error instanceof PearlRpcError &&
      (error.code === 'network-unavailable' ||
        error.code === 'rate-limited' ||
        error.code === 'chain-mismatch')) ||
    (error instanceof PearlDiscoveryError && error.code === 'rpc-failure')
  ) {
    return createPearlWalletRuntimeError('network-unavailable')
  }
  if (isKeyringErrorLike(error) && Reflect.get(error, 'code') === 'CREDENTIAL_LOCKED') {
    return createPearlWalletRuntimeError('account-unavailable')
  }
  if (error instanceof Error && /no Pearl ChainAccount/i.test(error.message)) {
    return createPearlWalletRuntimeError('account-unavailable')
  }
  if (
    (isKeyringErrorLike(error) && Reflect.get(error, 'code') === 'SIGNING_COMMAND_EXPIRED') ||
    (error instanceof Error && /expired/i.test(error.message))
  ) {
    return createPearlWalletRuntimeError('expired')
  }
  return createPearlWalletRuntimeError('request-failed')
}

function isKeyringErrorLike(
  error: unknown
): error is { readonly name: string; readonly message: string; readonly code: string } {
  if (error instanceof KeyringError) return true
  // Chunk boundaries can break `instanceof`; duck-type the stable keyring envelope.
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'name') === 'KeyringError' &&
    typeof Reflect.get(error, 'message') === 'string' &&
    typeof Reflect.get(error, 'code') === 'string'
  )
}

function sanitizePearlPrepareDetail(message: string): string {
  return message
    .replace(/\b(?:t|r)?prl1[a-z0-9]{8,}\b/gi, '[address]')
    .replace(/\b0x[0-9a-f]+\b/gi, '[hex]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[id]')
    .trim()
}

/** Safe prepare-stage detail for dApp errors; never includes addresses or raw payloads. */
export function pearlPrepareFailureMessage(
  error: unknown,
  mapped: PearlWalletRuntimeError
): string {
  if (isKeyringErrorLike(error)) {
    const detail = Reflect.get(error, 'detail')
    if (typeof detail === 'string' && detail.trim().length > 0) {
      const sanitizedDetail = sanitizePearlPrepareDetail(detail)
      if (sanitizedDetail.length > 0 && sanitizedDetail.length <= 180) return sanitizedDetail
    }
    return error.message
  }
  if (!(error instanceof Error) || error.message.trim().length === 0) return mapped.message
  const sanitized = sanitizePearlPrepareDetail(error.message)
  if (sanitized.length === 0 || sanitized.length > 180) return mapped.message
  return sanitized
}
