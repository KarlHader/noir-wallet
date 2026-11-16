import {
  buildChainAccountVerificationAnchorRef,
  commitCredentialBoundStorageV2Pointer
} from '@/core/keyring/application'
import { bytesToHex } from '@/lib/bytes'
import {
  CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  CREDENTIAL_SET_SCHEMA_VERSION,
  parseCredentialGenerationId,
  parseCredentialRef,
  parseEngineCredentialRef,
  parseKeyDomainId
} from '@/core/keyring/domain'
import { parseChainAccountId } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import {
  CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
  STORAGE_V2_SCHEMA_VERSION,
  type CredentialRepository,
  type CredentialTransactionJournal,
  type CredentialTransactionPhase,
  type StorageV2Repository
} from '@/ports/repositories'
import {
  parseCredentialArtifactRef,
  parseCredentialTransactionId,
  parseStorageV2GenerationId,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import type {
  V1DiscoveredWallet,
  V1MetadataDiscovery
} from '@/infrastructure/persistence/migrations'
import { authenticateSoftwareCredentialEnvelopePair } from '@/infrastructure/keyring/credential-envelope-authentication'
import {
  encodeV1EncryptedCredentialEnvelope,
  parseV1EncryptedCredentialEnvelope,
  type V1EncryptedCredentialEnvelope
} from './v1-credential-envelope'
import { CompatibilityWorkerHost } from './compatibility-worker-host'
import type { CompatibilityWorkerResult } from './compatibility-worker-protocol'
import {
  buildRetainedV1Snapshot,
  findPreparedAccount,
  retainedV1EntityId,
  type PreparedV1Wallet
} from './retained-v1-migration-snapshot'

export interface RetainedV1MigrationChainProfile {
  readonly zcashNetwork: 'mainnet' | 'testnet'
  readonly zcashChainId: string
  readonly evmChainId: string
  readonly bitcoinChainId: string
}

export interface RetainedV1MigrationInput {
  readonly discovery: V1MetadataDiscovery
  readonly credentialEnvelopes: Readonly<Record<string, unknown>>
  readonly password: string
  readonly chains: RetainedV1MigrationChainProfile
}

export interface RetainedV1MigrationResult {
  readonly status: 'committed' | 'already-committed'
  readonly generationId: string
  readonly transactionId: string
  readonly migratedKeyDomainIds: readonly string[]
}

interface CompatibilityMigrationPort {
  migrate(
    input: Parameters<CompatibilityWorkerHost['migrate']>[0],
    timeoutMs?: number
  ): Promise<CompatibilityWorkerResult>
}

export interface RetainedV1MigrationCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly compatibilityWorker?: CompatibilityMigrationPort
  readonly now?: () => number
}

const TEXT_ENCODER = new TextEncoder()

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

function assertChainProfile(input: RetainedV1MigrationChainProfile): void {
  const zcash = parseChainId(input.zcashChainId)
  const evm = parseChainId(input.evmChainId)
  const bitcoin = parseChainId(input.bitcoinChainId)
  if (
    zcash.namespace !== 'bip122' ||
    evm.namespace !== 'eip155' ||
    bitcoin.namespace !== 'bip122'
  ) {
    throw new Error('Retained V1 migration chain profile has invalid namespaces')
  }
}

function assertDiscovery(discovery: V1MetadataDiscovery): readonly V1DiscoveredWallet[] {
  if (discovery.status !== 'ready' || discovery.wallets.length === 0) {
    throw new Error(`V1 migration metadata is not ready: ${discovery.status}`)
  }
  if (discovery.wallets.some(wallet => wallet.keySource !== 'software')) {
    throw new Error('Retained V1 software migration cannot include hardware Wallet Sets')
  }
  if (discovery.wallets.some(wallet => wallet.accounts.length === 0)) {
    throw new Error('Retained V1 software migration requires at least one Account per Wallet Set')
  }
  return discovery.wallets
}

