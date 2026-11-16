import { parseAccountId, parseAddressId, parseChainAccountId } from '@/core/accounts/domain'
import { bytesToHex } from '@/lib/bytes'
import {
  isZcashHardwareKeySource,
  zcashHardwareMetadataForKeySource
} from '@/core/wallet/hardware-wallet-data'
import { parseChainId } from '@/core/chains/registry'
import {
  buildChainAccountVerificationAnchorRef,
  commitCredentialBoundStorageV2Pointer
} from '@/core/keyring/application'
import {
  CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  CREDENTIAL_SET_SCHEMA_VERSION,
  parseCredentialGenerationId,
  parseCredentialRef,
  parseEngineCredentialRef,
  parseKeyDomainId
} from '@/core/keyring/domain'
import { authenticateHardwareCredentialEnvelope } from '@/infrastructure/keyring/credential-envelope-authentication'
import type {
  V1DiscoveredWallet,
  V1MetadataDiscovery
} from '@/infrastructure/persistence/migrations'
import {
  parseCredentialArtifactRef,
  parseCredentialTransactionId,
  parseStorageV2GenerationId,
  parseStorageV2Snapshot,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import {
  CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
  STORAGE_V2_SCHEMA_VERSION,
  type CredentialRepository,
  type CredentialTransactionJournal,
  type CredentialTransactionPhase,
  type StorageV2Repository,
  type StorageV2Snapshot
} from '@/ports/repositories'
import type { RetainedV1MigrationChainProfile } from './retained-v1-migration-coordinator'
import {
  encodeV1EncryptedCredentialEnvelope,
  parseV1EncryptedCredentialEnvelope,
  type V1EncryptedCredentialEnvelope
} from './v1-credential-envelope'
import type {
  KeystoneZcashVerificationPort,
  KeystoneZcashVerificationResult
} from './keystone-hardware-verification'
import { assertKeystoneZcashVerificationMatches } from './keystone-hardware-verification'

export interface KeystoneHardwareMigrationInput {
  readonly discovery: V1MetadataDiscovery
  readonly credentialEnvelopes: Readonly<Record<string, unknown>>
  readonly password: string
  readonly chains: RetainedV1MigrationChainProfile
}

export interface KeystoneHardwareMigrationResult {
  readonly status: 'committed' | 'already-committed'
  readonly generationId: string
  readonly transactionId: string
  readonly migratedKeyDomainIds: readonly string[]
}

export interface KeystoneHardwareMigrationCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly verifier: KeystoneZcashVerificationPort
  readonly now?: () => number
}

interface PreparedHardwareWallet {
  readonly wallet: V1DiscoveredWallet
  readonly legacyEnvelope: V1EncryptedCredentialEnvelope
  readonly verification: KeystoneZcashVerificationResult
  readonly suffix: string
  readonly credentialGenerationId: ReturnType<typeof parseCredentialGenerationId>
  readonly credentialSetRef: ReturnType<typeof parseCredentialRef>
  readonly zcashCredentialRef: ReturnType<typeof parseEngineCredentialRef>
}

const TEXT_ENCODER = new TextEncoder()

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

function assertHardwareDiscovery(discovery: V1MetadataDiscovery): readonly V1DiscoveredWallet[] {
  if (discovery.status !== 'ready' || discovery.wallets.length === 0) {
    throw new Error(`V1 hardware migration metadata is not ready: ${discovery.status}`)
  }
  if (discovery.wallets.some(wallet => !isZcashHardwareKeySource(wallet.keySource))) {
    throw new Error('Hardware migration cannot include software Wallet Sets')
  }
  if (
    discovery.wallets.some(
      wallet =>
        wallet.accounts.length !== 1 ||
        wallet.accounts[0].accountIndex < 0 ||
        wallet.accounts[0].accountIndex > 0x7fffffff
    )
  ) {
    throw new Error('Legacy Keystone Wallet Sets require exactly one bound Account')
  }
  return discovery.wallets
}

function assertChainProfile(chains: RetainedV1MigrationChainProfile): void {
  const zcash = parseChainId(chains.zcashChainId)
  if (zcash.namespace !== 'bip122') throw new Error('Invalid Keystone Zcash chain profile')
}

