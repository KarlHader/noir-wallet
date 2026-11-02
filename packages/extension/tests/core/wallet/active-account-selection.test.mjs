import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ActiveAccountSelectionCoordinator } from '../../../src/infrastructure/keyring/active-account-selection-coordinator.ts'

const SOURCE_GENERATION_ID = 'storage-v2:generation:source'
const SOURCE_FINGERPRINT = '1'.repeat(64)
const CREATED_AT = 1_700_000_000_000

function sourceSnapshot(activeAccount = { keyDomainId: 'wallet:1', accountId: 'account:1:0' }) {
  return Object.freeze({
    manifest: Object.freeze({
      schemaVersion: 2,
      generationId: SOURCE_GENERATION_ID,
      status: 'verified',
      sourceFingerprint: SOURCE_FINGERPRINT,
      mainKeyDomainId: 'wallet:1',
      activeAccount,
      counts: Object.freeze({ keyDomains: 2, accounts: 3, chainAccounts: 0, addresses: 0 }),
      createdAt: CREATED_AT,
      verifiedAt: CREATED_AT
    }),
    keyDomains: Object.freeze([
      Object.freeze({
        id: 'wallet:1',
        credentialRef: 'credential-set:1',
        source: Object.freeze({ kind: 'software', mnemonicWordCount: 24 }),
        displayName: 'Wallet 1',
        createdAt: CREATED_AT
      }),
      Object.freeze({
        id: 'wallet:2',
        credentialRef: 'credential-set:2',
        source: Object.freeze({ kind: 'software', mnemonicWordCount: 12 }),
        displayName: 'Wallet 2',
        createdAt: CREATED_AT
      })
    ]),
    accounts: Object.freeze([
      Object.freeze({
        id: 'account:1:0',
        keyDomainId: 'wallet:1',
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: CREATED_AT
      }),
      Object.freeze({
        id: 'account:1:1',
        keyDomainId: 'wallet:1',
        accountIndex: 1,
        displayName: 'Account 2',
        createdAt: CREATED_AT
      }),
      Object.freeze({
        id: 'account:2:0',
        keyDomainId: 'wallet:2',
        accountIndex: 0,
        displayName: 'Imported Account',
        createdAt: CREATED_AT
      })
    ]),
    chainAccounts: Object.freeze([]),
    addresses: Object.freeze([])
  })
}

class MemoryStorageV2Repository {
  constructor(snapshot = sourceSnapshot()) {
    this.pointer = {
      schemaVersion: 2,
      generationId: snapshot.manifest.generationId,
      sourceFingerprint: snapshot.manifest.sourceFingerprint,
      committedAt: snapshot.manifest.verifiedAt
    }
    this.snapshots = new Map([[snapshot.manifest.generationId, snapshot]])
    this.staged = []
    this.discarded = []
    this.commits = []
  }

  async getActivePointer() {
    return this.pointer
  }

  async getSnapshot(generationId) {
    return this.snapshots.get(generationId) ?? null
  }

  async stage(snapshot) {
    const existing = this.snapshots.get(snapshot.manifest.generationId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
      throw new Error('generation conflict')
    }
    this.snapshots.set(snapshot.manifest.generationId, snapshot)
    this.staged.push(snapshot)
  }

  async commit(pointer, expectedGenerationId) {
    this.commits.push({ pointer, expectedGenerationId })
    if (this.pointer?.generationId !== expectedGenerationId) {
      return 'active-generation-changed'
    }
    this.pointer = pointer
    return 'committed'
  }

  async discardUncommittedGeneration(generationId) {
    if (this.pointer?.generationId === generationId) {
      throw new Error('cannot discard active generation')
    }
    this.snapshots.delete(generationId)
    this.discarded.push(generationId)
  }
}

function coordinator(repository, commitPointer) {
  return new ActiveAccountSelectionCoordinator({
    credentialRepository: {},
    storageRepository: repository,
    commitPointer:
      commitPointer ??
      ((storageRepository, _credentialRepository, pointer, expectedGenerationId) =>
        storageRepository.commit(pointer, expectedGenerationId))
  })
}

