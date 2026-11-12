import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'
import type { StarknetActiveAccount } from './starknet-dapp-handler'

export interface StarknetDappAccountSource {
  readonly chainAccount: {
    readonly identity: { readonly kind: string; readonly value: string }
    readonly scope: { readonly keyDomainId: string; readonly accountId: string }
  }
  readonly accountIndex: number
  readonly addressIndex: number
  readonly keyDomainSource: { readonly kind: string }
  readonly publicKey: string
  readonly classHash: string
}

export function starknetDappAccountFromContext(
  context: StarknetDappAccountSource | null,
  cached: StarknetActiveAccount | null
): StarknetActiveAccount | null {
  if (!context || context.chainAccount.identity.kind !== 'account-identifier') return null
  const address = context.chainAccount.identity.value
  const keyDomainId = context.chainAccount.scope.keyDomainId
  const accountId = context.chainAccount.scope.accountId
  if (
    cached &&
    cached.keyDomainId === keyDomainId &&
    cached.accountId === accountId &&
    normalizeStarknetFelt(cached.address) === normalizeStarknetFelt(address)
  ) {
    return cached
  }
  if (context.keyDomainSource.kind !== 'software') return null
  return Object.freeze({
    address,
    publicKey: context.publicKey,
    classHash: context.classHash,
    implementation: 'open_zeppelin',
    accountIndex: context.accountIndex,
    addressIndex: context.addressIndex,
    keyDomainId,
    accountId,
    keySource: 'software'
  })
}
