import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  unwrapHardwareCredentialEnvelope,
  unwrapSoftwareCredentialEnvelopePair
} from '../../../src/infrastructure/keyring/credential-envelope-authentication.ts'
import { MixedRetainedV1MigrationCoordinator } from '../../../src/infrastructure/keyring/migration/mixed-retained-v1-migration-coordinator.ts'
import {
  isNativeV2CredentialKeyDomain,
  RetainedV1ReconciliationCoordinator
} from '../../../src/infrastructure/keyring/migration/retained-v1-reconciliation-coordinator.ts'
import { decodeV1EncryptedCredentialEnvelope } from '../../../src/infrastructure/keyring/migration/v1-credential-envelope.ts'
import { discoverV1Metadata } from '../../../src/infrastructure/persistence/migrations/v1-metadata-discovery.ts'
import { InMemoryCredentialRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'
import { V1_MIGRATION_FIXTURES } from '../../fixtures/v1-migration-fixtures.mjs'
import { SecureStorage } from '../../../src/core/wallet/secure-storage.ts'

const PASSWORD = 'mixed-migration-password'
const CREATED_AT = 1_700_000_000_001
const CHAINS = Object.freeze({
  zcashNetwork: 'mainnet',
  zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  evmChainId: 'eip155:1',
  bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
})
const VAULT = Object.freeze({
  version: 1,
  kdf: 'argon2id',
  kdfParams: Object.freeze({ memoryKib: 19 * 1024, iterations: 2, parallelism: 1 }),
  cipher: 'xchacha20poly1305',
  salt: '11'.repeat(16),
  nonce: '22'.repeat(24),
  ciphertext: '33'.repeat(32)
})

test('retained V1 reconciliation preserves only recognized native V2 credential domains', () => {
  expect(
    isNativeV2CredentialKeyDomain({
      id: 'wallet:private-key-v2:fixture',
      source: { kind: 'private-key' }
    })
  ).toBe(true)
  expect(
    isNativeV2CredentialKeyDomain({
      id: 'wallet:keystone-v2:fixture',
      source: { kind: 'hardware' }
    })
  ).toBe(true)
  expect(
    isNativeV2CredentialKeyDomain({
      id: 'wallet:ledger-v3:fixture',
      source: { kind: 'hardware' }
    })
  ).toBe(true)
  expect(
    isNativeV2CredentialKeyDomain({
      id: 'wallet:ledger-v3:spoofed',
      source: { kind: 'software' }
    })
  ).toBe(false)
  expect(
    isNativeV2CredentialKeyDomain({
      id: 'wallet:private-key-v2:spoofed',
      source: { kind: 'software' }
    })
  ).toBe(false)
})

class MemoryStorageV2Repository {
  constructor() {
    this.pointer = null
    this.snapshots = new Map()
    this.commits = []
  }

  async getActivePointer() {
    return this.pointer
  }

  async getSnapshot(generationId) {
    return this.snapshots.get(generationId) ?? null
  }

  async stage(snapshot) {
    const current = this.snapshots.get(snapshot.manifest.generationId)
    if (current && JSON.stringify(current) !== JSON.stringify(snapshot)) {
      throw new Error('generation conflict')
    }
    this.snapshots.set(snapshot.manifest.generationId, snapshot)
  }

  async commit(pointer, expectedGenerationId) {
    if ((this.pointer?.generationId ?? null) !== expectedGenerationId) {
      return 'active-generation-changed'
    }
    this.pointer = pointer
    this.commits.push(pointer)
    return 'committed'
  }

  async discardUncommittedGeneration(generationId) {
    if (this.pointer?.generationId === generationId) throw new Error('cannot discard active')
    this.snapshots.delete(generationId)
  }
}

function mixedFixture() {
  return V1_MIGRATION_FIXTURES.find(fixture => fixture.id === 'software-and-keystone')
}

function compatibilityWorker(overrides = {}) {
  return {
    calls: [],
    async migrate(input) {
      this.calls.push(input)
      return {
        operation: 'migrate',
        vault: VAULT,
        mnemonicWordCount: 24,
        accounts: input.accounts.map(account => ({
          accountIndex: account.accountIndex,
          zcash: {
            chainId: input.zcashChainId,
            derivationPath: `m/32'/133'/${account.accountIndex}'`,
            identity: account.expectedZcash.fullUnified ?? account.expectedZcash.shielded
          },
          evm: {
            chainId: input.evmChainId,
            derivationPath: `m/44'/60'/0'/0/${account.accountIndex}`,
            identity: `0x${String(account.accountIndex + 1).padStart(40, '0')}`
          },
          bitcoin: {
            chainId: input.bitcoinChainId,
            derivationPath: `m/84'/0'/${account.accountIndex}'/0/0`,
            identity: `bc1qfixture${account.accountIndex}`
          }
        })),
        ...overrides
      }
    }
  }
}

function keystoneVerifier(overrides = {}) {
  return {
    calls: [],
    async verifyZcash(input) {
      this.calls.push(input)
      return {
        accountIndex: input.account.accountIndex,
        chainId: input.chainId,
        derivationPath: `m/32'/133'/${input.account.accountIndex}'`,
        identity: input.account.expected.fullUnified ?? input.account.expected.shielded,
        transparent: input.account.expected.transparent,
        shielded: input.account.expected.shielded,
        ...(input.account.expected.fullUnified === undefined
          ? {}
          : { fullUnified: input.account.expected.fullUnified }),
        ...overrides
      }
    }
  }
}

function input() {
  const fixture = mixedFixture()
  return inputForLocal(fixture.local)
}

function inputForLocal(local) {
  return {
    discovery: discoverV1Metadata(local),
    credentialEnvelopes: local,
    password: PASSWORD,
    chains: CHAINS
  }
}

async function decryptableMixedFixture() {
  const local = structuredClone(mixedFixture().local)
  local['hw_wallet-mixed-keystone'] = await SecureStorage.encrypt(
    JSON.stringify({
      ufvk: 'uview1mixedfixture',
      seedFingerprintHex: 'ab'.repeat(32),
      accountHdIndex: 0
    }),
    PASSWORD
  )
  return local
}

function addedSoftwareWalletLocal(sourceLocal = mixedFixture().local) {
  const local = structuredClone(sourceLocal)
  const state = JSON.parse(local.wallet_state)
  const sourceWallet = state.state.wallets.find(wallet => wallet.keySource === 'software')
  const sourceAccount = sourceWallet.accounts[0]
  const walletId = 'wallet-mixed-software-added'
  const accountId = 'account-mixed-software-added-0'
  state.state.wallets.push({
    ...structuredClone(sourceWallet),
    id: walletId,
    name: 'Added Software Wallet',
    seedPhraseKey: `seed_${walletId}`,
    accounts: [
      {
        ...structuredClone(sourceAccount),
        id: accountId,
        name: 'Account 1',
        addresses: {
          transparent: 't-fixture-added-software',
          shielded: 'u-fixture-added-software',
          fullUnified: 'u-full-fixture-added-software'
        }
      }
    ],
    createdAt: CREATED_AT + 10
  })
  state.state.currentWalletId = walletId
  state.state.currentAccountId = accountId
  local.wallet_state = JSON.stringify(state)
  local[`seed_${walletId}`] = local['seed_wallet-mixed-software']
  return local
}

test.describe('mixed software and Keystone retained V1 migration', () => {
  test('atomically commits both credential sources in one generation and password domain', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    const storageRepository = new MemoryStorageV2Repository()
    const software = compatibilityWorker()
    const hardware = keystoneVerifier()
    const coordinator = new MixedRetainedV1MigrationCoordinator({
      credentialRepository,
      storageRepository,
      compatibilityWorker: software,
      keystoneVerifier: hardware,
      now: () => CREATED_AT
    })

    const result = await coordinator.migrate(input())
    expect(result.status).toBe('committed')
    expect(storageRepository.pointer.generationId).toBe(result.generationId)
    expect(storageRepository.commits).toHaveLength(1)
    expect(software.calls).toHaveLength(1)
    expect(hardware.calls).toHaveLength(1)

    const snapshot = await storageRepository.getSnapshot(result.generationId)
    expect(snapshot.keyDomains).toHaveLength(2)
    expect(snapshot.keyDomains.map(keyDomain => keyDomain.source)).toEqual([
      { kind: 'software', mnemonicWordCount: 24 },
      {
        kind: 'hardware',
        vendor: 'keystone',
        firmwareProfile: 'cypherpunk',
        capabilities: ['zcash']
      }
    ])
    expect(snapshot.chainAccounts).toHaveLength(4)
    expect(snapshot.addresses).toHaveLength(8)
    expect(snapshot.manifest.activeAccount).toEqual({
      keyDomainId: 'wallet-mixed-software',
      accountId: 'account-mixed-software-0'
    })

    for (const keyDomain of snapshot.keyDomains) {
      const activation = await credentialRepository.validateForActivation(
        keyDomain.credentialRef,
        keyDomain.id
      )
      expect(activation.status).toBe('active')
      if (activation.record.manifest.source === 'software') {
        const zcash = await credentialRepository.getEnvelope(
          activation.record.manifest.engines.zcash.credentialRef
        )
        const multichain = await credentialRepository.getEnvelope(
          activation.record.manifest.engines.multichain.credentialRef
        )
        const decrypted = await unwrapSoftwareCredentialEnvelopePair(
          { zcash, multichain },
          PASSWORD
        )
        expect(decodeV1EncryptedCredentialEnvelope(decrypted.zcash)).toEqual(
          input().credentialEnvelopes['seed_wallet-mixed-software']
        )
        expect(JSON.parse(new TextDecoder().decode(decrypted.multichain))).toEqual(VAULT)
      } else {
        const envelope = await credentialRepository.getEnvelope(
          activation.record.manifest.engines.zcash.credentialRef
        )
        const decrypted = await unwrapHardwareCredentialEnvelope(envelope, PASSWORD)
        expect(decodeV1EncryptedCredentialEnvelope(decrypted)).toEqual(
          input().credentialEnvelopes['hw_wallet-mixed-keystone']
        )
      }
    }

    await expect(coordinator.migrate(input())).resolves.toMatchObject({
      status: 'already-committed',
      generationId: result.generationId
    })
    expect(storageRepository.commits).toHaveLength(1)
  })

  test('rejects a Keystone verification mismatch before any persistent write', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    const storageRepository = new MemoryStorageV2Repository()
    const coordinator = new MixedRetainedV1MigrationCoordinator({
      credentialRepository,
      storageRepository,
      compatibilityWorker: compatibilityWorker(),
      keystoneVerifier: keystoneVerifier({ transparent: 't1-substituted' })
    })

    await expect(coordinator.migrate(input())).rejects.toThrow(
      'Keystone Zcash verification anchor mismatch'
    )
    expect(storageRepository.pointer).toBeNull()
    expect(storageRepository.snapshots.size).toBe(0)
    expect(await credentialRepository.findIncompleteJournal('migrate')).toBeNull()
  })

  test('rejects an incomplete software result before staging either credential source', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    const storageRepository = new MemoryStorageV2Repository()
    const coordinator = new MixedRetainedV1MigrationCoordinator({
      credentialRepository,
      storageRepository,
      compatibilityWorker: compatibilityWorker({ accounts: [] }),
      keystoneVerifier: keystoneVerifier()
    })

    await expect(coordinator.migrate(input())).rejects.toThrow(
      'Compatibility Worker returned an incomplete Account set'
    )
    expect(storageRepository.pointer).toBeNull()
    expect(storageRepository.snapshots.size).toBe(0)
    expect(await credentialRepository.findIncompleteJournal('migrate')).toBeNull()
  })

  test('reconciles the committed mixed inventory idempotently and adds software Wallets without replacing hardware', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    const storageRepository = new MemoryStorageV2Repository()
    const software = compatibilityWorker()
    const hardware = keystoneVerifier()
    const migration = new MixedRetainedV1MigrationCoordinator({
      credentialRepository,
      storageRepository,
      compatibilityWorker: software,
      keystoneVerifier: hardware,
      now: () => CREATED_AT
    })
    const local = await decryptableMixedFixture()
    const initial = await migration.migrate(inputForLocal(local))
    const reconciliation = new RetainedV1ReconciliationCoordinator({
      credentialRepository,
      storageRepository,
      compatibilityWorker: software,
      now: () => CREATED_AT + 20
    })

    await expect(reconciliation.synchronize(inputForLocal(local))).resolves.toMatchObject({
      status: 'already-synchronized',
      generationId: initial.generationId
    })

    const added = await reconciliation.synchronize(inputForLocal(addedSoftwareWalletLocal(local)))
    expect(added.status).toBe('synchronized')
    expect(added.inventory.provisionedKeyDomainIds).toEqual(['wallet-mixed-software-added'])
    const snapshot = await storageRepository.getSnapshot(added.generationId)
    expect(snapshot.keyDomains.map(keyDomain => keyDomain.source.kind)).toEqual([
      'software',
      'hardware',
      'software'
    ])
    expect(
      snapshot.keyDomains.find(keyDomain => keyDomain.source.kind === 'hardware')
    ).toMatchObject({
      id: 'wallet-mixed-keystone',
      source: { firmwareProfile: 'cypherpunk', capabilities: ['zcash'] }
    })
    expect(snapshot.manifest.activeAccount).toEqual({
      keyDomainId: 'wallet-mixed-software-added',
      accountId: 'account-mixed-software-added-0'
    })
  })

  test('rejects retained hardware address drift during mixed reconciliation', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    const storageRepository = new MemoryStorageV2Repository()
    const software = compatibilityWorker()
    const hardware = keystoneVerifier()
    const local = await decryptableMixedFixture()
    await new MixedRetainedV1MigrationCoordinator({
      credentialRepository,
      storageRepository,
      compatibilityWorker: software,
      keystoneVerifier: hardware
    }).migrate(inputForLocal(local))
    const state = JSON.parse(local.wallet_state)
    const hardwareWallet = state.state.wallets.find(wallet => wallet.keySource === 'keystone')
    hardwareWallet.accounts[0].addresses.transparent = 't-fixture-substituted'
    local.wallet_state = JSON.stringify(state)

    await expect(
      new RetainedV1ReconciliationCoordinator({
        credentialRepository,
        storageRepository,
        compatibilityWorker: software
      }).synchronize(inputForLocal(local))
    ).rejects.toThrow('Retained V1 hardware Address metadata mismatch')
    expect(storageRepository.commits).toHaveLength(1)
  })

  test('preflights retained hardware before committing a simultaneous software removal', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    const storageRepository = new MemoryStorageV2Repository()
    const software = compatibilityWorker()
    const hardware = keystoneVerifier()
    const originalLocal = await decryptableMixedFixture()
    const initialLocal = addedSoftwareWalletLocal(originalLocal)
    const initial = await new MixedRetainedV1MigrationCoordinator({
      credentialRepository,
      storageRepository,
      compatibilityWorker: software,
      keystoneVerifier: hardware
    }).migrate(inputForLocal(initialLocal))

    const changedLocal = structuredClone(originalLocal)
    const state = JSON.parse(changedLocal.wallet_state)
    const hardwareWallet = state.state.wallets.find(wallet => wallet.keySource === 'keystone')
    hardwareWallet.accounts[0].addresses.transparent = 't-fixture-substituted'
    changedLocal.wallet_state = JSON.stringify(state)

    await expect(
      new RetainedV1ReconciliationCoordinator({
        credentialRepository,
        storageRepository,
        compatibilityWorker: software
      }).synchronize(inputForLocal(changedLocal))
    ).rejects.toThrow('Retained V1 hardware Address metadata mismatch')
    expect(storageRepository.commits).toHaveLength(1)
    expect(storageRepository.pointer.generationId).toBe(initial.generationId)
    expect(
      (await storageRepository.getSnapshot(storageRepository.pointer.generationId)).keyDomains
    ).toHaveLength(3)
  })
})