test.describe('Active Account selection coordinator', () => {
  test('commits an immutable metadata-only generation for a same-Wallet Account switch', async () => {
    const repository = new MemoryStorageV2Repository()
    const result = await coordinator(repository).select({
      keyDomainId: 'wallet:1',
      accountId: 'account:1:1'
    })

    expect(result.status).toBe('selected')
    expect(result.generationId).toMatch(/^storage-v2:active-account:[a-f0-9]{64}$/)
    expect(repository.staged).toHaveLength(1)
    const target = repository.staged[0]
    expect(target.manifest).toMatchObject({
      generationId: result.generationId,
      status: 'verified',
      mainKeyDomainId: 'wallet:1',
      activeAccount: { keyDomainId: 'wallet:1', accountId: 'account:1:1' },
      createdAt: CREATED_AT,
      verifiedAt: CREATED_AT
    })
    expect(target.keyDomains).toBe(repository.snapshots.get(SOURCE_GENERATION_ID).keyDomains)
    expect(target.accounts).toBe(repository.snapshots.get(SOURCE_GENERATION_ID).accounts)
    expect(repository.commits[0].expectedGenerationId).toBe(SOURCE_GENERATION_ID)
    expect(repository.pointer.generationId).toBe(result.generationId)
  })

  test('supports a cross-Wallet selection without changing Main Wallet', async () => {
    const repository = new MemoryStorageV2Repository()
    const result = await coordinator(repository).select({
      keyDomainId: 'wallet:2',
      accountId: 'account:2:0'
    })

    const target = repository.snapshots.get(result.generationId)
    expect(target.manifest.mainKeyDomainId).toBe('wallet:1')
    expect(target.manifest.activeAccount).toEqual({
      keyDomainId: 'wallet:2',
      accountId: 'account:2:0'
    })
  })

  test('does not create another generation when the requested Account is already active', async () => {
    const repository = new MemoryStorageV2Repository()
    const result = await coordinator(repository).select({
      keyDomainId: 'wallet:1',
      accountId: 'account:1:0'
    })

    expect(result).toEqual({
      status: 'already-selected',
      generationId: SOURCE_GENERATION_ID
    })
    expect(repository.staged).toEqual([])
    expect(repository.commits).toEqual([])
  })

  test('fails closed for an unknown or cross-Wallet Account reference', async () => {
    const repository = new MemoryStorageV2Repository()
    await expect(
      coordinator(repository).select({
        keyDomainId: 'wallet:2',
        accountId: 'account:1:1'
      })
    ).rejects.toThrow(/Active Account must belong/)
    expect(repository.staged).toEqual([])
    expect(repository.pointer.generationId).toBe(SOURCE_GENERATION_ID)
  })

  test('retries a compare-and-swap conflict and removes the abandoned generation', async () => {
    const repository = new MemoryStorageV2Repository()
    let attempts = 0
    const result = await coordinator(repository, (...args) => {
      attempts += 1
      if (attempts === 1) return Promise.resolve('active-generation-changed')
      const [storageRepository, , pointer, expectedGenerationId] = args
      return storageRepository.commit(pointer, expectedGenerationId)
    }).select({
      keyDomainId: 'wallet:1',
      accountId: 'account:1:1'
    })

    expect(result.status).toBe('selected')
    expect(attempts).toBe(2)
    expect(repository.discarded).toHaveLength(1)
  })

  test('cleans up a rejected target generation without changing the active pointer', async () => {
    const repository = new MemoryStorageV2Repository()
    await expect(
      coordinator(repository, () => Promise.resolve('credential-binding-invalid')).select({
        keyDomainId: 'wallet:1',
        accountId: 'account:1:1'
      })
    ).rejects.toThrow(/credential-binding-invalid/)

    expect(repository.pointer.generationId).toBe(SOURCE_GENERATION_ID)
    expect(repository.discarded).toHaveLength(1)
  })

  test('resolves an ambiguous commit error from the active pointer', async () => {
    const repository = new MemoryStorageV2Repository()
    const result = await coordinator(
      repository,
      async (storageRepository, _credentialRepository, pointer, expectedGenerationId) => {
        expect(await storageRepository.commit(pointer, expectedGenerationId)).toBe('committed')
        throw new Error('response lost after commit')
      }
    ).select({
      keyDomainId: 'wallet:1',
      accountId: 'account:1:1'
    })

    expect(result.status).toBe('selected')
    expect(repository.pointer.generationId).toBe(result.generationId)
    expect(repository.discarded).toEqual([])
  })

  test('does not read credentials or modify Storage V2 when it is inactive', async () => {
    const repository = new MemoryStorageV2Repository()
    repository.pointer = null
    const result = await coordinator(repository, () => {
      throw new Error('commit must not run')
    }).select({
      keyDomainId: 'wallet:1',
      accountId: 'account:1:0'
    })

    expect(result).toEqual({ status: 'storage-v2-inactive' })
    expect(repository.staged).toEqual([])
  })
})
