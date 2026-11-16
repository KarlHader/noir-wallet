import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import {
  buildChainAccountVerificationAnchorRef,
  commitCredentialBoundStorageV2Pointer,
  parseChainAccountVerificationAnchorRef,
  validateCredentialBindings
} from '../../../src/core/keyring/application/index.ts'
import { CREDENTIAL_SET_SCHEMA_VERSION } from '../../../src/core/keyring/domain/index.ts'
import { InMemoryCredentialRepository } from '../../../src/infrastructure/persistence/repositories/index.ts'
import { CredentialRepositoryState } from '../../../src/infrastructure/persistence/repositories/credential-repository-state.ts'
import {
  parseCredentialTransactionJournal,
  parseEncryptedCredentialEnvelopeRecord,
  parseStorageV2Snapshot
} from '../../../src/infrastructure/persistence/schema/index.ts'

const fingerprint = 'a'.repeat(64)

function engineRef(keyDomainId, generationId, engine) {
  return `credential:${keyDomainId}:${generationId}:${engine}`
}

function anchorRef(keyDomainId, engine) {
  return `chain-account:${encodeURIComponent(`${keyDomainId}:${engine}`)}`
}

function provisionTransition(keyDomainId, generationId, credentialSetRef) {
  return {
    kind: 'provision',
    keyDomainId,
    targetCredentialGenerationId: generationId,
    targetCredentialSetRef: credentialSetRef,
    stagedRefs: [
      engineRef(keyDomainId, generationId, 'zcash'),
      engineRef(keyDomainId, generationId, 'multichain')
    ]
  }
}

function replaceTransition(
  keyDomainId,
  sourceGenerationId,
  targetGenerationId,
  targetCredentialSetRef
) {
  return {
    kind: 'replace',
    keyDomainId,
    sourceCredentialGenerationId: sourceGenerationId,
    targetCredentialGenerationId: targetGenerationId,
    targetCredentialSetRef,
    stagedRefs: [
      engineRef(keyDomainId, targetGenerationId, 'zcash'),
      engineRef(keyDomainId, targetGenerationId, 'multichain')
    ],
    retiredRefs: [
      engineRef(keyDomainId, sourceGenerationId, 'zcash'),
      engineRef(keyDomainId, sourceGenerationId, 'multichain'),
      `retained-v1:${keyDomainId}`
    ]
  }
}

function journal({
  transactionId,
  operation = 'create',
  metadataGenerationId = `metadata:${transactionId}`,
  transitions,
  phase = 'staging',
  revision = 0,
  createdAt = 1_000,
  updatedAt = createdAt,
  lastErrorCode
}) {
  return {
    schemaVersion: 1,
    transactionId,
    operation,
    targetMetadataGenerationId: metadataGenerationId,
    transitions,
    phase,
    revision,
    createdAt,
    updatedAt,
    ...(lastErrorCode === undefined ? {} : { lastErrorCode })
  }
}

function advance(current, phase, overrides = {}) {
  return {
    ...current,
    phase,
    revision: current.revision + 1,
    updatedAt: current.updatedAt + 1,
    ...overrides
  }
}

function envelope(transactionId, keyDomainId, generationId, engine, bytes = [1, 2, 3]) {
  return {
    schemaVersion: 1,
    transactionId,
    aad: {
      schemaVersion: 1,
      engine,
      keyDomainId,
      credentialGenerationId: generationId,
      credentialRef: engineRef(keyDomainId, generationId, engine),
      formatVersion: 1
    },
    encryptedPayload: new Uint8Array(bytes),
    createdAt: 1_001
  }
}

function credentialSet(transactionId, keyDomainId, generationId, credentialSetRef) {
  return {
    schemaVersion: 1,
    transactionId,
    credentialSetRef,
    manifest: {
      schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
      credentialGenerationId: generationId,
      keyDomainId,
      source: 'software',
      mnemonicWordCount: 12,
      zcashSeedPolicy: 'direct-bip39-v1',
      engines: {
        zcash: {
          credentialRef: engineRef(keyDomainId, generationId, 'zcash'),
          formatVersion: 1,
          verificationAnchorRef: anchorRef(keyDomainId, 'zcash')
        },
        multichain: {
          credentialRef: engineRef(keyDomainId, generationId, 'multichain'),
          formatVersion: 1,
          verificationAnchorRef: anchorRef(keyDomainId, 'multichain')
        }
      },
      createdAt: 1_001,
      verifiedAt: 1_002
    }
  }
}

