import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519'
import { parseChainAccountVerificationAnchorRef } from '../../../src/core/keyring/application/index.ts'
import { createLedgerMultichainHardwareCredential } from '../../../src/core/wallet/ledger-hardware-credential.ts'
import { readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair } from '../../../src/infrastructure/keyring/credential-envelope-authentication.ts'
import {
  CredentialRemovalCoordinator,
  CredentialRemovalUnlockRequiredError
} from '../../../src/infrastructure/keyring/migration/credential-removal-coordinator.ts'
import { RetainedV1MigrationCoordinator } from '../../../src/infrastructure/keyring/migration/retained-v1-migration-coordinator.ts'
import { RetainedV1ReconciliationCoordinator } from '../../../src/infrastructure/keyring/migration/retained-v1-reconciliation-coordinator.ts'
import { LedgerHardwareProvisioningCoordinator } from '../../../src/infrastructure/keyring/ledger-hardware-provisioning-coordinator.ts'
import { discoverV1Metadata } from '../../../src/infrastructure/persistence/migrations/v1-metadata-discovery.ts'
import { InMemoryCredentialRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'
import { parseStorageV2Snapshot } from '../../../src/infrastructure/persistence/schema/index.ts'
import { encodeSolanaBase58 } from '../../../src/infrastructure/chains/solana/solana-rpc-codecs.ts'
import { V1_MIGRATION_FIXTURES } from '../../fixtures/v1-migration-fixtures.mjs'

const PASSWORD = 'removal-fixture-password'
const NOW = 1_700_000_000_000
const CHAINS = {
  zcashNetwork: 'mainnet',
  zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  evmChainId: 'eip155:1',
  bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
}
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
  commitFailure = null
  async getActivePointer() {
    return this.pointer
  }
  async getSnapshot(id) {
    return this.snapshots.get(id) ?? null
  }
  async stage(snapshot) {
    const previous = this.snapshots.get(snapshot.manifest.generationId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(snapshot)) {
      throw new Error('generation conflict')
    }
    this.snapshots.set(snapshot.manifest.generationId, snapshot)
  }
  async commit(pointer, expected) {
    if (this.commitFailure) {
      const failure = this.commitFailure
      this.commitFailure = null
      if (failure === 'throw') throw new Error('injected commit failure')
      return failure
    }
    if ((this.pointer?.generationId ?? null) !== expected) return 'active-generation-changed'
    this.pointer = pointer
    return 'committed'
  }
  async discardUncommittedGeneration(id) {
    this.snapshots.delete(id)
  }
}

function worker({ wrongAccount = false } = {}) {
  return {
    calls: [],
    async migrate(input) {
      this.calls.push(input)
      return {
        operation: 'migrate',
        vault: VAULT,
        mnemonicWordCount: 24,
        accounts: input.accounts.map(({ accountIndex, expectedZcash }) => ({
          accountIndex,
          zcash: {
            chainId: input.zcashChainId,
            derivationPath: `m/32'/133'/${accountIndex}'`,
            identity:
              expectedZcash.fullUnified ??
              (accountIndex === 2 ? 'u-full-fixture-rotated' : 'u-full-fixture-account_multi_0')
          },
          evm: {
            chainId: input.evmChainId,
            derivationPath: `m/44'/60'/0'/0/${accountIndex}`,
            identity: wrongAccount
              ? '0x' + 'f'.repeat(40)
              : `0x${String(accountIndex + 1).padStart(40, '0')}`
          },
          bitcoin: {
            chainId: input.bitcoinChainId,
            derivationPath: `m/84'/0'/${accountIndex}'/0/0`,
            identity: `bc1qfixture${accountIndex}`
          }
        }))
      }
    }
  }
}

async function fixture(options = {}) {
  const credentialRepository = new InMemoryCredentialRepository()
  const storageRepository = new MemoryStorage()
  const compatibilityWorker = worker(options)
  const local = V1_MIGRATION_FIXTURES.find(item => item.id === 'software-multi-account').local
  const migration = new RetainedV1MigrationCoordinator({
    credentialRepository,
    storageRepository,
    compatibilityWorker,
    now: () => NOW
  })
  await migration.migrate({
    discovery: discoverV1Metadata(local),
    credentialEnvelopes: local,
    password: PASSWORD,
    chains: CHAINS
  })
  const snapshot = await storageRepository.getSnapshot(storageRepository.pointer.generationId)
  const keyDomain = snapshot.keyDomains[0]
  const sourceSet = await credentialRepository.getCredentialSet(keyDomain.credentialRef)
  const sourceEnvelopes = {
    zcash: await credentialRepository.getEnvelope(sourceSet.manifest.engines.zcash.credentialRef),
    multichain: await credentialRepository.getEnvelope(
      sourceSet.manifest.engines.multichain.credentialRef
    )
  }
  const first = snapshot.accounts.find(account => account.accountIndex === 0)
  const retained = snapshot.accounts.find(account => account.accountIndex === 2)
  const removal = (now = NOW + 1) =>
    new CredentialRemovalCoordinator({
      credentialRepository,
      storageRepository,
      compatibilityWorker,
      now: () => now
    })
  return {
    credentialRepository,
    storageRepository,
    compatibilityWorker,
    snapshot,
    keyDomain,
    sourceSet,
    sourceEnvelopes,
    first,
    retained,
    removal
  }
}

