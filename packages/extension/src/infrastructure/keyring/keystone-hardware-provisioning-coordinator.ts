import { parseAccountId, parseAddressId, parseChainAccountId } from '@/core/accounts/domain'
import { bytesToHex } from '@/lib/bytes'
import { getBitcoinChainId, parseChainId } from '@/core/chains/registry'
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
  parseKeyDomainId,
  type HardwareCredentialMetadata
} from '@/core/keyring/domain'
import {
  parseKeystoneHardwareCredential,
  type KeystoneHardwareCredential
} from '@/core/wallet/hardware-wallet-data'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { getEvmNetworkConfig } from '@/config/networks'
import type { Network } from '@/types'
import {
  projectKeystoneBitcoinAccounts,
  projectKeystoneMultiCoinAccounts,
  type KeystoneBitcoinPublicAccount,
  type KeystoneMultiCoinPublicAccount
} from '@/lib/keystone'
import {
  authenticateHardwareCredentialEnvelope,
  unwrapHardwareCredentialEnvelope
} from '@/infrastructure/keyring/credential-envelope-authentication'
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
import {
  decodeV1EncryptedCredentialEnvelope,
  encodeV1EncryptedCredentialEnvelope
} from './migration/v1-credential-envelope'
import {
  hardwareCredentialMatchesMetadata,
  readHardwareCredentialEnvelope
} from './migration/hardware-credential-password-change'

export interface KeystoneHardwareProvisioningInput {
  readonly credential: KeystoneHardwareCredential
  readonly displayName: string
  readonly password: string
  readonly network: Network
  readonly evmChainIds?: readonly string[]
}

export interface KeystoneHardwareProvisioningResult {
  readonly status: 'committed' | 'already-committed'
  readonly generationId: string
  readonly transactionId: string
  readonly keyDomainId: string
  readonly accountIds: readonly string[]
}

export interface KeystoneHardwareProvisioningCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly now?: () => number
}

type SupportedPublicAccount = Extract<
  KeystoneMultiCoinPublicAccount,
  { readonly family: 'evm' | 'bitcoin' }
>

interface ProvisioningIdentity {
  readonly keyDomainId: ReturnType<typeof parseKeyDomainId>
  readonly suffix: string
  readonly credentialGenerationId: ReturnType<typeof parseCredentialGenerationId>
  readonly credentialSetRef: ReturnType<typeof parseCredentialRef>
  readonly engineCredentialRef: ReturnType<typeof parseEngineCredentialRef>
}

const TEXT_ENCODER = new TextEncoder()
const HARDWARE_FORMAT_VERSION = 2

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

function hardwareMetadata(credential: KeystoneHardwareCredential): HardwareCredentialMetadata {
  return Object.freeze({
    vendor: credential.vendor,
    firmwareProfile: credential.firmwareProfile,
    capabilities: credential.capabilities
  })
}

function credentialIdentityPayload(
  credential: KeystoneHardwareCredential,
  projected: readonly SupportedPublicAccount[]
): string {
  const anchor =
    projected.find(account => account.accountIndex === 0 && account.family === 'evm') ??
    projected.find(account => account.accountIndex === 0 && account.family === 'bitcoin')
  if (!anchor) throw new Error('Keystone Account 0 identity anchor is missing')
  const accountExport = credential.accountExport
  return JSON.stringify([
    'noir-keystone-public-root-v1',
    credential.firmwareProfile,
    accountExport.protocol,
    accountExport.protocol === 'zcash-accounts-v1'
      ? accountExport.seedFingerprintHex
      : accountExport.masterFingerprintHex,
    anchor.family,
    anchor.derivationPath,
    anchor.identity
  ])
}

