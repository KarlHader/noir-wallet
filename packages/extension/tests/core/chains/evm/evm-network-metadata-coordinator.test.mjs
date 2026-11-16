import { test } from 'node:test'
import { expect } from '@playwright/test'
import { EvmNetworkMetadataCoordinator } from '../../../../src/infrastructure/keyring/evm-network-metadata-coordinator.ts'
import { parseStorageV2Snapshot } from '../../../../src/infrastructure/persistence/schema/storage-v2-validation.ts'

const source = parseStorageV2Snapshot({
  manifest: {
    schemaVersion: 2,
    generationId: 'source',
    status: 'verified',
    sourceFingerprint: '1'.repeat(64),
    mainKeyDomainId: 'wallet:test',
    activeAccount: { keyDomainId: 'wallet:test', accountId: 'account:test' },
    counts: { keyDomains: 1, accounts: 1, chainAccounts: 1, addresses: 1 },
    createdAt: 1,
    verifiedAt: 1
  },
  keyDomains: [
    {
      id: 'wallet:test',
      credentialRef: 'credential:test',
      source: { kind: 'software', mnemonicWordCount: 12 },
      displayName: 'Wallet 1',
      createdAt: 1
    }
  ],
  accounts: [
    {
      id: 'account:test',
      keyDomainId: 'wallet:test',
      accountIndex: 0,
      displayName: 'Account 1',
      createdAt: 1
    }
  ],
  chainAccounts: [
    {
      id: 'chain-account:ethereum',
      scope: {
        keyDomainId: 'wallet:test',
        accountId: 'account:test',
        chainId: 'eip155:1'
      },
      derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
      identity: {
        kind: 'account-identifier',
        value: '0x1111111111111111111111111111111111111111'
      },
      createdAt: 1
    }
  ],
  addresses: [
    {
      id: 'address:ethereum',
      chainAccountId: 'chain-account:ethereum',
      value: '0x1111111111111111111111111111111111111111',
      scheme: 'evm',
      purpose: 'identity',
      derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
      rotatable: false,
      preferredForReceive: true,
      privacy: 'transparent',
      walletCompatibility: 'broad'
    }
  ]
})

function repositories() {
  let active = {
    schemaVersion: 2,
    generationId: 'source',
    sourceFingerprint: '1'.repeat(64),
    committedAt: 1
  }
  const snapshots = new Map([['source', source]])
  return {
    storage: {
      getActivePointer: async () => active,
      getSnapshot: async generationId => snapshots.get(generationId) ?? null,
      stage: async snapshot => snapshots.set(snapshot.manifest.generationId, snapshot),
      commit: async (pointer, expected) => {
        if (active?.generationId !== expected) return 'active-generation-changed'
        active = pointer
        return 'committed'
      },
      discardUncommittedGeneration: async generationId => snapshots.delete(generationId)
    },
    readActive: () => snapshots.get(active.generationId)
  }
}

test.describe('EVM network metadata coordinator', () => {
  test('creates chain-isolated metadata from an existing public EVM identity', async () => {
    const repository = repositories()
    const coordinator = new EvmNetworkMetadataCoordinator({
      storageRepository: repository.storage,
      credentialRepository: {},
      commitPointer: async (storage, _credentials, pointer, expected) =>
        storage.commit(pointer, expected),
      now: () => 2
    })
    const result = await coordinator.synchronize(['eip155:1', 'eip155:56', 'eip155:8453'])
    expect(result).toMatchObject({ status: 'synchronized', addedChainAccounts: 2 })
    const active = repository.readActive()
    expect(active.chainAccounts.map(account => account.scope.chainId)).toEqual([
      'eip155:1',
      'eip155:56',
      'eip155:8453'
    ])
    expect(new Set(active.chainAccounts.map(account => account.identity.value))).toEqual(
      new Set(['0x1111111111111111111111111111111111111111'])
    )
    expect(active.addresses.every(address => address.preferredForReceive)).toBe(true)
    await expect(
      coordinator.synchronize(['eip155:1', 'eip155:56', 'eip155:8453'])
    ).resolves.toMatchObject({
      status: 'already-synchronized',
      addedChainAccounts: 0
    })
  })

  test('fails closed when existing EVM identities disagree', async () => {
    const repository = repositories()
    const conflicting = parseStorageV2Snapshot({
      ...source,
      manifest: {
        ...source.manifest,
        counts: { ...source.manifest.counts, chainAccounts: 2, addresses: 2 }
      },
      chainAccounts: [
        ...source.chainAccounts,
        {
          ...source.chainAccounts[0],
          id: 'chain-account:base',
          scope: { ...source.chainAccounts[0].scope, chainId: 'eip155:8453' },
          identity: {
            kind: 'account-identifier',
            value: '0x2222222222222222222222222222222222222222'
          }
        }
      ],
      addresses: [
        ...source.addresses,
        { ...source.addresses[0], id: 'address:base', chainAccountId: 'chain-account:base' }
      ]
    })
    repository.storage.getSnapshot = async () => conflicting
    const coordinator = new EvmNetworkMetadataCoordinator({
      storageRepository: repository.storage,
      credentialRepository: {},
      commitPointer: async () => 'committed'
    })
    await expect(coordinator.synchronize(['eip155:1', 'eip155:56'])).rejects.toThrow(
      /identities are inconsistent/
    )
  })
})
