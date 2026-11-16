import { Buffer } from 'buffer'
import { HDKey } from '@scure/bip32'
import { networks, payments } from 'bitcoinjs-lib'
import {
  parseAccountId,
  parseAccountIndex,
  parseAddressId,
  parseChainAccountId
} from '@/core/accounts/domain'
import { getBitcoinChainId, getZcashChainId, parseChainId } from '@/core/chains/registry'
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
  ledgerPublicAccountEquals,
  ledgerPublicAccountIdentity,
  parseLedgerMultichainHardwareCredential,
  type LedgerMultichainHardwareCredential,
  type LedgerPublicAccount
} from '@/core/wallet/ledger-hardware-credential'
import { SecureStorage } from '@/core/wallet/secure-storage'
import {
  getEvmNetworkConfig,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '@/config/networks'
import type { Network } from '@/types'
import type { AccountAddresses } from '@/types'
import { bytesToHex } from '@/lib/bytes'
import {
  authenticateHardwareCredentialEnvelope,
  unwrapHardwareCredentialEnvelope
} from './credential-envelope-authentication'
import { readActiveLedgerHardwareCredential } from './active-hardware-credential-inventory'
import {
  decodeV1EncryptedCredentialEnvelope,
  encodeV1EncryptedCredentialEnvelope
} from './migration/v1-credential-envelope'
import { readHardwareCredentialEnvelope } from './migration/hardware-credential-password-change'
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

export interface LedgerHardwareProvisioningInput {
  readonly credential: LedgerMultichainHardwareCredential
  readonly displayName: string
  readonly password: string
  readonly network: Network
  readonly evmChainIds?: readonly string[]
  readonly existingKeyDomainId?: string
  readonly anchorProof?: LedgerPublicAccount
  readonly zcashProjection?: Readonly<{
    accountId: string
    accountIndex: number
    addresses: AccountAddresses
  }>
}

export interface LedgerHardwareProvisioningResult {
  readonly status: 'committed' | 'already-committed'
  readonly generationId: string
  readonly transactionId: string
  readonly keyDomainId: string
  readonly accountIds: readonly string[]
}

export interface LedgerHardwareProvisioningCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly now?: () => number
}

type CredentialIdentity = Readonly<{
  keyDomainId: ReturnType<typeof parseKeyDomainId>
  suffix: string
  credentialGenerationId: ReturnType<typeof parseCredentialGenerationId>
  credentialSetRef: ReturnType<typeof parseCredentialRef>
  engineCredentialRef: ReturnType<typeof parseEngineCredentialRef>
}>

const encoder = new TextEncoder()
const HARDWARE_FORMAT_VERSION = 3

