import { parseAccountId, parseAddressId, parseChainAccountId } from '@/core/accounts/domain'
import { bytesToHex } from '@/lib/bytes'
import {
  isZcashHardwareKeySource,
  zcashHardwareMetadataForKeySource
} from '@/core/wallet/hardware-wallet-data'
import { BITCOIN_ADDRESS_POLICY } from '@/core/chains/bitcoin'
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
import {
  authenticateHardwareCredentialEnvelope,
  authenticateSoftwareCredentialEnvelopePair
} from '@/infrastructure/keyring/credential-envelope-authentication'
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
import { CompatibilityWorkerHost } from './compatibility-worker-host'
import type { CompatibilityWorkerResult } from './compatibility-worker-protocol'
import { assertKeystoneZcashVerificationMatches } from './keystone-hardware-verification'
import type {
  KeystoneZcashVerificationPort,
  KeystoneZcashVerificationResult
} from './keystone-hardware-verification'
import { retainedV1EntityId } from './retained-v1-migration-snapshot'
import type { RetainedV1MigrationChainProfile } from './retained-v1-migration-coordinator'
import {
  encodeV1EncryptedCredentialEnvelope,
  parseV1EncryptedCredentialEnvelope,
  type V1EncryptedCredentialEnvelope
} from './v1-credential-envelope'

export interface MixedRetainedV1MigrationInput {
  readonly discovery: V1MetadataDiscovery
  readonly credentialEnvelopes: Readonly<Record<string, unknown>>
  readonly password: string
  readonly chains: RetainedV1MigrationChainProfile
}

export interface MixedRetainedV1MigrationResult {
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

export interface MixedRetainedV1MigrationCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly compatibilityWorker?: CompatibilityMigrationPort
  readonly keystoneVerifier: KeystoneZcashVerificationPort
  readonly now?: () => number
}

interface PreparedBase {
  readonly wallet: V1DiscoveredWallet
  readonly legacyEnvelope: V1EncryptedCredentialEnvelope
  readonly suffix: string
  readonly credentialGenerationId: ReturnType<typeof parseCredentialGenerationId>
  readonly credentialSetRef: ReturnType<typeof parseCredentialRef>
}

interface PreparedSoftwareWallet extends PreparedBase {
  readonly kind: 'software'
  readonly result: Extract<CompatibilityWorkerResult, { readonly operation: 'migrate' }>
  readonly zcashCredentialRef: ReturnType<typeof parseEngineCredentialRef>
  readonly multichainCredentialRef: ReturnType<typeof parseEngineCredentialRef>
}

interface PreparedHardwareWallet extends PreparedBase {
  readonly kind: 'hardware'
  readonly verification: KeystoneZcashVerificationResult
  readonly zcashCredentialRef: ReturnType<typeof parseEngineCredentialRef>
}

type PreparedWallet = PreparedSoftwareWallet | PreparedHardwareWallet

const TEXT_ENCODER = new TextEncoder()

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