test('removing Account 0 reanchors both engines and preserves authenticated inner ciphertext', async () => {
  const state = await fixture()
  const retainedEvm = state.snapshot.chainAccounts.find(
    account => account.scope.accountId === state.retained.id && account.scope.chainId === 'eip155:1'
  )
  const earlierEvm = {
    ...retainedEvm,
    id: 'chain-account:fixture:evm-10',
    scope: { ...retainedEvm.scope, chainId: 'eip155:10' }
  }
  state.storageRepository.snapshots.set(
    state.snapshot.manifest.generationId,
    parseStorageV2Snapshot({
      ...state.snapshot,
      manifest: {
        ...state.snapshot.manifest,
        counts: {
          ...state.snapshot.manifest.counts,
          chainAccounts: state.snapshot.chainAccounts.length + 1
        }
      },
      chainAccounts: [earlierEvm, ...state.snapshot.chainAccounts]
    })
  )
  await state.removal().preflightAccountRemoval(state.keyDomain.id, state.first.id, PASSWORD)
  const result = await state.removal().removeAccount(state.keyDomain.id, state.first.id, PASSWORD)
  assert.equal(result.status, 'removed')
  const snapshot = await state.storageRepository.getSnapshot(result.generationId)
  assert.deepEqual(
    snapshot.accounts.map(account => account.id),
    [state.retained.id]
  )
  assert.equal(snapshot.keyDomains[0].credentialRef === state.keyDomain.credentialRef, false)
  const targetSet = await state.credentialRepository.getCredentialSet(
    snapshot.keyDomains[0].credentialRef
  )
  assert.equal(state.compatibilityWorker.calls.at(-1).evmChainId, 'eip155:1')
  for (const engine of ['zcash', 'multichain']) {
    const ref = targetSet.manifest.engines[engine].verificationAnchorRef
    const anchorId = parseChainAccountVerificationAnchorRef(ref)
    assert.equal(
      snapshot.chainAccounts.find(account => account.id === anchorId).scope.accountId,
      state.retained.id
    )
  }
  const targetEnvelopes = {
    zcash: await state.credentialRepository.getEnvelope(
      targetSet.manifest.engines.zcash.credentialRef
    ),
    multichain: await state.credentialRepository.getEnvelope(
      targetSet.manifest.engines.multichain.credentialRef
    )
  }
  const sourcePayloads = await readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair(
    state.sourceEnvelopes,
    PASSWORD
  )
  const targetPayloads = await readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair(
    targetEnvelopes,
    PASSWORD
  )
  assert.deepEqual(targetPayloads, sourcePayloads)
  assert.equal(
    (
      await state.credentialRepository.validateForActivation(
        targetSet.credentialSetRef,
        state.keyDomain.id
      )
    ).status,
    'active'
  )
  assert.equal(
    (
      await state.credentialRepository.validateForActivation(
        state.sourceSet.credentialSetRef,
        state.keyDomain.id
      )
    ).status,
    'retired'
  )
  assert.equal(
    await state.credentialRepository.getEnvelope(
      state.sourceSet.manifest.engines.zcash.credentialRef
    ),
    null
  )
  assert.equal(
    (await state.credentialRepository.getJournal(result.transactionId)).phase,
    'complete'
  )
  assert.equal(
    (await state.removal().removeAccount(state.keyDomain.id, state.first.id, PASSWORD)).status,
    'already-removed'
  )
})

test('missing unlock or a retained anchor fails before metadata removal', async () => {
  const state = await fixture()
  await assert.rejects(
    state.removal().preflightAccountRemoval(state.keyDomain.id, state.first.id),
    CredentialRemovalUnlockRequiredError
  )
  assert.equal(state.storageRepository.pointer.generationId, state.snapshot.manifest.generationId)
  const source = state.snapshot
  const withoutZcash = {
    ...source,
    chainAccounts: source.chainAccounts.filter(
      account =>
        account.scope.accountId !== state.retained.id ||
        account.scope.chainId !== CHAINS.zcashChainId
    )
  }
  state.storageRepository.snapshots.set(source.manifest.generationId, withoutZcash)
  await assert.rejects(
    state.removal().preflightAccountRemoval(state.keyDomain.id, state.first.id, PASSWORD),
    /No verified zcash account remains/
  )
  assert.equal(state.storageRepository.pointer.generationId, source.manifest.generationId)
  assert.equal(await state.credentialRepository.findIncompleteJournal('remove'), null)
})