async function stageSoftwareCredentialSet(
  repository,
  { transactionId, keyDomainId, generationId, credentialSetRef, operation = 'create', transition }
) {
  const firstJournal = journal({
    transactionId,
    operation,
    transitions: [transition ?? provisionTransition(keyDomainId, generationId, credentialSetRef)]
  })
  await expect(repository.createJournal(firstJournal)).resolves.toBe('created')
  await expect(
    repository.putEnvelope(envelope(transactionId, keyDomainId, generationId, 'zcash'))
  ).resolves.toBe('created')
  await expect(
    repository.putEnvelope(envelope(transactionId, keyDomainId, generationId, 'multichain'))
  ).resolves.toBe('created')
  await expect(
    repository.putCredentialSet(
      credentialSet(transactionId, keyDomainId, generationId, credentialSetRef)
    )
  ).resolves.toBe('created')
  return firstJournal
}

async function advanceJournal(repository, current, phase, overrides) {
  const next = advance(current, phase, overrides)
  await expect(repository.advanceJournal(next, current.revision)).resolves.toBe('advanced')
  return next
}

async function provisionCommittedCredentialSet(
  repository,
  { transactionId, keyDomainId, generationId, credentialSetRef }
) {
  let current = await stageSoftwareCredentialSet(repository, {
    transactionId,
    keyDomainId,
    generationId,
    credentialSetRef
  })
  current = await advanceJournal(repository, current, 'verified')
  current = await advanceJournal(repository, current, 'committing')
  current = await advanceJournal(repository, current, 'committed-pending-cleanup')
  return advanceJournal(repository, current, 'complete')
}

function storageSnapshot(keyDomains, generationId = 'metadata:active') {
  const accounts = keyDomains.map(keyDomain => ({
    id: `${keyDomain.id}:account:0`,
    keyDomainId: keyDomain.id,
    accountIndex: 0,
    displayName: 'Account 1',
    createdAt: 1_000
  }))
  const chainAccounts = keyDomains.flatMap(keyDomain => [
    {
      id: `${keyDomain.id}:zcash`,
      scope: {
        keyDomainId: keyDomain.id,
        accountId: `${keyDomain.id}:account:0`,
        chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d'
      },
      derivation: { scheme: 'zip32', path: "m/32'/133'/0'" },
      identity: { kind: 'account-identifier', value: `zcash:${keyDomain.id}` },
      createdAt: 1_000
    },
    {
      id: `${keyDomain.id}:multichain`,
      scope: {
        keyDomainId: keyDomain.id,
        accountId: `${keyDomain.id}:account:0`,
        chainId: 'eip155:1'
      },
      derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
      identity: { kind: 'account-identifier', value: `evm:${keyDomain.id}` },
      createdAt: 1_000
    }
  ])
  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: 2,
      generationId,
      status: 'verified',
      sourceFingerprint: fingerprint,
      ...(keyDomains.length === 0 ? {} : { mainKeyDomainId: keyDomains[0].id }),
      counts: {
        keyDomains: keyDomains.length,
        accounts: accounts.length,
        chainAccounts: chainAccounts.length,
        addresses: 0
      },
      createdAt: 2_000,
      verifiedAt: 2_001
    },
    keyDomains,
    accounts,
    chainAccounts,
    addresses: []
  })
}

function softwareKeyDomain(id, credentialRef) {
  return {
    id,
    credentialRef,
    source: { kind: 'software', mnemonicWordCount: 12 },
    displayName: id,
    createdAt: 1_000
  }
}