function assertVerification(
  prepared: Pick<PreparedHardwareWallet, 'wallet' | 'verification'>,
  chains: RetainedV1MigrationChainProfile
): void {
  const account = prepared.wallet.accounts[0]
  assertKeystoneZcashVerificationMatches(prepared.verification, {
    accountIndex: account.accountIndex,
    expected: account.addresses,
    chainId: chains.zcashChainId,
    network: chains.zcashNetwork
  })
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

function assertCreated(status: string, label: string): void {
  if (status !== 'created' && status !== 'already-exists') {
    throw new Error(`${label} failed: ${status}`)
  }
}

function assertAdvanced(status: string, label: string): void {
  if (status !== 'advanced' && status !== 'already-applied') {
    throw new Error(`${label} failed: ${status}`)
  }
}

function entityId(
  prepared: PreparedHardwareWallet,
  type: 'chain-account' | 'address',
  role: string
) {
  return `${type}:keystone-migration:${prepared.suffix}:${role}`
}

function buildSnapshot(
  discovery: V1MetadataDiscovery,
  preparedWallets: readonly PreparedHardwareWallet[],
  generationId: ReturnType<typeof parseStorageV2GenerationId>,
  sourceFingerprint: ReturnType<typeof parseStorageV2SourceFingerprint>,
  timestamp: number
): StorageV2Snapshot {
  const preparedById = new Map(preparedWallets.map(prepared => [prepared.wallet.id, prepared]))
  const keyDomains = discovery.wallets.map(wallet => {
    const prepared = preparedById.get(wallet.id)
    if (!prepared) throw new Error('Prepared Keystone credential is missing')
    return {
      id: parseKeyDomainId(wallet.id),
      credentialRef: prepared.credentialSetRef,
      source: {
        kind: 'hardware' as const,
        ...zcashHardwareMetadataForKeySource(wallet.keySource as 'keystone' | 'ledger')
      },
      displayName: wallet.displayName,
      createdAt: wallet.createdAt
    }
  })
  const accounts = preparedWallets.map(prepared => {
    const account = prepared.wallet.accounts[0]
    return {
      id: parseAccountId(account.id),
      keyDomainId: parseKeyDomainId(prepared.wallet.id),
      accountIndex: account.accountIndex,
      displayName: account.displayName,
      createdAt: account.createdAt
    }
  })
  const chainAccounts: StorageV2Snapshot['chainAccounts'][number][] = []
  const addresses: StorageV2Snapshot['addresses'][number][] = []
  for (const prepared of preparedWallets) {
    const account = prepared.wallet.accounts[0]
    const chainAccountId = parseChainAccountId(entityId(prepared, 'chain-account', 'zcash'))
    chainAccounts.push({
      id: chainAccountId,
      scope: {
        keyDomainId: parseKeyDomainId(prepared.wallet.id),
        accountId: parseAccountId(account.id),
        chainId: parseChainId(prepared.verification.chainId).id
      },
      derivation: { scheme: 'zip32-unified', path: prepared.verification.derivationPath },
      identity: { kind: 'account-identifier', value: prepared.verification.identity },
      createdAt: account.createdAt
    })
    addresses.push(
      {
        id: parseAddressId(entityId(prepared, 'address', 'zcash-identity')),
        chainAccountId,
        value: prepared.verification.identity,
        scheme: 'zcash-full-unified',
        purpose: 'identity',
        derivation: { scheme: 'zip32-unified', path: prepared.verification.derivationPath },
        rotatable: false,
        preferredForReceive: false,
        privacy: 'mixed',
        walletCompatibility: 'limited'
      },
      {
        id: parseAddressId(entityId(prepared, 'address', 'zcash-shielded')),
        chainAccountId,
        value: prepared.verification.shielded,
        scheme: 'zcash-shielded-unified',
        purpose: 'receive',
        rotatable: true,
        preferredForReceive: true,
        privacy: 'shielded',
        walletCompatibility: 'limited'
      },
      {
        id: parseAddressId(entityId(prepared, 'address', 'zcash-transparent')),
        chainAccountId,
        value: prepared.verification.transparent,
        scheme: 'zcash-transparent-p2pkh',
        purpose: 'receive',
        rotatable: false,
        preferredForReceive: false,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      }
    )
  }
  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId: keyDomains[0]?.id,
      ...(discovery.currentWalletId && discovery.currentAccountId
        ? {
            activeAccount: {
              keyDomainId: parseKeyDomainId(discovery.currentWalletId),
              accountId: parseAccountId(discovery.currentAccountId)
            }
          }
        : {}),
      counts: {
        keyDomains: keyDomains.length,
        accounts: accounts.length,
        chainAccounts: chainAccounts.length,
        addresses: addresses.length
      },
      createdAt: timestamp,
      verifiedAt: timestamp
    },
    keyDomains,
    accounts,
    chainAccounts,
    addresses
  })
}