test('removing a non-anchor Account keeps the original CredentialSet without Worker proof', async () => {
  const state = await fixture()
  const calls = state.compatibilityWorker.calls.length
  const result = await state.removal().removeAccount(state.keyDomain.id, state.retained.id)
  const active = await state.storageRepository.getSnapshot(result.generationId)
  assert.deepEqual(
    active.accounts.map(account => account.id),
    [state.first.id]
  )
  assert.equal(active.keyDomains[0].credentialRef, state.keyDomain.credentialRef)
  assert.equal(state.compatibilityWorker.calls.length, calls)
  assert.equal(
    (
      await state.credentialRepository.validateForActivation(
        state.sourceSet.credentialSetRef,
        state.keyDomain.id
      )
    ).status,
    'active'
  )
  assert.equal(await state.credentialRepository.findIncompleteJournal('remove'), null)
})

test('mismatched Worker proof fails closed without changing the active pointer', async () => {
  const state = await fixture()
  state.compatibilityWorker.migrate = worker({ wrongAccount: true }).migrate
  await assert.rejects(
    state.removal().removeAccount(state.keyDomain.id, state.first.id, PASSWORD),
    /proof does not match/
  )
  assert.equal(state.storageRepository.pointer.generationId, state.snapshot.manifest.generationId)
  assert.equal(await state.credentialRepository.findIncompleteJournal('remove'), null)
})

test('an interrupted commit resumes one replacement and does not revive Account 0', async () => {
  const state = await fixture()
  state.storageRepository.commitFailure = 'throw'
  await assert.rejects(
    state.removal().removeAccount(state.keyDomain.id, state.first.id, PASSWORD),
    /injected commit failure/
  )
  assert.equal(state.storageRepository.pointer.generationId, state.snapshot.manifest.generationId)
  assert.equal(
    (await state.credentialRepository.findIncompleteJournal('remove')).phase,
    'committing'
  )
  await state.removal().resumePendingAccountReplacement(PASSWORD)
  const active = await state.storageRepository.getSnapshot(
    state.storageRepository.pointer.generationId
  )
  assert.deepEqual(
    active.accounts.map(account => account.id),
    [state.retained.id]
  )
  const targetRef = active.keyDomains[0].credentialRef
  assert.equal(
    (await state.credentialRepository.validateForActivation(targetRef, state.keyDomain.id)).status,
    'active'
  )
  assert.equal(await state.credentialRepository.findIncompleteJournal('remove'), null)
  await state.removal().resumePendingAccountReplacement()
  assert.equal(state.storageRepository.pointer.generationId, active.manifest.generationId)
})

async function verifyCommittedCleanupRetry(failure) {
  const state = await fixture()
  if (failure === 'purge') {
    const original = state.credentialRepository.purgeRetiredEnvelopes.bind(
      state.credentialRepository
    )
    state.credentialRepository.purgeRetiredEnvelopes = async (...args) => {
      state.credentialRepository.purgeRetiredEnvelopes = original
      throw new Error('injected purge failure')
    }
  } else {
    const original = state.credentialRepository.advanceJournal.bind(state.credentialRepository)
    state.credentialRepository.advanceJournal = async (...args) => {
      if (args[0].phase === 'complete') {
        state.credentialRepository.advanceJournal = original
        throw new Error('injected completion failure')
      }
      return original(...args)
    }
  }
  await assert.rejects(
    state.removal(NOW + 10).removeAccount(state.keyDomain.id, state.first.id, PASSWORD),
    new RegExp(`injected ${failure === 'purge' ? 'purge' : 'completion'} failure`)
  )
  const journal = await state.credentialRepository.findIncompleteJournal('remove')
  assert.equal(journal.phase, 'committed-pending-cleanup')
  const retirement = await state.credentialRepository.getRetirement(
    state.sourceSet.credentialSetRef
  )
  assert.equal(retirement.retiredAt, journal.updatedAt)
  const active = await state.storageRepository.getSnapshot(
    state.storageRepository.pointer.generationId
  )
  assert.deepEqual(
    active.accounts.map(account => account.id),
    [state.retained.id]
  )
  await state.removal(NOW + 10_000).resumePendingAccountReplacement()
  assert.equal(await state.credentialRepository.findIncompleteJournal('remove'), null)
  assert.deepEqual(
    await state.credentialRepository.getRetirement(state.sourceSet.credentialSetRef),
    retirement
  )
  assert.equal(
    (
      await state.credentialRepository.validateForActivation(
        active.keyDomains[0].credentialRef,
        state.keyDomain.id
      )
    ).status,
    'active'
  )
}

