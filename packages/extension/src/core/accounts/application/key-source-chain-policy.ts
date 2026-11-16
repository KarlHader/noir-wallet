import type { AccountId, ChainAccount } from '@/core/accounts/domain'
import type { ChainDefinition } from '@/core/chains/registry'
import type { KeyDomain, KeyDomainId, KeyDomainSource } from '@/core/keyring/domain'

export function keySourceSupportsChainFamily(
  source: KeyDomainSource,
  family: ChainDefinition['family']
): boolean {
  if (source.kind === 'software') return true
  if (source.kind === 'private-key') {
    return (
      (source.chainFamily === 'eip155' && family === 'evm') ||
      (source.chainFamily === 'bip122' && family === 'bitcoin') ||
      source.chainFamily === family
    )
  }
  if (source.vendor === 'ledger') {
    return family !== 'tron' && source.capabilities.includes(family)
  }
  if (source.vendor !== 'keystone') return false
  if (family === 'zcash') return source.capabilities.includes('zcash')
  if (family === 'bitcoin') return source.capabilities.includes('bitcoin')
  return family === 'evm' && source.capabilities.includes('evm')
}

export function keySourceSupportsAddressFamily(
  source: KeyDomainSource,
  family: ChainDefinition['family']
): boolean {
  if (source.kind === 'software') return true
  if (source.kind === 'private-key') {
    return (
      (source.chainFamily === 'eip155' && family === 'evm') ||
      (source.chainFamily === 'bip122' && family === 'bitcoin') ||
      source.chainFamily === family
    )
  }
  if (source.vendor === 'ledger') {
    return family !== 'tron' && source.capabilities.includes(family)
  }
  if (source.vendor !== 'keystone') return false
  const capability = family === 'evm' ? 'evm' : family === 'bitcoin' ? 'bitcoin' : family
  return source.capabilities.includes(capability)
}

export function resolveKeyDomain(
  keyDomains: readonly KeyDomain[],
  keyDomainId: KeyDomainId
): KeyDomain {
  const matches = keyDomains.filter(keyDomain => keyDomain.id === keyDomainId)
  if (matches.length !== 1) {
    throw new Error('Account KeyDomain metadata is missing or ambiguous')
  }
  return matches[0]
}

export function listKeySourceAllowedAccountScopes(
  input: Readonly<{
    keyDomains: readonly KeyDomain[]
    chainAccounts: readonly ChainAccount[]
    chainId: string
    family: ChainDefinition['family']
  }>
): readonly Readonly<{ keyDomainId: KeyDomainId; accountId: AccountId }>[] {
  const scopes = new Map<string, Readonly<{ keyDomainId: KeyDomainId; accountId: AccountId }>>()
  for (const chainAccount of input.chainAccounts) {
    if (chainAccount.scope.chainId !== input.chainId) continue
    const keyDomain = resolveKeyDomain(input.keyDomains, chainAccount.scope.keyDomainId)
    if (!keySourceSupportsChainFamily(keyDomain.source, input.family)) continue
    const scope = Object.freeze({
      keyDomainId: chainAccount.scope.keyDomainId,
      accountId: chainAccount.scope.accountId
    })
    scopes.set(JSON.stringify([scope.keyDomainId, scope.accountId]), scope)
  }
  return Object.freeze([...scopes.values()])
}
