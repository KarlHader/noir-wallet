import { test } from 'node:test'
import { expect } from '@playwright/test'

import { WalletMetadataCoordinator } from '../../../src/infrastructure/keyring/wallet-metadata-coordinator.ts'

const CREATED_AT = 1_700_000_000_000
const SOURCE_GENERATION_ID = 'storage-v2:generation:source'

function sourceSnapshot() {
  return Object.freeze({
    manifest: Object.freeze({
      schemaVersion: 2,
      generationId: SOURCE_GENERATION_ID,
      status: 'verified',
      sourceFingerprint: '1'.repeat(64),
      mainKeyDomainId: 'wallet:keystone-v2:one',
      activeAccount: {
        keyDomainId: 'wallet:keystone-v2:one',
        accountId: 'account:keystone-v2:one:0'
      },
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 0, addresses: 0 },
      createdAt: CREATED_AT,
      verifiedAt: CREATED_AT
    }),
    keyDomains: Object.freeze([
      Object.freeze({
        id: 'wallet:keystone-v2:one',
        credentialRef: 'credential-set:keystone-v2:one',
        source: Object.freeze({
          kind: 'hardware',
          vendor: 'keystone',
          firmwareProfile: 'multi-coin',
          capabilities: Object.freeze(['bitcoin', 'evm'])
        }),
        displayName: 'Keystone Multi-Coin',
        createdAt: CREATED_AT
      })
    ]),
    accounts: Object.freeze([
      Object.freeze({
        id: 'account:keystone-v2:one:0',
        keyDomainId: 'wallet:keystone-v2:one',
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: CREATED_AT
      })
    ]),
    chainAccounts: Object.freeze([]),
    addresses: Object.freeze([])
  })
}

class MemoryStorageV2Repository {
  constructor(source = sourceSnapshot()) {
    this.pointer = {
      schemaVersion: 2,
      generationId: source.manifest.generationId,
      sourceFingerprint: source.manifest.sourceFingerprint,
      committedAt: source.manifest.verifiedAt
    }
    this.snapshots = new Map([[source.manifest.generationId, source]])
    this.discarded = []
  }

  async getActivePointer() {
    return this.pointer
  }

  async getSnapshot(generationId) {
    return this.snapshots.get(generationId) ?? null
  }

  async stage(snapshot) {
    this.snapshots.set(snapshot.manifest.generationId, snapshot)
  }

  async commit(pointer, expectedGenerationId) {
    if (this.pointer?.generationId !== expectedGenerationId) return 'active-generation-changed'
    this.pointer = pointer
    return 'committed'
  }

  async discardUncommittedGeneration(generationId) {
    if (this.pointer?.generationId === generationId) throw new Error('cannot discard active')
    this.snapshots.delete(generationId)
    this.discarded.push(generationId)
  }
}

function coordinator(repository, commitPointer) {
  return new WalletMetadataCoordinator({
    credentialRepository: {},
    storageRepository: repository,
    now: () => CREATED_AT + 1,
    commitPointer:
      commitPointer ??
      ((storageRepository, _credentialRepository, pointer, expectedGenerationId) =>
        storageRepository.commit(pointer, expectedGenerationId))
  })
}

