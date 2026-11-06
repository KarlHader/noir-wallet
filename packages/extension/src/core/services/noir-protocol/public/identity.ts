import { SIGNING_ACCOUNT_INDEX } from '@/config/wallet'
import type { ZcashWalletCore } from '@/core/zcash/wallet-core'

export type ProtocolSigningMode = 'derived' | 'legacy_index0'

export function publicIdentityAddressIndex(derivationIndex: number): number {
  if (
    !Number.isSafeInteger(derivationIndex) ||
    derivationIndex < 0 ||
    derivationIndex >= 0x80000000
  )
    throw new Error('Invalid Protocol account derivation index')
  return derivationIndex
}

export function publicIdentityPath(derivationIndex: number, mode: ProtocolSigningMode): string {
  const index =
    mode === 'derived' ? SIGNING_ACCOUNT_INDEX : publicIdentityAddressIndex(derivationIndex)
  return `m/44'/133'/${index}'/0/0`
}

/** Use the existing Lending signing paths without introducing another identity. */
export async function signPublicMessage(
  core: Pick<ZcashWalletCore, 'signMessage'>,
  derivationIndex: number,
  publicKey: string,
  message: string,
  mode: ProtocolSigningMode
): Promise<string> {
  const result =
    mode === 'derived'
      ? await core.signMessage(message, SIGNING_ACCOUNT_INDEX)
      : await core.signMessage(message, publicIdentityAddressIndex(derivationIndex), 0)
  if (
    result.pubkey.toLowerCase() !== publicKey.toLowerCase() ||
    !/^[0-9a-f]{130}$/i.test(result.signature)
  )
    throw new Error('Protocol signing identity changed')
  return result.signature.toLowerCase()
}
