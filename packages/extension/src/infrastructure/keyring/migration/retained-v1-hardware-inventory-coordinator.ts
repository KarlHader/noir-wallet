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
  type CredentialSetRecord,
  type CredentialTransactionJournal,
  type CredentialTransactionPhase,
  type EncryptedCredentialEnvelopeRecord,
  type StorageV2Repository,
  type StorageV2Snapshot
} from '@/ports/repositories'
import type { RetainedV1MigrationChainProfile } from './retained-v1-migration-coordinator'
import {
  assertKeystoneZcashVerificationMatches,
  type KeystoneZcashVerificationPort,
  type KeystoneZcashVerificationResult
} from './keystone-hardware-verification'
import {
  encodeV1EncryptedCredentialEnvelope,
  parseV1EncryptedCredentialEnvelope,
  type V1EncryptedCredentialEnvelope
} from './v1-credential-envelope'

export interface RetainedV1HardwareInventoryInput {
  readonly discovery: V1MetadataDiscovery
  readonly credentialEnvelopes: Readonly<Record<string, unknown>>
  readonly password: string
  readonly chains: RetainedV1MigrationChainProfile
}

export interface RetainedV1HardwareInventoryResult {
  readonly status: 'synchronized' | 'already-synchronized'
  readonly generationId: string
  readonly transactionId?: string
  readonly addedKeyDomainIds: readonly string[]
}

