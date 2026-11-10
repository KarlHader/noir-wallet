import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import {
  parseAccountId,
  parseAccountIndex,
  parseAddressId,
  parseChainAccountId
} from '../../../src/core/accounts/domain/index.ts'
import {
  parseCredentialRef,
  parseKeyDomain,
  parseKeyDomainId
} from '../../../src/core/keyring/domain/index.ts'

const domainSources = [
  '../../../src/core/keyring/domain/key-domain.ts',
  '../../../src/core/accounts/domain/account.ts',
  '../../../src/core/accounts/domain/chain-account.ts',
  '../../../src/core/accounts/domain/address.ts',
  '../../../src/core/chains/domain/chain.ts',
  '../../../src/core/chains/domain/asset.ts'
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))

test.describe('Multichain domain foundations', () => {
  test('preserves valid opaque identifiers, including migrated V1 IDs', () => {
    expect(parseKeyDomainId('wallet_with_underscores')).toBe('wallet_with_underscores')
    expect(parseCredentialRef('credential-set:1')).toBe('credential-set:1')
    expect(parseAccountId('account_with_underscores')).toBe('account_with_underscores')
    expect(parseChainAccountId('zcash-account:1')).toBe('zcash-account:1')
    expect(parseAddressId('address:1')).toBe('address:1')
  })

  test('rejects blank or whitespace-padded identifiers', () => {
    expect(() => parseKeyDomainId('')).toThrow(/KeyDomainId/)
    expect(() => parseCredentialRef(' credential-set:1')).toThrow(/CredentialRef/)
    expect(() => parseAccountId('account:1 ')).toThrow(/AccountId/)
    expect(() => parseChainAccountId(' ')).toThrow(/ChainAccountId/)
    expect(() => parseAddressId('\taddress:1')).toThrow(/AddressId/)
  })

  test('accepts only non-negative safe HD account indexes', () => {
    expect(parseAccountIndex(0)).toBe(0)
    expect(parseAccountIndex(2)).toBe(2)
    expect(() => parseAccountIndex(-1)).toThrow(/AccountIndex/)
    expect(() => parseAccountIndex(1.5)).toThrow(/AccountIndex/)
    expect(() => parseAccountIndex(Number.MAX_SAFE_INTEGER + 1)).toThrow(/AccountIndex/)
  })

  test('persists a Dash private-key source and still reads Bitcoin bip122 records', () => {
    const base = {
      id: 'wallet:dash',
      credentialRef: 'credential-set:dash',
      displayName: 'Imported key',
      createdAt: 1
    }
    expect(
      parseKeyDomain({
        ...base,
        source: { kind: 'private-key', chainFamily: 'dash', dashNetwork: 'testnet' }
      }).source
    ).toEqual({ kind: 'private-key', chainFamily: 'dash', dashNetwork: 'testnet' })
    expect(
      parseKeyDomain({
        ...base,
        id: 'wallet:bitcoin',
        source: { kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'mainnet' }
      }).source
    ).toEqual({ kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'mainnet' })
    expect(() =>
      parseKeyDomain({
        ...base,
        source: { kind: 'private-key', chainFamily: 'dash' }
      })
    ).toThrow(/private-key/)
  })

  test('keeps domain modules independent from runtime frameworks and wallet engines', () => {
    const source = domainSources.join('\n')
    expect(source).not.toMatch(/from ['"](?:react|zustand|@\/store)/)
    expect(source).not.toMatch(/chrome\.|WORKER_RPC|wasm/i)
  })
})
