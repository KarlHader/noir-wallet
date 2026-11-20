import { isFrostAccount } from '../domain/account-source'
import type { Account, Address, ChainAccount } from '../domain'
import type { ChainDefinition } from '@/core/chains/registry'

/** Project only addresses written by the original FROST metadata coordinator. */
export function projectLegacyFrostAddressScheme(
  account: Account,
  chainAccount: ChainAccount,
  chain: ChainDefinition,
  address: Address
): string {
  if (
    chain.family === 'zcash' &&
    chain.capabilities.address.addressSchemes.includes('zcash-shielded-unified') &&
    isFrostAccount(account) &&
    isFrostAccount(chainAccount) &&
    account.source.groupId === chainAccount.source.groupId &&
    account.source.network === chainAccount.source.network &&
    chainAccount.scope.keyDomainId === account.keyDomainId &&
    chainAccount.scope.accountId === account.id &&
    chainAccount.id === `frost-chain:${account.id}` &&
    address.id === `frost-address:${account.id}` &&
    address.chainAccountId === chainAccount.id &&
    address.scheme === 'zcash-unified' &&
    address.value === chainAccount.identity.value &&
    address.purpose === 'receive' &&
    address.privacy === 'shielded' &&
    address.walletCompatibility === 'limited' &&
    address.rotatable &&
    address.preferredForReceive
  )
    return 'zcash-shielded-unified'
  return address.scheme
}
