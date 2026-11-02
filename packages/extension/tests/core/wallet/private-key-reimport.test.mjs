import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCredentialBindings } from '../../../src/core/keyring/application/credential-bound-storage-v2.ts'
import { authenticatePrivateKeyCredentialEnvelope } from '../../../src/infrastructure/keyring/credential-envelope-authentication.ts'
import { PrivateKeyProvisioningCoordinator } from '../../../src/infrastructure/keyring/private-key-provisioning-coordinator.ts'
import { CredentialRemovalCoordinator } from '../../../src/infrastructure/keyring/migration/credential-removal-coordinator.ts'
import { InMemoryCredentialRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'
import { parseStorageV2Snapshot } from '../../../src/infrastructure/persistence/schema/index.ts'

const PASSWORD = 'synthetic-private-key-reimport-password'
const VAULT = {
  version: 1,
  kdf: 'argon2id',
  kdfParams: { memoryKib: 19 * 1024, iterations: 2, parallelism: 1 },
  cipher: 'xchacha20poly1305',
  salt: '11'.repeat(16),
  nonce: '22'.repeat(24),
  ciphertext: '33'.repeat(32)
}

class MemoryStorage {
  pointer = null
  snapshots = new Map()
  beforeNextCommit = null

  async getActivePointer() {
    return this.pointer
  }

  async getSnapshot(id) {
    return this.snapshots.get(id) ?? null
  }

  async stage(snapshot) {
    const previous = this.snapshots.get(snapshot.manifest.generationId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(snapshot)) {
      throw new Error('Storage generation conflict')
    }
    this.snapshots.set(snapshot.manifest.generationId, snapshot)
  }

  async commit(pointer, expected) {
    const beforeNextCommit = this.beforeNextCommit
    this.beforeNextCommit = null
    if (beforeNextCommit) await beforeNextCommit()
    if ((this.pointer?.generationId ?? null) !== expected) return 'active-generation-changed'
    this.pointer = pointer
    return 'committed'
  }

  async discardUncommittedGeneration(id) {
    this.snapshots.delete(id)
  }
}

function fixture() {
  const credentialRepository = new InMemoryCredentialRepository()
  const storageRepository = new MemoryStorage()
  let clock = 1_700_000_000_000
  const now = () => ++clock
  const derive = async input => ({
    vault: VAULT,
    scope: { chainFamily: 'eip155' },
    derived: [
      {
        chainId: 'eip155:1',
        address:
          input.privateKey === 'synthetic-key-a'
            ? `0x${'1'.repeat(40)}`
            : input.privateKey === 'synthetic-key-b'
              ? `0x${'2'.repeat(40)}`
              : `0x${'3'.repeat(40)}`,
        addressScheme: 'evm',
        publicKey: `public-${input.privateKey}`
      }
    ]
  })
  const createCoordinator = (repository = credentialRepository) => {
    const coordinator = new PrivateKeyProvisioningCoordinator({
      credentialRepository: repository,
      storageRepository,
      now
    })
    coordinator.derive = derive
    return coordinator
  }
  const provisioning = createCoordinator()
  const removal = new CredentialRemovalCoordinator({
    credentialRepository,
    storageRepository,
    compatibilityWorker: {},
    now
  })
  const inputFor = (privateKey, displayName = privateKey) => ({
    privateKey,
    chainFamily: 'eip155',
    displayName,
    password: PASSWORD,
    network: 'mainnet',
    evmChainIds: ['eip155:1']
  })
  const importKey = (privateKey, displayName = privateKey) =>
    provisioning.provision(inputFor(privateKey, displayName))
  const importCompetingKey = (privateKey, displayName = privateKey) =>
    createCoordinator().provision(inputFor(privateKey, displayName))
  const activeSnapshot = async () =>
    storageRepository.getSnapshot(storageRepository.pointer.generationId)
  return {
    credentialRepository,
    storageRepository,
    createCoordinator,
    inputFor,
    importKey,
    importCompetingKey,
    removal,
    activeSnapshot
  }
}

test('deleted private-key wallet reimports twice with stable public identity and fresh retired credentials', async () => {
  const state = fixture()
  const first = await state.importKey('synthetic-key-a')
  assert.equal(first.status, 'committed')
  await state.importKey('synthetic-key-b')
  const refs = []

  for (let round = 0; round < 2; round++) {
    const source = await state.activeSnapshot()
    const keyDomain = source.keyDomains.find(item => item.id === first.keyDomainId)
    refs.push(keyDomain.credentialRef)
    const sourceSet = await state.credentialRepository.getCredentialSet(keyDomain.credentialRef)
    assert.equal((await state.removal.removeWallet(first.keyDomainId)).status, 'removed')
    assert.equal(
      (await state.activeSnapshot()).keyDomains.some(item => item.id === first.keyDomainId),
      false
    )
    assert.equal(
      (
        await state.credentialRepository.validateForActivation(
          keyDomain.credentialRef,
          first.keyDomainId
        )
      ).status,
      'retired'
    )
    assert.equal(
      await state.credentialRepository.getEnvelope(
        sourceSet.manifest.engines.multichain.credentialRef
      ),
      null
    )
    const imported = await state.importKey('synthetic-key-a')
    assert.equal(imported.status, 'committed')
    assert.equal(imported.keyDomainId, first.keyDomainId)
    assert.equal(imported.accountId, first.accountId)
    assert.equal(
      (await state.importKey('synthetic-key-a', 'different name')).status,
      'already-committed'
    )
  }

  refs.push(
    (await state.activeSnapshot()).keyDomains.find(item => item.id === first.keyDomainId)
      .credentialRef
  )
  assert.equal(new Set(refs).size, 3)
  assert.equal((await state.activeSnapshot()).keyDomains.length, 2)
})

test('a competing pointer commit leaves the failed credential inactive and retry succeeds', async () => {
  const state = fixture()
  await state.importKey('synthetic-key-b')
  const previousPointer = state.storageRepository.pointer.generationId
  state.storageRepository.beforeNextCommit = () => state.importCompetingKey('synthetic-key-c')
  await assert.rejects(state.importKey('synthetic-key-a'), /active-generation-changed/)
  assert.notEqual(state.storageRepository.pointer.generationId, previousPointer)
  assert.equal((await state.activeSnapshot()).keyDomains.length, 2)
  const abandoned = await state.credentialRepository.findIncompleteJournal('create')
  const abandonedRef = abandoned.transitions[0].targetCredentialSetRef
  const keyDomainId = abandoned.transitions[0].keyDomainId
  assert.equal(
    (await state.credentialRepository.validateForActivation(abandonedRef, keyDomainId)).status,
    'transaction-not-committed'
  )
  const retry = await state.importKey('synthetic-key-a')
  assert.equal(retry.status, 'committed')
  assert.equal(retry.keyDomainId, keyDomainId)
  assert.notEqual(
    (await state.activeSnapshot()).keyDomains.find(item => item.id === keyDomainId).credentialRef,
    abandonedRef
  )
  assert.equal(
    (await state.credentialRepository.validateForActivation(abandonedRef, keyDomainId)).status,
    'transaction-not-committed'
  )
})

test('an active wallet with legacy deterministic credential refs remains idempotent', async () => {
  const state = fixture()
  let staged
  const stageTransaction = state.credentialRepository.stageTransaction.bind(
    state.credentialRepository
  )
  state.credentialRepository.stageTransaction = async (...args) => {
    staged = args
    return stageTransaction(...args)
  }
  const first = await state.importKey('synthetic-key-a')
  const snapshot = await state.activeSnapshot()
  const sourceSet = staged[2][0]
  const sourceEnvelope = staged[1][0]
  const identityHash = Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify([
          'noir-imported-private-key-public-v1',
          { chainFamily: 'eip155' },
          [['eip155:1', `0x${'1'.repeat(40)}`, 'public-synthetic-key-a']]
        ])
      )
    )
  ).toString('hex')
  const legacyGeneration = `credential-generation:private-key-v2:${identityHash}`
  const legacySetRef = `credential-set:private-key-v2:${identityHash}`
  const legacyEngineRef = `credential:private-key-v2:${identityHash}:multichain`
  const legacyEnvelope = await authenticatePrivateKeyCredentialEnvelope(
    {
      ...sourceEnvelope,
      aad: {
        ...sourceEnvelope.aad,
        credentialGenerationId: legacyGeneration,
        credentialRef: legacyEngineRef
      },
      encryptedPayload: new TextEncoder().encode(JSON.stringify(VAULT))
    },
    PASSWORD
  )
  const legacySet = {
    ...sourceSet,
    credentialSetRef: legacySetRef,
    manifest: {
      ...sourceSet.manifest,
      credentialGenerationId: legacyGeneration,
      engines: {
        multichain: {
          ...sourceSet.manifest.engines.multichain,
          credentialRef: legacyEngineRef
        }
      }
    }
  }
  const sourceJournal = await state.credentialRepository.getJournal(first.transactionId)
  const legacyJournal = {
    ...sourceJournal,
    transitions: [
      {
        ...sourceJournal.transitions[0],
        targetCredentialGenerationId: legacyGeneration,
        targetCredentialSetRef: legacySetRef,
        stagedRefs: [legacyEngineRef]
      }
    ]
  }
  const legacyRepository = new InMemoryCredentialRepository({
    envelopes: [legacyEnvelope],
    credentialSets: [legacySet],
    journals: [legacyJournal],
    retirements: []
  })
  const legacySnapshot = parseStorageV2Snapshot({
    ...snapshot,
    keyDomains: snapshot.keyDomains.map(keyDomain => ({
      ...keyDomain,
      credentialRef: legacySetRef
    }))
  })
  state.storageRepository.snapshots.set(snapshot.manifest.generationId, legacySnapshot)
  assert.deepEqual(await validateCredentialBindings(legacySnapshot, legacyRepository), {
    status: 'valid'
  })
  const duplicate = await state
    .createCoordinator(legacyRepository)
    .provision(state.inputFor('synthetic-key-a', 'different name'))
  assert.equal(duplicate.status, 'already-committed')
  assert.equal(duplicate.keyDomainId, first.keyDomainId)
  assert.equal(duplicate.accountId, first.accountId)
  assert.equal((await state.activeSnapshot()).keyDomains[0].credentialRef, legacySetRef)
})