export class KeystoneHardwareMigrationCoordinator {
  private readonly credentialRepository: CredentialRepository
  private readonly storageRepository: StorageV2Repository
  private readonly verifier: KeystoneZcashVerificationPort
  private readonly now: () => number

  constructor(options: KeystoneHardwareMigrationCoordinatorOptions) {
    this.credentialRepository = options.credentialRepository
    this.storageRepository = options.storageRepository
    this.verifier = options.verifier
    this.now = options.now ?? Date.now
  }

  async migrate(input: KeystoneHardwareMigrationInput): Promise<KeystoneHardwareMigrationResult> {
    const wallets = assertHardwareDiscovery(input.discovery)
    assertChainProfile(input.chains)
    const envelopes = wallets.map(wallet => ({
      key: wallet.credentialStorageKey,
      value: parseV1EncryptedCredentialEnvelope(
        input.credentialEnvelopes[wallet.credentialStorageKey]
      )
    }))
    const sourceFingerprint = parseStorageV2SourceFingerprint(
      await sha256(
        JSON.stringify({
          schema: 'keystone-hardware-migration-v1',
          discovery: input.discovery,
          envelopes,
          network: input.chains.zcashNetwork,
          chainId: input.chains.zcashChainId
        })
      )
    )
    const generationId = parseStorageV2GenerationId(`storage-v2:keystone:${sourceFingerprint}`)
    const transactionId = parseCredentialTransactionId(`credential:keystone:${sourceFingerprint}`)
    let journal = await this.credentialRepository.getJournal(transactionId)
    const activePointer = await this.storageRepository.getActivePointer()
    if (activePointer && activePointer.generationId !== generationId) {
      throw new Error('Another Storage V2 generation is already active')
    }
    if (journal?.phase === 'failed') throw new Error('Keystone migration is terminally failed')
    if (journal?.phase === 'complete') {
      if (activePointer?.generationId !== generationId) {
        throw new Error('Completed Keystone migration does not own the active generation')
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
      const prepared: PreparedHardwareWallet[] = []
      for (const [index, wallet] of wallets.entries()) {
        const account = wallet.accounts[0]
        const verification = await this.verifier.verifyZcash({
          vendor: wallet.keySource as 'keystone' | 'ledger',
          envelope: envelopes[index].value,
          password: input.password,
          network: input.chains.zcashNetwork,
          chainId: input.chains.zcashChainId,
          account: {
            accountIndex: account.accountIndex,
            birthdayHeight: account.birthdayHeight,
            expected: account.addresses
          }
        })
        assertVerification({ wallet, verification }, input.chains)
        const suffix = (await sha256(`${sourceFingerprint}:${wallet.id}`)).slice(0, 32)
        prepared.push({
          wallet,
          legacyEnvelope: envelopes[index].value,
          verification,
          suffix,
          credentialGenerationId: parseCredentialGenerationId(
            `credential-generation:keystone:${suffix}`
          ),
          credentialSetRef: parseCredentialRef(`credential-set:keystone:${suffix}`),
          zcashCredentialRef: parseEngineCredentialRef(`credential:keystone:${suffix}:zcash`)
        })
      }
      const createdAt = journal?.createdAt ?? this.now()
      if (!journal) {
        journal = Object.freeze({
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          operation: 'migrate',
          targetMetadataGenerationId: generationId,
          transitions: Object.freeze(
            prepared.map(item => ({
              kind: 'provision' as const,
              keyDomainId: parseKeyDomainId(item.wallet.id),
              targetCredentialGenerationId: item.credentialGenerationId,
              targetCredentialSetRef: item.credentialSetRef,
              stagedRefs: Object.freeze([parseCredentialArtifactRef(item.zcashCredentialRef)])
            }))
          ),
          phase: 'staging',
          revision: 0,
          createdAt,
          updatedAt: createdAt
        })
        assertCreated(
          await this.credentialRepository.createJournal(journal),
          'Keystone migration journal creation'
        )
      }
      for (const item of prepared) {
        const chainAccountId = parseChainAccountId(entityId(item, 'chain-account', 'zcash'))
        const rawEnvelope = {
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          aad: {
            schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
            engine: 'zcash' as const,
            keyDomainId: parseKeyDomainId(item.wallet.id),
            credentialGenerationId: item.credentialGenerationId,
            credentialRef: item.zcashCredentialRef,
            formatVersion: 2
          },
          encryptedPayload: encodeV1EncryptedCredentialEnvelope(item.legacyEnvelope),
          createdAt
        }
        if (!(await this.credentialRepository.getEnvelope(item.zcashCredentialRef))) {
          assertCreated(
            await this.credentialRepository.putEnvelope(
              await authenticateHardwareCredentialEnvelope(rawEnvelope, input.password)
            ),
            'Keystone credential staging'
          )
        }
        if (!(await this.credentialRepository.getCredentialSet(item.credentialSetRef))) {
          assertCreated(
            await this.credentialRepository.putCredentialSet({
              schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
              transactionId,
              credentialSetRef: item.credentialSetRef,
              manifest: {
                schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
                credentialGenerationId: item.credentialGenerationId,
                keyDomainId: parseKeyDomainId(item.wallet.id),
                source: 'hardware',
                hardware: zcashHardwareMetadataForKeySource(
                  item.wallet.keySource as 'keystone' | 'ledger'
                ),
                engines: {
                  zcash: {
                    credentialRef: item.zcashCredentialRef,
                    formatVersion: 2,
                    verificationAnchorRef: buildChainAccountVerificationAnchorRef(chainAccountId)
                  }
                },
                createdAt,
                verifiedAt: createdAt
              }
            }),
            'Keystone CredentialSet staging'
          )
        }
      }
      snapshot = buildSnapshot(
        input.discovery,
        prepared,
        generationId,
        sourceFingerprint,
        createdAt
      )
      await this.storageRepository.stage(snapshot)
      if (journal.phase === 'staging') {
        const verified = nextJournal(journal, 'verified', this.now())
        assertAdvanced(
          await this.credentialRepository.advanceJournal(verified, journal.revision),
          'Keystone migration verification'
        )
        journal = verified
      }
    }

    if (!snapshot) throw new Error('Verified Keystone Storage V2 snapshot is missing')
    if (journal.phase === 'verified') {
      const committing = nextJournal(journal, 'committing', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committing, journal.revision),
        'Keystone migration commit preparation'
      )
      journal = committing
    }
    if (journal.phase === 'committing') {
      const pointer = await this.storageRepository.getActivePointer()
      if (!pointer) {
        const status = await commitCredentialBoundStorageV2Pointer(
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
        if (status !== 'committed') throw new Error(`Keystone migration commit failed: ${status}`)
      } else if (pointer.generationId !== generationId) {
        throw new Error('Another Storage V2 generation became active')
      }
      const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committed, journal.revision),
        'Keystone migration commit finalization'
      )
      journal = committed
    }
    if (journal.phase === 'committed-pending-cleanup') {
      const complete = nextJournal(journal, 'complete', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(complete, journal.revision),
        'Keystone migration completion'
      )
    }
    return Object.freeze({
      status: 'committed',
      generationId,
      transactionId,
      migratedKeyDomainIds: Object.freeze(wallets.map(wallet => wallet.id))
    })
  }
}
