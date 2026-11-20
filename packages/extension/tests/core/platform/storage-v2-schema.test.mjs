import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { getZcashChainId } from '../../../src/core/chains/registry/index.ts'

import {
  STORAGE_V2_ACTIVE_POINTER_KEY,
  buildStorageV2EntityKey,
  buildStorageV2IndexKey,
  parseStorageV2ActivePointer,
  parseStorageV2Snapshot
} from '../../../src/infrastructure/persistence/schema/index.ts'

const fingerprint = 'a'.repeat(64)

function createSnapshot() {
  return {
    manifest: {
      schemaVersion: 2,
      generationId: 'generation:1',
      status: 'staged',
      sourceFingerprint: fingerprint,
      mainKeyDomainId: 'wallet_with_underscores',
      activeAccount: {
        keyDomainId: 'wallet_with_underscores',
        accountId: 'account_with_underscores'
      },
      counts: {
        keyDomains: 1,
        accounts: 1,
        chainAccounts: 1,
        addresses: 1
      },
      createdAt: 1_700_000_000_000
    },
    keyDomains: [
      {
        id: 'wallet_with_underscores',
        credentialRef: 'credential:wallet_with_underscores',
        source: { kind: 'software', mnemonicWordCount: 24 },
        displayName: 'Main Wallet',
        createdAt: 1_700_000_000_000
      }
    ],
    accounts: [
      {
        id: 'account_with_underscores',
        keyDomainId: 'wallet_with_underscores',
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1_700_000_000_000
      }
    ],
    chainAccounts: [
      {
        id: 'chain-account:zcash:main',
        scope: {
          keyDomainId: 'wallet_with_underscores',
          accountId: 'account_with_underscores',
          chainId: 'zcash:main'
        },
        derivation: { scheme: 'zip32', path: "m/32'/133'/0'" },
        identity: { kind: 'account-identifier', value: 'u1-public-identity' },
        createdAt: 1_700_000_000_000
      }
    ],
    addresses: [
      {
        id: 'address:zcash:shielded',
        chainAccountId: 'chain-account:zcash:main',
        value: 'u1-public-receive-address',
        scheme: 'zcash-unified',
        purpose: 'receive',
        rotatable: true,
        preferredForReceive: true,
        privacy: 'mixed',
        walletCompatibility: 'limited'
      }
    ]
  }
}