function canonicalMigrationSource(
  discovery: V1MetadataDiscovery,
  envelopes: readonly Readonly<{ key: string; value: V1EncryptedCredentialEnvelope }>[],
  chains: RetainedV1MigrationChainProfile
): string {
  return JSON.stringify({
    schema: 'retained-v1-migration-v1',
    source: discovery.source,
    currentWalletId: discovery.currentWalletId,
    currentAccountId: discovery.currentAccountId,
    wallets: discovery.wallets,
    envelopes,
    chains
  })
}

function enginePayload(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(value))
}

function assertCreatedOrExisting(status: string, label: string): void {
  if (status !== 'created' && status !== 'already-exists') {
    throw new Error(`${label} failed: ${status}`)
  }
}

function assertAdvancedOrApplied(status: string, label: string): void {
  if (status !== 'advanced' && status !== 'already-applied') {
    throw new Error(`${label} failed: ${status}`)
  }
}

function nextJournal(
  journal: CredentialTransactionJournal,
  phase: CredentialTransactionPhase,
  updatedAt: number
): CredentialTransactionJournal {
  return Object.freeze({
    ...journal,
    phase,
    revision: journal.revision + 1,
    updatedAt: Math.max(journal.updatedAt, updatedAt)
  })
}

export class RetainedV1MigrationCoordinator {
  private readonly credentialRepository: CredentialRepository
  private readonly storageRepository: StorageV2Repository
  private readonly compatibilityWorker: CompatibilityMigrationPort
  private readonly now: () => number

  constructor(options: RetainedV1MigrationCoordinatorOptions) {
    this.credentialRepository = options.credentialRepository
    this.storageRepository = options.storageRepository
    this.compatibilityWorker = options.compatibilityWorker ?? new CompatibilityWorkerHost()
    this.now = options.now ?? Date.now
  }