test.describe('Wallet metadata coordinator', () => {
  test('renames a hardware Wallet in an immutable credential-bound generation', async () => {
    const repository = new MemoryStorageV2Repository()
    const result = await coordinator(repository).renameWallet({
      keyDomainId: 'wallet:keystone-v2:one',
      displayName: 'Daily Hardware'
    })

    expect(result).toMatchObject({
      status: 'renamed',
      generationId: expect.stringMatching(/^storage-v2:wallet-metadata:[a-f0-9]{64}$/)
    })
    const target = await repository.getSnapshot(result.generationId)
    expect(target.keyDomains[0]).toMatchObject({
      displayName: 'Daily Hardware',
      credentialRef: 'credential-set:keystone-v2:one',
      source: { kind: 'hardware', firmwareProfile: 'multi-coin' }
    })
    expect(target.accounts).toEqual(sourceSnapshot().accounts)
    expect(target.manifest.activeAccount).toEqual(sourceSnapshot().manifest.activeAccount)
  })

  test('renames only the targeted Account in an immutable credential-bound generation', async () => {
    const repository = new MemoryStorageV2Repository()
    const result = await coordinator(repository).renameAccount({
      keyDomainId: 'wallet:keystone-v2:one',
      accountId: 'account:keystone-v2:one:0',
      displayName: 'Trading Account'
    })

    expect(result).toMatchObject({
      status: 'renamed',
      generationId: expect.stringMatching(/^storage-v2:wallet-metadata:[a-f0-9]{64}$/)
    })
    const target = await repository.getSnapshot(result.generationId)
    expect(target.accounts[0]).toMatchObject({
      id: 'account:keystone-v2:one:0',
      keyDomainId: 'wallet:keystone-v2:one',
      accountIndex: 0,
      displayName: 'Trading Account'
    })
    expect(target.keyDomains).toEqual(sourceSnapshot().keyDomains)
    expect(target.manifest.activeAccount).toEqual(sourceSnapshot().manifest.activeAccount)
  })

  test('renames a retained software wallet without changing its accounts or credentials', async () => {
    const source = structuredClone(sourceSnapshot())
    source.keyDomains[0].id = 'wallet:retained:one'
    source.keyDomains[0].credentialRef = 'credential-set:retained:one'
    source.keyDomains[0].source = { kind: 'software', mnemonicWordCount: 12 }
    source.accounts[0].keyDomainId = 'wallet:retained:one'
    source.manifest.mainKeyDomainId = 'wallet:retained:one'
    source.manifest.activeAccount.keyDomainId = 'wallet:retained:one'
    const repository = new MemoryStorageV2Repository(source)

    const result = await coordinator(repository).renameWallet({
      keyDomainId: 'wallet:retained:one',
      displayName: 'Daily software'
    })

    const target = await repository.getSnapshot(result.generationId)
    expect(target.keyDomains[0]).toMatchObject({
      id: 'wallet:retained:one',
      displayName: 'Daily software',
      credentialRef: 'credential-set:retained:one'
    })
    expect(target.accounts).toEqual(source.accounts)
    expect(target.manifest.activeAccount).toEqual(source.manifest.activeAccount)
  })

  test('is idempotent and validates names before staging', async () => {
    const repository = new MemoryStorageV2Repository()
    await expect(
      coordinator(repository).renameWallet({
        keyDomainId: 'wallet:keystone-v2:one',
        displayName: 'Unsafe\u202eName'
      })
    ).rejects.toThrow(/displayName/)
    expect(repository.snapshots.size).toBe(1)

    const service = coordinator(repository)
    const first = await service.renameWallet({
      keyDomainId: 'wallet:keystone-v2:one',
      displayName: 'Daily Hardware'
    })
    await expect(
      service.renameWallet({
        keyDomainId: 'wallet:keystone-v2:one',
        displayName: 'Daily Hardware'
      })
    ).resolves.toEqual({ status: 'already-renamed', generationId: first.generationId })

    await expect(
      service.renameAccount({
        keyDomainId: 'wallet:keystone-v2:one',
        accountId: 'account:keystone-v2:one:0',
        displayName: 'Unsafe\u202eName'
      })
    ).rejects.toThrow(/displayName/)
    await expect(
      service.renameAccount({
        keyDomainId: 'wallet:keystone-v2:other',
        accountId: 'account:keystone-v2:one:0',
        displayName: 'Trading Account'
      })
    ).rejects.toThrow(/Account not found/)
  })

  test('discards a rejected target without changing the active generation', async () => {
    const repository = new MemoryStorageV2Repository()
    await expect(
      coordinator(repository, () => Promise.resolve('credential-binding-invalid')).renameWallet({
        keyDomainId: 'wallet:keystone-v2:one',
        displayName: 'Daily Hardware'
      })
    ).rejects.toThrow(/credential-binding-invalid/)
    expect(repository.pointer.generationId).toBe(SOURCE_GENERATION_ID)
    expect(repository.discarded).toHaveLength(1)
  })
})
