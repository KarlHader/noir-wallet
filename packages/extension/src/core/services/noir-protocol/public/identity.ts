import type { ZcashWalletCore } from '@/core/zcash/wallet-core'

// A reserved purpose account keeps Public identities separate from Lending's
// 2147483647 account. The external child binds the identity to its HD account.
export const PUBLIC_IDENTITY_ACCOUNT_INDEX = 2_147_483_646

export function publicIdentityAddressIndex(derivationIndex: number): number {
  if (
    !Number.isSafeInteger(derivationIndex) ||
    derivationIndex < 0 ||
    derivationIndex >= 0x80000000
  ) {
    throw new Error('Invalid Public account derivation index')
  }
  return derivationIndex
}

export function publicIdentityPath(derivationIndex: number): string {
  return `m/44'/133'/${PUBLIC_IDENTITY_ACCOUNT_INDEX}'/0/${publicIdentityAddressIndex(derivationIndex)}`
}

export async function derivePublicIdentity(
  core: Pick<ZcashWalletCore, 'getPublicKey'>,
  derivationIndex: number
): Promise<{ pubkey: string; address: string }> {
  const identity = await core.getPublicKey(
    PUBLIC_IDENTITY_ACCOUNT_INDEX,
    publicIdentityAddressIndex(derivationIndex)
  )
  if (!/^04[0-9a-f]{128}$/i.test(identity.pubkey)) {
    throw new Error('Public identity is unavailable')
  }
  return { pubkey: identity.pubkey.toLowerCase(), address: identity.address }
}

export async function signPublicMessage(
  core: Pick<ZcashWalletCore, 'signMessage'>,
  derivationIndex: number,
  publicKey: string,
  message: string
): Promise<string> {
  const result = await core.signMessage(
    message,
    PUBLIC_IDENTITY_ACCOUNT_INDEX,
    publicIdentityAddressIndex(derivationIndex)
  )
  if (
    result.pubkey.toLowerCase() !== publicKey.toLowerCase() ||
    !/^[0-9a-f]{130}$/i.test(result.signature)
  ) {
    throw new Error('Public signing identity changed')
  }
  return result.signature.toLowerCase()
}