  async migrate(input: RetainedV1MigrationInput): Promise<RetainedV1MigrationResult> {
    const wallets = assertDiscovery(input.discovery)
    assertChainProfile(input.chains)
    const legacyEnvelopes = wallets.map(wallet => ({
      key: wallet.credentialStorageKey,
      value: parseV1EncryptedCredentialEnvelope(
        input.credentialEnvelopes[wallet.credentialStorageKey]
      )
    }))
    const sourceFingerprint = parseStorageV2SourceFingerprint(
      await sha256(canonicalMigrationSource(input.discovery, legacyEnvelopes, input.chains))
    )
    const generationId = parseStorageV2GenerationId(`storage-v2:migrate:${sourceFingerprint}`)
    const transactionId = parseCredentialTransactionId(`credential:migrate:${sourceFingerprint}`)
    let journal = await this.credentialRepository.getJournal(transactionId)
    const activePointer = await this.storageRepository.getActivePointer()
    if (activePointer && activePointer.generationId !== generationId) {
      throw new Error('Another Storage V2 generation is already active')
    }
    if (journal?.phase === 'failed') {
      throw new Error('Retained V1 migration is terminally failed')
    }
    if (journal?.phase === 'complete') {
      if (activePointer?.generationId !== generationId) {
        throw new Error('Completed migration does not own the active Storage V2 generation')
      }
      return Object.freeze({
        status: 'already-committed',
        generationId,
        transactionId,
        migratedKeyDomainIds: Object.freeze(wallets.map(wallet => wallet.id))
      })
    }

    let snapshot = await this.storageRepository.getSnapshot(generationId)
    if (!journal || journal.phase === 'staging') {
      const preparedWallets: PreparedV1Wallet[] = []
      for (const [index, wallet] of wallets.entries()) {
        const legacyEnvelope = legacyEnvelopes[index].value
        const result = await this.compatibilityWorker.migrate({
          operation: 'migrate',
          envelope: legacyEnvelope,
          password: input.password,
          ...input.chains,
          accounts: wallet.accounts.map(account => ({
            accountIndex: account.accountIndex,
            expectedZcash: account.addresses
          }))
        })
        if (result.accounts.length !== wallet.accounts.length) {
          throw new Error('Compatibility Worker returned an incomplete Account set')
        }
        if (result.operation !== 'migrate') {
          throw new Error('Compatibility Worker returned the wrong operation result')
        }
        const stableSuffix = (await sha256(`${sourceFingerprint}:${wallet.id}`)).slice(0, 32)
        const credentialGenerationId = parseCredentialGenerationId(
          `credential-generation:v1-migration:${stableSuffix}`
        )
        const credentialSetRef = parseCredentialRef(`credential-set:v1-migration:${stableSuffix}`)
        preparedWallets.push(
          Object.freeze({
            wallet,
            legacyEnvelope,
            result,
            stableSuffix,
            credentialGenerationId,
            credentialSetRef,
            zcashCredentialRef: parseEngineCredentialRef(
              `credential:v1-migration:${stableSuffix}:zcash`
            ),
            multichainCredentialRef: parseEngineCredentialRef(
              `credential:v1-migration:${stableSuffix}:multichain`
            )
          })
        )
      }

      const createdAt = journal?.createdAt ?? this.now()
      if (!journal) {
        journal = Object.freeze({
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          operation: 'migrate',
          targetMetadataGenerationId: generationId,
          transitions: Object.freeze(
            preparedWallets.map(prepared => ({
              kind: 'provision' as const,
              keyDomainId: parseKeyDomainId(prepared.wallet.id),
              targetCredentialGenerationId: prepared.credentialGenerationId,
              targetCredentialSetRef: prepared.credentialSetRef,
              stagedRefs: Object.freeze([
                parseCredentialArtifactRef(prepared.zcashCredentialRef),
                parseCredentialArtifactRef(prepared.multichainCredentialRef)
              ])
            }))
          ),
          phase: 'staging',
          revision: 0,
          createdAt,
          updatedAt: createdAt
        })
        assertCreatedOrExisting(
          await this.credentialRepository.createJournal(journal),
          'Credential migration journal creation'
        )
      }

      for (const prepared of preparedWallets) {
        const firstAccount = prepared.wallet.accounts[0]
        const anchors = findPreparedAccount(prepared, firstAccount)
        const zcashChainAccountId = parseChainAccountId(
          retainedV1EntityId(
            'chain-account',
            prepared.stableSuffix,
            firstAccount.accountIndex,
            'zcash'
          )
        )
        const multichainChainAccountId = parseChainAccountId(
          retainedV1EntityId(
            'chain-account',
            prepared.stableSuffix,
            firstAccount.accountIndex,
            'evm'
          )
        )
        const rawZcashEnvelope = {
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          aad: {
            schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
            engine: 'zcash' as const,
            keyDomainId: parseKeyDomainId(prepared.wallet.id),
            credentialGenerationId: prepared.credentialGenerationId,
            credentialRef: prepared.zcashCredentialRef,
            formatVersion: 1
          },
          encryptedPayload: encodeV1EncryptedCredentialEnvelope(prepared.legacyEnvelope),
          createdAt
        }
        const rawMultichainEnvelope = {
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          aad: {
            schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
            engine: 'multichain' as const,
            keyDomainId: parseKeyDomainId(prepared.wallet.id),
            credentialGenerationId: prepared.credentialGenerationId,
            credentialRef: prepared.multichainCredentialRef,
            formatVersion: 1
          },
          encryptedPayload: enginePayload(prepared.result.vault),
          createdAt
        }
        const { zcash: zcashEnvelope, multichain: multichainEnvelope } =
          await authenticateSoftwareCredentialEnvelopePair(
            { zcash: rawZcashEnvelope, multichain: rawMultichainEnvelope },
            input.password
          )
        if (!(await this.credentialRepository.getEnvelope(prepared.zcashCredentialRef))) {
          assertCreatedOrExisting(
            await this.credentialRepository.putEnvelope(zcashEnvelope),
            'Zcash credential staging'
          )
        }
        if (!(await this.credentialRepository.getEnvelope(prepared.multichainCredentialRef))) {
          assertCreatedOrExisting(
            await this.credentialRepository.putEnvelope(multichainEnvelope),
            'Multichain credential staging'
          )
        }
        if (!(await this.credentialRepository.getCredentialSet(prepared.credentialSetRef))) {
          assertCreatedOrExisting(
            await this.credentialRepository.putCredentialSet({
              schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
              transactionId,
              credentialSetRef: prepared.credentialSetRef,
              manifest: {
                schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
                credentialGenerationId: prepared.credentialGenerationId,
                keyDomainId: parseKeyDomainId(prepared.wallet.id),
                source: 'software',
                mnemonicWordCount: prepared.result.mnemonicWordCount,
                zcashSeedPolicy: 'direct-bip39-v1',
                engines: {
                  zcash: {
                    credentialRef: prepared.zcashCredentialRef,
                    formatVersion: 1,
                    verificationAnchorRef:
                      buildChainAccountVerificationAnchorRef(zcashChainAccountId)
                  },
                  multichain: {
                    credentialRef: prepared.multichainCredentialRef,
                    formatVersion: 1,
                    verificationAnchorRef:
                      buildChainAccountVerificationAnchorRef(multichainChainAccountId)
                  }
                },
                createdAt,
                verifiedAt: createdAt
              }
            }),
            'CredentialSet staging'
          )
        }
        if (anchors.zcash.chainId !== input.chains.zcashChainId) {
          throw new Error('Zcash verification anchor chain mismatch')
        }
      }

      snapshot = buildRetainedV1Snapshot(
        input.discovery,
        preparedWallets,
        generationId,
        sourceFingerprint,
        createdAt
      )
      await this.storageRepository.stage(snapshot)
      if (journal.phase === 'staging') {
        const verified = nextJournal(journal, 'verified', this.now())
        assertAdvancedOrApplied(
          await this.credentialRepository.advanceJournal(verified, journal.revision),
          'Credential migration verification'
        )
        journal = verified
      }
    }

    if (!snapshot) throw new Error('Verified Storage V2 migration snapshot is missing')
    if (journal.phase === 'verified') {
      const committing = nextJournal(journal, 'committing', this.now())
      assertAdvancedOrApplied(
        await this.credentialRepository.advanceJournal(committing, journal.revision),
        'Credential migration commit preparation'
      )
      journal = committing
    }

    if (journal.phase === 'committing') {
      const currentPointer = await this.storageRepository.getActivePointer()
      if (!currentPointer) {
        const commitStatus = await commitCredentialBoundStorageV2Pointer(
          this.storageRepository,
          this.credentialRepository,
          {
            schemaVersion: STORAGE_V2_SCHEMA_VERSION,
            generationId,
            sourceFingerprint,
            committedAt: Math.max(snapshot.manifest.verifiedAt ?? 0, this.now())
          },
          null,
          transactionId
        )
        if (commitStatus !== 'committed') {
          throw new Error(`Credential-bound Storage V2 commit failed: ${commitStatus}`)
        }
      } else if (currentPointer.generationId !== generationId) {
        throw new Error('Storage V2 active generation changed during migration')
      }
      const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
      assertAdvancedOrApplied(
        await this.credentialRepository.advanceJournal(committed, journal.revision),
        'Credential migration commit finalization'
      )
      journal = committed
    }

    if (journal.phase === 'committed-pending-cleanup') {
      const complete = nextJournal(journal, 'complete', this.now())
      assertAdvancedOrApplied(
        await this.credentialRepository.advanceJournal(complete, journal.revision),
        'Credential migration completion'
      )
      journal = complete
    }
    if (journal.phase !== 'complete') {
      throw new Error(`Credential migration stopped in phase: ${journal.phase}`)
    }
    return Object.freeze({
      status: 'committed',
      generationId,
      transactionId,
      migratedKeyDomainIds: Object.freeze(wallets.map(wallet => wallet.id))
    })
  }
}