test.describe('Storage V2 schema', () => {
  test('round-trips independent FROST accounts without accepting an HD index or path', () => {
    const snapshot = createSnapshot()
    const source = { kind: 'frost-vault', version: 1, groupId: 'group-1', network: 'mainnet' }
    const external = { ...snapshot.accounts[0], id: 'frost-account', source }
    delete external.accountIndex
    const chain = {
      ...snapshot.chainAccounts[0],
      id: 'frost-chain',
      source,
      scope: {
        ...snapshot.chainAccounts[0].scope,
        accountId: external.id,
        chainId: getZcashChainId('mainnet')
      },
      identity: { kind: 'account-identifier', value: 'u1-frost-identity' }
    }
    delete chain.derivation
    snapshot.accounts.push(external)
    snapshot.chainAccounts.push(chain)
    snapshot.manifest.counts.accounts++
    snapshot.manifest.counts.chainAccounts++
    const parsed = parseStorageV2Snapshot(snapshot)
    expect(parsed.accounts[1]).toEqual(external)
    expect(parsed.chainAccounts[1]).toEqual(chain)
    expect(() =>
      parseStorageV2Snapshot({
        ...snapshot,
        accounts: [snapshot.accounts[0], { ...external, accountIndex: 0 }]
      })
    ).toThrow()
    expect(() =>
      parseStorageV2Snapshot({
        ...snapshot,
        chainAccounts: [
          snapshot.chainAccounts[0],
          { ...chain, derivation: snapshot.chainAccounts[0].derivation }
        ]
      })
    ).toThrow()
    for (const badSource of [
      { ...source, version: 2 },
      { ...source, network: 'wrong' },
      { ...source, groupId: '' },
      { ...source, ufvk: 'private' }
    ]) {
      expect(() =>
        parseStorageV2Snapshot({
          ...snapshot,
          accounts: [snapshot.accounts[0], { ...external, source: badSource }]
        })
      ).toThrow()
    }
    expect(() =>
      parseStorageV2Snapshot({
        ...snapshot,
        chainAccounts: [
          snapshot.chainAccounts[0],
          { ...chain, scope: { ...chain.scope, chainId: 'eip155:1' } }
        ]
      })
    ).toThrow()
    expect(() =>
      parseStorageV2Snapshot({
        ...snapshot,
        chainAccounts: [
          snapshot.chainAccounts[0],
          { ...chain, source: { ...source, network: 'testnet' } }
        ]
      })
    ).toThrow()
  })

  test('parses a complete staged generation and freezes its records', () => {
    const parsed = parseStorageV2Snapshot(createSnapshot())

    expect(parsed.manifest.generationId).toBe('generation:1')
    expect(parsed.accounts[0].accountIndex).toBe(0)
    expect(parsed.chainAccounts[0].scope.chainId).toBe('zcash:main')
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.keyDomains[0])).toBe(true)
  })

  test('uses an exact versioned active pointer', () => {
    expect(STORAGE_V2_ACTIVE_POINTER_KEY).toBe('noir-wallet:v2:active')
    expect(
      parseStorageV2ActivePointer({
        schemaVersion: 2,
        generationId: 'generation:1',
        sourceFingerprint: fingerprint,
        committedAt: 1_700_000_000_001
      })
    ).toMatchObject({ generationId: 'generation:1' })
    expect(() =>
      parseStorageV2ActivePointer({
        schemaVersion: 2,
        generationId: 'generation:1',
        sourceFingerprint: fingerprint,
        committedAt: 1_700_000_000_001,
        unexpected: true
      })
    ).toThrow(/keys/i)
  })

  test('builds unambiguous entity and partition keys without parsing opaque IDs', () => {
    expect(buildStorageV2EntityKey('generation:1', 'account', 'account/id:1')).toBe(
      'noir-wallet:v2:generation:generation%3A1:entity:account:account%2Fid%3A1'
    )
    expect(
      buildStorageV2IndexKey('generation:1', 'accounts-by-key-domain', ['wallet_with_underscores'])
    ).toBe(
      'noir-wallet:v2:generation:generation%3A1:index:accounts-by-key-domain:wallet_with_underscores'
    )
  })

  test('rejects count mismatches, unknown references and duplicate scoped indexes', () => {
    const countMismatch = createSnapshot()
    countMismatch.manifest.counts.accounts = 2
    expect(() => parseStorageV2Snapshot(countMismatch)).toThrow(/counts/i)

    const unknownReference = createSnapshot()
    unknownReference.addresses[0].chainAccountId = 'missing-chain-account'
    expect(() => parseStorageV2Snapshot(unknownReference)).toThrow(/unknown ChainAccount/i)

    const duplicateIndex = createSnapshot()
    duplicateIndex.accounts.push({
      ...duplicateIndex.accounts[0],
      id: 'account:second'
    })
    duplicateIndex.manifest.counts.accounts = 2
    expect(() => parseStorageV2Snapshot(duplicateIndex)).toThrow(/duplicate Account index/i)
  })

  test('rejects an active Account outside its declared KeyDomain', () => {
    const invalidActive = createSnapshot()
    invalidActive.manifest.activeAccount.keyDomainId = 'wallet:other'
    expect(() => parseStorageV2Snapshot(invalidActive)).toThrow(/active Account/i)
  })

  test('rejects extra entity fields and unsupported classifications', () => {
    const extraField = createSnapshot()
    extraField.keyDomains[0].seedPhrase = 'must never enter metadata'
    expect(() => parseStorageV2Snapshot(extraField)).toThrow(/keys/i)

    const invalidAddress = createSnapshot()
    invalidAddress.addresses[0].privacy = 'private'
    expect(() => parseStorageV2Snapshot(invalidAddress)).toThrow(/classification/i)
  })

  test('keeps repository ports independent from Chrome and infrastructure adapters', () => {
    const source = [
      '../../../src/ports/repositories/storage-v2-types.ts',
      '../../../src/ports/repositories/storage-v2-repository.ts'
    ]
      .map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
      .join('\n')

    expect(source).not.toMatch(/chrome\.|from ['"]@\/infrastructure/)
  })
})
