import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import {
  parseCredentialGenerationId as parseSessionCredentialGenerationId,
  parseGlobalUnlockEpoch,
  parseSessionKeyDomainId,
  type KeyringCommandBinding,
  type KeyringCommandPayload
} from '@/core/keyring/ports'
import { bytesToHex } from '@/lib/bytes'
import { parseAccountId, parseAddressId, parseChainAccountId } from '@/core/accounts/domain'
import {
  parseSupportedBitcoinAddress,
  type BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'
import {
  nearImplicitAccountIdFromPublicKey,
  parseNearAccountId,
  parseNearPublicKey
} from '@/core/chains/near'
import { getBitcoinChainId, parseChainId } from '@/core/chains/registry'
import { parseSolanaPublicKey } from '@/core/chains/solana'
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
  type PrivateKeyCredentialScope
} from '@/core/keyring/domain'
import {
  getEvmNetworkConfig,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '@/config/networks'
import type { Network } from '@/types'
import { authenticatePrivateKeyCredentialEnvelope } from './credential-envelope-authentication'
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
  assertExactKeys,
  parseRawEncryptedVault,
  readHex,
  readLiteral,
  readRecord,
  readString,
  type RawEncryptedVault
} from './multichain/raw-wallet-engine'
import { BackgroundMultichainTransport } from './multichain/background-transport'

export interface PrivateKeyProvisioningInput {
  readonly privateKey: string
  readonly chainFamily: 'eip155' | 'bip122' | 'solana' | 'near'
  readonly displayName: string
  readonly password: string
  readonly network: Network
  readonly evmChainIds?: readonly string[]
}

export type PrivateKeyPreviewInput = Omit<PrivateKeyProvisioningInput, 'displayName'>

export interface PrivateKeyPreviewResult {
  readonly chainFamily: 'eip155' | 'bip122' | 'solana' | 'near'
  readonly addresses: readonly Readonly<{
    chainId: string
    address: string
    addressScheme: DerivedPublicAccount['addressScheme']
    preferredForReceive: boolean
  }>[]
}

export interface PrivateKeyProvisioningResult {
  readonly status: 'committed' | 'already-committed'
  readonly generationId: string
  readonly transactionId: string
  readonly keyDomainId: string
  readonly accountId: string
}

export interface PrivateKeyProvisioningCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly now?: () => number
  readonly createEpochId?: () => string
}

interface DerivedPublicAccount {
  readonly chainId: string
  readonly address: string
  readonly addressScheme:
    | 'evm'
    | 'bitcoin-p2pkh'
    | 'bitcoin-p2sh-p2wpkh'
    | 'bitcoin-p2wpkh'
    | 'bitcoin-p2tr'
    | 'solana'
    | 'near'
  readonly publicKey: string
  readonly masterFingerprint?: string
  readonly scriptPubKey?: string
  readonly redeemScript?: string
}

interface ProvisioningIdentity {
  readonly suffix: string
  readonly keyDomainId: ReturnType<typeof parseKeyDomainId>
  readonly credentialGenerationId: ReturnType<typeof parseCredentialGenerationId>
  readonly credentialSetRef: ReturnType<typeof parseCredentialRef>
  readonly engineCredentialRef: ReturnType<typeof parseEngineCredentialRef>
}

const PRIVATE_KEY_VAULT_FORMAT_VERSION = 2
const TEXT_ENCODER = new TextEncoder()
const BITCOIN_ADDRESS_TYPES = Object.freeze(['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'] as const)

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

function encodeVault(value: RawEncryptedVault): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(value))
}

function validateSecretInput(input: PrivateKeyPreviewInput): void {
  if (
    typeof input.privateKey !== 'string' ||
    input.privateKey.length === 0 ||
    input.privateKey.length > 512 ||
    typeof input.password !== 'string' ||
    input.password.length === 0 ||
    TEXT_ENCODER.encode(input.password).byteLength > 1024 * 1024
  ) {
    throw new Error('Invalid private-key Wallet input')
  }
}

function validateInput(input: PrivateKeyProvisioningInput): void {
  validateSecretInput(input)
  if (
    typeof input.displayName !== 'string' ||
    input.displayName.length === 0 ||
    input.displayName.length > 128 ||
    input.displayName.trim() !== input.displayName
  ) {
    throw new Error('Invalid private-key Wallet input')
  }
}

