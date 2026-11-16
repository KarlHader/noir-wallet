import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import {
  CredentialPasswordChangeCoordinator,
  KeystoneHardwareMigrationCoordinator,
  MixedRetainedV1MigrationCoordinator,
  reconcileActiveHardwareCredentials,
  RetainedV1HardwareInventoryCoordinator,
  RetainedV1MigrationCoordinator,
  RetainedV1ReconciliationCoordinator
} from '@/infrastructure/keyring/migration'
import {
  discoverV1Metadata,
  excludeNativeV2HardwareShadows
} from '@/infrastructure/persistence/migrations'
import {
  IndexedDbCredentialRepository,
  IndexedDbStorageV2Repository
} from '@/infrastructure/persistence/repositories'
import type { StorageV2Snapshot } from '@/ports/repositories'
import { parseAccountId } from '@/core/accounts/domain'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import { parseKeyDomainId, type CredentialSetManifest } from '@/core/keyring/domain'
import { ActiveAccountSelectionCoordinator } from '@/infrastructure/keyring/active-account-selection-coordinator'
import {
  KeystoneHardwareProvisioningCoordinator,
  type KeystoneHardwareProvisioningInput,
  type KeystoneHardwareProvisioningResult
} from '@/infrastructure/keyring/keystone-hardware-provisioning-coordinator'
import {
  LedgerHardwareProvisioningCoordinator,
  type LedgerHardwareProvisioningInput,
  type LedgerHardwareProvisioningResult
} from '@/infrastructure/keyring/ledger-hardware-provisioning-coordinator'
import { isNativeHardwareWalletId } from '@/core/wallet/native-hardware-identity'
import type { ActiveWalletSetMode } from '@/core/wallet/wallet-unlock-path'
import {
  PrivateKeyProvisioningCoordinator,
  type PrivateKeyPreviewInput,
  type PrivateKeyPreviewResult,
  type PrivateKeyProvisioningInput,
  type PrivateKeyProvisioningResult
} from '@/infrastructure/keyring/private-key-provisioning-coordinator'
import type { RetainedV1MigrationChainProfile } from '@/infrastructure/keyring/migration'
import { assertPasswordChangeCredentialInventorySupported } from '@/infrastructure/keyring/migration/credential-password-change-support'
import { decodeV1EncryptedCredentialEnvelope } from '@/infrastructure/keyring/migration/v1-credential-envelope'
import { parseRawEncryptedVault } from '@/infrastructure/keyring/multichain/raw-wallet-engine'
import type { CredentialSessionUnlockCredential } from '@/infrastructure/keyring/session'
import {
  credentialEnvelopePairFormat,
  unwrapPrivateKeyCredentialEnvelope,
  unwrapSoftwareCredentialEnvelopePair
} from '@/infrastructure/keyring/credential-envelope-authentication'
import { verifyActiveHardwareCredentialInventory } from '@/infrastructure/keyring/active-hardware-credential-inventory'
import type { EncryptedCredentialEnvelopeRecord } from '@/ports/repositories'
import { getEvmNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  getBitcoinChainId,
  getZcashChainId,
  parseChainId,
  type ChainDefinition
} from '@/core/chains/registry'
import {
  OffscreenCompatibilityWorkerPort,
  OffscreenKeystoneZcashVerificationPort
} from './offscreen-compatibility-worker'
import { EvmNetworkMetadataCoordinator } from '@/infrastructure/keyring/evm-network-metadata-coordinator'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import {
  resolveEvmNetworkCatalog,
  resolvePersistedEvmNetworkChainIds
} from '@/core/chains/evm-runtime-config'
import {
  SETTINGS_STORAGE_KEY,
  resolvePersistedNetworkChainEndpointSettings
} from '@/lib/wallet-settings-storage'
import { NetworkAccountMetadataCoordinator } from '@/infrastructure/keyring/network-account-metadata-coordinator'
import type { NetworkAccountMetadataInput } from '@/infrastructure/keyring/network-account-metadata-coordinator'
import type { KeyringCommandBinding, KeyringCommandPayload } from '@/core/keyring/ports'
import { BackgroundMultichainTransport } from '@/infrastructure/keyring/multichain/background-transport'
import { parseRawExportedPrivateKey } from '@/infrastructure/keyring/multichain/raw-wallet-engine'
import { isStoredAccountNetworkEnabled } from '@/lib/wallet-metadata-storage'