function assertMixedDiscovery(discovery: V1MetadataDiscovery): readonly V1DiscoveredWallet[] {
  if (discovery.status !== 'ready' || discovery.wallets.length < 2) {
    throw new Error(`Mixed V1 migration metadata is not ready: ${discovery.status}`)
  }
  const sources = new Set(discovery.wallets.map(wallet => wallet.keySource))
  if (!sources.has('software') || ![...sources].some(isZcashHardwareKeySource)) {
    throw new Error('Mixed V1 migration requires software and hardware Wallet Sets')
  }
  for (const wallet of discovery.wallets) {
    if (wallet.accounts.length === 0) {
      throw new Error('Mixed V1 migration requires at least one Account per Wallet Set')
    }
    if (isZcashHardwareKeySource(wallet.keySource) && wallet.accounts.length !== 1) {
      throw new Error('Legacy Keystone Wallet Sets require exactly one bound Account')
    }
  }
  return discovery.wallets
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
    throw new Error('Mixed V1 migration chain profile has invalid namespaces')
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

function assertAdvanced(status: string, label: string): void {
  if (status !== 'advanced' && status !== 'already-applied') {
    throw new Error(`${label} failed: ${status}`)
  }
}

function stableEntityId(
  prepared: PreparedWallet,
  kind: 'chain-account' | 'address',
  accountIndex: number,
  role: string
): string {
  return retainedV1EntityId(kind, prepared.suffix, accountIndex, role)
}

function softwareAccountResult(
  prepared: PreparedSoftwareWallet,
  accountIndex: number
): CompatibilityWorkerResult['accounts'][number] {
  const account = prepared.result.accounts.find(item => item.accountIndex === accountIndex)
  if (!account) throw new Error('Compatibility Worker omitted a V1 Account')
  return account
}

function buildSnapshot(
  discovery: V1MetadataDiscovery,
  preparedWallets: readonly PreparedWallet[],
  generationId: ReturnType<typeof parseStorageV2GenerationId>,
  sourceFingerprint: ReturnType<typeof parseStorageV2SourceFingerprint>,
  timestamp: number
): StorageV2Snapshot {
  const preparedById = new Map(preparedWallets.map(prepared => [prepared.wallet.id, prepared]))
  const keyDomains = discovery.wallets.map(wallet => {
    const prepared = preparedById.get(wallet.id)
    if (!prepared) throw new Error('Prepared mixed credential is missing')
    return {
      id: parseKeyDomainId(wallet.id),
      credentialRef: prepared.credentialSetRef,
      source:
        prepared.kind === 'software'
          ? { kind: 'software' as const, mnemonicWordCount: prepared.result.mnemonicWordCount }
          : {
              kind: 'hardware' as const,
              ...zcashHardwareMetadataForKeySource(wallet.keySource as 'keystone' | 'ledger')
            },
      displayName: wallet.displayName,
      createdAt: wallet.createdAt
    }
  })
  const accounts = discovery.wallets.flatMap(wallet =>
    wallet.accounts.map(account => ({
      id: parseAccountId(account.id),
      keyDomainId: parseKeyDomainId(wallet.id),
      accountIndex: account.accountIndex,
      displayName: account.displayName,
      createdAt: account.createdAt
    }))
  )
  const chainAccounts: StorageV2Snapshot['chainAccounts'][number][] = []
  const addresses: StorageV2Snapshot['addresses'][number][] = []

  for (const prepared of preparedWallets) {
    for (const account of prepared.wallet.accounts) {
      const scope = {
        keyDomainId: parseKeyDomainId(prepared.wallet.id),
        accountId: parseAccountId(account.id)
      }
      const zcash =
        prepared.kind === 'software'
          ? softwareAccountResult(prepared, account.accountIndex).zcash
          : prepared.verification
      const zcashChainAccountId = parseChainAccountId(
        stableEntityId(prepared, 'chain-account', account.accountIndex, 'zcash')
      )
      chainAccounts.push({
        id: zcashChainAccountId,
        scope: { ...scope, chainId: parseChainId(zcash.chainId).id },
        derivation: { scheme: 'zip32-unified', path: zcash.derivationPath },
        identity: { kind: 'account-identifier', value: zcash.identity },
        createdAt: account.createdAt
      })
      const addressId = (role: string) =>
        parseAddressId(stableEntityId(prepared, 'address', account.accountIndex, role))
      addresses.push(
        {
          id: addressId('zcash-full-unified'),
          chainAccountId: zcashChainAccountId,
          value: zcash.identity,
          scheme: 'zcash-full-unified',
          purpose: 'identity',
          derivation: { scheme: 'zip32-unified', path: zcash.derivationPath },
          rotatable: false,
          preferredForReceive: false,
          privacy: 'mixed',
          walletCompatibility: 'limited'
        },
        {
          id: addressId('zcash-shielded'),
          chainAccountId: zcashChainAccountId,
          value: account.addresses.shielded,
          scheme: 'zcash-shielded-unified',
          purpose: 'receive',
          rotatable: true,
          preferredForReceive: true,
          privacy: 'shielded',
          walletCompatibility: 'limited'
        },
        {
          id: addressId('zcash-transparent'),
          chainAccountId: zcashChainAccountId,
          value: account.addresses.transparent,
          scheme: 'zcash-transparent-p2pkh',
          purpose: 'receive',
          rotatable: false,
          preferredForReceive: false,
          privacy: 'transparent',
          walletCompatibility: 'broad'
        }
      )

      if (prepared.kind === 'hardware') continue
      const result = softwareAccountResult(prepared, account.accountIndex)
      const evmChainAccountId = parseChainAccountId(
        stableEntityId(prepared, 'chain-account', account.accountIndex, 'evm')
      )
      const bitcoinChainAccountId = parseChainAccountId(
        stableEntityId(prepared, 'chain-account', account.accountIndex, 'bitcoin')
      )
      chainAccounts.push(
        {
          id: evmChainAccountId,
          scope: { ...scope, chainId: parseChainId(result.evm.chainId).id },
          derivation: { scheme: 'bip44', path: result.evm.derivationPath },
          identity: { kind: 'account-identifier', value: result.evm.identity },
          createdAt: account.createdAt
        },
        {
          id: bitcoinChainAccountId,
          scope: { ...scope, chainId: parseChainId(result.bitcoin.chainId).id },
          derivation: {
            scheme: BITCOIN_ADDRESS_POLICY.defaultCreate.derivationScheme,
            path: result.bitcoin.derivationPath
          },
          identity: { kind: 'account-identifier', value: result.bitcoin.identity },
          createdAt: account.createdAt
        }
      )
      addresses.push(
        {
          id: addressId('evm'),
          chainAccountId: evmChainAccountId,
          value: result.evm.identity,
          scheme: 'evm',
          purpose: 'identity',
          derivation: { scheme: 'bip44', path: result.evm.derivationPath },
          rotatable: false,
          preferredForReceive: true,
          privacy: 'transparent',
          walletCompatibility: 'broad'
        },
        {
          id: addressId('bitcoin-receive-0'),
          chainAccountId: bitcoinChainAccountId,
          value: result.bitcoin.identity,
          scheme: BITCOIN_ADDRESS_POLICY.defaultCreate.addressScheme,
          purpose: 'receive',
          derivation: {
            scheme: BITCOIN_ADDRESS_POLICY.defaultCreate.derivationScheme,
            path: result.bitcoin.derivationPath
          },
          rotatable: true,
          preferredForReceive: true,
          privacy: 'transparent',
          walletCompatibility: 'broad'
        }
      )
    }
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

export class MixedRetainedV1MigrationCoordinator {
  private readonly credentialRepository: CredentialRepository
  private readonly storageRepository: StorageV2Repository
  private readonly compatibilityWorker: CompatibilityMigrationPort
  private readonly keystoneVerifier: KeystoneZcashVerificationPort
  private readonly now: () => number

  constructor(options: MixedRetainedV1MigrationCoordinatorOptions) {
    this.credentialRepository = options.credentialRepository
    this.storageRepository = options.storageRepository
    this.compatibilityWorker = options.compatibilityWorker ?? new CompatibilityWorkerHost()
    this.keystoneVerifier = options.keystoneVerifier
    this.now = options.now ?? Date.now
  }

  async migrate(input: MixedRetainedV1MigrationInput): Promise<MixedRetainedV1MigrationResult> {
    const wallets = assertMixedDiscovery(input.discovery)
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
          schema: 'mixed-retained-v1-migration-v1',
          discovery: input.discovery,
          envelopes,
          chains: input.chains
        })
      )
    )
    const generationId = parseStorageV2GenerationId(`storage-v2:mixed:${sourceFingerprint}`)
    const transactionId = parseCredentialTransactionId(`credential:mixed:${sourceFingerprint}`)
    let journal = await this.credentialRepository.getJournal(transactionId)
    const activePointer = await this.storageRepository.getActivePointer()
    if (activePointer && activePointer.generationId !== generationId) {
      throw new Error('Another Storage V2 generation is already active')
    }
    if (journal?.phase === 'failed') throw new Error('Mixed V1 migration is terminally failed')
    if (journal?.phase === 'complete') {
      if (activePointer?.generationId !== generationId) {
        throw new Error('Completed mixed migration does not own the active generation')
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
      const prepared: PreparedWallet[] = []
      for (const [index, wallet] of wallets.entries()) {
        const suffix = (await sha256(`${sourceFingerprint}:${wallet.id}`)).slice(0, 32)
        const base = {
          wallet,
          legacyEnvelope: envelopes[index].value,
          suffix,
          credentialGenerationId: parseCredentialGenerationId(
            `credential-generation:mixed:${suffix}`
          ),
          credentialSetRef: parseCredentialRef(`credential-set:mixed:${suffix}`)
        }
        if (wallet.keySource === 'software') {
          const result = await this.compatibilityWorker.migrate({
            operation: 'migrate',
            envelope: envelopes[index].value,
            password: input.password,
            ...input.chains,
            accounts: wallet.accounts.map(account => ({
              accountIndex: account.accountIndex,
              expectedZcash: account.addresses
            }))
          })
          if (result.operation !== 'migrate' || result.accounts.length !== wallet.accounts.length) {
            throw new Error('Compatibility Worker returned an incomplete Account set')
          }
          prepared.push(
            Object.freeze({
              ...base,
              kind: 'software' as const,
              result,
              zcashCredentialRef: parseEngineCredentialRef(`credential:mixed:${suffix}:zcash`),
              multichainCredentialRef: parseEngineCredentialRef(
                `credential:mixed:${suffix}:multichain`
              )
            })
          )
          continue
        }

        const account = wallet.accounts[0]
        const verification = await this.keystoneVerifier.verifyZcash({
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
        prepared.push(
          Object.freeze({
            ...base,
            kind: 'hardware' as const,
            verification,
            zcashCredentialRef: parseEngineCredentialRef(`credential:mixed:${suffix}:zcash`)
          })
        )
      }

      const createdAt = journal?.createdAt ?? this.now()
      const transitions: CredentialTransactionJournal['transitions'][number][] = prepared.map(
        item => ({
          kind: 'provision' as const,
          keyDomainId: parseKeyDomainId(item.wallet.id),
          targetCredentialGenerationId: item.credentialGenerationId,
          targetCredentialSetRef: item.credentialSetRef,
          stagedRefs: Object.freeze(
            item.kind === 'software'
              ? [
                  parseCredentialArtifactRef(item.zcashCredentialRef),
                  parseCredentialArtifactRef(item.multichainCredentialRef)
                ]
              : [parseCredentialArtifactRef(item.zcashCredentialRef)]
          )
        })
      )
      journal ??= Object.freeze({
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

      const stagedEnvelopes: EncryptedCredentialEnvelopeRecord[] = []
      const stagedSets: CredentialSetRecord[] = []
      for (const item of prepared) {
        const firstAccount = item.wallet.accounts[0]
        const zcashChainAccountId = parseChainAccountId(
          stableEntityId(item, 'chain-account', firstAccount.accountIndex, 'zcash')
        )
        const rawZcashEnvelope = {
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          aad: {
            schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
            engine: 'zcash' as const,
            keyDomainId: parseKeyDomainId(item.wallet.id),
            credentialGenerationId: item.credentialGenerationId,
            credentialRef: item.zcashCredentialRef,
            formatVersion: item.kind === 'software' ? 1 : 2
          },
          encryptedPayload: encodeV1EncryptedCredentialEnvelope(item.legacyEnvelope),
          createdAt
        }
        if (item.kind === 'software') {
          const evmChainAccountId = parseChainAccountId(
            stableEntityId(item, 'chain-account', firstAccount.accountIndex, 'evm')
          )
          const rawMultichainEnvelope = {
            schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
            transactionId,
            aad: {
              schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
              engine: 'multichain' as const,
              keyDomainId: parseKeyDomainId(item.wallet.id),
              credentialGenerationId: item.credentialGenerationId,
              credentialRef: item.multichainCredentialRef,
              formatVersion: 1
            },
            encryptedPayload: TEXT_ENCODER.encode(JSON.stringify(item.result.vault)),
            createdAt
          }
          const authenticated = await authenticateSoftwareCredentialEnvelopePair(
            { zcash: rawZcashEnvelope, multichain: rawMultichainEnvelope },
            input.password
          )
          stagedEnvelopes.push(authenticated.zcash, authenticated.multichain)
          stagedSets.push({
            schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
            transactionId,
            credentialSetRef: item.credentialSetRef,
            manifest: {
              schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
              credentialGenerationId: item.credentialGenerationId,
              keyDomainId: parseKeyDomainId(item.wallet.id),
              source: 'software',
              mnemonicWordCount: item.result.mnemonicWordCount,
              zcashSeedPolicy: 'direct-bip39-v1',
              engines: {
                zcash: {
                  credentialRef: item.zcashCredentialRef,
                  formatVersion: 1,
                  verificationAnchorRef: buildChainAccountVerificationAnchorRef(zcashChainAccountId)
                },
                multichain: {
                  credentialRef: item.multichainCredentialRef,
                  formatVersion: 1,
                  verificationAnchorRef: buildChainAccountVerificationAnchorRef(evmChainAccountId)
                }
              },
              createdAt,
              verifiedAt: createdAt
            }
          })
          continue
        }

        stagedEnvelopes.push(
          await authenticateHardwareCredentialEnvelope(rawZcashEnvelope, input.password)
        )
        stagedSets.push({
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
                verificationAnchorRef: buildChainAccountVerificationAnchorRef(zcashChainAccountId)
              }
            },
            createdAt,
            verifiedAt: createdAt
          }
        })
      }

      const stageStatus = await this.credentialRepository.stageTransaction(
        journal,
        stagedEnvelopes,
        stagedSets
      )
      if (stageStatus !== 'staged' && stageStatus !== 'already-staged') {
        throw new Error(`Mixed credential migration staging failed: ${stageStatus}`)
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
          'Mixed credential migration verification'
        )
        journal = verified
      }
    }

    if (!snapshot) throw new Error('Verified mixed Storage V2 snapshot is missing')
    if (journal.phase === 'verified') {
      const committing = nextJournal(journal, 'committing', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committing, journal.revision),
        'Mixed credential migration commit preparation'
      )
      journal = committing
    }
    if (journal.phase === 'committing') {
      const currentPointer = await this.storageRepository.getActivePointer()
      if (!currentPointer) {
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
        if (status !== 'committed') {
          throw new Error(`Mixed credential-bound Storage V2 commit failed: ${status}`)
        }
      } else if (currentPointer.generationId !== generationId) {
        throw new Error('Storage V2 active generation changed during mixed migration')
      }
      const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committed, journal.revision),
        'Mixed credential migration commit finalization'
      )
      journal = committed
    }
    if (journal.phase === 'committed-pending-cleanup') {
      const complete = nextJournal(journal, 'complete', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(complete, journal.revision),
        'Mixed credential migration completion'
      )
      journal = complete
    }
    if (journal.phase !== 'complete') {
      throw new Error(`Mixed credential migration stopped in phase: ${journal.phase}`)
    }
    return Object.freeze({
      status: 'committed',
      generationId,
      transactionId,
      migratedKeyDomainIds: Object.freeze(wallets.map(wallet => wallet.id))
    })
  }
}