function privateKeyScopeMatches(
  candidate: {
    readonly chainFamily: PrivateKeyCredentialScope['chainFamily']
    readonly bitcoinNetwork?: Network
  },
  scope: PrivateKeyCredentialScope
): boolean {
  return (
    candidate.chainFamily === scope.chainFamily &&
    candidate.bitcoinNetwork === (scope.chainFamily === 'bip122' ? scope.bitcoinNetwork : undefined)
  )
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

function entityId(identity: ProvisioningIdentity, kind: string, scope: string): string {
  return `${kind}:private-key-v2:${identity.suffix}:${scope}`
}

function rawBitcoinAddressType(addressType: BitcoinSupportedAddressType) {
  return addressType === 'p2sh-p2wpkh' ? 'p2sh_p2wpkh' : addressType
}

function bitcoinAddressScheme(addressType: BitcoinSupportedAddressType) {
  switch (addressType) {
    case 'p2pkh':
      return 'bitcoin-p2pkh' as const
    case 'p2sh-p2wpkh':
      return 'bitcoin-p2sh-p2wpkh' as const
    case 'p2wpkh':
      return 'bitcoin-p2wpkh' as const
    case 'p2tr':
      return 'bitcoin-p2tr' as const
  }
}

function parseDerivedPublicAccount(
  value: unknown,
  chainId: string,
  addressType?: BitcoinSupportedAddressType
): DerivedPublicAccount {
  const record = readRecord(value, 'Imported private-key public account')
  assertExactKeys(
    record,
    ['chainId', 'derivation', 'identity', 'addresses', 'publicKey'],
    addressType === undefined ? [] : ['masterFingerprint', 'scriptPubKey', 'redeemScript'],
    'Imported private-key public account'
  )
  if (
    record.chainId !== chainId ||
    !Array.isArray(record.addresses) ||
    record.addresses.length !== 1
  ) {
    throw new Error('Imported private-key public account does not match its request')
  }
  const derivation = readRecord(record.derivation, 'Imported private-key derivation')
  const identity = readRecord(record.identity, 'Imported private-key identity')
  const address = readRecord(record.addresses[0], 'Imported private-key address')
  const addressDerivation = readRecord(
    address.derivation,
    'Imported private-key address derivation'
  )
  assertExactKeys(derivation, ['scheme', 'path'], [], 'Imported private-key derivation')
  assertExactKeys(identity, ['kind', 'value'], [], 'Imported private-key identity')
  assertExactKeys(
    address,
    ['value', 'scheme', 'purpose', 'derivation'],
    [],
    'Imported private-key address'
  )
  assertExactKeys(
    addressDerivation,
    ['scheme', 'path'],
    [],
    'Imported private-key address derivation'
  )
  readLiteral(identity.kind, ['account-identifier'], 'Imported private-key identity kind')
  readLiteral(derivation.scheme, ['imported'], 'Imported private-key derivation scheme')
  readLiteral(
    addressDerivation.scheme,
    ['imported'],
    'Imported private-key address derivation scheme'
  )
  if (derivation.path !== 'm' || addressDerivation.path !== 'm') {
    throw new Error('Imported private-key derivation path is invalid')
  }
  const addressValue = readString(address.value, 'Imported private-key address', 128)
  if (identity.value !== addressValue) {
    throw new Error('Imported private-key identity does not match its address')
  }
  const publicKey = readString(record.publicKey, 'Imported private-key public key', 128)
  if (addressType === undefined) {
    const addressScheme = chainId.startsWith('eip155:')
      ? ('evm' as const)
      : chainId.startsWith('solana:')
        ? ('solana' as const)
        : chainId.startsWith('near:')
          ? ('near' as const)
          : null
    if (addressScheme === null) throw new Error('Imported private-key chain is unsupported')
    if (address.scheme !== addressScheme || address.purpose !== 'identity') {
      throw new Error('Imported private-key account is invalid')
    }
    if (addressScheme === 'evm') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(addressValue) || !/^0x0[23][0-9a-f]{64}$/.test(publicKey)) {
        throw new Error('Imported EVM private-key account is invalid')
      }
    } else if (addressScheme === 'solana') {
      if (
        parseSolanaPublicKey(addressValue) !== parseSolanaPublicKey(publicKey) ||
        addressValue !== publicKey
      ) {
        throw new Error('Imported Solana private-key account is invalid')
      }
    } else {
      const nearAddress = parseNearAccountId(addressValue)
      const nearPublicKey = parseNearPublicKey(publicKey)
      if (nearAddress !== nearImplicitAccountIdFromPublicKey(nearPublicKey)) {
        throw new Error('Imported NEAR private-key account is invalid')
      }
    }
    return Object.freeze({ chainId, address: addressValue, addressScheme, publicKey })
  }
  readHex(publicKey, 'Imported Bitcoin private-key public key')
  const addressScheme = bitcoinAddressScheme(addressType)
  if (address.scheme !== addressScheme.replace(/-/g, '_') || address.purpose !== 'receive') {
    throw new Error('Imported Bitcoin private-key account is invalid')
  }
  parseSupportedBitcoinAddress(addressValue, parseChainId(chainId).id, addressType)
  return Object.freeze({
    chainId,
    address: addressValue,
    addressScheme,
    publicKey,
    masterFingerprint: readHex(record.masterFingerprint, 'Imported Bitcoin fingerprint', {
      bytes: 4
    }),
    scriptPubKey: readHex(record.scriptPubKey, 'Imported Bitcoin scriptPubKey'),
    ...(record.redeemScript === undefined
      ? {}
      : { redeemScript: readHex(record.redeemScript, 'Imported Bitcoin redeemScript') })
  })
}

