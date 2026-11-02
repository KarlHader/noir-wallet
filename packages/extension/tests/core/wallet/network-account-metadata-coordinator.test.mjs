import { test } from 'node:test'
import { expect } from '@playwright/test'
import { NetworkAccountMetadataCoordinator } from '../../../src/infrastructure/keyring/network-account-metadata-coordinator.ts'
import { parseStorageV2Snapshot } from '../../../src/infrastructure/persistence/schema/storage-v2-validation.ts'

const source = parseStorageV2Snapshot({
  manifest: {
    schemaVersion: 2,
    generationId: 'source',
    status: 'verified',
    sourceFingerprint: '1'.repeat(64),
    mainKeyDomainId: 'wallet:test',
    activeAccount: { keyDomainId: 'wallet:test', accountId: 'account:test' },
    counts: { keyDomains: 1, accounts: 1, chainAccounts: 0, addresses: 0 },
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
  chainAccounts: [],
  addresses: []
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
        if (active.generationId !== expected) return 'active-generation-changed'
        active = pointer
        return 'committed'
      },
      discardUncommittedGeneration: async generationId => snapshots.delete(generationId)
    },
    readActive: () => snapshots.get(active.generationId)
  }
}

const input = {
  keyDomainId: 'wallet:test',
  accountId: 'account:test',
  accountIndex: 0,
  zcashNetwork: 'testnet',
  zcashChainId: 'bip122:05a60a92d99d85997cce3b87616c089f',
  zcashAddresses: {
    transparent: 'tmNetworkFixture',
    shielded: 'utest1NetworkFixture',
    fullUnified: 'utest1NetworkFullFixture'
  },
  bitcoin: {
    chainId: 'bip122:000000000933ea01ad0ee984209779ba',
    addressType: 'p2wpkh',
    accountIndex: 0,
    change: false,
    addressIndex: 0,
    address: 'tb1q5cyxnuxmeuwuvkwfem96llyxfqv3d8hl9r5rpt',
    addressScheme: 'bitcoin-p2wpkh',
    derivationScheme: 'bip84',
    derivationPath: "m/84'/1'/0'/0/0",
    publicKey: `0x02${'11'.repeat(32)}`,
    masterFingerprint: '0x12345678'
  },
  solana: {
    chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    address: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
    publicKey: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
    derivationPath: "m/44'/501'/0'/0'"
  },
  near: {
    chainId: 'near:testnet',
    address: 'alice.testnet',
    implicitAddress: '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412',
    accountIds: [
      'alice.testnet',
      '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
    ],
    publicKey: 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25',
    derivationPath: "m/44'/397'/0'"
  }
}

test.describe('Network Account metadata coordinator', () => {
  test('adds target Zcash, Bitcoin, Solana and NEAR ChainAccounts atomically and idempotently', async () => {
    const repository = repositories()
    const coordinator = new NetworkAccountMetadataCoordinator({
      storageRepository: repository.storage,
      credentialRepository: {},
      commitPointer: async (storage, _credentials, pointer, expected) =>
        storage.commit(pointer, expected),
      now: () => 2
    })
    await expect(coordinator.synchronize([input])).resolves.toMatchObject({
      status: 'synchronized',
      addedChainAccounts: 4
    })
    const active = repository.readActive()
    expect(active.chainAccounts.map(account => account.scope.chainId).sort()).toEqual([
      'bip122:000000000933ea01ad0ee984209779ba',
      'bip122:05a60a92d99d85997cce3b87616c089f',
      'near:testnet',
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
    ])
    expect(active.addresses).toHaveLength(7)
    expect(
      active.addresses.filter(address => address.scheme === 'solana' || address.scheme === 'near')
    ).toEqual([
      expect.objectContaining({
        scheme: 'solana',
        value: input.solana.address,
        preferredForReceive: true
      }),
      expect.objectContaining({
        scheme: 'near',
        value: input.near.address,
        preferredForReceive: true
      }),
      expect.objectContaining({
        scheme: 'near',
        value: input.near.implicitAddress,
        preferredForReceive: false
      })
    ])
    await expect(coordinator.synchronize([input])).resolves.toMatchObject({
      status: 'already-synchronized',
      addedChainAccounts: 0
    })
  })

  test('upgrades an existing implicit NEAR ChainAccount after automatic named-account discovery', async () => {
    const repository = repositories()
    const coordinator = new NetworkAccountMetadataCoordinator({
      storageRepository: repository.storage,
      credentialRepository: {},
      commitPointer: async (storage, _credentials, pointer, expected) =>
        storage.commit(pointer, expected),
      now: () => 2
    })
    const implicitNear = {
      ...input.near,
      address: input.near.implicitAddress,
      accountIds: [input.near.implicitAddress]
    }
    await coordinator.synchronize([{ ...input, near: implicitNear }])
    await expect(coordinator.synchronize([input])).resolves.toMatchObject({
      status: 'synchronized',
      addedChainAccounts: 0
    })

    const active = repository.readActive()
    const nearAccount = active.chainAccounts.find(
      account => account.scope.chainId === 'near:testnet'
    )
    expect(nearAccount.identity.value).toBe('alice.testnet')
    expect(
      active.addresses
        .filter(address => address.chainAccountId === nearAccount.id)
        .map(address => ({ value: address.value, preferred: address.preferredForReceive }))
    ).toEqual([
      { value: 'alice.testnet', preferred: true },
      { value: input.near.implicitAddress, preferred: false }
    ])
  })

  test('rejects derivation metadata crossing the Account index', async () => {
    const repository = repositories()
    const coordinator = new NetworkAccountMetadataCoordinator({
      storageRepository: repository.storage,
      credentialRepository: {},
      commitPointer: async (storage, _credentials, pointer, expected) =>
        storage.commit(pointer, expected)
    })
    await expect(
      coordinator.synchronize([{ ...input, bitcoin: { ...input.bitcoin, accountIndex: 1 } }])
    ).rejects.toThrow('incomplete default receive addresses')
    await expect(
      coordinator.synchronize([
        { ...input, solana: { ...input.solana, derivationPath: "m/44'/501'/1'/0'" } }
      ])
    ).rejects.toThrow('solana derivation index mismatch')
  })
})
