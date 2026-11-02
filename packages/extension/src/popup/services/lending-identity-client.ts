import type { LendingSigningMode } from '@/core/services/lending-service'

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function parsePublicKeyResponse(value: unknown): string {
  const response = readRecord(value, 'Lending identity response')
  if (typeof response.error === 'string') throw new Error(response.error)
  const result = readRecord(response.result, 'Zcash lending identity')
  if (
    Object.keys(result).length !== 1 ||
    typeof result.publicKey !== 'string' ||
    result.publicKey.length === 0
  ) {
    throw new Error('Zcash lending identity is invalid')
  }
  return result.publicKey
}

async function getZcashPublicKey(
  walletId: string,
  accountId: string,
  signingMode: LendingSigningMode
): Promise<string> {
  return parsePublicKeyResponse(
    await chrome.runtime.sendMessage({
      type: 'GET_ZCASH_LENDING_PUBLIC_KEY',
      walletId,
      accountId,
      signingMode
    })
  )
}

export const lendingIdentityClient = Object.freeze({ getZcashPublicKey })
