import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import {
  createWalletSetCatalog,
  listWalletSetAccounts,
  registerProvisionedWalletSet,
  renameAccount,
  renameWalletSet,
  setMainWalletSet,
  switchActiveAccount
} from '../../../src/core/accounts/application/index.ts'

function keyDomain(id, overrides = {}) {
  return {
    id,
    credentialRef: `credential:${id}`,
    source: { kind: 'software', mnemonicWordCount: 24 },
    displayName: `Wallet ${id}`,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

function account(keyDomainId, id, overrides = {}) {
  return {
    id,
    keyDomainId,
    accountIndex: 0,
    displayName: 'Account 1',
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

function register(catalog, keyDomainId, accountId) {
  return registerProvisionedWalletSet(catalog, {
    keyDomain: keyDomain(keyDomainId),
    initialAccount: account(keyDomainId, accountId)
  })
}

test.describe('Wallet Set catalog', () => {
  test('registers provisioned metadata and makes only the first Wallet Set main', () => {
    const empty = createWalletSetCatalog()
    const first = register(empty, 'key-domain:a', 'account:a:0')
    const second = register(first, 'key-domain:b', 'account:b:0')

    expect(first.mainKeyDomainId).toBe('key-domain:a')
    expect(first.activeAccount).toBeNull()
    expect(second.mainKeyDomainId).toBe('key-domain:a')
    expect(second.activeAccount).toBeNull()
    expect(second.keyDomains).toHaveLength(2)
    expect(Object.isFrozen(second)).toBe(true)
    expect(Object.isFrozen(second.keyDomains)).toBe(true)
  })

  test('keeps Main Wallet Set and explicit active Account as separate pointers', () => {
    let catalog = register(createWalletSetCatalog(), 'key-domain:a', 'account:a:0')
    catalog = switchActiveAccount(catalog, {
      keyDomainId: 'key-domain:a',
      accountId: 'account:a:0'
    })
    catalog = register(catalog, 'key-domain:b', 'account:b:0')
    const changedMain = setMainWalletSet(catalog, 'key-domain:b')

    expect(changedMain.mainKeyDomainId).toBe('key-domain:b')
    expect(changedMain.activeAccount).toEqual({
      keyDomainId: 'key-domain:a',
      accountId: 'account:a:0'
    })

    const switched = switchActiveAccount(changedMain, {
      keyDomainId: 'key-domain:b',
      accountId: 'account:b:0'
    })
    expect(switched.activeAccount).toEqual({
      keyDomainId: 'key-domain:b',
      accountId: 'account:b:0'
    })
    expect(Object.keys(switched.activeAccount)).toEqual(['keyDomainId', 'accountId'])
  })

  test('rejects cross-Wallet Account selection and missing Main pointers', () => {
    const catalog = register(
      register(createWalletSetCatalog(), 'key-domain:a', 'account:a:0'),
      'key-domain:b',
      'account:b:0'
    )

    expect(() =>
      switchActiveAccount(catalog, {
        keyDomainId: 'key-domain:a',
        accountId: 'account:b:0'
      })
    ).toThrow(/belong/)
    expect(() => setMainWalletSet(catalog, 'key-domain:missing')).toThrow(/Unknown Wallet Set/)
    expect(() =>
      createWalletSetCatalog({
        keyDomains: [keyDomain('key-domain:a')],
        accounts: [account('key-domain:a', 'account:a:0')],
        mainKeyDomainId: null,
        activeAccount: null
      })
    ).toThrow(/Main Wallet Set/)
  })

  test('requires a unique credential and Account 0 when registering', () => {
    const first = register(createWalletSetCatalog(), 'key-domain:a', 'account:a:0')
    expect(() =>
      registerProvisionedWalletSet(first, {
        keyDomain: keyDomain('key-domain:b', {
          credentialRef: 'credential:key-domain:a'
        }),
        initialAccount: account('key-domain:b', 'account:b:0')
      })
    ).toThrow(/CredentialRef/)
    expect(() =>
      registerProvisionedWalletSet(first, {
        keyDomain: keyDomain('key-domain:b'),
        initialAccount: account('key-domain:b', 'account:b:1', {
          accountIndex: 1
        })
      })
    ).toThrow(/Account index 0/)
    expect(() =>
      registerProvisionedWalletSet(first, {
        keyDomain: keyDomain('key-domain:b'),
        initialAccount: account('key-domain:a', 'account:b:0')
      })
    ).toThrow(/same KeyDomain/)
  })

  test('renames immutable metadata without using display names as identity', () => {
    const original = register(
      register(createWalletSetCatalog(), 'key-domain:a', 'account:a:0'),
      'key-domain:b',
      'account:b:0'
    )
    const renamedWallet = renameWalletSet(original, 'key-domain:a', 'Daily Wallet')
    const renamed = renameAccount(renamedWallet, 'account:b:0', 'Daily Wallet')

    expect(original.keyDomains[0].displayName).not.toBe('Daily Wallet')
    expect(renamed.keyDomains[0].displayName).toBe('Daily Wallet')
    expect(renamed.accounts[1].displayName).toBe('Daily Wallet')
    expect(listWalletSetAccounts(renamed, 'key-domain:b').map(item => item.id)).toEqual([
      'account:b:0'
    ])
    expect(() => renameWalletSet(renamed, 'key-domain:a', 'Unsafe\u202eName')).toThrow(
      /displayName/
    )
  })

  test('does not couple account semantics to Zcash, WASM, Chrome, or dApp permissions', () => {
    const source = readFileSync(
      new URL('../../../src/core/accounts/application/wallet-set-catalog.ts', import.meta.url),
      'utf8'
    )

    expect(source).not.toMatch(
      /zcash|wasm|chrome\.|dapp|permission|ChainAccountId|zcash-wallet-runtime/i
    )
  })
})