function credentialVerificationPayload(credential: KeystoneHardwareCredential): string {
  const accountExport = credential.accountExport
  if (accountExport.protocol === 'crypto-multi-accounts-v1') {
    return JSON.stringify({
      schemaVersion: credential.schemaVersion,
      vendor: credential.vendor,
      firmwareProfile: credential.firmwareProfile,
      capabilities: credential.capabilities,
      accountExport: {
        protocol: accountExport.protocol,
        masterFingerprintHex: accountExport.masterFingerprintHex,
        keys: [...accountExport.keys].sort(
          (left, right) =>
            left.derivationPath.localeCompare(right.derivationPath) ||
            left.publicKeyHex.localeCompare(right.publicKeyHex)
        )
      }
    })
  }
  return JSON.stringify(credential)
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

function validatePassword(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    TEXT_ENCODER.encode(password).byteLength > 1024 * 1024
  ) {
    throw new Error('Invalid hardware Wallet password')
  }
}

function projectPublicAccounts(
  credential: KeystoneHardwareCredential,
  network: Network
): readonly SupportedPublicAccount[] {
  let projected: readonly (KeystoneMultiCoinPublicAccount | KeystoneBitcoinPublicAccount)[]
  if (credential.accountExport.protocol === 'crypto-multi-accounts-v1') {
    projected = projectKeystoneMultiCoinAccounts(
      {
        type: 'multi-accounts',
        masterFingerprintHex: credential.accountExport.masterFingerprintHex,
        keys: credential.accountExport.keys,
        ...(credential.accountExport.device === undefined
          ? {}
          : { device: credential.accountExport.device }),
        ...(credential.accountExport.deviceId === undefined
          ? {}
          : { deviceId: credential.accountExport.deviceId }),
        ...(credential.accountExport.version === undefined
          ? {}
          : { version: credential.accountExport.version })
      },
      network
    )
  } else if (credential.accountExport.protocol === 'crypto-account-v1') {
    projected = projectKeystoneBitcoinAccounts(
      {
        type: 'bitcoin-account',
        masterFingerprintHex: credential.accountExport.masterFingerprintHex,
        descriptors: credential.accountExport.descriptors
      },
      network
    )
  } else {
    throw new Error('Zcash Keystone Wallets require the verified Zcash provisioning flow')
  }

  const supported = projected.filter(
    (account): account is SupportedPublicAccount =>
      account.family === 'evm' || account.family === 'bitcoin'
  )
  if (supported.length === 0 || !supported.some(account => account.accountIndex === 0)) {
    throw new Error('Keystone export has no supported Account 0 for this build')
  }
  return Object.freeze(
    [...supported].sort(
      (left, right) =>
        left.accountIndex - right.accountIndex ||
        (left.family === right.family ? 0 : left.family === 'evm' ? -1 : 1)
    )
  )
}

function entityId(identity: ProvisioningIdentity, kind: string, scope: string): string {
  return `${kind}:keystone-v2:${identity.suffix}:${scope}`
}