export interface RetainedV1HardwareInventoryCoordinatorOptions {
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

function assertAdvanced(status: string, label: string): void {
  if (status !== 'advanced' && status !== 'already-applied') {
    throw new Error(`${label} failed: ${status}`)
  }
}

function entityId(
  prepared: PreparedHardwareWallet,
  type: 'chain-account' | 'address',
  role: string
): string {
  return `${type}:keystone-inventory:${prepared.suffix}:${role}`
}

function assertInput(
  discovery: V1MetadataDiscovery,
  chains: RetainedV1MigrationChainProfile
): readonly V1DiscoveredWallet[] {
  if (discovery.status !== 'ready' || discovery.wallets.length === 0) {
    throw new Error(`V1 hardware inventory metadata is not ready: ${discovery.status}`)
  }
  if (parseChainId(chains.zcashChainId).namespace !== 'bip122') {
    throw new Error('Invalid Keystone Zcash chain profile')
  }
  const wallets = discovery.wallets.filter(wallet => isZcashHardwareKeySource(wallet.keySource))
  if (
    wallets.some(
      wallet =>
        wallet.accounts.length !== 1 ||
        wallet.accounts[0].accountIndex < 0 ||
        wallet.accounts[0].accountIndex > 0x7fffffff
    )
  ) {
    throw new Error('Legacy Keystone Wallet Sets require exactly one bound Account')
  }
  return wallets
}

function canonicalSource(
  source: StorageV2Snapshot,
  wallets: readonly V1DiscoveredWallet[],
  envelopes: readonly Readonly<{ key: string; value: V1EncryptedCredentialEnvelope }>[],
  chains: RetainedV1MigrationChainProfile
): string {
  return JSON.stringify({
    schema: 'retained-v1-hardware-inventory-v1',
    sourceGenerationId: source.manifest.generationId,
    wallets,
    envelopes,
    network: chains.zcashNetwork,
    chainId: chains.zcashChainId
  })
}

function buildSnapshot(
  source: StorageV2Snapshot,
  discovery: V1MetadataDiscovery,
  prepared: readonly PreparedHardwareWallet[],
  generationId: ReturnType<typeof parseStorageV2GenerationId>,
  sourceFingerprint: ReturnType<typeof parseStorageV2SourceFingerprint>,
  timestamp: number
): StorageV2Snapshot {
  const keyDomains = [
    ...source.keyDomains,
    ...prepared.map(item => ({
      id: parseKeyDomainId(item.wallet.id),
      credentialRef: item.credentialSetRef,
      source: {
        kind: 'hardware' as const,
        ...zcashHardwareMetadataForKeySource(item.wallet.keySource as 'keystone' | 'ledger')
      },
      displayName: item.wallet.displayName,
      createdAt: item.wallet.createdAt
    }))
  ]
  const accounts = [
    ...source.accounts,
    ...prepared.map(item => {
      const account = item.wallet.accounts[0]
      return {
        id: parseAccountId(account.id),
        keyDomainId: parseKeyDomainId(item.wallet.id),
        accountIndex: account.accountIndex,
        displayName: account.displayName,
        createdAt: account.createdAt
      }
    })
  ]
  const addedChainAccounts: StorageV2Snapshot['chainAccounts'][number][] = []
  const addedAddresses: StorageV2Snapshot['addresses'][number][] = []

  for (const item of prepared) {
    const account = item.wallet.accounts[0]
    const chainAccountId = parseChainAccountId(entityId(item, 'chain-account', 'zcash'))
    const derivation = {
      scheme: 'zip32-unified' as const,
      path: item.verification.derivationPath
    }
    addedChainAccounts.push({
      id: chainAccountId,
      scope: {
        keyDomainId: parseKeyDomainId(item.wallet.id),
        accountId: parseAccountId(account.id),
        chainId: parseChainId(item.verification.chainId).id
      },
      derivation,
      identity: { kind: 'account-identifier', value: item.verification.identity },
      createdAt: account.createdAt
    })
    addedAddresses.push(
      {
        id: parseAddressId(entityId(item, 'address', 'zcash-identity')),
        chainAccountId,
        value: item.verification.identity,
        scheme: 'zcash-full-unified',
        purpose: 'identity',
        derivation,
        rotatable: false,
        preferredForReceive: false,
        privacy: 'mixed',
        walletCompatibility: 'limited'
      },
      {
        id: parseAddressId(entityId(item, 'address', 'zcash-shielded')),
        chainAccountId,
        value: item.verification.shielded,
        scheme: 'zcash-shielded-unified',
        purpose: 'receive',
        rotatable: true,
        preferredForReceive: true,
        privacy: 'shielded',
        walletCompatibility: 'limited'
      },
      {
        id: parseAddressId(entityId(item, 'address', 'zcash-transparent')),
        chainAccountId,
        value: item.verification.transparent,
        scheme: 'zcash-transparent-p2pkh',
        purpose: 'receive',
        rotatable: false,
        preferredForReceive: false,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      }
    )
  }

  const desiredActive =
    discovery.currentWalletId && discovery.currentAccountId
      ? {
          keyDomainId: parseKeyDomainId(discovery.currentWalletId),
          accountId: parseAccountId(discovery.currentAccountId)
        }
      : source.manifest.activeAccount
  const activeExists =
    desiredActive !== undefined &&
    keyDomains.some(keyDomain => keyDomain.id === desiredActive.keyDomainId) &&
    accounts.some(
      account =>
        account.id === desiredActive.accountId && account.keyDomainId === desiredActive.keyDomainId
    )

  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId,
      status: 'verified',
      sourceFingerprint,
      ...(source.manifest.mainKeyDomainId === undefined
        ? {}
        : { mainKeyDomainId: source.manifest.mainKeyDomainId }),
      ...(activeExists ? { activeAccount: desiredActive } : {}),
      counts: {
        keyDomains: keyDomains.length,
        accounts: accounts.length,
        chainAccounts: source.chainAccounts.length + addedChainAccounts.length,
        addresses: source.addresses.length + addedAddresses.length
      },
      createdAt: timestamp,
      verifiedAt: timestamp
    },
    keyDomains,
    accounts,
    chainAccounts: [...source.chainAccounts, ...addedChainAccounts],
    addresses: [...source.addresses, ...addedAddresses]
  })
}

export class RetainedV1HardwareInventoryCoordinator {
  private readonly credentialRepository: CredentialRepository
  private readonly storageRepository: StorageV2Repository
  private readonly verifier: KeystoneZcashVerificationPort
  private readonly now: () => number