// This migration-only profile anchors identities; it does not enable chain runtime capabilities.
function getProvisioningChainProfile(): RetainedV1MigrationChainProfile {
  return Object.freeze({
    zcashNetwork: DEFAULT_NETWORK,
    zcashChainId: getZcashChainId(DEFAULT_NETWORK),
    evmChainId: getEvmNetworkConfig(DEFAULT_NETWORK).chainId,
    bitcoinChainId: getBitcoinChainId(DEFAULT_NETWORK)
  })
}

export type RetainedV1SynchronizationStatus =
  | 'migrated'
  | 'already-migrated'
  | 'synchronized'
  | 'already-synchronized'

export interface RetainedV1SynchronizationResult {
  readonly status: RetainedV1SynchronizationStatus
  readonly generationId?: string
}

interface ActiveMultichainCredentialRecord {
  readonly keyDomainId: string
  readonly manifest: Extract<CredentialSetManifest, { readonly source: 'software' | 'private-key' }>
  readonly zcashEnvelope?: EncryptedCredentialEnvelopeRecord
  readonly multichainEnvelope: EncryptedCredentialEnvelopeRecord
}

export interface ActiveCredentialSessionInventory {
  readonly softwareCredentials: readonly CredentialSessionUnlockCredential[]
  readonly hardwareCredentialCount: number
}

export interface ActiveCredentialSessionDescriptorInventory {
  readonly softwareCredentials: readonly Readonly<{
    keyDomainId: string
    credentialGenerationId: string
  }>[]
  readonly hardwareCredentialCount: number
}

export interface ExportWalletPrivateKeyInput {
  readonly keyDomainId: string
  readonly accountId: string
  readonly chainId: string
  readonly password: string
  readonly binding: Extract<KeyringCommandBinding, { readonly kind: 'credential' }>
  readonly bitcoinAddressType?: 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr'
}

function chainIdForAddressScheme(
  snapshot: StorageV2Snapshot,
  matches: (scheme: string) => boolean,
  label: string,
  preferredChainId?: string
): string {
  const chainIds = new Set<string>(
    snapshot.addresses
      .filter(address => matches(address.scheme))
      .map(
        address =>
          snapshot.chainAccounts.find(account => account.id === address.chainAccountId)?.scope
            .chainId
      )
      .filter((chainId): chainId is NonNullable<typeof chainId> => chainId !== undefined)
  )
  if (preferredChainId !== undefined && chainIds.has(preferredChainId)) return preferredChainId
  if (chainIds.size !== 1) throw new Error(`Storage V2 ${label} chain profile is ambiguous`)
  return [...chainIds][0]
}

function resolveChainProfile(snapshot: StorageV2Snapshot): RetainedV1MigrationChainProfile {
  const provisioning = getProvisioningChainProfile()
  const hasSoftwareWallet = snapshot.keyDomains.some(
    keyDomain => keyDomain.source.kind === 'software'
  )
  const resolve = (
    matches: (scheme: string) => boolean,
    label: string,
    fallback: string,
    preferredChainId?: string
  ): string => {
    try {
      return chainIdForAddressScheme(snapshot, matches, label, preferredChainId)
    } catch (error) {
      if (hasSoftwareWallet) throw error
      return fallback
    }
  }
  return Object.freeze({
    zcashNetwork: DEFAULT_NETWORK,
    zcashChainId: resolve(
      scheme => scheme.startsWith('zcash-'),
      'Zcash',
      provisioning.zcashChainId,
      provisioning.zcashChainId
    ),
    evmChainId: resolve(
      scheme => scheme === 'evm',
      'EVM',
      provisioning.evmChainId,
      provisioning.evmChainId
    ),
    bitcoinChainId: resolve(
      scheme => scheme.startsWith('bitcoin-'),
      'Bitcoin',
      provisioning.bitcoinChainId,
      provisioning.bitcoinChainId
    )
  })
}

