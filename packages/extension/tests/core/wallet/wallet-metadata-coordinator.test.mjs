import { test } from 'node:test'
import { expect } from '@playwright/test'

import { WalletMetadataCoordinator } from '../../../src/infrastructure/keyring/wallet-metadata-coordinator.ts'
import { FrostAccountMetadataCoordinator } from '../../../src/infrastructure/keyring/frost-account-metadata-coordinator.ts'
import { installStorageEnv } from '../multisig/helpers/storage-env.ts'

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
  test('commits the first FROST account and clears pending wallet markers on retry', async () => {
    const env = installStorageEnv()
    try {
      const source = structuredClone(sourceSnapshot())
      source.keyDomains[0].source = { kind: 'software', mnemonicWordCount: 12 }
      source.accounts = []
      source.manifest.counts.accounts = 0
      delete source.manifest.activeAccount
      const walletId = source.keyDomains[0].id
      const repository = new MemoryStorageV2Repository(source)
      const credentials = {
        validateForActivation: async () => ({
          status: 'active',
          record: {
            manifest: { source: 'software', mnemonicWordCount: 12, engines: {} }
          }
        })
      }
      const account = {
        id: 'first-multisig',
        name: 'My multisig',
        source: { kind: 'frost-vault', version: 1, groupId: 'new-group', network: 'mainnet' },
        birthdayHeight: 123,
        addresses: { shielded: 'u1-independent', transparent: '' },
        isPinned: false,
        isHidden: false
      }
      const operation = {
        version: 1,
        operationId: 'operation',
        scope: { network: 'mainnet', walletId, accountId: account.id },
        parentAccountId: 'pending-first-account',
        accountName: account.name,
        groupId: 'new-group',
        threshold: '2-of-2',
        birthdayHeight: 123,
        createdAt: CREATED_AT + 1,
        phase: 'external_imported'
      }
      env.store.set('wallet_state', {
        state: {
          wallets: [
            {
              id: walletId,
              keySource: 'software',
              accounts: [],
              pendingFirstAccountId: operation.parentAccountId,
              pendingFirstAccountName: account.name,
              pendingFirstAccountNetwork: 'mainnet'
            }
          ],
          currentWalletId: walletId,
          currentAccountId: null
        }
      })
      const metadata = new FrostAccountMetadataCoordinator(credentials, repository)
      await metadata.commit(operation, account, async () => {})
      await metadata.commit(operation, account, async () => {})
      const target = await repository.getSnapshot(repository.pointer.generationId)
      expect(target.accounts).toHaveLength(1)
      expect(target.accounts[0].id).toBe(account.id)
      expect(target.manifest.activeAccount).toEqual({
        keyDomainId: walletId,
        accountId: account.id
      })
      const retained = env.store.get('wallet_state').state
      expect(retained.wallets[0].accounts).toHaveLength(1)
      expect(retained.wallets[0]).not.toHaveProperty('pendingFirstAccountId')
      expect(retained.wallets[0]).not.toHaveProperty('pendingFirstAccountName')
      expect(retained.wallets[0]).not.toHaveProperty('pendingFirstAccountNetwork')
      expect(retained.currentAccountId).toBe(account.id)
    } finally {
      env.restore()
    }
  })

  test('commits an independent FROST account through credential-bound pointer and retries without duplicating its HD parent', async () => {
    const env = installStorageEnv()
    try {
      const source = structuredClone(sourceSnapshot())
      source.keyDomains[0].source = { kind: 'software', mnemonicWordCount: 12 }
      const walletId = source.keyDomains[0].id
      source.chainAccounts = [
        {
          id: 'hd-zcash',
          scope: { keyDomainId: walletId, accountId: source.accounts[0].id, chainId: 'zcash:main' },
          derivation: { scheme: 'zip32', path: "m/32'/133'/0'" },
          identity: { kind: 'account-identifier', value: 'hd-address' },
          createdAt: CREATED_AT
        }
      ]
      source.manifest.counts.chainAccounts = 1
      const repository = new MemoryStorageV2Repository(source)
      const credentials = {
        validateForActivation: async () => ({
          status: 'active',
          record: {
            manifest: {
              source: 'software',
              mnemonicWordCount: 12,
              engines: { zcash: { verificationAnchorRef: 'chain-account:hd-zcash' } }
            }
          }
        })
      }
      const account = {
        id: 'independent-account',
        name: 'Multisig',
        source: { kind: 'frost-vault', version: 1, groupId: 'new-group', network: 'mainnet' },
        birthdayHeight: 123,
        addresses: { shielded: 'u1-independent', transparent: '' },
        isPinned: false,
        isHidden: false
      }
      const operation = {
        version: 1,
        operationId: 'operation',
        scope: { network: 'mainnet', walletId, accountId: account.id },
        parentAccountId: source.accounts[0].id,
        groupId: 'new-group',
        threshold: '2-of-3',
        birthdayHeight: 123,
        createdAt: CREATED_AT + 1,
        phase: 'external_imported'
      }
      env.store.set('wallet_state', {
        state: {
          wallets: [
            {
              id: walletId,
              keySource: 'software',
              accounts: [{ id: source.accounts[0].id, derivationIndex: 0, name: 'Original' }]
            }
          ],
          unrelated: 'preserved'
        }
      })
      const metadata = new FrostAccountMetadataCoordinator(credentials, repository)
      const commit = repository.commit.bind(repository)
      repository.commit = async () => 'active-generation-changed'
      await expect(metadata.commit(operation, account, async () => {})).rejects.toThrow(
        'Account metadata could not be committed'
      )
      expect(repository.pointer.generationId).toBe(SOURCE_GENERATION_ID)
      expect(env.store.get('wallet_state').state.wallets[0].accounts).toHaveLength(1)
      repository.commit = commit
      await metadata.commit(operation, account, async () => {})
      await metadata.commit(operation, account, async () => {})
      const target = await repository.getSnapshot(repository.pointer.generationId)
      expect(target.accounts).toHaveLength(2)
      expect(target.accounts[0]).toEqual(source.accounts[0])
      expect(target.accounts[1]).not.toHaveProperty('accountIndex')
      expect(target.chainAccounts[1]).not.toHaveProperty('derivation')
      expect(target.keyDomains).toEqual(source.keyDomains)
      expect(target.addresses[0].scheme).toBe('zcash-shielded-unified')
      const retained = env.store.get('wallet_state')
      expect(retained.state.wallets[0].accounts).toHaveLength(2)
      expect(retained.state.wallets[0].accounts[0]).toEqual({
        id: source.accounts[0].id,
        derivationIndex: 0,
        name: 'Original'
      })
      expect(retained.state.unrelated).toBe('preserved')
    } finally {
      env.restore()
    }
  })
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