test('retirement survives an interrupted envelope purge with a later clock', async () => {
  await verifyCommittedCleanupRetry('purge')
})

test('retirement survives an interrupted journal completion with a later clock', async () => {
  await verifyCommittedCleanupRetry('complete')
})

test('a pointer conflict keeps the original account and a recoverable journal', async () => {
  const state = await fixture()
  state.storageRepository.commitFailure = 'active-generation-changed'
  await assert.rejects(
    state.removal().removeAccount(state.keyDomain.id, state.first.id, PASSWORD),
    /active-generation-changed/
  )
  assert.equal(state.storageRepository.pointer.generationId, state.snapshot.manifest.generationId)
  assert.equal(
    (await state.credentialRepository.findIncompleteJournal('remove')).phase,
    'committing'
  )
})

test('retained V1 reconciliation does not restore a deleted anchor Account', async () => {
  const state = await fixture()
  await state.removal().removeAccount(state.keyDomain.id, state.first.id, PASSWORD)
  const local = structuredClone(
    V1_MIGRATION_FIXTURES.find(item => item.id === 'software-multi-account').local
  )
  const walletState = JSON.parse(local.wallet_state)
  walletState.state.wallets[0].accounts = walletState.state.wallets[0].accounts.filter(
    account => account.id === state.retained.id
  )
  walletState.state.currentAccountId = state.retained.id
  local.wallet_state = JSON.stringify(walletState)
  const reconciliation = new RetainedV1ReconciliationCoordinator({
    credentialRepository: state.credentialRepository,
    storageRepository: state.storageRepository,
    compatibilityWorker: state.compatibilityWorker,
    now: () => NOW + 2
  })
  await reconciliation.synchronize({
    discovery: discoverV1Metadata(local),
    credentialEnvelopes: local,
    password: PASSWORD,
    chains: CHAINS
  })
  const active = await state.storageRepository.getSnapshot(
    state.storageRepository.pointer.generationId
  )
  assert.deepEqual(
    active.accounts.map(account => account.id),
    [state.retained.id]
  )
  assert.equal(await state.credentialRepository.findIncompleteJournal('remove'), null)
})

test('a retained Ledger Account is proven against its authenticated public export', async () => {
  const credentialRepository = new InMemoryCredentialRepository()
  const storageRepository = new MemoryStorage()
  const accounts = [0, 1].map(index => {
    const address = encodeSolanaBase58(ed25519.getPublicKey(new Uint8Array(32).fill(index + 7)))
    return {
      family: 'solana',
      accountIndex: index,
      derivationPath: `m/44'/501'/${index}'`,
      publicKey: address,
      address
    }
  })
  const credential = createLedgerMultichainHardwareCredential({
    accounts,
    deviceModel: 'nanoX',
    deviceName: 'Ledger Nano X'
  })
  const provisioned = await new LedgerHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => NOW
  }).provision({ credential, displayName: 'Ledger', password: PASSWORD, network: 'mainnet' })
  const original = await storageRepository.getSnapshot(provisioned.generationId)
  const first = original.accounts.find(account => account.accountIndex === 0)
  const retained = original.accounts.find(account => account.accountIndex === 1)
  const removal = new CredentialRemovalCoordinator({
    credentialRepository,
    storageRepository,
    now: () => NOW + 1
  })
  const tampered = {
    ...original,
    chainAccounts: original.chainAccounts.map(account =>
      account.scope.accountId === retained.id
        ? { ...account, identity: { ...account.identity, value: accounts[0].address } }
        : account
    )
  }
  storageRepository.snapshots.set(original.manifest.generationId, tampered)
  await assert.rejects(
    removal.preflightAccountRemoval(provisioned.keyDomainId, first.id, PASSWORD),
    /Hardware account removal proof does not match/
  )
  assert.equal(storageRepository.pointer.generationId, original.manifest.generationId)
  storageRepository.snapshots.set(original.manifest.generationId, original)
  const result = await removal.removeAccount(provisioned.keyDomainId, first.id, PASSWORD)
  const target = await storageRepository.getSnapshot(result.generationId)
  assert.deepEqual(
    target.accounts.map(account => account.id),
    [retained.id]
  )
  const set = await credentialRepository.getCredentialSet(target.keyDomains[0].credentialRef)
  const anchor = parseChainAccountVerificationAnchorRef(
    set.manifest.engines.multichain.verificationAnchorRef
  )
  assert.equal(
    target.chainAccounts.find(account => account.id === anchor).scope.accountId,
    retained.id
  )
  assert.equal(
    (
      await credentialRepository.validateForActivation(
        set.credentialSetRef,
        provisioned.keyDomainId
      )
    ).status,
    'active'
  )
})