function fakeStorageRepository(snapshot) {
  const commits = []
  return {
    commits,
    async getSnapshot(generationId) {
      return generationId === snapshot.manifest.generationId ? snapshot : null
    },
    async commit(pointer, expectedActiveGenerationId) {
      commits.push({ pointer, expectedActiveGenerationId })
      return 'committed'
    }
  }
}

test.describe('Credential repository', () => {
  test('accepts only canonical encoded ChainAccount verification anchors', () => {
    const chainAccountId = 'wallet:1:evm/account:0'
    const anchor = buildChainAccountVerificationAnchorRef(chainAccountId)

    expect(anchor).toBe('chain-account:wallet%3A1%3Aevm%2Faccount%3A0')
    expect(parseChainAccountVerificationAnchorRef(anchor)).toBe(chainAccountId)
    expect(() => parseChainAccountVerificationAnchorRef('chain-account:wallet:1')).toThrow(
      /not canonical/
    )
    expect(() => parseChainAccountVerificationAnchorRef('chain-account:%E0%A4%A')).toThrow(
      /invalid encoding/
    )
    expect(() => parseChainAccountVerificationAnchorRef('credential:wallet%3A1')).toThrow(
      /does not reference/
    )
  })

  test('uses an exact global transaction schema for multiple Wallet replacements', () => {
    const value = journal({
      transactionId: 'transaction:global-password-change',
      operation: 'change-password',
      transitions: [
        replaceTransition('wallet:1', 'generation:1', 'generation:2', 'set:2'),
        replaceTransition('wallet:2', 'generation:3', 'generation:4', 'set:4')
      ]
    })

    expect(parseCredentialTransactionJournal(value).transitions).toHaveLength(2)
    expect(() =>
      parseCredentialTransactionJournal({ ...value, password: 'must-not-persist' })
    ).toThrow(/journal/i)
    expect(() =>
      parseCredentialTransactionJournal({
        ...value,
        transitions: [value.transitions[0], { ...value.transitions[1], keyDomainId: 'wallet:1' }]
      })
    ).toThrow(/duplicate KeyDomain/i)
    expect(() =>
      parseCredentialTransactionJournal({
        ...value,
        operation: 'change-password',
        transitions: [provisionTransition('wallet:1', 'generation:2', 'set:2')]
      })
    ).toThrow(/operation/i)
  })

  test('requires a staging journal and exact dual-engine envelopes', async () => {
    const repository = new InMemoryCredentialRepository()
    const transactionId = 'transaction:create'
    const keyDomainId = 'wallet:1'
    const generationId = 'generation:1'
    const credentialSetRef = 'set:1'
    const zcashEnvelope = envelope(transactionId, keyDomainId, generationId, 'zcash', [7, 8, 9])

    await expect(repository.putEnvelope(zcashEnvelope)).resolves.toBe('journal-not-staging')
    const current = journal({
      transactionId,
      transitions: [provisionTransition(keyDomainId, generationId, credentialSetRef)]
    })
    await repository.createJournal(current)
    await expect(repository.putEnvelope(zcashEnvelope)).resolves.toBe('created')
    zcashEnvelope.encryptedPayload[0] = 0
    expect(
      (await repository.getEnvelope(zcashEnvelope.aad.credentialRef)).encryptedPayload[0]
    ).toBe(7)

    await expect(
      repository.putCredentialSet(
        credentialSet(transactionId, keyDomainId, generationId, credentialSetRef)
      )
    ).resolves.toBe('missing-envelope')
    await repository.putEnvelope(envelope(transactionId, keyDomainId, generationId, 'multichain'))
    await expect(
      repository.putCredentialSet(
        credentialSet(transactionId, keyDomainId, generationId, credentialSetRef)
      )
    ).resolves.toBe('created')

    expect(() =>
      parseEncryptedCredentialEnvelopeRecord({
        ...envelope(transactionId, keyDomainId, generationId, 'zcash'),
        mnemonic: 'must-not-persist'
      })
    ).toThrow(/envelope/i)
  })

  test('advances journals monotonically, idempotently, and without ambiguous commit failure', async () => {
    const repository = new InMemoryCredentialRepository()
    const options = {
      transactionId: 'transaction:monotonic',
      keyDomainId: 'wallet:1',
      generationId: 'generation:1',
      credentialSetRef: 'set:1'
    }
    let current = await stageSoftwareCredentialSet(repository, options)
    const verified = advance(current, 'verified')

    await expect(repository.advanceJournal(verified, 99)).resolves.toBe('revision-conflict')
    await expect(repository.advanceJournal(verified, current.revision)).resolves.toBe('advanced')
    await expect(repository.advanceJournal(verified, current.revision)).resolves.toBe(
      'already-applied'
    )
    current = verified
    current = await advanceJournal(repository, current, 'committing')
    await expect(
      repository.advanceJournal(
        advance(current, 'failed', { lastErrorCode: 'COMMIT_UNKNOWN' }),
        current.revision
      )
    ).resolves.toBe('invalid-transition')

    const removedRef = {
      ...current,
      phase: 'committing',
      revision: current.revision + 1,
      updatedAt: current.updatedAt + 1,
      transitions: [
        {
          ...current.transitions[0],
          stagedRefs: current.transitions[0].stagedRefs.slice(0, 1)
        }
      ]
    }
    await expect(repository.advanceJournal(removedRef, current.revision)).resolves.toBe(
      'invalid-transition'
    )
  })

  test('retires a superseded generation before reporting cleanup complete', async () => {
    const repository = new InMemoryCredentialRepository()
    await provisionCommittedCredentialSet(repository, {
      transactionId: 'transaction:old',
      keyDomainId: 'wallet:1',
      generationId: 'generation:old',
      credentialSetRef: 'set:old'
    })

    const transition = replaceTransition('wallet:1', 'generation:old', 'generation:new', 'set:new')
    let current = await stageSoftwareCredentialSet(repository, {
      transactionId: 'transaction:change-password',
      operation: 'change-password',
      keyDomainId: 'wallet:1',
      generationId: 'generation:new',
      credentialSetRef: 'set:new',
      transition
    })
    current = await advanceJournal(repository, current, 'verified')
    current = await advanceJournal(repository, current, 'committing')

    const retirement = {
      schemaVersion: 1,
      credentialSetRef: 'set:old',
      credentialGenerationId: 'generation:old',
      keyDomainId: 'wallet:1',
      reason: 'superseded',
      replacementCredentialSetRef: 'set:new',
      transactionId: 'transaction:change-password',
      retiredAt: current.updatedAt + 2
    }
    await expect(repository.retire(retirement)).resolves.toBe('journal-not-committed')
    current = await advanceJournal(repository, current, 'committed-pending-cleanup')
    await expect(
      repository.advanceJournal(advance(current, 'complete'), current.revision)
    ).resolves.toBe('invalid-transition')
    await expect(repository.retire(retirement)).resolves.toBe('created')
    await expect(repository.retire(retirement)).resolves.toBe('already-exists')
    await expect(repository.purgeRetiredEnvelopes('set:old', 'transaction:old')).resolves.toBe(
      'transaction-mismatch'
    )
    await expect(
      repository.purgeRetiredEnvelopes('set:new', 'transaction:change-password')
    ).resolves.toBe('not-retired')
    await expect(
      repository.purgeRetiredEnvelopes('set:old', 'transaction:change-password')
    ).resolves.toBe('purged')
    await expect(
      repository.purgeRetiredEnvelopes('set:old', 'transaction:change-password')
    ).resolves.toBe('already-purged')
    await expect(
      repository.getEnvelope(engineRef('wallet:1', 'generation:old', 'zcash'))
    ).resolves.toBeNull()
    current = await advanceJournal(repository, current, 'complete')

    const state = repository.state
    expect(() => new CredentialRepositoryState(state.snapshot())).not.toThrow()

    await expect(repository.validateForActivation('set:old', 'wallet:1')).resolves.toMatchObject({
      status: 'retired'
    })
    await expect(repository.validateForActivation('set:new', 'wallet:1')).resolves.toMatchObject({
      status: 'active'
    })
    expect(current.phase).toBe('complete')
  })

  test('stages a complete multi-Wallet credential transaction atomically', async () => {
    const repository = new InMemoryCredentialRepository()
    const transactionId = 'transaction:atomic-stage'
    const generationOne = 'generation:new-1'
    const generationTwo = 'generation:new-2'
    const credentialSetOne = 'set:new-1'
    const credentialSetTwo = 'set:new-2'
    const current = journal({
      transactionId,
      operation: 'change-password',
      transitions: [
        replaceTransition('wallet:1', 'generation:old-1', generationOne, credentialSetOne),
        replaceTransition('wallet:2', 'generation:old-2', generationTwo, credentialSetTwo)
      ]
    })
    const envelopes = [
      envelope(transactionId, 'wallet:1', generationOne, 'zcash'),
      envelope(transactionId, 'wallet:1', generationOne, 'multichain'),
      envelope(transactionId, 'wallet:2', generationTwo, 'zcash'),
      envelope(transactionId, 'wallet:2', generationTwo, 'multichain')
    ]
    const credentialSets = [
      credentialSet(transactionId, 'wallet:1', generationOne, credentialSetOne),
      credentialSet(transactionId, 'wallet:2', generationTwo, credentialSetTwo)
    ]

    await expect(
      repository.stageTransaction(current, envelopes.slice(0, 3), credentialSets)
    ).resolves.toBe('invalid-artifacts')
    await expect(repository.getJournal(transactionId)).resolves.toBeNull()
    await expect(repository.getEnvelope(envelopes[0].aad.credentialRef)).resolves.toBeNull()

    await expect(repository.stageTransaction(current, envelopes, credentialSets)).resolves.toBe(
      'staged'
    )
    await expect(repository.stageTransaction(current, envelopes, credentialSets)).resolves.toBe(
      'already-staged'
    )
    await expect(repository.getCredentialSet(credentialSetTwo)).resolves.toMatchObject({
      credentialSetRef: credentialSetTwo
    })
  })

  test('guards the single Storage V2 pointer with transaction and retirement state', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    let current = await stageSoftwareCredentialSet(credentialRepository, {
      transactionId: 'transaction:activate',
      keyDomainId: 'wallet:1',
      generationId: 'generation:1',
      credentialSetRef: 'set:1'
    })
    current = await advanceJournal(credentialRepository, current, 'verified')
    current = await advanceJournal(credentialRepository, current, 'committing')

    const snapshot = storageSnapshot(
      [softwareKeyDomain('wallet:1', 'set:1')],
      current.targetMetadataGenerationId
    )
    const storageRepository = fakeStorageRepository(snapshot)
    const pointer = {
      schemaVersion: 2,
      generationId: snapshot.manifest.generationId,
      sourceFingerprint: fingerprint,
      committedAt: 2_002
    }

    await expect(
      commitCredentialBoundStorageV2Pointer(storageRepository, credentialRepository, pointer, null)
    ).resolves.toBe('credential-binding-invalid')
    await expect(
      commitCredentialBoundStorageV2Pointer(
        storageRepository,
        credentialRepository,
        pointer,
        null,
        'transaction:activate'
      )
    ).resolves.toBe('committed')
    expect(storageRepository.commits).toHaveLength(1)

    await expect(
      commitCredentialBoundStorageV2Pointer(
        storageRepository,
        credentialRepository,
        { ...pointer, sourceFingerprint: 'b'.repeat(64) },
        null,
        'transaction:activate'
      )
    ).resolves.toBe('invalid-generation')

    const duplicateSnapshot = {
      ...snapshot,
      keyDomains: [softwareKeyDomain('wallet:1', 'set:1'), softwareKeyDomain('wallet:2', 'set:1')]
    }
    await expect(
      validateCredentialBindings(duplicateSnapshot, credentialRepository)
    ).resolves.toEqual({ status: 'invalid', reason: 'duplicate-credential-ref' })

    const mismatchedWordCountSnapshot = {
      ...snapshot,
      keyDomains: [
        {
          ...softwareKeyDomain('wallet:1', 'set:1'),
          source: { kind: 'software', mnemonicWordCount: 24 }
        }
      ]
    }
    await expect(
      validateCredentialBindings(
        mismatchedWordCountSnapshot,
        credentialRepository,
        current.transactionId
      )
    ).resolves.toEqual({
      status: 'invalid',
      reason: 'credential-mnemonic-word-count-mismatch'
    })

    const missingAnchorSnapshot = parseStorageV2Snapshot({
      ...snapshot,
      manifest: {
        ...snapshot.manifest,
        counts: { ...snapshot.manifest.counts, chainAccounts: 1 }
      },
      chainAccounts: snapshot.chainAccounts.slice(0, 1)
    })
    await expect(
      validateCredentialBindings(missingAnchorSnapshot, credentialRepository, current.transactionId)
    ).resolves.toEqual({ status: 'invalid', reason: 'credential-anchor-not-found' })
  })

  test('rejects a password change that omits an active software Wallet', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    await provisionCommittedCredentialSet(credentialRepository, {
      transactionId: 'transaction:old-1',
      keyDomainId: 'wallet:1',
      generationId: 'generation:old-1',
      credentialSetRef: 'set:old-1'
    })
    await provisionCommittedCredentialSet(credentialRepository, {
      transactionId: 'transaction:old-2',
      keyDomainId: 'wallet:2',
      generationId: 'generation:old-2',
      credentialSetRef: 'set:old-2'
    })

    const transition = replaceTransition(
      'wallet:1',
      'generation:old-1',
      'generation:new-1',
      'set:new-1'
    )
    let current = await stageSoftwareCredentialSet(credentialRepository, {
      transactionId: 'transaction:partial-password-change',
      operation: 'change-password',
      keyDomainId: 'wallet:1',
      generationId: 'generation:new-1',
      credentialSetRef: 'set:new-1',
      transition
    })
    current = await advanceJournal(credentialRepository, current, 'verified')
    current = await advanceJournal(credentialRepository, current, 'committing')

    const activeSnapshot = storageSnapshot(
      [softwareKeyDomain('wallet:1', 'set:old-1'), softwareKeyDomain('wallet:2', 'set:old-2')],
      'metadata:before-password-change'
    )
    const targetSnapshot = storageSnapshot(
      [softwareKeyDomain('wallet:1', 'set:new-1'), softwareKeyDomain('wallet:2', 'set:old-2')],
      current.targetMetadataGenerationId
    )
    const snapshots = new Map([
      [activeSnapshot.manifest.generationId, activeSnapshot],
      [targetSnapshot.manifest.generationId, targetSnapshot]
    ])
    let commitCalls = 0
    const storageRepository = {
      async getActivePointer() {
        return {
          schemaVersion: 2,
          generationId: activeSnapshot.manifest.generationId,
          sourceFingerprint: fingerprint,
          committedAt: 2_002
        }
      },
      async getSnapshot(generationId) {
        return snapshots.get(generationId) ?? null
      },
      async commit() {
        commitCalls += 1
        return 'committed'
      }
    }

    await expect(
      commitCredentialBoundStorageV2Pointer(
        storageRepository,
        credentialRepository,
        {
          schemaVersion: 2,
          generationId: targetSnapshot.manifest.generationId,
          sourceFingerprint: fingerprint,
          committedAt: 2_002
        },
        activeSnapshot.manifest.generationId,
        current.transactionId
      )
    ).resolves.toBe('credential-transaction-invalid')
    expect(commitCalls).toBe(0)
  })

  test('keeps credential persistence independent from browser, WASM, and secret inputs', () => {
    const source = [
      '../../../src/ports/repositories/credential-repository-types.ts',
      '../../../src/ports/repositories/credential-repository.ts',
      '../../../src/infrastructure/persistence/repositories/credential-repository-policy.ts',
      '../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts',
      '../../../src/core/keyring/application/credential-bound-storage-v2.ts'
    ]
      .map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n')

    expect(source).not.toMatch(
      /chrome\.|zustand|zcash-wallet-runtime|mnemonicPhrase|seedPhrase|rawPassword|password:\s*string|raw session|wasm/i
    )
  })
})