function buildSnapshot(
  source: StorageV2Snapshot | null,
  identity: ProvisioningIdentity,
  scope: PrivateKeyCredentialScope,
  displayName: string,
  derived: readonly DerivedPublicAccount[],
  generationId: ReturnType<typeof parseStorageV2GenerationId>,
  sourceFingerprint: ReturnType<typeof parseStorageV2SourceFingerprint>,
  timestamp: number
): StorageV2Snapshot {
  const accountId = parseAccountId(entityId(identity, 'account', '0'))
  const account = {
    id: accountId,
    keyDomainId: identity.keyDomainId,
    accountIndex: 0,
    displayName: 'Account 1',
    createdAt: timestamp
  }
  const byChain = new Map<string, DerivedPublicAccount[]>()
  for (const item of derived) {
    const values = byChain.get(item.chainId) ?? []
    values.push(item)
    byChain.set(item.chainId, values)
  }
  const chainAccounts: StorageV2Snapshot['chainAccounts'][number][] = []
  const addresses: StorageV2Snapshot['addresses'][number][] = []
  for (const [chainId, items] of byChain) {
    const preferred = items.find(item => item.addressScheme === 'bitcoin-p2wpkh') ?? items[0]
    if (!preferred) throw new Error('Imported private-key chain has no public account')
    const chainAccountId = parseChainAccountId(entityId(identity, 'chain-account', chainId))
    chainAccounts.push({
      id: chainAccountId,
      scope: { keyDomainId: identity.keyDomainId, accountId, chainId: parseChainId(chainId).id },
      derivation: { scheme: 'imported', path: 'm' },
      identity: { kind: 'account-identifier', value: preferred.address },
      createdAt: timestamp
    })
    addresses.push(
      ...items.map(item => ({
        id: parseAddressId(entityId(identity, 'address', `${chainId}:${item.addressScheme}`)),
        chainAccountId,
        value: item.address,
        scheme: item.addressScheme,
        purpose:
          item.addressScheme === 'evm' ||
          item.addressScheme === 'solana' ||
          item.addressScheme === 'near'
            ? ('identity' as const)
            : ('receive' as const),
        derivation: { scheme: 'imported', path: 'm' },
        rotatable: false,
        preferredForReceive: item === preferred,
        privacy: 'transparent' as const,
        walletCompatibility: 'broad' as const
      }))
    )
  }
  const keyDomain = {
    id: identity.keyDomainId,
    credentialRef: identity.credentialSetRef,
    source: { kind: 'private-key' as const, ...scope },
    displayName,
    createdAt: timestamp
  }
  const keyDomains = [...(source?.keyDomains ?? []), keyDomain]
  const accounts = [...(source?.accounts ?? []), account]
  const allChainAccounts = [...(source?.chainAccounts ?? []), ...chainAccounts]
  const allAddresses = [...(source?.addresses ?? []), ...addresses]
  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId: source?.manifest.mainKeyDomainId ?? identity.keyDomainId,
      activeAccount: { keyDomainId: identity.keyDomainId, accountId },
      counts: {
        keyDomains: keyDomains.length,
        accounts: accounts.length,
        chainAccounts: allChainAccounts.length,
        addresses: allAddresses.length
      },
      createdAt: timestamp,
      verifiedAt: timestamp
    },
    keyDomains,
    accounts,
    chainAccounts: allChainAccounts,
    addresses: allAddresses
  })
}