export class CredentialLifecycleCoordinator {
  private readonly credentialRepository = new IndexedDbCredentialRepository()
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private readonly networkAccountMetadata = new NetworkAccountMetadataCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository
  })
  private readonly compatibilityWorker = new OffscreenCompatibilityWorkerPort()
  private readonly keystoneVerifier = new OffscreenKeystoneZcashVerificationPort()
  private readonly keystoneMigration = new KeystoneHardwareMigrationCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository,
    verifier: this.keystoneVerifier
  })
  private readonly mixedMigration = new MixedRetainedV1MigrationCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository,
    compatibilityWorker: this.compatibilityWorker,
    keystoneVerifier: this.keystoneVerifier
  })
  private readonly migration = new RetainedV1MigrationCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository,
    compatibilityWorker: this.compatibilityWorker
  })
  private readonly passwordChange = new CredentialPasswordChangeCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository,
    compatibilityWorker: this.compatibilityWorker
  })
  private readonly retainedV1Reconciliation = new RetainedV1ReconciliationCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository,
    compatibilityWorker: this.compatibilityWorker
  })
  private readonly retainedV1HardwareInventory = new RetainedV1HardwareInventoryCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository,
    verifier: this.keystoneVerifier
  })
  private readonly activeAccountSelection = new ActiveAccountSelectionCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository
  })
  private readonly evmNetworkMetadata = new EvmNetworkMetadataCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository
  })
  private readonly hardwareProvisioning = new KeystoneHardwareProvisioningCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository
  })
  private readonly ledgerProvisioning = new LedgerHardwareProvisioningCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository
  })
  private readonly privateKeyProvisioning = new PrivateKeyProvisioningCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository
  })
  private synchronizationQueue: Promise<void> = Promise.resolve()

  synchronizeRetainedV1(password: string): Promise<RetainedV1SynchronizationResult> {
    const operation = this.synchronizationQueue.then(async () => {
      const result = await this.runRetainedV1Synchronization(password)
      const upgradedGenerationId = await this.upgradeLegacyCredentialAuthentication(password)
      const evmMetadata = await this.evmNetworkMetadata.synchronize(
        await this.readPersistedEvmNetworkChainIds()
      )
      const generationId = evmMetadata.generationId ?? upgradedGenerationId ?? result.generationId
      return upgradedGenerationId !== null
        ? Object.freeze({
            status: 'synchronized' as const,
            ...(generationId === undefined ? {} : { generationId })
          })
        : Object.freeze({
            status: result.status,
            ...(generationId === undefined ? {} : { generationId })
          })
    })
    this.synchronizationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  async resumeActiveRetainedWalletForRecovery(
    password: string,
    keyDomainId: string
  ): Promise<RetainedV1SynchronizationResult> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) throw new Error('Wallet recovery requires an active credential generation')
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (
      !snapshot ||
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Wallet storage does not match its pointer')
    }
    const keyDomain = snapshot.keyDomains.find(candidate => candidate.id === keyDomainId)
    if (!keyDomain || keyDomain.source.kind === 'private-key') {
      throw new Error('Recovered Wallet has no active credential binding')
    }
    const inventory = await this.getActiveCredentialSessionInventory(password)
    if (
      keyDomain.source.kind === 'software' &&
      !inventory.softwareCredentials.some(item => item.keyDomainId === keyDomainId)
    ) {
      throw new Error('Recovered Wallet credential is unavailable')
    }
    return Object.freeze({ status: 'already-migrated', generationId: pointer.generationId })
  }

  synchronizeEvmNetworkMetadata(settings: ChainEndpointSettings) {
    const operation = this.synchronizationQueue
      .catch(() => {})
      .then(() =>
        this.evmNetworkMetadata.synchronize(
          resolveEvmNetworkCatalog(DEFAULT_NETWORK, settings).map(network => network.chainId)
        )
      )
    this.synchronizationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  synchronizeNetworkAccountMetadata(values: readonly NetworkAccountMetadataInput[]) {
    const operation = this.synchronizationQueue
      .catch(() => {})
      .then(() => this.networkAccountMetadata.synchronize(values))
    this.synchronizationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  selectActiveAccount(keyDomainId: string, accountId: string) {
    const operation = this.synchronizationQueue.then(() =>
      this.activeAccountSelection.select({
        keyDomainId: parseKeyDomainId(keyDomainId),
        accountId: parseAccountId(accountId)
      })
    )
    this.synchronizationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  async assertActiveAccountSupportsChain(
    keyDomainId: string,
    accountId: string,
    family: ChainDefinition['family']
  ): Promise<void> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) throw new Error('Active Wallet storage is unavailable')
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (
      !snapshot ||
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Wallet storage does not match its pointer')
    }
    const active = snapshot.manifest.activeAccount
    if (active?.keyDomainId !== keyDomainId || active.accountId !== accountId) {
      throw new Error('Active account changed. Review this action again.')
    }
    const keyDomain = resolveKeyDomain(snapshot.keyDomains, active.keyDomainId)
    if (!keySourceSupportsChainFamily(keyDomain.source, family)) {
      throw new Error(`The active Wallet does not support ${family}`)
    }
    if (keyDomain.source.kind === 'software') {
      if (!(await isStoredAccountNetworkEnabled(keyDomainId, accountId, DEFAULT_NETWORK, family))) {
        throw new Error(`The active Wallet has not enabled ${family}`)
      }
    }
  }

  async activeAccountSupportsChain(family: ChainDefinition['family']): Promise<boolean | null> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return null
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (
      !snapshot ||
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Wallet storage does not match its pointer')
    }
    const active = snapshot.manifest.activeAccount
    if (!active) throw new Error('Active Wallet has no selected Account')
    const keyDomain = resolveKeyDomain(snapshot.keyDomains, active.keyDomainId)
    if (!keySourceSupportsChainFamily(keyDomain.source, family)) return false
    if (keyDomain.source.kind !== 'software') return true
    return isStoredAccountNetworkEnabled(
      active.keyDomainId,
      active.accountId,
      DEFAULT_NETWORK,
      family
    )
  }

  provisionKeystoneHardware(
    input: KeystoneHardwareProvisioningInput
  ): Promise<KeystoneHardwareProvisioningResult> {
    const operation = this.synchronizationQueue.then(async () =>
      this.hardwareProvisioning.provision({
        ...input,
        evmChainIds: await this.readPersistedEvmNetworkChainIds()
      })
    )
    this.synchronizationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  provisionPrivateKey(input: PrivateKeyProvisioningInput): Promise<PrivateKeyProvisioningResult> {
    const operation = this.synchronizationQueue.then(async () =>
      this.privateKeyProvisioning.provision({
        ...input,
        evmChainIds: await this.readPersistedEvmNetworkChainIds()
      })
    )
    this.synchronizationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  provisionLedgerHardware(
    input: LedgerHardwareProvisioningInput
  ): Promise<LedgerHardwareProvisioningResult> {
    const operation = this.synchronizationQueue.then(async () =>
      this.ledgerProvisioning.provision({
        ...input,
        evmChainIds: await this.readPersistedEvmNetworkChainIds()
      })
    )
    this.synchronizationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  previewPrivateKey(input: PrivateKeyPreviewInput): Promise<PrivateKeyPreviewResult> {
    const operation = this.synchronizationQueue.then(async () =>
      this.privateKeyProvisioning.preview({
        ...input,
        evmChainIds: await this.readCurrentEvmNetworkChainIds()
      })
    )
    this.synchronizationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  async hasActiveWalletSet(): Promise<boolean> {
    return (await this.getActiveWalletSetMode()) !== 'inactive'
  }

  async getActiveWalletSetMode(): Promise<ActiveWalletSetMode> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return 'inactive'
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    if (snapshot.keyDomains.length === 0) return 'inactive'
    if (
      snapshot.keyDomains.every(
        keyDomain => keyDomain.source.kind === 'hardware' && isNativeHardwareWalletId(keyDomain.id)
      )
    ) {
      return 'native-v2-hardware-only'
    }
    if (
      snapshot.keyDomains.every(
        keyDomain =>
          keyDomain.source.kind === 'private-key' &&
          keyDomain.id.startsWith('wallet:private-key-v2:')
      )
    ) {
      return 'native-v2-private-key-only'
    }
    if (
      snapshot.keyDomains.every(
        keyDomain =>
          (keyDomain.source.kind === 'hardware' && isNativeHardwareWalletId(keyDomain.id)) ||
          (keyDomain.source.kind === 'private-key' &&
            keyDomain.id.startsWith('wallet:private-key-v2:'))
      )
    ) {
      return 'native-v2-mixed'
    }
    return 'retained-v1-backed'
  }

  private async runRetainedV1Synchronization(
    password: string
  ): Promise<RetainedV1SynchronizationResult> {
    const local = await chrome.storage.local.get(null)
    let discovery = discoverV1Metadata(local)
    const pointer = await this.storageRepository.getActivePointer()
    if (pointer && discovery.status === 'ready') {
      const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
      if (!snapshot) throw new Error('Active Storage V2 generation is missing')
      discovery = excludeNativeV2HardwareShadows(discovery, snapshot)
    }
    if (discovery.status === 'empty' && pointer) {
      const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
      if (!snapshot) throw new Error('Active Storage V2 generation is missing')
      if (
        snapshot.keyDomains.length === 0 ||
        snapshot.keyDomains.some(
          keyDomain =>
            !(
              (keyDomain.source.kind === 'hardware' && isNativeHardwareWalletId(keyDomain.id)) ||
              (keyDomain.source.kind === 'private-key' &&
                keyDomain.id.startsWith('wallet:private-key-v2:'))
            )
        )
      ) {
        throw new Error('V1 credential metadata is missing for an active Wallet')
      }
      return Object.freeze({
        status: 'already-migrated' as const,
        generationId: pointer.generationId
      })
    }
    if (discovery.status !== 'ready' || discovery.wallets.length === 0) {
      throw new Error(`V1 credential metadata is not ready: ${discovery.status}`)
    }
    const hardwareWallets = discovery.wallets.filter(wallet => wallet.keySource !== 'software')
    if (hardwareWallets.length > 0 && hardwareWallets.length !== discovery.wallets.length) {
      if (pointer) {
        const source = await this.storageRepository.getSnapshot(pointer.generationId)
        if (!source) throw new Error('Active Storage V2 generation is missing')
        const hardwareInventory = await this.retainedV1HardwareInventory.synchronize({
          discovery,
          credentialEnvelopes: local,
          password,
          chains: resolveChainProfile(source)
        })
        const activePointer = await this.storageRepository.getActivePointer()
        if (!activePointer) throw new Error('Storage V2 became inactive during synchronization')
        const snapshot = await this.storageRepository.getSnapshot(activePointer.generationId)
        if (!snapshot) throw new Error('Active Storage V2 generation is missing')
        const result = await this.retainedV1Reconciliation.synchronize({
          discovery,
          credentialEnvelopes: local,
          password,
          chains: resolveChainProfile(snapshot)
        })
        return Object.freeze({
          status:
            hardwareInventory.status === 'synchronized' || result.status === 'synchronized'
              ? 'synchronized'
              : 'already-synchronized',
          generationId: result.generationId
        })
      }
      const result = await this.mixedMigration.migrate({
        discovery,
        credentialEnvelopes: local,
        password,
        chains: getProvisioningChainProfile()
      })
      return Object.freeze({
        status: result.status === 'committed' ? 'migrated' : 'already-migrated',
        generationId: result.generationId
      })
    }
    if (hardwareWallets.length > 0) {
      if (pointer) {
        const source = await this.storageRepository.getSnapshot(pointer.generationId)
        if (!source) throw new Error('Active Storage V2 generation is missing')
        const hardwareInventory = await this.retainedV1HardwareInventory.synchronize({
          discovery,
          credentialEnvelopes: local,
          password,
          chains: resolveChainProfile(source)
        })
        const activePointer = await this.storageRepository.getActivePointer()
        if (!activePointer) throw new Error('Storage V2 became inactive during synchronization')
        const snapshot = await this.storageRepository.getSnapshot(activePointer.generationId)
        if (!snapshot) throw new Error('Active Storage V2 generation is missing')
        await reconcileActiveHardwareCredentials(
          this.credentialRepository,
          snapshot,
          discovery,
          local,
          password,
          { allowNativeV2Wallets: true }
        )
        return Object.freeze({
          status: hardwareInventory.status === 'synchronized' ? 'synchronized' : 'already-migrated',
          generationId: activePointer.generationId
        })
      }
      const result = await this.keystoneMigration.migrate({
        discovery,
        credentialEnvelopes: local,
        password,
        chains: getProvisioningChainProfile()
      })
      return Object.freeze({
        status: result.status === 'committed' ? 'migrated' : 'already-migrated',
        generationId: result.generationId
      })
    }
    if (!pointer) {
      const result = await this.migration.migrate({
        discovery,
        credentialEnvelopes: local,
        password,
        chains: getProvisioningChainProfile()
      })
      return Object.freeze({
        status: result.status === 'committed' ? 'migrated' : 'already-migrated',
        generationId: result.generationId
      })
    }

    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    const result = await this.retainedV1Reconciliation.synchronize({
      discovery,
      credentialEnvelopes: local,
      password,
      chains: resolveChainProfile(snapshot)
    })
    return Object.freeze({ status: result.status, generationId: result.generationId })
  }

  changePassword(
    currentPassword: string,
    newPassword: string,
    changeV1Only: () => Promise<void>
  ): Promise<'v1' | 'v2'> {
    const operation = this.synchronizationQueue.then(() =>
      this.runPasswordChange(currentPassword, newPassword, changeV1Only)
    )
    this.synchronizationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async runPasswordChange(
    currentPassword: string,
    newPassword: string,
    changeV1Only: () => Promise<void>
  ): Promise<'v1' | 'v2'> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) {
      await changeV1Only()
      return 'v1'
    }
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    const local = await chrome.storage.local.get(null)
    const discovery = discoverV1Metadata(local)
    assertPasswordChangeCredentialInventorySupported(discovery, snapshot)
    await this.passwordChange.changePassword({
      discovery,
      credentialEnvelopes: local,
      currentPassword,
      newPassword,
      chains: resolveChainProfile(snapshot)
    })
    return 'v2'
  }

  async passwordChangeFailureRequiresLock(): Promise<boolean> {
    const journal = await this.credentialRepository.findIncompleteJournal('change-password')
    return journal?.phase === 'committing' || journal?.phase === 'committed-pending-cleanup'
  }

  async getActiveSoftwareCredentialDescriptorInventory(): Promise<
    readonly Readonly<{ keyDomainId: string; credentialGenerationId: string }>[]
  > {
    const records = await this.loadActiveSoftwareCredentialRecords()
    return Object.freeze(
      records.map(record =>
        Object.freeze({
          keyDomainId: record.keyDomainId,
          credentialGenerationId: record.manifest.credentialGenerationId
        })
      )
    )
  }

  async getActiveCredentialSessionDescriptorInventory(): Promise<ActiveCredentialSessionDescriptorInventory> {
    const { snapshot, softwareRecords } = await this.loadActiveCredentialState()
    return Object.freeze({
      softwareCredentials: Object.freeze(
        softwareRecords.map(record =>
          Object.freeze({
            keyDomainId: record.keyDomainId,
            credentialGenerationId: record.manifest.credentialGenerationId
          })
        )
      ),
      hardwareCredentialCount:
        snapshot?.keyDomains.filter(keyDomain => keyDomain.source.kind === 'hardware').length ?? 0
    })
  }

  async getActiveCredentialSessionInventory(
    password: string
  ): Promise<ActiveCredentialSessionInventory> {
    const { snapshot, softwareRecords } = await this.loadActiveCredentialState()
    const softwareCredentials = await this.readSoftwareCredentialInventory(
      softwareRecords,
      password
    )
    const hardwareCredentialCount = snapshot
      ? await verifyActiveHardwareCredentialInventory(this.credentialRepository, snapshot, password)
      : 0
    return Object.freeze({ softwareCredentials, hardwareCredentialCount })
  }

  async getActiveSoftwareCredentialInventory(
    password: string
  ): Promise<readonly CredentialSessionUnlockCredential[]> {
    const records = await this.loadActiveSoftwareCredentialRecords()
    return this.readSoftwareCredentialInventory(records, password)
  }

  async exportPrivateKey(input: ExportWalletPrivateKeyInput) {
    const { snapshot, softwareRecords } = await this.loadActiveCredentialState()
    if (!snapshot) throw new Error('Storage V2 is not active')
    const keyDomainId = parseKeyDomainId(input.keyDomainId)
    const accountId = parseAccountId(input.accountId)
    const chainId = parseChainId(input.chainId).id
    const keyDomain = snapshot.keyDomains.find(item => item.id === keyDomainId)
    const account = snapshot.accounts.find(
      item => item.id === accountId && item.keyDomainId === keyDomainId
    )
    const chainAccount = snapshot.chainAccounts.find(
      item =>
        item.scope.keyDomainId === keyDomainId &&
        item.scope.accountId === accountId &&
        item.scope.chainId === chainId
    )
    if (!keyDomain || keyDomain.source.kind === 'hardware' || !account || !chainAccount) {
      throw new Error('Private-key export is unavailable for this Account')
    }
    if (
      String(input.binding.keyDomainId) !== keyDomainId ||
      !softwareRecords.some(
        record =>
          record.keyDomainId === keyDomainId &&
          record.manifest.credentialGenerationId === String(input.binding.credentialGenerationId)
      )
    ) {
      throw new Error('Private-key export credential binding mismatch')
    }
    const record = softwareRecords.find(item => item.keyDomainId === keyDomainId)
    if (!record) throw new Error('Private-key export credential is missing')
    if (record.manifest.source === 'private-key') {
      const scope = record.manifest.privateKey
      if (
        (scope.chainFamily === 'eip155' && !chainId.startsWith('eip155:')) ||
        (scope.chainFamily === 'bip122' && chainId !== getBitcoinChainId(scope.bitcoinNetwork)) ||
        (scope.chainFamily === 'solana' && !chainId.startsWith('solana:')) ||
        (scope.chainFamily === 'near' && !chainId.startsWith('near:'))
      ) {
        throw new Error('Private-key export chain is outside the credential scope')
      }
    }
    let payload: Uint8Array
    if (record.manifest.source === 'software') {
      if (!record.zcashEnvelope) throw new Error('Software credential envelope is incomplete')
      payload = (
        await unwrapSoftwareCredentialEnvelopePair(
          {
            zcash: record.zcashEnvelope,
            multichain: record.multichainEnvelope
          },
          input.password
        )
      ).multichain
    } else {
      payload = await unwrapPrivateKeyCredentialEnvelope(record.multichainEnvelope, input.password)
    }
    let vault: unknown
    try {
      vault = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
    } catch {
      throw new Error('Invalid persisted Multichain credential envelope')
    }
    const parsedVault = parseRawEncryptedVault(vault)
    const commandClient = new MultichainCommandClient(new BackgroundMultichainTransport(), {
      defaultTimeoutMs: 120_000,
      maxTimeoutMs: 120_000
    })
    try {
      const commandPayload: KeyringCommandPayload = chainId.startsWith('eip155:')
        ? {
            vault: parsedVault,
            password: input.password,
            chainId,
            addressIndex: account.accountIndex
          }
        : chainId.startsWith('bip122:')
          ? {
              vault: parsedVault,
              password: input.password,
              chainId,
              addressType:
                input.bitcoinAddressType === 'p2sh-p2wpkh'
                  ? 'p2sh_p2wpkh'
                  : (input.bitcoinAddressType ?? 'p2wpkh'),
              accountIndex: account.accountIndex,
              change: false,
              addressIndex: 0
            }
          : chainId.startsWith('solana:') || chainId.startsWith('near:')
            ? {
                vault: parsedVault,
                password: input.password,
                chainId,
                accountIndex: account.accountIndex,
                addressIndex: 0
              }
            : (() => {
                throw new Error('Private-key export does not support this chain')
              })()
      return await commandClient.execute(
        {
          operation: 'credential.export-private-key',
          binding: input.binding,
          payload: commandPayload
        },
        parseRawExportedPrivateKey
      )
    } finally {
      payload.fill(0)
      await commandClient.destroy()
    }
  }

  private async readSoftwareCredentialInventory(
    records: readonly ActiveMultichainCredentialRecord[],
    password: string
  ): Promise<readonly CredentialSessionUnlockCredential[]> {
    const inventory: CredentialSessionUnlockCredential[] = []
    for (const record of records) {
      let zcashPayload: Uint8Array | undefined
      let multichainPayload: Uint8Array
      if (record.manifest.source === 'software') {
        if (
          !record.zcashEnvelope ||
          credentialEnvelopePairFormat({
            zcash: record.zcashEnvelope,
            multichain: record.multichainEnvelope
          }) !== 'authenticated'
        ) {
          throw new Error('Active credential envelope requires authentication upgrade')
        }
        const payloads = await unwrapSoftwareCredentialEnvelopePair(
          { zcash: record.zcashEnvelope, multichain: record.multichainEnvelope },
          password
        )
        zcashPayload = payloads.zcash
        multichainPayload = payloads.multichain
      } else {
        if (record.zcashEnvelope) {
          throw new Error('Private-key CredentialSet must not contain a Zcash envelope')
        }
        multichainPayload = await unwrapPrivateKeyCredentialEnvelope(
          record.multichainEnvelope,
          password
        )
      }
      let multichainVault: unknown
      try {
        multichainVault = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(multichainPayload)
        )
      } catch {
        throw new Error('Invalid persisted Multichain credential envelope')
      }
      inventory.push(
        Object.freeze({
          keyDomainId: record.keyDomainId,
          credentialGenerationId: record.manifest.credentialGenerationId,
          ...(zcashPayload === undefined
            ? {}
            : { zcashEnvelope: decodeV1EncryptedCredentialEnvelope(zcashPayload) }),
          multichainVault: parseRawEncryptedVault(multichainVault)
        })
      )
    }
    return Object.freeze(inventory)
  }

  private async loadActiveSoftwareCredentialRecords(): Promise<
    readonly ActiveMultichainCredentialRecord[]
  > {
    return (await this.loadActiveCredentialState()).softwareRecords
  }

  private async loadActiveCredentialState(): Promise<
    Readonly<{
      snapshot: StorageV2Snapshot | null
      softwareRecords: readonly ActiveMultichainCredentialRecord[]
    }>
  > {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return Object.freeze({ snapshot: null, softwareRecords: Object.freeze([]) })
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')

    const records: ActiveMultichainCredentialRecord[] = []
    for (const keyDomain of snapshot.keyDomains) {
      if (keyDomain.source.kind !== 'software' && keyDomain.source.kind !== 'private-key') continue
      const activation = await this.credentialRepository.validateForActivation(
        keyDomain.credentialRef,
        keyDomain.id
      )
      if (activation.status !== 'active' || !activation.record) {
        throw new Error(`CredentialSet is not active: ${activation.status}`)
      }
      const { manifest } = activation.record
      if (manifest.source !== keyDomain.source.kind || manifest.keyDomainId !== keyDomain.id) {
        throw new Error('Active Multichain CredentialSet binding mismatch')
      }
      const zcashMetadata = manifest.source === 'software' ? manifest.engines.zcash : undefined
      const [zcashEnvelope, multichainEnvelope] = await Promise.all([
        zcashMetadata
          ? this.credentialRepository.getEnvelope(zcashMetadata.credentialRef)
          : Promise.resolve(undefined),
        this.credentialRepository.getEnvelope(manifest.engines.multichain.credentialRef)
      ])
      if ((zcashMetadata && !zcashEnvelope) || !multichainEnvelope) {
        throw new Error('Active Multichain CredentialSet is missing an engine envelope')
      }
      if (
        (zcashEnvelope && zcashEnvelope.aad.keyDomainId !== keyDomain.id) ||
        multichainEnvelope.aad.keyDomainId !== keyDomain.id ||
        (zcashEnvelope &&
          zcashEnvelope.aad.credentialGenerationId !== manifest.credentialGenerationId) ||
        multichainEnvelope.aad.credentialGenerationId !== manifest.credentialGenerationId
      ) {
        throw new Error('Active credential envelope binding mismatch')
      }
      records.push(
        Object.freeze({
          keyDomainId: keyDomain.id,
          manifest,
          ...(zcashEnvelope == null ? {} : { zcashEnvelope }),
          multichainEnvelope
        })
      )
    }
    return Object.freeze({ snapshot, softwareRecords: Object.freeze(records) })
  }

  private async upgradeLegacyCredentialAuthentication(password: string): Promise<string | null> {
    const records = (await this.loadActiveSoftwareCredentialRecords()).filter(
      (
        record
      ): record is ActiveMultichainCredentialRecord & {
        readonly manifest: Extract<CredentialSetManifest, { readonly source: 'software' }>
        readonly zcashEnvelope: EncryptedCredentialEnvelopeRecord
      } => record.manifest.source === 'software' && record.zcashEnvelope !== undefined
    )
    if (
      records.length === 0 ||
      records.every(
        record =>
          credentialEnvelopePairFormat({
            zcash: record.zcashEnvelope,
            multichain: record.multichainEnvelope
          }) === 'authenticated'
      )
    ) {
      return null
    }

    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) throw new Error('Storage V2 is not active')
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    const local = await chrome.storage.local.get(null)
    const result = await this.passwordChange.changePassword({
      discovery: discoverV1Metadata(local),
      credentialEnvelopes: local,
      currentPassword: password,
      newPassword: password,
      chains: resolveChainProfile(snapshot)
    })
    return result.generationId
  }

  private async readPersistedEvmNetworkChainIds(): Promise<readonly string[]> {
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
    return resolvePersistedEvmNetworkChainIds(stored[SETTINGS_STORAGE_KEY])
  }

  private async readCurrentEvmNetworkChainIds(): Promise<readonly string[]> {
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
    return resolveEvmNetworkCatalog(
      DEFAULT_NETWORK,
      resolvePersistedNetworkChainEndpointSettings(stored[SETTINGS_STORAGE_KEY], DEFAULT_NETWORK)
    ).map(network => network.chainId)
  }
}

export const credentialLifecycle = new CredentialLifecycleCoordinator()