  constructor(options: RetainedV1HardwareInventoryCoordinatorOptions) {
    this.credentialRepository = options.credentialRepository
    this.storageRepository = options.storageRepository
    this.verifier = options.verifier
    this.now = options.now ?? Date.now
  }

  async synchronize(
    input: RetainedV1HardwareInventoryInput
  ): Promise<RetainedV1HardwareInventoryResult> {
    const wallets = assertInput(input.discovery, input.chains)
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) throw new Error('Storage V2 is not active')
    const source = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!source) throw new Error('Active Storage V2 generation is missing')

    await this.completeCommittedJournal(pointer.generationId)
    const missing = wallets.filter(
      wallet => !source.keyDomains.some(keyDomain => keyDomain.id === wallet.id)
    )
    if (missing.length === 0) {
      return Object.freeze({
        status: 'already-synchronized',
        generationId: pointer.generationId,
        addedKeyDomainIds: Object.freeze([])
      })
    }
    for (const wallet of missing) {
      if (source.accounts.some(account => wallet.accounts.some(item => item.id === account.id))) {
        throw new Error('Retained V1 hardware Account identity conflicts with Storage V2')
      }
    }

    const envelopes = missing.map(wallet => ({
      key: wallet.credentialStorageKey,
      value: parseV1EncryptedCredentialEnvelope(
        input.credentialEnvelopes[wallet.credentialStorageKey]
      )
    }))
    const fingerprint = parseStorageV2SourceFingerprint(
      await sha256(canonicalSource(source, missing, envelopes, input.chains))
    )
    const generationId = parseStorageV2GenerationId(`storage-v2:keystone-inventory:${fingerprint}`)
    const transactionId = parseCredentialTransactionId(
      `credential:keystone-inventory:${fingerprint}`
    )
    const pending = await this.credentialRepository.findIncompleteJournal('create')
    if (pending && pending.transactionId !== transactionId) {
      throw new Error('Another hardware Wallet provisioning transaction is incomplete')
    }
    let journal = await this.credentialRepository.getJournal(transactionId)
    if (journal?.phase === 'failed') {
      throw new Error('Retained V1 hardware inventory transaction is terminally failed')
    }
    if (journal?.phase === 'complete') {
      const active = await this.storageRepository.getActivePointer()
      if (active?.generationId !== generationId) {
        throw new Error('Completed hardware inventory transaction is not active')
      }
      return Object.freeze({
        status: 'already-synchronized',
        generationId,
        transactionId,
        addedKeyDomainIds: Object.freeze(missing.map(wallet => wallet.id))
      })
    }

    const createdAt = journal?.createdAt ?? this.now()
    const prepared: PreparedHardwareWallet[] = []
    for (const [index, wallet] of missing.entries()) {
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
      assertKeystoneZcashVerificationMatches(verification, {
        accountIndex: account.accountIndex,
        expected: account.addresses,
        chainId: input.chains.zcashChainId,
        network: input.chains.zcashNetwork
      })
      const suffix = (await sha256(`${fingerprint}:${wallet.id}`)).slice(0, 32)
      prepared.push({
        wallet,
        legacyEnvelope: envelopes[index].value,
        verification,
        suffix,
        credentialGenerationId: parseCredentialGenerationId(
          `credential-generation:keystone-inventory:${suffix}`
        ),
        credentialSetRef: parseCredentialRef(`credential-set:keystone-inventory:${suffix}`),
        zcashCredentialRef: parseEngineCredentialRef(
          `credential:keystone-inventory:${suffix}:zcash`
        )
      })
    }

    const target = buildSnapshot(
      source,
      input.discovery,
      prepared,
      generationId,
      fingerprint,
      createdAt
    )
    if (!journal || journal.phase === 'staging') {
      const transitions: CredentialTransactionJournal['transitions'][number][] = []
      const stagedEnvelopes: EncryptedCredentialEnvelopeRecord[] = []
      const stagedSets: CredentialSetRecord[] = []
      for (const item of prepared) {
        const keyDomainId = parseKeyDomainId(item.wallet.id)
        const chainAccountId = parseChainAccountId(entityId(item, 'chain-account', 'zcash'))
        transitions.push({
          kind: 'provision',
          keyDomainId,
          targetCredentialGenerationId: item.credentialGenerationId,
          targetCredentialSetRef: item.credentialSetRef,
          stagedRefs: Object.freeze([parseCredentialArtifactRef(item.zcashCredentialRef)])
        })
        stagedEnvelopes.push(
          await authenticateHardwareCredentialEnvelope(
            {
              schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
              transactionId,
              aad: {
                schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
                engine: 'zcash',
                keyDomainId,
                credentialGenerationId: item.credentialGenerationId,
                credentialRef: item.zcashCredentialRef,
                formatVersion: 2
              },
              encryptedPayload: encodeV1EncryptedCredentialEnvelope(item.legacyEnvelope),
              createdAt
            },
            input.password
          )
        )
        stagedSets.push({
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          credentialSetRef: item.credentialSetRef,
          manifest: {
            schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
            credentialGenerationId: item.credentialGenerationId,
            keyDomainId,
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
        })
      }
      journal ??= Object.freeze({
        schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
        transactionId,
        operation: 'create',
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
        throw new Error(`Retained V1 hardware credential staging failed: ${stageStatus}`)
      }
      await this.storageRepository.stage(target)
      if (journal.phase === 'staging') {
        const verified = nextJournal(journal, 'verified', this.now())
        assertAdvanced(
          await this.credentialRepository.advanceJournal(verified, journal.revision),
          'Retained V1 hardware inventory verification'
        )
        journal = verified
      }
    }

    if (journal.phase === 'verified') {
      const committing = nextJournal(journal, 'committing', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committing, journal.revision),
        'Retained V1 hardware inventory commit preparation'
      )
      journal = committing
    }
    if (journal.phase === 'committing') {
      const active = await this.storageRepository.getActivePointer()
      if (active?.generationId === pointer.generationId) {
        const status = await commitCredentialBoundStorageV2Pointer(
          this.storageRepository,
          this.credentialRepository,
          {
            schemaVersion: STORAGE_V2_SCHEMA_VERSION,
            generationId,
            sourceFingerprint: fingerprint,
            committedAt: Math.max(target.manifest.verifiedAt ?? 0, this.now())
          },
          pointer.generationId,
          transactionId
        )
        if (status !== 'committed') {
          throw new Error(`Retained V1 hardware inventory commit failed: ${status}`)
        }
      } else if (active?.generationId !== generationId) {
        throw new Error('Active Storage V2 generation changed during hardware provisioning')
      }
      const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committed, journal.revision),
        'Retained V1 hardware inventory commit finalization'
      )
      journal = committed
    }
    if (journal.phase === 'committed-pending-cleanup') {
      const complete = nextJournal(journal, 'complete', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(complete, journal.revision),
        'Retained V1 hardware inventory completion'
      )
    }

    return Object.freeze({
      status: 'synchronized',
      generationId,
      transactionId,
      addedKeyDomainIds: Object.freeze(missing.map(wallet => wallet.id))
    })
  }

  private async completeCommittedJournal(activeGenerationId: string): Promise<void> {
    const pending = await this.credentialRepository.findIncompleteJournal('create')
    if (
      !pending ||
      pending.targetMetadataGenerationId !== activeGenerationId ||
      !pending.transactionId.startsWith('credential:keystone-inventory:')
    ) {
      return
    }
    let journal = pending
    if (journal.phase === 'committing') {
      const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committed, journal.revision),
        'Retained V1 hardware inventory commit recovery'
      )
      journal = committed
    }
    if (journal.phase !== 'committed-pending-cleanup') return
    const complete = nextJournal(journal, 'complete', this.now())
    assertAdvanced(
      await this.credentialRepository.advanceJournal(complete, journal.revision),
      'Retained V1 hardware inventory recovery'
    )
  }
}