export class PrivateKeyProvisioningCoordinator {
  private readonly now: () => number
  private readonly createEpochId: () => string
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: PrivateKeyProvisioningCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.createEpochId = options.createEpochId ?? (() => crypto.randomUUID())
  }

  provision(input: PrivateKeyProvisioningInput): Promise<PrivateKeyProvisioningResult> {
    const result = this.queue.catch(() => {}).then(() => this.run(input))
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  preview(input: PrivateKeyPreviewInput): Promise<PrivateKeyPreviewResult> {
    const result = this.queue
      .catch(() => {})
      .then(async () => {
        const { derived } = await this.derive(input)
        return Object.freeze({
          chainFamily: input.chainFamily,
          addresses: Object.freeze(
            derived.map(item =>
              Object.freeze({
                chainId: item.chainId,
                address: item.address,
                addressScheme: item.addressScheme,
                preferredForReceive:
                  item.addressScheme === 'evm' ||
                  item.addressScheme === 'solana' ||
                  item.addressScheme === 'near' ||
                  item.addressScheme === 'bitcoin-p2wpkh'
              })
            )
          )
        })
      })
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async derive(input: PrivateKeyPreviewInput): Promise<
    Readonly<{
      vault: RawEncryptedVault
      derived: readonly DerivedPublicAccount[]
      scope: PrivateKeyCredentialScope
    }>
  > {
    validateSecretInput(input)
    const defaultEvmChainId = parseChainId(getEvmNetworkConfig(input.network).chainId).id
    const evmChainIds =
      input.chainFamily === 'eip155'
        ? [
            ...new Set(
              (input.evmChainIds ?? [defaultEvmChainId]).map(value => parseChainId(value).id)
            )
          ]
        : []
    if (
      input.chainFamily === 'eip155' &&
      (!evmChainIds.includes(defaultEvmChainId) ||
        evmChainIds.some(value => !value.startsWith('eip155:')))
    ) {
      throw new Error('Private-key provisioning requires the build EVM network catalog')
    }
    const scope: PrivateKeyCredentialScope =
      input.chainFamily === 'eip155'
        ? Object.freeze({ chainFamily: 'eip155' })
        : input.chainFamily === 'bip122'
          ? Object.freeze({ chainFamily: 'bip122', bitcoinNetwork: input.network })
          : Object.freeze({ chainFamily: input.chainFamily })
    const provisionalHash = await sha256(
      JSON.stringify([
        'private-key-provision-v2',
        input.chainFamily,
        input.network,
        this.createEpochId()
      ])
    )
    const provisionalIdentity: ProvisioningIdentity = Object.freeze({
      suffix: provisionalHash.slice(0, 32),
      keyDomainId: parseKeyDomainId(`wallet:private-key-v2:provisional:${provisionalHash}`),
      credentialGenerationId: parseCredentialGenerationId(
        `credential-generation:private-key-v2:provisional:${provisionalHash}`
      ),
      credentialSetRef: parseCredentialRef(
        `credential-set:private-key-v2:provisional:${provisionalHash}`
      ),
      engineCredentialRef: parseEngineCredentialRef(
        `credential:private-key-v2:provisional:${provisionalHash}:multichain`
      )
    })
    const binding: Extract<KeyringCommandBinding, { readonly kind: 'credential' }> = Object.freeze({
      kind: 'credential',
      keyDomainId: parseSessionKeyDomainId(provisionalIdentity.keyDomainId),
      credentialGenerationId: parseSessionCredentialGenerationId(
        provisionalIdentity.credentialGenerationId
      ),
      globalUnlockEpoch: parseGlobalUnlockEpoch(`global-unlock:${this.createEpochId()}`)
    })
    const commandClient = new MultichainCommandClient(new BackgroundMultichainTransport(), {
      defaultTimeoutMs: 120_000,
      maxTimeoutMs: 120_000
    })
    let vault: RawEncryptedVault
    let derived: readonly DerivedPublicAccount[]
    let unlocked = false
    let operationError: unknown
    try {
      vault = await commandClient.execute(
        {
          operation: 'credential.import-private-key',
          binding,
          payload: {
            privateKey: input.privateKey,
            password: input.password,
            chainFamily: input.chainFamily,
            ...(input.chainFamily === 'bip122' ? { bitcoinNetwork: input.network } : {})
          } as KeyringCommandPayload
        },
        parseRawEncryptedVault
      )
      await commandClient.execute(
        { operation: 'credential.unlock', binding, payload: { vault, password: input.password } },
        value => value
      )
      unlocked = true
      if (input.chainFamily === 'eip155') {
        derived = Object.freeze(
          await Promise.all(
            evmChainIds.map(chainId =>
              commandClient.execute(
                {
                  operation: 'account.derive-public',
                  binding,
                  payload: { family: 'evm', chainId, addressIndex: 0 }
                },
                value => parseDerivedPublicAccount(value, chainId)
              )
            )
          )
        )
      } else if (input.chainFamily === 'bip122') {
        const bitcoinChainId = parseChainId(getBitcoinChainId(input.network)).id
        derived = Object.freeze(
          await Promise.all(
            BITCOIN_ADDRESS_TYPES.map(addressType =>
              commandClient.execute(
                {
                  operation: 'account.derive-public',
                  binding,
                  payload: {
                    family: 'bitcoin',
                    chainId: bitcoinChainId,
                    addressType: rawBitcoinAddressType(addressType),
                    accountIndex: 0,
                    change: false,
                    addressIndex: 0
                  }
                },
                value => parseDerivedPublicAccount(value, bitcoinChainId, addressType)
              )
            )
          )
        )
      } else {
        const chainId = parseChainId(
          input.chainFamily === 'solana'
            ? getSolanaNetworkConfig(input.network === 'mainnet' ? 'mainnet' : 'devnet').chainId
            : getNearNetworkConfig(input.network).chainId
        ).id
        derived = Object.freeze([
          await commandClient.execute(
            {
              operation: 'account.derive-public',
              binding,
              payload: {
                family: input.chainFamily,
                chainId,
                accountIndex: 0
              }
            },
            value => parseDerivedPublicAccount(value, chainId)
          )
        ])
      }
    } catch (error) {
      operationError = error
      throw error
    } finally {
      let cleanupError: unknown
      if (unlocked) {
        try {
          await commandClient.execute(
            { operation: 'credential.lock', binding, payload: {} },
            value => value
          )
        } catch (error) {
          cleanupError = error
        }
      }
      await commandClient.destroy()
      if (cleanupError !== undefined && operationError === undefined) throw cleanupError
    }
    return Object.freeze({ vault, derived, scope })
  }

  private async run(input: PrivateKeyProvisioningInput): Promise<PrivateKeyProvisioningResult> {
    validateInput(input)
    const { vault, derived, scope } = await this.derive(input)
    const identityHash = await sha256(
      JSON.stringify([
        'noir-imported-private-key-public-v1',
        scope,
        derived.map(item => [item.chainId, item.address, item.publicKey])
      ])
    )
    const keyDomainId = parseKeyDomainId(`wallet:private-key-v2:${identityHash}`)
    const activePointer = await this.options.storageRepository.getActivePointer()
    const source = activePointer
      ? await this.options.storageRepository.getSnapshot(activePointer.generationId)
      : null
    if (activePointer && !source) throw new Error('Active Storage V2 generation is missing')
    const existing = source?.keyDomains.find(item => item.id === keyDomainId)
    if (source && existing) {
      if (
        existing.source.kind !== 'private-key' ||
        !privateKeyScopeMatches(existing.source, scope)
      ) {
        throw new Error('Existing imported Wallet identity is inconsistent')
      }
      const existingSet = await this.options.credentialRepository.validateForActivation(
        existing.credentialRef,
        keyDomainId
      )
      if (existingSet.status !== 'active')
        throw new Error('Existing imported Wallet credential is not active')
      if (
        existingSet.record?.manifest.source !== 'private-key' ||
        !privateKeyScopeMatches(existingSet.record.manifest.privateKey, scope)
      ) {
        throw new Error('Existing imported Wallet credential source is inconsistent')
      }
      return this.result('already-committed', source, keyDomainId, existingSet.record.transactionId)
    }
    const transactionFingerprint = await sha256(
      JSON.stringify([
        'private-key-provision-v2',
        activePointer?.generationId ?? null,
        keyDomainId,
        input.displayName
      ])
    )
    const transactionId = parseCredentialTransactionId(
      `credential:private-key-v2:${transactionFingerprint}`
    )
    const identity: ProvisioningIdentity = Object.freeze({
      suffix: identityHash.slice(0, 32),
      keyDomainId,
      credentialGenerationId: parseCredentialGenerationId(
        `credential-generation:private-key-v2:${transactionFingerprint}`
      ),
      credentialSetRef: parseCredentialRef(
        `credential-set:private-key-v2:${transactionFingerprint}`
      ),
      engineCredentialRef: parseEngineCredentialRef(
        `credential:private-key-v2:${transactionFingerprint}:multichain`
      )
    })
    const sourceFingerprint = parseStorageV2SourceFingerprint(
      await sha256(`storage-v2:private-key-v2:${transactionFingerprint}`)
    )
    const generationId = parseStorageV2GenerationId(
      `storage-v2:private-key-v2:${sourceFingerprint}`
    )
    const createdAt = this.now()
    const accountId = parseAccountId(entityId(identity, 'account', '0'))
    const firstDerivedAccount = derived[0]
    if (!firstDerivedAccount) throw new Error('Imported private-key Wallet has no public account')
    const anchor = parseChainAccountId(
      entityId(identity, 'chain-account', firstDerivedAccount.chainId)
    )
    const envelope = await authenticatePrivateKeyCredentialEnvelope(
      {
        schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
        transactionId,
        aad: {
          schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
          engine: 'multichain',
          keyDomainId: identity.keyDomainId,
          credentialGenerationId: identity.credentialGenerationId,
          credentialRef: identity.engineCredentialRef,
          formatVersion: PRIVATE_KEY_VAULT_FORMAT_VERSION
        },
        encryptedPayload: encodeVault(vault),
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
        source: 'private-key' as const,
        privateKey: scope,
        engines: {
          multichain: {
            credentialRef: identity.engineCredentialRef,
            formatVersion: PRIVATE_KEY_VAULT_FORMAT_VERSION,
            verificationAnchorRef: buildChainAccountVerificationAnchorRef(anchor)
          }
        },
        createdAt,
        verifiedAt: createdAt
      }
    }
    let journal: CredentialTransactionJournal = Object.freeze({
      schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
      transactionId,
      operation: 'create',
      targetMetadataGenerationId: generationId,
      transitions: Object.freeze([
        {
          kind: 'provision' as const,
          keyDomainId: identity.keyDomainId,
          targetCredentialGenerationId: identity.credentialGenerationId,
          targetCredentialSetRef: identity.credentialSetRef,
          stagedRefs: Object.freeze([parseCredentialArtifactRef(identity.engineCredentialRef)])
        }
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
    if (staged !== 'staged' && staged !== 'already-staged')
      throw new Error(`Private-key credential staging failed: ${staged}`)
    const target = buildSnapshot(
      source,
      identity,
      scope,
      input.displayName,
      derived,
      generationId,
      sourceFingerprint,
      createdAt
    )
    await this.options.storageRepository.stage(target)
    const verified = nextJournal(journal, 'verified', this.now())
    assertAdvanced(
      await this.options.credentialRepository.advanceJournal(verified, journal.revision),
      'Private-key provisioning verification'
    )
    journal = verified
    const committing = nextJournal(journal, 'committing', this.now())
    assertAdvanced(
      await this.options.credentialRepository.advanceJournal(committing, journal.revision),
      'Private-key provisioning commit preparation'
    )
    journal = committing
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
    if (status !== 'committed') throw new Error(`Private-key provisioning commit failed: ${status}`)
    const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
    assertAdvanced(
      await this.options.credentialRepository.advanceJournal(committed, journal.revision),
      'Private-key provisioning commit finalization'
    )
    const complete = nextJournal(committed, 'complete', this.now())
    assertAdvanced(
      await this.options.credentialRepository.advanceJournal(complete, committed.revision),
      'Private-key provisioning completion'
    )
    return Object.freeze({
      status: 'committed',
      generationId,
      transactionId,
      keyDomainId: identity.keyDomainId,
      accountId
    })
  }

  private result(
    status: PrivateKeyProvisioningResult['status'],
    snapshot: StorageV2Snapshot,
    keyDomainId: ProvisioningIdentity['keyDomainId'],
    transactionId: string
  ): PrivateKeyProvisioningResult {
    const account = snapshot.accounts.find(item => item.keyDomainId === keyDomainId)
    if (!account) throw new Error('Imported private-key Account is missing')
    return Object.freeze({
      status,
      generationId: snapshot.manifest.generationId,
      transactionId,
      keyDomainId,
      accountId: account.id
    })
  }
}