async function hash(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

function metadata(credential: LedgerMultichainHardwareCredential): HardwareCredentialMetadata {
  return { vendor: 'ledger', firmwareProfile: 'multi-app', capabilities: credential.capabilities }
}

function publicInventory(credential: LedgerMultichainHardwareCredential): string {
  return JSON.stringify(
    [...credential.accountExport.accounts].sort((a, b) =>
      ledgerPublicAccountIdentity(a).localeCompare(ledgerPublicAccountIdentity(b))
    )
  )
}

function nextJournal(
  journal: CredentialTransactionJournal,
  phase: CredentialTransactionPhase,
  now: number
): CredentialTransactionJournal {
  return {
    ...journal,
    phase,
    revision: journal.revision + 1,
    updatedAt: Math.max(now, journal.updatedAt)
  }
}

function advanced(status: string, label: string): void {
  if (status !== 'advanced' && status !== 'already-applied')
    throw new Error(`${label} failed: ${status}`)
}

function selectedAccounts(
  credential: LedgerMultichainHardwareCredential,
  network: Network
): readonly LedgerPublicAccount[] {
  return credential.accountExport.accounts.filter(
    account => !('network' in account) || account.network === network
  )
}

function chainIdsFor(
  account: LedgerPublicAccount,
  network: Network,
  evmChainIds: readonly string[]
): readonly string[] {
  if (account.family === 'zcash') return [getZcashChainId(network)]
  if (account.family === 'bitcoin') return [getBitcoinChainId(network)]
  if (account.family === 'solana')
    return [getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet').chainId]
  if (account.family === 'near') return [getNearNetworkConfig(network).chainId]
  return evmChainIds
}

function bitcoinIdentity(account: Extract<LedgerPublicAccount, { family: 'bitcoin' }>): string {
  const versions =
    account.network === 'testnet' ? { public: 0x043587cf, private: 0x04358394 } : undefined
  const pubkey = HDKey.fromExtendedKey(account.xpub, versions)
    .deriveChild(0)
    .deriveChild(0).publicKey
  if (!pubkey) throw new Error('Ledger Bitcoin xpub cannot derive receive address')
  const address = payments.p2wpkh({
    pubkey: Buffer.from(pubkey),
    network: account.network === 'testnet' ? networks.testnet : networks.bitcoin
  }).address
  if (address !== account.address)
    throw new Error('Ledger Bitcoin receive address does not match xpub')
  return address
}

function verifyPriorAccounts(
  prior: Awaited<ReturnType<typeof readActiveLedgerHardwareCredential>>,
  incoming: LedgerMultichainHardwareCredential,
  proof: LedgerPublicAccount | undefined,
  snapshot: StorageV2Snapshot,
  keyDomainId: string
): void {
  if (!proof) throw new Error('A fresh Ledger anchor export is required to extend this Wallet')
  const candidate = incoming.accountExport.accounts.find(
    account => ledgerPublicAccountIdentity(account) === ledgerPublicAccountIdentity(proof)
  )
  if (!candidate || !ledgerPublicAccountEquals(candidate, proof)) {
    throw new Error('Ledger anchor proof does not match the submitted account export')
  }
  if (prior.accountExport.protocol === 'ledger-accounts-v1') {
    for (const oldAccount of prior.accountExport.accounts) {
      const current = incoming.accountExport.accounts.find(
        account => ledgerPublicAccountIdentity(account) === ledgerPublicAccountIdentity(oldAccount)
      )
      if (!current || !ledgerPublicAccountEquals(current, oldAccount)) {
        throw new Error('Existing Ledger public accounts cannot be removed or changed')
      }
    }
    const oldAnchor = prior.accountExport.accounts.find(
      account => ledgerPublicAccountIdentity(account) === ledgerPublicAccountIdentity(proof)
    )
    if (!oldAnchor || !ledgerPublicAccountEquals(oldAnchor, proof)) {
      throw new Error('Ledger anchor does not match the active credential')
    }
  } else {
    const old = prior.accountExport
    if (
      proof.family !== 'zcash' ||
      proof.ufvk !== old.ufvk ||
      proof.accountHdIndex !== old.accountHdIndex
    ) {
      throw new Error('Ledger Zcash anchor does not match the active credential')
    }
    const account = snapshot.accounts.find(
      item => item.keyDomainId === keyDomainId && item.accountIndex === proof.accountIndex
    )
    if (!account) throw new Error('Retained Ledger Zcash account is missing')
  }
}

function buildSnapshot(
  source: StorageV2Snapshot | null,
  identity: CredentialIdentity,
  credential: LedgerMultichainHardwareCredential,
  displayName: string,
  network: Network,
  evmChainIds: readonly string[],
  zcashProjection: LedgerHardwareProvisioningInput['zcashProjection'],
  generationId: ReturnType<typeof parseStorageV2GenerationId>,
  sourceFingerprint: ReturnType<typeof parseStorageV2SourceFingerprint>,
  timestamp: number
): StorageV2Snapshot {
  const selected = selectedAccounts(credential, network)
  const sourceDomain = source?.keyDomains.find(item => item.id === identity.keyDomainId)
  const suffix = identity.suffix
  const accounts = [...(source?.accounts ?? [])]
  const chainAccounts = [...(source?.chainAccounts ?? [])]
  const addresses = [...(source?.addresses ?? [])]
  const indexes = [...new Set(selected.map(account => account.accountIndex))].sort((a, b) => a - b)
  for (const index of indexes) {
    if (
      !accounts.some(
        account => account.keyDomainId === identity.keyDomainId && account.accountIndex === index
      )
    ) {
      accounts.push({
        id: parseAccountId(`account:ledger-v3:${suffix}:${index}`),
        keyDomainId: identity.keyDomainId,
        accountIndex: parseAccountIndex(index),
        displayName: `Account ${index + 1}`,
        createdAt: timestamp
      })
    }
  }
  for (const account of selected) {
    const owner = accounts.find(
      item =>
        item.keyDomainId === identity.keyDomainId && item.accountIndex === account.accountIndex
    )
    if (!owner) throw new Error('Ledger account projection is missing')
    if (account.family === 'zcash') {
      if (
        !chainAccounts.some(
          item =>
            item.scope.accountId === owner.id && item.scope.chainId === getZcashChainId(network)
        )
      ) {
        if (
          !zcashProjection ||
          zcashProjection.accountId !== owner.id ||
          zcashProjection.accountIndex !== account.accountIndex ||
          !zcashProjection.addresses.fullUnified ||
          !zcashProjection.addresses.shielded ||
          !zcashProjection.addresses.transparent
        ) {
          throw new Error('Zcash Ledger account requires a verified wallet projection')
        }
        const tag = `${account.accountIndex}:zcash:${getZcashChainId(network)}`
        const chainAccountId = parseChainAccountId(`chain-account:ledger-v3:${suffix}:${tag}`)
        const derivation = { scheme: 'zip32-unified', path: account.derivationPath }
        chainAccounts.push({
          id: chainAccountId,
          scope: {
            keyDomainId: identity.keyDomainId,
            accountId: owner.id,
            chainId: parseChainId(getZcashChainId(network)).id
          },
          derivation,
          identity: { kind: 'account-identifier', value: zcashProjection.addresses.fullUnified },
          createdAt: timestamp
        })
        addresses.push(
          {
            id: parseAddressId(`address:ledger-v3:${suffix}:${tag}:identity`),
            chainAccountId,
            value: zcashProjection.addresses.fullUnified,
            scheme: 'zcash-full-unified',
            purpose: 'identity',
            derivation,
            rotatable: false,
            preferredForReceive: false,
            privacy: 'mixed',
            walletCompatibility: 'limited'
          },
          {
            id: parseAddressId(`address:ledger-v3:${suffix}:${tag}:shielded`),
            chainAccountId,
            value: zcashProjection.addresses.shielded,
            scheme: 'zcash-shielded-unified',
            purpose: 'receive',
            rotatable: true,
            preferredForReceive: true,
            privacy: 'shielded',
            walletCompatibility: 'limited'
          },
          {
            id: parseAddressId(`address:ledger-v3:${suffix}:${tag}:transparent`),
            chainAccountId,
            value: zcashProjection.addresses.transparent,
            scheme: 'zcash-transparent-p2pkh',
            purpose: 'receive',
            rotatable: false,
            preferredForReceive: false,
            privacy: 'transparent',
            walletCompatibility: 'broad'
          }
        )
      }
      continue
    }
    const address = account.family === 'bitcoin' ? bitcoinIdentity(account) : account.address
    const projectedPath =
      account.family === 'bitcoin' ? `${account.derivationPath}/0/0` : account.derivationPath
    for (const rawChainId of chainIdsFor(account, network, evmChainIds)) {
      const chainId = parseChainId(rawChainId).id
      const prior = chainAccounts.find(
        item => item.scope.accountId === owner.id && item.scope.chainId === chainId
      )
      if (prior) {
        if (
          prior.scope.keyDomainId !== identity.keyDomainId ||
          prior.identity.value !== address ||
          prior.derivation.path !== projectedPath
        ) {
          throw new Error('Existing Ledger chain account projection changed')
        }
        continue
      }
      const tag = `${account.accountIndex}:${account.family}:${chainId}`
      const chainAccountId = parseChainAccountId(`chain-account:ledger-v3:${suffix}:${tag}`)
      const scheme =
        account.family === 'bitcoin'
          ? 'bip84'
          : account.family === 'solana' || account.family === 'near'
            ? 'slip10'
            : 'bip44'
      chainAccounts.push({
        id: chainAccountId,
        scope: { keyDomainId: identity.keyDomainId, accountId: owner.id, chainId },
        derivation: { scheme, path: projectedPath },
        identity: { kind: 'account-identifier', value: address },
        createdAt: timestamp
      })
      addresses.push({
        id: parseAddressId(`address:ledger-v3:${suffix}:${tag}`),
        chainAccountId,
        value: address,
        scheme: account.family === 'bitcoin' ? 'bitcoin-p2wpkh' : account.family,
        purpose: account.family === 'evm' ? 'identity' : 'receive',
        derivation: { scheme, path: projectedPath },
        rotatable: account.family === 'bitcoin',
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      })
    }
  }
  const keyDomain = sourceDomain
    ? {
        ...sourceDomain,
        credentialRef: identity.credentialSetRef,
        source: { kind: 'hardware' as const, ...metadata(credential) }
      }
    : {
        id: identity.keyDomainId,
        credentialRef: identity.credentialSetRef,
        source: { kind: 'hardware' as const, ...metadata(credential) },
        displayName,
        createdAt: timestamp
      }
  const keyDomains = sourceDomain
    ? source!.keyDomains.map(item => (item.id === identity.keyDomainId ? keyDomain : item))
    : [...(source?.keyDomains ?? []), keyDomain]
  const activeAccount = source?.manifest.activeAccount ?? {
    keyDomainId: identity.keyDomainId,
    accountId: accounts.find(account => account.keyDomainId === identity.keyDomainId)?.id
  }
  if (!activeAccount.accountId) throw new Error('Ledger account projection is empty')
  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId: source?.manifest.mainKeyDomainId ?? identity.keyDomainId,
      activeAccount,
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

export class LedgerHardwareProvisioningCoordinator {
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: LedgerHardwareProvisioningCoordinatorOptions) {
    this.now = options.now ?? Date.now
  }

  provision(input: LedgerHardwareProvisioningInput): Promise<LedgerHardwareProvisioningResult> {
    const result = this.queue.catch(() => {}).then(() => this.run(input))
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async run(
    input: LedgerHardwareProvisioningInput
  ): Promise<LedgerHardwareProvisioningResult> {
    const credential = parseLedgerMultichainHardwareCredential(input.credential)
    if (
      typeof input.password !== 'string' ||
      !input.password ||
      encoder.encode(input.password).length > 1024 * 1024
    ) {
      throw new Error('Invalid Ledger Wallet password')
    }
    if (
      !input.displayName ||
      input.displayName.length > 128 ||
      input.displayName.trim() !== input.displayName
    ) {
      throw new Error('Invalid Ledger Wallet name')
    }
    const defaultEvm = parseChainId(getEvmNetworkConfig(input.network).chainId).id
    const evmChainIds = [
      ...new Set((input.evmChainIds ?? [defaultEvm]).map(value => parseChainId(value).id))
    ]
    if (!evmChainIds.includes(defaultEvm) || evmChainIds.some(id => !id.startsWith('eip155:'))) {
      throw new Error('Ledger provisioning requires the active EVM catalog')
    }
    const activePointer = await this.options.storageRepository.getActivePointer()
    const source = activePointer
      ? await this.options.storageRepository.getSnapshot(activePointer.generationId)
      : null
    if (
      activePointer &&
      (!source ||
        source.manifest.status !== 'verified' ||
        source.manifest.sourceFingerprint !== activePointer.sourceFingerprint)
    ) {
      throw new Error('Active Storage V2 generation is invalid')
    }
    const anchor = credential.accountExport.accounts[0]
    if (!anchor) throw new Error('Ledger public account export is empty')
    const rootHash = await hash(
      JSON.stringify([
        'noir-ledger-public-root-v3',
        anchor.family,
        anchor.derivationPath,
        'ufvk' in anchor ? anchor.ufvk : anchor.publicKey
      ])
    )
    const keyDomainId = input.existingKeyDomainId
      ? parseKeyDomainId(input.existingKeyDomainId)
      : parseKeyDomainId(`wallet:ledger-v3:${rootHash}`)
    const existing = source?.keyDomains.find(item => item.id === keyDomainId)
    if (
      input.existingKeyDomainId &&
      (!existing || existing.source.kind !== 'hardware' || existing.source.vendor !== 'ledger')
    ) {
      throw new Error('Existing Ledger Wallet was not found')
    }
    if (!input.existingKeyDomainId && existing && source) {
      const old = await readActiveLedgerHardwareCredential(
        this.options.credentialRepository,
        source,
        keyDomainId,
        input.password
      )
      if (old.schemaVersion !== 3 || publicInventory(old) !== publicInventory(credential)) {
        throw new Error('Ledger Wallet already exists; select it to add accounts')
      }
      const set = await this.options.credentialRepository.getCredentialSet(existing.credentialRef)
      if (!set) throw new Error('Active Ledger CredentialSet is missing')
      return this.result('already-committed', source, keyDomainId, set.transactionId)
    }
    if (existing && source) {
      const old = await readActiveLedgerHardwareCredential(
        this.options.credentialRepository,
        source,
        keyDomainId,
        input.password
      )
      verifyPriorAccounts(old, credential, input.anchorProof, source, keyDomainId)
      if (old.schemaVersion === 3 && publicInventory(old) === publicInventory(credential)) {
        const set = await this.options.credentialRepository.getCredentialSet(existing.credentialRef)
        if (!set) throw new Error('Active Ledger CredentialSet is missing')
        return this.result('already-committed', source, keyDomainId, set.transactionId)
      }
    }
    const suffix = keyDomainId.startsWith('wallet:ledger-v3:')
      ? keyDomainId.slice('wallet:ledger-v3:'.length, 'wallet:ledger-v3:'.length + 32)
      : (await hash(keyDomainId)).slice(0, 32)
    const revisionHash = await hash(
      JSON.stringify([
        'noir-ledger-credential-v3',
        activePointer?.generationId ?? null,
        keyDomainId,
        publicInventory(credential),
        input.network,
        evmChainIds,
        input.zcashProjection ?? null
      ])
    )
    const identity: CredentialIdentity = {
      keyDomainId,
      suffix,
      credentialGenerationId: parseCredentialGenerationId(
        `credential-generation:ledger-v3:${revisionHash}`
      ),
      credentialSetRef: parseCredentialRef(`credential-set:ledger-v3:${revisionHash}`),
      engineCredentialRef: parseEngineCredentialRef(
        `credential:ledger-v3:${revisionHash}:multichain`
      )
    }
    const transactionId = parseCredentialTransactionId(`credential:ledger-v3:${revisionHash}`)
    const sourceFingerprint = parseStorageV2SourceFingerprint(
      await hash(`storage-v2:ledger-v3:${revisionHash}`)
    )
    const generationId = parseStorageV2GenerationId(`storage-v2:ledger-v3:${sourceFingerprint}`)
    let journal = await this.options.credentialRepository.getJournal(transactionId)
    if (journal?.phase === 'failed') throw new Error('Ledger provisioning transaction has failed')
    const createdAt = journal?.createdAt ?? this.now()
    let target = await this.options.storageRepository.getSnapshot(generationId)
    if (!target) {
      target = buildSnapshot(
        source,
        identity,
        credential,
        input.displayName,
        input.network,
        evmChainIds,
        input.zcashProjection,
        generationId,
        sourceFingerprint,
        createdAt
      )
    }
    const anchorChain = target.chainAccounts.find(item => item.scope.keyDomainId === keyDomainId)
    if (!anchorChain) throw new Error('Ledger chain account verification anchor is missing')
    if (!journal) {
      const encrypted = await SecureStorage.encrypt(JSON.stringify(credential), input.password)
      const envelope = await authenticateHardwareCredentialEnvelope(
        {
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          aad: {
            schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
            engine: 'multichain',
            keyDomainId,
            credentialGenerationId: identity.credentialGenerationId,
            credentialRef: identity.engineCredentialRef,
            formatVersion: HARDWARE_FORMAT_VERSION
          },
          encryptedPayload: encodeV1EncryptedCredentialEnvelope(encrypted),
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
          keyDomainId,
          source: 'hardware' as const,
          hardware: metadata(credential),
          engines: {
            multichain: {
              credentialRef: identity.engineCredentialRef,
              formatVersion: HARDWARE_FORMAT_VERSION,
              verificationAnchorRef: buildChainAccountVerificationAnchorRef(anchorChain.id)
            }
          },
          createdAt,
          verifiedAt: createdAt
        }
      }
      const sourceSet = existing
        ? await this.options.credentialRepository.getCredentialSet(existing.credentialRef)
        : null
      if (existing && !sourceSet) throw new Error('Active Ledger CredentialSet is missing')
      journal = {
        schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
        transactionId,
        operation: existing ? 'migrate' : 'create',
        targetMetadataGenerationId: generationId,
        transitions: [
          existing && sourceSet
            ? {
                kind: 'replace' as const,
                keyDomainId,
                sourceCredentialGenerationId: sourceSet.manifest.credentialGenerationId,
                targetCredentialGenerationId: identity.credentialGenerationId,
                targetCredentialSetRef: identity.credentialSetRef,
                stagedRefs: [parseCredentialArtifactRef(identity.engineCredentialRef)],
                retiredRefs: [
                  parseCredentialArtifactRef(existing.credentialRef),
                  ...Object.values(sourceSet.manifest.engines)
                    .filter(item => item !== undefined)
                    .map(item => parseCredentialArtifactRef(item.credentialRef))
                ]
              }
            : {
                kind: 'provision' as const,
                keyDomainId,
                targetCredentialGenerationId: identity.credentialGenerationId,
                targetCredentialSetRef: identity.credentialSetRef,
                stagedRefs: [parseCredentialArtifactRef(identity.engineCredentialRef)]
              }
        ],
        phase: 'staging',
        revision: 0,
        createdAt,
        updatedAt: createdAt
      }
      const staged = await this.options.credentialRepository.stageTransaction(
        journal,
        [envelope],
        [credentialSet]
      )
      if (staged !== 'staged' && staged !== 'already-staged')
        throw new Error(`Ledger credential staging failed: ${staged}`)
    }
    if (!(await this.options.storageRepository.getSnapshot(generationId))) {
      await this.options.storageRepository.stage(target)
    }
    await this.verifyCredential(identity, credential, input.password, transactionId)
    if (journal.phase === 'staging') {
      const next = nextJournal(journal, 'verified', this.now())
      advanced(
        await this.options.credentialRepository.advanceJournal(next, journal.revision),
        'Ledger credential verification'
      )
      journal = next
    }
    if (journal.phase === 'verified') {
      const next = nextJournal(journal, 'committing', this.now())
      advanced(
        await this.options.credentialRepository.advanceJournal(next, journal.revision),
        'Ledger credential commit preparation'
      )
      journal = next
    }
    if (journal.phase === 'committing') {
      const pointer = await this.options.storageRepository.getActivePointer()
      if (pointer?.generationId !== generationId) {
        if ((pointer?.generationId ?? null) !== (activePointer?.generationId ?? null)) {
          throw new Error('Storage V2 generation changed during Ledger provisioning')
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
        if (status !== 'committed') throw new Error(`Ledger provisioning commit failed: ${status}`)
      }
      const next = nextJournal(journal, 'committed-pending-cleanup', this.now())
      advanced(
        await this.options.credentialRepository.advanceJournal(next, journal.revision),
        'Ledger commit finalization'
      )
      journal = next
    }
    if (journal.phase === 'committed-pending-cleanup') {
      for (const transition of journal.transitions) {
        if (transition.kind !== 'replace') continue
        const sourceSet = await this.options.credentialRepository.getCredentialSetByGeneration(
          transition.sourceCredentialGenerationId
        )
        if (!sourceSet) throw new Error('Retired Ledger CredentialSet is missing')
        const retirement = await this.options.credentialRepository.retire({
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          credentialSetRef: sourceSet.credentialSetRef,
          credentialGenerationId: sourceSet.manifest.credentialGenerationId,
          keyDomainId: sourceSet.manifest.keyDomainId,
          reason: 'superseded',
          replacementCredentialSetRef: transition.targetCredentialSetRef,
          transactionId: journal.transactionId,
          retiredAt: Math.max(journal.updatedAt, this.now())
        })
        if (retirement !== 'created' && retirement !== 'already-exists') {
          throw new Error(`Ledger credential retirement failed: ${retirement}`)
        }
        const purged = await this.options.credentialRepository.purgeRetiredEnvelopes(
          sourceSet.credentialSetRef,
          journal.transactionId
        )
        if (purged !== 'purged' && purged !== 'already-purged') {
          throw new Error(`Ledger credential cleanup failed: ${purged}`)
        }
      }
      const next = nextJournal(journal, 'complete', this.now())
      advanced(
        await this.options.credentialRepository.advanceJournal(next, journal.revision),
        'Ledger cleanup'
      )
    }
    return this.result('committed', target, keyDomainId, transactionId)
  }

  private async verifyCredential(
    identity: CredentialIdentity,
    expected: LedgerMultichainHardwareCredential,
    password: string,
    transactionId: ReturnType<typeof parseCredentialTransactionId>
  ): Promise<void> {
    const set = await this.options.credentialRepository.getCredentialSet(identity.credentialSetRef)
    if (
      !set ||
      set.transactionId !== transactionId ||
      set.manifest.keyDomainId !== identity.keyDomainId ||
      set.manifest.source !== 'hardware' ||
      set.manifest.hardware?.vendor !== 'ledger' ||
      set.manifest.hardware.firmwareProfile !== 'multi-app' ||
      JSON.stringify(set.manifest.hardware.capabilities) !== JSON.stringify(expected.capabilities)
    ) {
      throw new Error('Staged Ledger CredentialSet does not match')
    }
    const envelope = await this.options.credentialRepository.getEnvelope(
      identity.engineCredentialRef
    )
    if (
      !envelope ||
      envelope.transactionId !== transactionId ||
      envelope.aad.keyDomainId !== identity.keyDomainId ||
      envelope.aad.credentialGenerationId !== identity.credentialGenerationId ||
      envelope.aad.credentialRef !== identity.engineCredentialRef
    ) {
      throw new Error('Staged Ledger credential envelope is missing')
    }
    const legacy = decodeV1EncryptedCredentialEnvelope(
      await unwrapHardwareCredentialEnvelope(envelope, password)
    )
    const actual = await readHardwareCredentialEnvelope(legacy, password)
    if (
      actual.vendor !== 'ledger' ||
      actual.schemaVersion !== 3 ||
      publicInventory(actual) !== publicInventory(expected)
    ) {
      throw new Error('Staged Ledger public account inventory changed')
    }
  }

  private result(
    status: LedgerHardwareProvisioningResult['status'],
    snapshot: StorageV2Snapshot,
    keyDomainId: string,
    transactionId: ReturnType<typeof parseCredentialTransactionId>
  ): LedgerHardwareProvisioningResult {
    const accountIds = snapshot.accounts
      .filter(account => account.keyDomainId === keyDomainId)
      .map(account => account.id)
    return {
      status,
      generationId: snapshot.manifest.generationId,
      transactionId,
      keyDomainId,
      accountIds
    }
  }
}