function buildSnapshot(
  source: StorageV2Snapshot | null,
  identity: ProvisioningIdentity,
  credentialSetRef: ReturnType<typeof parseCredentialRef>,
  displayName: string,
  projected: readonly SupportedPublicAccount[],
  network: Network,
  evmChainIds: readonly string[],
  generationId: ReturnType<typeof parseStorageV2GenerationId>,
  sourceFingerprint: ReturnType<typeof parseStorageV2SourceFingerprint>,
  timestamp: number,
  metadata: HardwareCredentialMetadata
): StorageV2Snapshot {
  const accountIndexes = [...new Set(projected.map(account => account.accountIndex))].sort(
    (left, right) => left - right
  )
  const accounts = accountIndexes.map(accountIndex => ({
    id: parseAccountId(entityId(identity, 'account', String(accountIndex))),
    keyDomainId: identity.keyDomainId,
    accountIndex,
    displayName: `Account ${accountIndex + 1}`,
    createdAt: timestamp
  }))
  const accountIdByIndex = new Map(accounts.map(account => [account.accountIndex, account.id]))
  const bitcoinChainId = parseChainId(getBitcoinChainId(network)).id
  const chainAccounts: StorageV2Snapshot['chainAccounts'][number][] = []
  const addresses: StorageV2Snapshot['addresses'][number][] = []

  for (const projectedAccount of projected) {
    const accountId = accountIdByIndex.get(projectedAccount.accountIndex)
    if (!accountId) throw new Error('Projected Keystone Account is missing')
    const isBitcoin = projectedAccount.family === 'bitcoin'
    const targetChainIds = isBitcoin
      ? [bitcoinChainId]
      : evmChainIds.map(value => parseChainId(value).id)
    for (const [networkIndex, chainId] of targetChainIds.entries()) {
      const entityScope =
        networkIndex === 0
          ? `${projectedAccount.accountIndex}:${projectedAccount.family}`
          : `${projectedAccount.accountIndex}:${projectedAccount.family}:${chainId}`
      const chainAccountId = parseChainAccountId(entityId(identity, 'chain-account', entityScope))
      chainAccounts.push({
        id: chainAccountId,
        scope: {
          keyDomainId: identity.keyDomainId,
          accountId,
          chainId
        },
        derivation: {
          scheme: isBitcoin ? 'bip84' : 'bip44',
          path: projectedAccount.derivationPath
        },
        identity: { kind: 'account-identifier', value: projectedAccount.identity },
        createdAt: timestamp
      })
      addresses.push({
        id: parseAddressId(entityId(identity, 'address', entityScope)),
        chainAccountId,
        value: projectedAccount.identity,
        scheme: isBitcoin ? 'bitcoin-p2wpkh' : 'evm',
        purpose: isBitcoin ? 'receive' : 'identity',
        derivation: {
          scheme: isBitcoin ? 'bip84' : 'bip44',
          path: projectedAccount.derivationPath
        },
        rotatable: isBitcoin,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      })
    }
  }

  const initialAccountId = accountIdByIndex.get(0)
  if (!initialAccountId) throw new Error('Keystone Account 0 is missing')
  const keyDomain = {
    id: identity.keyDomainId,
    credentialRef: credentialSetRef,
    source: { kind: 'hardware' as const, ...metadata },
    displayName,
    createdAt: timestamp
  }
  const keyDomains = [...(source?.keyDomains ?? []), keyDomain]
  const allAccounts = [...(source?.accounts ?? []), ...accounts]
  const allChainAccounts = [...(source?.chainAccounts ?? []), ...chainAccounts]
  const allAddresses = [...(source?.addresses ?? []), ...addresses]
  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId: source?.manifest.mainKeyDomainId ?? identity.keyDomainId,
      activeAccount: {
        keyDomainId: identity.keyDomainId,
        accountId: initialAccountId
      },
      counts: {
        keyDomains: keyDomains.length,
        accounts: allAccounts.length,
        chainAccounts: allChainAccounts.length,
        addresses: allAddresses.length
      },
      createdAt: timestamp,
      verifiedAt: timestamp
    },
    keyDomains,
    accounts: allAccounts,
    chainAccounts: allChainAccounts,
    addresses: allAddresses
  })
}

