import {
  buildChainAccountVerificationAnchorRef,
  commitCredentialBoundStorageV2Pointer
} from '@/core/keyring/application'
import { parseChainAccountId } from '@/core/accounts/domain'
import {
  CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  CREDENTIAL_SET_SCHEMA_VERSION,
  parseCredentialGenerationId,
  parseCredentialRef,
  parseEngineCredentialRef,
  parseKeyDomainId
} from '@/core/keyring/domain'
import type { V1DiscoveredAccount } from '@/infrastructure/persistence/migrations'
import {
  authenticateSoftwareCredentialEnvelopePair,
  readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair
} from '@/infrastructure/keyring/credential-envelope-authentication'
import {
  parseCredentialArtifactRef,
  parseCredentialTransactionId,
  parseStorageV2GenerationId,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import {
  CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
  STORAGE_V2_SCHEMA_VERSION,
  type CredentialRepository,
  type CredentialSetRecord,
  type CredentialTransactionJournal,
  type EncryptedCredentialEnvelopeRecord,
  type StorageV2Repository
} from '@/ports/repositories'
import { CompatibilityWorkerHost } from './compatibility-worker-host'
import { retainedV1EntityId, type PreparedV1Wallet } from './retained-v1-migration-snapshot'
import { parseRawEncryptedVault } from '../multichain/raw-wallet-engine'
import {
  encodeV1EncryptedCredentialEnvelope,
  parseV1EncryptedCredentialEnvelope
} from './v1-credential-envelope'

import {
  assertAdvanced,
  assertChainProfile,
  assertExistingAccountAnchors,
  canonicalInventorySource,
  decodeEnginePayload,
  enginePayload,
  findResultAccount,
  inventoryAlreadyMatches,
  inventoryTimestamp,
  mergeInventorySnapshot,
  nextJournal,
  sha256,
  softwareWallets,
  workerAccounts,
  type CompatibilityInventoryPort,
  type PreparedInventoryWallet,
  type RetainedV1InventoryCoordinatorOptions,
  type RetainedV1InventoryInput,
  type RetainedV1InventoryResult
} from './retained-v1-inventory-support'

export type {
  RetainedV1InventoryCoordinatorOptions,
  RetainedV1InventoryInput,
  RetainedV1InventoryResult
} from './retained-v1-inventory-support'

export class RetainedV1InventoryCoordinator {
  private readonly credentialRepository: CredentialRepository
  private readonly storageRepository: StorageV2Repository
  private readonly compatibilityWorker: CompatibilityInventoryPort
  private readonly now: () => number
  private inFlight: Promise<RetainedV1InventoryResult> | null = null

  constructor(options: RetainedV1InventoryCoordinatorOptions) {
    this.credentialRepository = options.credentialRepository
    this.storageRepository = options.storageRepository
    this.compatibilityWorker = options.compatibilityWorker ?? new CompatibilityWorkerHost()
    this.now = options.now ?? Date.now
  }

  synchronize(input: RetainedV1InventoryInput): Promise<RetainedV1InventoryResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.run(input).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async run(input: RetainedV1InventoryInput): Promise<RetainedV1InventoryResult> {
    const wallets = softwareWallets(input.discovery)
    assertChainProfile(input.chains)
    let activePointer = await this.storageRepository.getActivePointer()
    if (!activePointer) throw new Error('Storage V2 is not active')
    let source = await this.storageRepository.getSnapshot(activePointer.generationId)
    if (!source) throw new Error('Active Storage V2 generation is missing')

    let pending = await this.credentialRepository.findIncompleteJournal('migrate')
    if (pending && pending.targetMetadataGenerationId === activePointer.generationId) {
      if (pending.phase !== 'committing' && pending.phase !== 'committed-pending-cleanup') {
        throw new Error('Active Storage V2 generation has an invalid migration journal phase')
      }
      if (pending.phase === 'committing') {
        const committed = nextJournal(pending, 'committed-pending-cleanup', this.now())
        assertAdvanced(
          await this.credentialRepository.advanceJournal(committed, pending.revision),
          'Credential inventory commit recovery'
        )
        pending = committed
      }
      const complete = nextJournal(pending, 'complete', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(complete, pending.revision),
        'Credential inventory completion recovery'
      )
      pending = null
      activePointer = (await this.storageRepository.getActivePointer()) ?? activePointer
      source = (await this.storageRepository.getSnapshot(activePointer.generationId)) ?? source
    }

    const legacyEnvelopes = wallets.map(wallet => ({
      key: wallet.credentialStorageKey,
      value: parseV1EncryptedCredentialEnvelope(
        input.credentialEnvelopes[wallet.credentialStorageKey]
      )
    }))
    const prepared: PreparedInventoryWallet[] = []
    const sourceKeyDomains = new Map(source.keyDomains.map(keyDomain => [keyDomain.id, keyDomain]))
    if (
      source.keyDomains.some(
        keyDomain =>
          keyDomain.source.kind === 'software' &&
          !wallets.some(wallet => wallet.id === keyDomain.id)
      )
    ) {
      throw new Error('Retained V1 inventory removed an active Storage V2 Wallet Set')
    }

    for (const [index, wallet] of wallets.entries()) {
      const pendingTransition = pending?.transitions.find(
        transition => transition.keyDomainId === wallet.id
      )
      let targetVault: ReturnType<typeof parseRawEncryptedVault> | undefined
      if (pendingTransition && pendingTransition.kind !== 'retire') {
        const targetSet = await this.credentialRepository.getCredentialSet(
          pendingTransition.targetCredentialSetRef
        )
        if (!targetSet || targetSet.manifest.source !== 'software') {
          throw new Error('Staged inventory CredentialSet is missing')
        }
        const targetZcashEnvelope = await this.credentialRepository.getEnvelope(
          targetSet.manifest.engines.zcash.credentialRef
        )
        const targetMultichainEnvelope = await this.credentialRepository.getEnvelope(
          targetSet.manifest.engines.multichain.credentialRef
        )
        if (!targetZcashEnvelope || !targetMultichainEnvelope) {
          throw new Error('Staged inventory engine envelope is missing')
        }
        const targetPayloads = await readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair(
          { zcash: targetZcashEnvelope, multichain: targetMultichainEnvelope },
          input.password
        )
        targetVault = decodeEnginePayload(targetPayloads.multichain)
      }
      const result = await this.compatibilityWorker.migrate({
        operation: 'migrate',
        envelope: legacyEnvelopes[index].value,
        password: input.password,
        ...(targetVault === undefined ? {} : { targetVault }),
        ...input.chains,
        accounts: workerAccounts(wallet)
      })
      if (result.operation !== 'migrate' || result.accounts.length !== wallet.accounts.length) {
        throw new Error('Compatibility Worker returned an incomplete inventory result')
      }
      const existingKeyDomain = sourceKeyDomains.get(parseKeyDomainId(wallet.id))
      let existingCredentialSet: CredentialSetRecord | undefined
      const newAccounts: V1DiscoveredAccount[] = []
      if (existingKeyDomain) {
        const activation = await this.credentialRepository.validateForActivation(
          existingKeyDomain.credentialRef,
          existingKeyDomain.id
        )
        if (activation.status !== 'active' || !activation.record) {
          throw new Error(`Existing CredentialSet is not active: ${activation.status}`)
        }
        existingCredentialSet = activation.record
        if (
          existingCredentialSet.manifest.source !== 'software' ||
          existingCredentialSet.manifest.mnemonicWordCount !== result.mnemonicWordCount ||
          existingKeyDomain.source.kind !== 'software' ||
          existingKeyDomain.source.mnemonicWordCount !== result.mnemonicWordCount
        ) {
          throw new Error('Retained V1 inventory mnemonic metadata mismatch')
        }
        const sourceAccounts = source.accounts.filter(account => account.keyDomainId === wallet.id)
        if (
          sourceAccounts.some(
            account =>
              !wallet.accounts.some(
                candidate =>
                  candidate.id === account.id && candidate.accountIndex === account.accountIndex
              )
          )
        ) {
          throw new Error('Retained V1 inventory removed or reindexed a Storage V2 Account')
        }
        for (const account of wallet.accounts) {
          const byId = sourceAccounts.find(candidate => candidate.id === account.id)
          const byIndex = sourceAccounts.find(
            candidate => candidate.accountIndex === account.accountIndex
          )
          if (!byId && !byIndex) {
            findResultAccount(result, account)
            newAccounts.push(account)
            continue
          }
          if (!byId || !byIndex || byId.id !== byIndex.id) {
            throw new Error('Retained V1 Account id and derivation index conflict')
          }
          assertExistingAccountAnchors(source, wallet, account, result, input.chains)
        }
      } else {
        wallet.accounts.forEach(account => findResultAccount(result, account))
        newAccounts.push(...wallet.accounts)
      }
      prepared.push({
        wallet,
        legacyEnvelope: legacyEnvelopes[index].value,
        result,
        ...(existingCredentialSet ? { existingCredentialSet } : {}),
        newAccounts: Object.freeze(newAccounts)
      })
    }

    if (inventoryAlreadyMatches(source, input.discovery, prepared)) {
      return Object.freeze({
        status: 'already-synchronized',
        generationId: source.manifest.generationId,
        provisionedKeyDomainIds: Object.freeze([]),
        addedAccountIds: Object.freeze([])
      })
    }

    const fingerprint = parseStorageV2SourceFingerprint(
      await sha256(canonicalInventorySource(source, input.discovery, legacyEnvelopes, input.chains))
    )
    const generationId = parseStorageV2GenerationId(`storage-v2:inventory:${fingerprint}`)
    const transactionId = parseCredentialTransactionId(`credential:inventory:${fingerprint}`)
    if (pending && pending.targetMetadataGenerationId !== generationId) {
      throw new Error('Another retained V1 inventory transaction is incomplete')
    }
    const createdAt = pending?.createdAt ?? inventoryTimestamp(source, wallets)
    const provisioned = prepared.filter(item => item.existingCredentialSet === undefined)
    const preparedWallets: PreparedV1Wallet[] = []

    for (const item of prepared) {
      if (item.newAccounts.length === 0) continue
      const suffix = (await sha256(`${fingerprint}:${item.wallet.id}`)).slice(0, 32)
      const existing = item.existingCredentialSet
      preparedWallets.push({
        wallet: Object.freeze({ ...item.wallet, accounts: item.newAccounts }),
        legacyEnvelope: item.legacyEnvelope,
        result: item.result,
        stableSuffix: suffix,
        credentialGenerationId:
          existing?.manifest.credentialGenerationId ??
          parseCredentialGenerationId(`credential-generation:inventory:${suffix}`),
        credentialSetRef:
          existing?.credentialSetRef ?? parseCredentialRef(`credential-set:inventory:${suffix}`),
        zcashCredentialRef:
          existing?.manifest.source === 'software'
            ? existing.manifest.engines.zcash.credentialRef
            : parseEngineCredentialRef(`credential:inventory:${suffix}:zcash`),
        multichainCredentialRef:
          existing?.manifest.source === 'software'
            ? existing.manifest.engines.multichain.credentialRef
            : parseEngineCredentialRef(`credential:inventory:${suffix}:multichain`)
      })
    }

    const targetSnapshot = mergeInventorySnapshot(
      source,
      input.discovery,
      prepared,
      generationId,
      fingerprint,
      createdAt,
      preparedWallets
    )
    const stagedSets: CredentialSetRecord[] = []
    const stagedEnvelopes: EncryptedCredentialEnvelopeRecord[] = []

    if (provisioned.length > 0) {
      const preparedByWalletId = new Map(preparedWallets.map(item => [item.wallet.id, item]))
      const transitions: CredentialTransactionJournal['transitions'][number][] = []
      for (const item of provisioned) {
        const target = preparedByWalletId.get(item.wallet.id)
        if (!target) throw new Error('Provisioned Wallet target is missing')
        const firstAccount = item.wallet.accounts[0]
        const zcashChainAccountId = parseChainAccountId(
          retainedV1EntityId(
            'chain-account',
            target.stableSuffix,
            firstAccount.accountIndex,
            'zcash'
          )
        )
        const evmChainAccountId = parseChainAccountId(
          retainedV1EntityId('chain-account', target.stableSuffix, firstAccount.accountIndex, 'evm')
        )
        const envelopes = await authenticateSoftwareCredentialEnvelopePair(
          {
            zcash: {
              schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
              transactionId,
              aad: {
                schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
                engine: 'zcash',
                keyDomainId: parseKeyDomainId(item.wallet.id),
                credentialGenerationId: target.credentialGenerationId,
                credentialRef: target.zcashCredentialRef,
                formatVersion: 1
              },
              encryptedPayload: encodeV1EncryptedCredentialEnvelope(item.legacyEnvelope),
              createdAt
            },
            multichain: {
              schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
              transactionId,
              aad: {
                schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
                engine: 'multichain',
                keyDomainId: parseKeyDomainId(item.wallet.id),
                credentialGenerationId: target.credentialGenerationId,
                credentialRef: target.multichainCredentialRef,
                formatVersion: 1
              },
              encryptedPayload: enginePayload(item.result.vault),
              createdAt
            }
          },
          input.password
        )
        stagedEnvelopes.push(envelopes.zcash, envelopes.multichain)
        stagedSets.push({
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          credentialSetRef: target.credentialSetRef,
          manifest: {
            schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
            credentialGenerationId: target.credentialGenerationId,
            keyDomainId: parseKeyDomainId(item.wallet.id),
            source: 'software',
            mnemonicWordCount: item.result.mnemonicWordCount,
            zcashSeedPolicy: 'direct-bip39-v1',
            engines: {
              zcash: {
                credentialRef: target.zcashCredentialRef,
                formatVersion: 1,
                verificationAnchorRef: buildChainAccountVerificationAnchorRef(zcashChainAccountId)
              },
              multichain: {
                credentialRef: target.multichainCredentialRef,
                formatVersion: 1,
                verificationAnchorRef: buildChainAccountVerificationAnchorRef(evmChainAccountId)
              }
            },
            createdAt,
            verifiedAt: createdAt
          }
        })
        transitions.push(
          Object.freeze({
            kind: 'provision' as const,
            keyDomainId: parseKeyDomainId(item.wallet.id),
            targetCredentialGenerationId: target.credentialGenerationId,
            targetCredentialSetRef: target.credentialSetRef,
            stagedRefs: Object.freeze([
              parseCredentialArtifactRef(target.zcashCredentialRef),
              parseCredentialArtifactRef(target.multichainCredentialRef)
            ])
          })
        )
      }
      const journal: CredentialTransactionJournal =
        pending ??
        Object.freeze({
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          operation: 'migrate',
          targetMetadataGenerationId: generationId,
          transitions: Object.freeze(transitions),
          phase: 'staging',
          revision: 0,
          createdAt,
          updatedAt: createdAt
        })
      const stageStatus = await this.credentialRepository.stageTransaction(
        journal,
        stagedEnvelopes,
        stagedSets
      )
      if (stageStatus !== 'staged' && stageStatus !== 'already-staged') {
        throw new Error(`Credential inventory staging failed: ${stageStatus}`)
      }
      pending = journal
    }

    await this.storageRepository.stage(targetSnapshot)
    if (pending?.phase === 'staging') {
      const verified = nextJournal(pending, 'verified', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(verified, pending.revision),
        'Credential inventory verification'
      )
      pending = verified
    }
    if (pending?.phase === 'verified') {
      const committing = nextJournal(pending, 'committing', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committing, pending.revision),
        'Credential inventory commit preparation'
      )
      pending = committing
    }

    activePointer = (await this.storageRepository.getActivePointer()) ?? activePointer
    if (activePointer.generationId !== generationId) {
      if (activePointer.generationId !== source.manifest.generationId) {
        throw new Error('Storage V2 active generation changed during inventory synchronization')
      }
      const commitStatus = await commitCredentialBoundStorageV2Pointer(
        this.storageRepository,
        this.credentialRepository,
        {
          schemaVersion: STORAGE_V2_SCHEMA_VERSION,
          generationId,
          sourceFingerprint: fingerprint,
          committedAt: Math.max(createdAt, this.now())
        },
        source.manifest.generationId,
        pending?.transactionId
      )
      if (commitStatus !== 'committed') {
        throw new Error(`Credential-bound inventory commit failed: ${commitStatus}`)
      }
    }
    if (pending?.phase === 'committing') {
      const committed = nextJournal(pending, 'committed-pending-cleanup', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committed, pending.revision),
        'Credential inventory commit finalization'
      )
      pending = committed
    }
    if (pending?.phase === 'committed-pending-cleanup') {
      const complete = nextJournal(pending, 'complete', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(complete, pending.revision),
        'Credential inventory completion'
      )
      pending = complete
    }
    if (pending && pending.phase !== 'complete') {
      throw new Error(`Credential inventory stopped in phase: ${pending.phase}`)
    }
    return Object.freeze({
      status: 'synchronized',
      generationId,
      ...(pending ? { transactionId: pending.transactionId } : {}),
      provisionedKeyDomainIds: Object.freeze(provisioned.map(item => item.wallet.id)),
      addedAccountIds: Object.freeze(
        prepared.flatMap(item => item.newAccounts.map(account => account.id))
      )
    })
  }
}
