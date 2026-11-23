import type { KeyDomainSource } from '@/core/keyring/domain'

type PrivateKeyChainFamily = Extract<KeyDomainSource, { kind: 'private-key' }>['chainFamily']

/**
 * Structural wallet source. Imported NEAR keys carry the account index because
 * only index 0 has a signing key; mnemonic and hardware sources do not.
 */
export type NearPrivateExecutionWalletSource =
  | Readonly<{ kind: 'software' | 'hardware' }>
  | Readonly<{
      kind: 'private-key'
      chainFamily: PrivateKeyChainFamily
      accountIndex?: number
    }>

export function supportsNearPrivateExecution(
  walletSource: NearPrivateExecutionWalletSource | null | undefined
): boolean {
  if (walletSource?.kind === 'software') return true
  if (walletSource?.kind !== 'private-key') return false
  return walletSource.chainFamily === 'near' && walletSource.accountIndex === 0
}