export class KeystoneHardwareProvisioningCoordinator {
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: KeystoneHardwareProvisioningCoordinatorOptions) {
    this.now = options.now ?? Date.now
  }

  provision(input: KeystoneHardwareProvisioningInput): Promise<KeystoneHardwareProvisioningResult> {
    const result = this.queue.catch(() => {}).then(() => this.run(input))
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async run(
    input: KeystoneHardwareProvisioningInput
  ): Promise<KeystoneHardwareProvisioningResult> {
    validatePassword(input.password)
    const credential = parseKeystoneHardwareCredential(input.credential)
    const projected = projectPublicAccounts(credential, input.network)
    const defaultEvmChainId = parseChainId(getEvmNetworkConfig(input.network).chainId).id
    const normalizedEvmChainIds = [
      ...new Set((input.evmChainIds ?? [defaultEvmChainId]).map(value => parseChainId(value).id))
    ]
    if (
      normalizedEvmChainIds.length === 0 ||
      !normalizedEvmChainIds.includes(defaultEvmChainId) ||
      normalizedEvmChainIds.some(chainId => !chainId.startsWith('eip155:'))
    ) {
      throw new Error('Keystone provisioning requires the build EVM network catalog')
    }
    const evmChainIds = normalizedEvmChainIds
    const credentialHash = await sha256(credentialIdentityPayload(credential, projected))
    const suffix = credentialHash.slice(0, 32)
    const identity: ProvisioningIdentity = Object.freeze({
      suffix,
      keyDomainId: parseKeyDomainId(`wallet:keystone-v2:${credentialHash}`),
      credentialGenerationId: parseCredentialGenerationId(
        `credential-generation:keystone-v2:${credentialHash}`
      ),
      credentialSetRef: parseCredentialRef(`credential-set:keystone-v2:${credentialHash}`),
      engineCredentialRef: parseEngineCredentialRef(
        `credential:keystone-v2:${credentialHash}:multichain`
      )
    })
    const activePointer = await this.options.storageRepository.getActivePointer()
    const source = activePointer
      ? await this.options.storageRepository.getSnapshot(activePointer.generationId)
      : null
    if (activePointer && !source) throw new Error('Active Storage V2 generation is missing')
    if (
      source &&
      (source.manifest.status !== 'verified' ||
        source.manifest.sourceFingerprint !== activePointer?.sourceFingerprint)
    ) {
      throw new Error('Active Storage V2 generation does not match its pointer')
    }
    const existing = source?.keyDomains.find(item => item.id === identity.keyDomainId)
    if (source && existing) {
      if (existing.credentialRef !== identity.credentialSetRef) {
        throw new Error('Existing Keystone Wallet identity is inconsistent')
      }
      const existingSet = await this.options.credentialRepository.getCredentialSet(
        identity.credentialSetRef
      )
      if (!existingSet) throw new Error('Existing Keystone CredentialSet is missing')
      let existingJournal = await this.options.credentialRepository.getJournal(
        existingSet.transactionId
      )
      if (
        existingJournal?.phase === 'committing' &&
        existingJournal.targetMetadataGenerationId === source.manifest.generationId
      ) {
        const committed = nextJournal(existingJournal, 'committed-pending-cleanup', this.now())
        assertAdvanced(
          await this.options.credentialRepository.advanceJournal(
            committed,
            existingJournal.revision
          ),
          'Keystone provisioning commit recovery'
        )
        existingJournal = committed
      }
      if (existingJournal?.phase === 'committed-pending-cleanup') {
        const complete = nextJournal(existingJournal, 'complete', this.now())
        assertAdvanced(
          await this.options.credentialRepository.advanceJournal(
            complete,
            existingJournal.revision
          ),
          'Keystone provisioning cleanup recovery'
        )
      }
      await this.verifyCredential(
        identity,
        credential,
        input.network,
        input.password,
        existingSet.transactionId,
        true
      )
      return this.result('already-committed', source, identity, existingSet.transactionId)
    }

    const transactionFingerprint = await sha256(
      JSON.stringify({
        schema: 'keystone-hardware-provision-v1',
        sourceGenerationId: activePointer?.generationId ?? null,
        keyDomainId: identity.keyDomainId,
        displayName: input.displayName,
        network: input.network,
        evmChainIds
      })
    )
    const transactionId = parseCredentialTransactionId(
      `credential:keystone-v2:${transactionFingerprint}`
    )
    const sourceFingerprint = parseStorageV2SourceFingerprint(
      await sha256(`storage-v2:keystone-v2:${transactionFingerprint}`)
    )
    const generationId = parseStorageV2GenerationId(`storage-v2:keystone-v2:${sourceFingerprint}`)
    let journal = await this.options.credentialRepository.getJournal(transactionId)
    if (journal?.phase === 'failed') throw new Error('Keystone provisioning is terminally failed')
    const createdAt = journal?.createdAt ?? this.now()
    const metadata = hardwareMetadata(credential)
    const anchor = projected.find(account => account.accountIndex === 0)
    if (!anchor) throw new Error('Keystone verification anchor is missing')
    const anchorId = parseChainAccountId(entityId(identity, 'chain-account', `0:${anchor.family}`))

    if (!journal) {
      const legacyEnvelope = await SecureStorage.encrypt(JSON.stringify(credential), input.password)
      const envelope = await authenticateHardwareCredentialEnvelope(
        {
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          aad: {
            schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
            engine: 'multichain',
            keyDomainId: identity.keyDomainId,
            credentialGenerationId: identity.credentialGenerationId,
            credentialRef: identity.engineCredentialRef,
            formatVersion: HARDWARE_FORMAT_VERSION
          },
          encryptedPayload: encodeV1EncryptedCredentialEnvelope(legacyEnvelope),
          createdAt
        },
        input.password
      )
      const credentialSet = {
        schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
        transactionId,
        credentialSetRef: identity.credentialSetRef,
        manifest: {
          schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
          credentialGenerationId: identity.credentialGenerationId,
          keyDomainId: identity.keyDomainId,
          source: 'hardware' as const,
          hardware: metadata,
          engines: {
            multichain: {
              credentialRef: identity.engineCredentialRef,
              formatVersion: HARDWARE_FORMAT_VERSION,
              verificationAnchorRef: buildChainAccountVerificationAnchorRef(anchorId)
            }
          },
          createdAt,
          verifiedAt: createdAt
        }
      }
      journal = Object.freeze({
        schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
        transactionId,
        operation: 'create',
        targetMetadataGenerationId: generationId,
        transitions: Object.freeze([
          Object.freeze({
            kind: 'provision' as const,
            keyDomainId: identity.keyDomainId,
            targetCredentialGenerationId: identity.credentialGenerationId,
            targetCredentialSetRef: identity.credentialSetRef,
            stagedRefs: Object.freeze([parseCredentialArtifactRef(identity.engineCredentialRef)])
          })
        ]),
        phase: 'staging',
        revision: 0,
        createdAt,
        updatedAt: createdAt
      })
      const staged = await this.options.credentialRepository.stageTransaction(
        journal,
        [envelope],
        [credentialSet]
      )
      if (staged !== 'staged' && staged !== 'already-staged') {
        throw new Error(`Keystone credential staging failed: ${staged}`)
      }
    }

    let target = await this.options.storageRepository.getSnapshot(generationId)
    if (!target) {
      target = buildSnapshot(
        source,
        identity,
        identity.credentialSetRef,
        input.displayName,
        projected,
        input.network,
        evmChainIds,
        generationId,
        sourceFingerprint,
        createdAt,
        metadata
      )
      await this.options.storageRepository.stage(target)
    }
    await this.verifyCredential(
      identity,
      credential,
      input.network,
      input.password,
      transactionId,
      false
    )
    if (journal.phase === 'staging') {
      const verified = nextJournal(journal, 'verified', this.now())
      assertAdvanced(
        await this.options.credentialRepository.advanceJournal(verified, journal.revision),
        'Keystone provisioning verification'
      )
      journal = verified
    }
    if (journal.phase === 'verified') {
      const committing = nextJournal(journal, 'committing', this.now())
      assertAdvanced(
        await this.options.credentialRepository.advanceJournal(committing, journal.revision),
        'Keystone provisioning commit preparation'
      )
      journal = committing
    }
    if (journal.phase === 'committing') {
      const pointer = await this.options.storageRepository.getActivePointer()
      if (pointer?.generationId !== generationId) {
        if ((pointer?.generationId ?? null) !== (activePointer?.generationId ?? null)) {
          throw new Error('Storage V2 active generation changed during Keystone provisioning')
        }
        const status = await commitCredentialBoundStorageV2Pointer(
          this.options.storageRepository,
          this.options.credentialRepository,
          {
            schemaVersion: STORAGE_V2_SCHEMA_VERSION,
            generationId,
            sourceFingerprint,
            committedAt: Math.max(target.manifest.verifiedAt ?? 0, this.now())
          },
          activePointer?.generationId ?? null,
          transactionId
        )
        if (status !== 'committed') {
          throw new Error(`Keystone provisioning commit failed: ${status}`)
        }
      }
      const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
      assertAdvanced(
        await this.options.credentialRepository.advanceJournal(committed, journal.revision),
        'Keystone provisioning commit finalization'
      )
      journal = committed
    }
    if (journal.phase === 'committed-pending-cleanup') {
      const complete = nextJournal(journal, 'complete', this.now())
      assertAdvanced(
        await this.options.credentialRepository.advanceJournal(complete, journal.revision),
        'Keystone provisioning completion'
      )
    }
    return this.result('committed', target, identity, transactionId)
  }

  private async verifyCredential(
    identity: ProvisioningIdentity,
    expected: KeystoneHardwareCredential,
    network: Network,
    password: string,
    transactionId: ReturnType<typeof parseCredentialTransactionId>,
    requireActive: boolean
  ): Promise<void> {
    const activation = requireActive
      ? await this.options.credentialRepository.validateForActivation(
          identity.credentialSetRef,
          identity.keyDomainId
        )
      : null
    const record = requireActive
      ? activation?.status === 'active'
        ? activation.record
        : undefined
      : await this.options.credentialRepository.getCredentialSet(identity.credentialSetRef)
    if (!record) {
      throw new Error(
        requireActive
          ? `Keystone CredentialSet is not active: ${activation?.status ?? 'not-found'}`
          : 'Staged Keystone CredentialSet is missing'
      )
    }
    if (
      record.transactionId !== transactionId ||
      record.credentialSetRef !== identity.credentialSetRef ||
      record.manifest.keyDomainId !== identity.keyDomainId ||
      record.manifest.credentialGenerationId !== identity.credentialGenerationId ||
      record.manifest.source !== 'hardware' ||
      !hardwareCredentialMatchesMetadata(expected, record.manifest.hardware)
    ) {
      throw new Error('Keystone CredentialSet metadata mismatch')
    }
    const metadata = record.manifest.engines.multichain
    if (!metadata || metadata.credentialRef !== identity.engineCredentialRef) {
      throw new Error('Keystone Multichain credential is missing')
    }
    const envelope = await this.options.credentialRepository.getEnvelope(metadata.credentialRef)
    if (
      !envelope ||
      envelope.transactionId !== transactionId ||
      envelope.aad.engine !== 'multichain' ||
      envelope.aad.keyDomainId !== identity.keyDomainId ||
      envelope.aad.credentialGenerationId !== identity.credentialGenerationId ||
      envelope.aad.credentialRef !== identity.engineCredentialRef
    ) {
      throw new Error('Keystone credential envelope binding mismatch')
    }
    const legacy = decodeV1EncryptedCredentialEnvelope(
      await unwrapHardwareCredentialEnvelope(envelope, password)
    )
    const actual = await readHardwareCredentialEnvelope(legacy, password)
    if (actual.vendor !== 'keystone') {
      throw new Error('Keystone credential vendor mismatch')
    }
    const actualProjected = projectPublicAccounts(actual, network)
    if (
      (await sha256(credentialIdentityPayload(actual, actualProjected))) !==
        (await sha256(
          credentialIdentityPayload(expected, projectPublicAccounts(expected, network))
        )) ||
      credentialVerificationPayload(actual) !== credentialVerificationPayload(expected)
    ) {
      throw new Error('Keystone credential verification mismatch')
    }
  }

  private result(
    status: KeystoneHardwareProvisioningResult['status'],
    snapshot: StorageV2Snapshot,
    identity: ProvisioningIdentity,
    transactionId: ReturnType<typeof parseCredentialTransactionId>
  ): KeystoneHardwareProvisioningResult {
    const keyDomain = snapshot.keyDomains.find(item => item.id === identity.keyDomainId)
    if (!keyDomain) throw new Error('Provisioned Keystone KeyDomain is missing')
    const accountIds = snapshot.accounts
      .filter(account => account.keyDomainId === keyDomain.id)
      .map(account => account.id)
    return Object.freeze({
      status,
      generationId: snapshot.manifest.generationId,
      transactionId,
      keyDomainId: keyDomain.id,
      accountIds: Object.freeze(accountIds)
    })
  }
}
