import {
  parseAccountId,
  parseAddressId,
  parseChainAccountId,
  type AccountId,
  type Address,
  type ChainAccount
} from '@/core/accounts/domain'
import { bytesToHex } from '@/lib/bytes'
import { commitCredentialBoundStorageV2Pointer } from '@/core/keyring/application'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import type { DerivedBitcoinAddress } from '@/core/chains/bitcoin'
import type { DerivedDashAddress } from '@/infrastructure/keyring/multichain/dash-derivation-client'
import { readDashNetworkParams } from '@/infrastructure/keyring/multichain/dash-codecs'
import {
  decodeQuantusAccountId,
  parseQuantusAddress,
  resolveQuantusDerivationScheme
} from '@/core/chains/quantus'
import { getQuantusChainId, getPearlChainId, parseChainId } from '@/core/chains/registry'
import {
  nearImplicitAccountIdFromPublicKey,
  parseNearAccountId,
  parseNearPublicKey
} from '@/core/chains/near'
import { parseSupportedPearlAddress, type DerivedPearlAddress } from '@/core/chains/pearl'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import type { AccountAddresses, Network } from '@/types'
import {
  parseStorageV2GenerationId,
  parseStorageV2Snapshot,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import { resolveQuantusDerivation } from '@/infrastructure/keyring/multichain/quantus-derivation-client'
import {
  STORAGE_V2_SCHEMA_VERSION,
  type CredentialRepository,
  type StorageV2GenerationId,
  type StorageV2Repository
} from '@/ports/repositories'

export interface NetworkAccountMetadataInput {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
  readonly accountIndex: number
  readonly zcashNetwork: Network
  readonly zcashChainId: string
  readonly zcashAddresses: AccountAddresses
  readonly bitcoin: DerivedBitcoinAddress
  readonly dash?: DerivedDashAddress
  readonly pearl?: DerivedPearlAddress
  readonly quantus?: DerivedQuantusNetworkAccount
  readonly solana?: DerivedEd25519NetworkAccount
  readonly near?: DerivedEd25519NetworkAccount
  readonly starknet?: DerivedStarknetNetworkAccount
}

export interface DerivedStarknetNetworkAccount {
  readonly chainId: string
  readonly address: string
  readonly publicKey: string
  readonly classHash: string
  readonly derivationPath: string
}

export interface DerivedQuantusNetworkAccount {
  readonly chainId: string
  readonly address: string
  /** ML-DSA public key with a `0x` prefix. */
  readonly publicKey: string
  /** Poseidon account ID derived from the SS58 address, with a `0x` prefix. */
  readonly accountId: string
  readonly scheme: 'ml-dsa-87' | 'ml-dsa-65'
  readonly derivationPath: string
}

export interface DerivedEd25519NetworkAccount {
  readonly chainId: string
  readonly address: string
  readonly publicKey: string
  readonly derivationPath: string
  readonly implicitAddress?: string
  readonly accountIds?: readonly string[]
}

export interface NetworkAccountMetadataCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly commitPointer?: typeof commitCredentialBoundStorageV2Pointer
  readonly now?: () => number
}

export interface SynchronizeNetworkAccountMetadataResult {
  readonly status: 'synchronized' | 'already-synchronized' | 'storage-v2-inactive'
  readonly generationId?: StorageV2GenerationId
  readonly addedChainAccounts: number
}

const MAX_COMMIT_ATTEMPTS = 3
const TEXT_ENCODER = new TextEncoder()

interface NetworkAddressDefinition {
  readonly role: string
  readonly value: string
  readonly scheme: Address['scheme']
  readonly purpose: Address['purpose']
  readonly derivation?: ChainAccount['derivation']
  readonly rotatable: boolean
  readonly preferredForReceive: boolean
  readonly privacy: Address['privacy']
  readonly walletCompatibility: Address['walletCompatibility']
}

interface NetworkChainAccountDefinition {
  readonly chainId: string
  readonly role: string
  readonly derivation: ChainAccount['derivation']
  readonly identity: string
  readonly addresses: readonly NetworkAddressDefinition[]
  readonly reconcileExisting?: boolean
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

function stableEntityId(kind: 'chain-account' | 'address', scope: string, role: string): string {
  return `${kind}:network-account-v1:${encodeURIComponent(scope)}:${encodeURIComponent(role)}`
}

function assertAccountIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 31) {
    throw new Error('Invalid network Account index')
  }
  return value
}

function normalizeInput(value: NetworkAccountMetadataInput): NetworkAccountMetadataInput {
  const keyDomainId = parseKeyDomainId(value.keyDomainId)
  const accountId = parseAccountId(value.accountId)
  const accountIndex = assertAccountIndex(value.accountIndex)
  const zcashChainId = parseChainId(value.zcashChainId).id
  const bitcoinChainId = parseChainId(value.bitcoin.chainId).id
  if (!zcashChainId.startsWith('bip122:') || !bitcoinChainId.startsWith('bip122:')) {
    throw new Error('Network Account metadata requires Zcash and Bitcoin chains')
  }
  if (
    value.zcashAddresses.transparent.length === 0 ||
    value.zcashAddresses.shielded.length === 0 ||
    value.bitcoin.address.length === 0 ||
    value.bitcoin.accountIndex !== accountIndex ||
    value.bitcoin.change ||
    value.bitcoin.addressIndex !== 0 ||
    value.bitcoin.addressType !== 'p2wpkh'
  ) {
    throw new Error('Network Account metadata contains incomplete default receive addresses')
  }
  const dash = value.dash === undefined ? undefined : normalizeDashAccount(value.dash, accountIndex)
  const pearl =
    value.pearl === undefined ? undefined : normalizePearlAccount(value.pearl, accountIndex)
  const quantus =
    value.quantus === undefined ? undefined : normalizeQuantusAccount(value.quantus, accountIndex)
  const solana =
    value.solana === undefined
      ? undefined
      : normalizeEd25519Account(value.solana, 'solana', accountIndex)
  const near =
    value.near === undefined ? undefined : normalizeEd25519Account(value.near, 'near', accountIndex)
  const starknet =
    value.starknet === undefined
      ? undefined
      : normalizeStarknetAccount(value.starknet, accountIndex)
  return Object.freeze({
    ...value,
    keyDomainId,
    accountId,
    accountIndex,
    zcashChainId,
    bitcoin: Object.freeze({ ...value.bitcoin, chainId: bitcoinChainId }),
    ...(dash === undefined ? {} : { dash }),
    ...(pearl === undefined ? {} : { pearl }),
    ...(quantus === undefined ? {} : { quantus }),
    ...(solana === undefined ? {} : { solana }),
    ...(near === undefined ? {} : { near }),
    ...(starknet === undefined ? {} : { starknet })
  })
}

function normalizeStarknetAccount(
  value: DerivedStarknetNetworkAccount,
  accountIndex: number
): DerivedStarknetNetworkAccount {
  const chainId = parseChainId(value.chainId).id
  if (chainId !== 'starknet:SN_MAIN' && chainId !== 'starknet:SN_SEPOLIA') {
    throw new Error('Network Account metadata requires a Starknet chain')
  }
  const expectedPath = `m/44'/9004'/${accountIndex}'/0/0`
  if (value.derivationPath !== expectedPath) {
    throw new Error('Network Account metadata Starknet derivation index mismatch')
  }
  if (!/^0x[0-9a-f]{1,64}$/.test(value.address) || !/^0x[0-9a-f]{1,64}$/.test(value.publicKey)) {
    throw new Error('Network Account metadata Starknet address is invalid')
  }
  if (!/^0x[0-9a-f]{1,64}$/.test(value.classHash)) {
    throw new Error('Network Account metadata Starknet class hash is invalid')
  }
  return Object.freeze({
    chainId,
    address: value.address,
    publicKey: value.publicKey,
    classHash: value.classHash,
    derivationPath: expectedPath
  })
}

function normalizePearlAccount(
  value: DerivedPearlAddress,
  accountIndex: number
): DerivedPearlAddress {
  const chainId = parseChainId(value.chainId).id
  if (chainId !== getPearlChainId('mainnet') && chainId !== getPearlChainId('testnet')) {
    throw new Error('Network Account metadata requires a Pearl chain')
  }
  const coinType = chainId === getPearlChainId('mainnet') ? 808276 : 1
  const expectedPath = `m/86'/${coinType}'/${accountIndex}'/0/0`
  if (
    value.accountIndex !== accountIndex ||
    value.change ||
    value.addressIndex !== 0 ||
    value.addressScheme !== 'pearl_p2tr' ||
    value.derivationScheme !== 'bip86' ||
    value.derivationPath !== expectedPath
  ) {
    throw new Error('Network Account metadata Pearl derivation index mismatch')
  }
  const address = parseSupportedPearlAddress(value.address, chainId)
  if (!/^0x0[23][0-9a-f]{64}$/.test(value.publicKey)) {
    throw new Error('Network Account metadata Pearl public key is invalid')
  }
  if (!/^0x[0-9a-f]{8}$/.test(value.masterFingerprint)) {
    throw new Error('Network Account metadata Pearl fingerprint is invalid')
  }
  if (!/^0x[0-9a-f]+$/.test(value.scriptPubKey) || value.scriptPubKey.length < 4) {
    throw new Error('Network Account metadata Pearl scriptPubKey is invalid')
  }
  return Object.freeze({
    chainId,
    address,
    accountIndex,
    change: false,
    addressIndex: 0,
    derivationPath: expectedPath,
    publicKey: value.publicKey,
    masterFingerprint: value.masterFingerprint,
    scriptPubKey: value.scriptPubKey,
    addressScheme: 'pearl_p2tr' as const,
    derivationScheme: 'bip86' as const
  })
}

function normalizeDashAccount(value: DerivedDashAddress, accountIndex: number): DerivedDashAddress {
  const params = readDashNetworkParams(parseChainId(value.chainId).id)
  const path = `m/44'/${params.coinType}'/${accountIndex}'/0/0`
  if (
    value.addressScheme !== 'dash_p2pkh' ||
    value.derivationScheme !== 'bip44' ||
    value.change ||
    value.addressIndex !== 0 ||
    value.accountIndex !== accountIndex ||
    value.derivationPath !== path ||
    value.network !== params.network ||
    value.address.length === 0 ||
    !value.address.startsWith(params.network === 'mainnet' ? 'X' : 'y')
  ) {
    throw new Error('Network Account metadata Dash derivation index mismatch')
  }
  return Object.freeze({ ...value, chainId: params.chainId, derivationPath: path })
}

function normalizeQuantusAccount(
  value: DerivedQuantusNetworkAccount,
  accountIndex: number
): DerivedQuantusNetworkAccount {
  const chainId = parseChainId(value.chainId).id
  if (chainId !== getQuantusChainId('mainnet') && chainId !== getQuantusChainId('testnet')) {
    throw new Error('Network Account metadata requires a Quantus chain')
  }
  const scheme = resolveQuantusDerivationScheme(value.scheme)
  const expectedPath = resolveQuantusDerivation(
    { chainId, scheme, accountIndex, change: false, addressIndex: 0 },
    0
  ).derivationPath
  if (value.derivationPath !== expectedPath) {
    throw new Error('Network Account metadata Quantus derivation index mismatch')
  }
  const address = parseQuantusAddress(value.address)
  if (!/^0x(?:[0-9a-f]{2})+$/.test(value.publicKey)) {
    throw new Error('Network Account metadata Quantus public key is invalid')
  }
  const expectedAccountId = `0x${bytesToHex(decodeQuantusAccountId(address))}`
  if (value.accountId !== expectedAccountId) {
    throw new Error('Network Account metadata Quantus identity mismatch')
  }
  return Object.freeze({
    chainId,
    address,
    publicKey: value.publicKey,
    accountId: expectedAccountId,
    scheme,
    derivationPath: expectedPath
  })
}

function normalizeEd25519Account(
  value: DerivedEd25519NetworkAccount,
  family: 'solana' | 'near',
  accountIndex: number
): DerivedEd25519NetworkAccount {
  const chainId = parseChainId(value.chainId)
  if (chainId.namespace !== family) {
    throw new Error(`Network Account metadata requires a ${family} chain`)
  }
  const expectedPath =
    family === 'solana' ? `m/44'/501'/${accountIndex}'/0'` : `m/44'/397'/${accountIndex}'`
  if (value.derivationPath !== expectedPath) {
    throw new Error(`Network Account metadata ${family} derivation index mismatch`)
  }
  if (family === 'solana') {
    const address = parseSolanaPublicKey(value.address)
    const publicKey = parseSolanaPublicKey(value.publicKey)
    if (address !== publicKey) {
      throw new Error('Network Account metadata Solana identity mismatch')
    }
    return Object.freeze({ chainId: chainId.id, address, publicKey, derivationPath: expectedPath })
  }
  const address = parseNearAccountId(value.address)
  const publicKey = parseNearPublicKey(value.publicKey)
  const implicitAddress = nearImplicitAccountIdFromPublicKey(publicKey)
  const storedImplicitAddress = parseNearAccountId(value.implicitAddress ?? address)
  const accountIds = Object.freeze(
    (
      value.accountIds ??
      (address === storedImplicitAddress ? [address] : [address, storedImplicitAddress])
    ).map(accountId => parseNearAccountId(accountId))
  )
  if (
    storedImplicitAddress !== implicitAddress ||
    !accountIds.includes(address) ||
    !accountIds.includes(implicitAddress) ||
    new Set(accountIds).size !== accountIds.length
  ) {
    throw new Error('Network Account metadata NEAR identity mismatch')
  }
  return Object.freeze({
    chainId: chainId.id,
    address,
    publicKey,
    derivationPath: expectedPath,
    implicitAddress,
    accountIds
  })
}

export class NetworkAccountMetadataCoordinator {
  private readonly commitPointer: typeof commitCredentialBoundStorageV2Pointer
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: NetworkAccountMetadataCoordinatorOptions) {
    this.commitPointer = options.commitPointer ?? commitCredentialBoundStorageV2Pointer
    this.now = options.now ?? Date.now
  }

  synchronize(
    values: readonly NetworkAccountMetadataInput[]
  ): Promise<SynchronizeNetworkAccountMetadataResult> {
    const result = this.queue.catch(() => {}).then(() => this.run(values))
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async run(
    values: readonly NetworkAccountMetadataInput[]
  ): Promise<SynchronizeNetworkAccountMetadataResult> {
    const inputs = values
      .map(normalizeInput)
      .sort((left, right) =>
        `${left.keyDomainId}:${left.accountId}`.localeCompare(
          `${right.keyDomainId}:${right.accountId}`
        )
      )
    const inputScopes = inputs.map(input => `${input.keyDomainId}:${input.accountId}`)
    if (new Set(inputScopes).size !== inputScopes.length) {
      throw new Error('Duplicate network Account metadata input')
    }

    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const pointer = await this.options.storageRepository.getActivePointer()
      if (!pointer) {
        return Object.freeze({
          status: 'storage-v2-inactive' as const,
          addedChainAccounts: 0
        })
      }
      const source = await this.options.storageRepository.getSnapshot(pointer.generationId)
      if (!source) throw new Error('Active Storage V2 generation is missing')
      if (
        source.manifest.status !== 'verified' ||
        source.manifest.generationId !== pointer.generationId ||
        source.manifest.sourceFingerprint !== pointer.sourceFingerprint ||
        source.manifest.verifiedAt === undefined
      ) {
        throw new Error('Active Storage V2 generation does not match its pointer')
      }

      const keyDomains = new Map(source.keyDomains.map(item => [item.id, item]))
      const accounts = new Map(
        source.accounts.map(item => [`${item.keyDomainId}:${item.id}`, item])
      )
      const existingScopes = new Map(
        source.chainAccounts.map(item => [
          `${item.scope.keyDomainId}:${item.scope.accountId}:${item.scope.chainId}`,
          item
        ])
      )
      const newChainAccounts: (typeof source.chainAccounts)[number][] = []
      const newAddresses: (typeof source.addresses)[number][] = []
      const updatedChainAccounts = new Map<
        (typeof source.chainAccounts)[number]['id'],
        (typeof source.chainAccounts)[number]
      >()
      const replacementAddresses = new Map<
        (typeof source.chainAccounts)[number]['id'],
        readonly (typeof source.addresses)[number][]
      >()

      for (const input of inputs) {
        const keyDomain = keyDomains.get(input.keyDomainId)
        const account = accounts.get(`${input.keyDomainId}:${input.accountId}`)
        if (!keyDomain || keyDomain.source.kind !== 'software' || !account) {
          throw new Error('Network Account metadata does not match a software Wallet')
        }
        if (account.accountIndex !== input.accountIndex) {
          throw new Error('Network Account metadata derivation index mismatch')
        }
        const scope = `${input.keyDomainId}:${input.accountId}`
        const coinType = input.zcashNetwork === 'mainnet' ? 133 : 1
        const zcashIdentity = input.zcashAddresses.fullUnified ?? input.zcashAddresses.shielded
        const definitions: NetworkChainAccountDefinition[] = [
          {
            chainId: input.zcashChainId,
            role: `zcash:${input.zcashChainId}`,
            derivation: {
              scheme: 'zip32-unified',
              path: `m/32'/${coinType}'/${input.accountIndex}'`
            },
            identity: zcashIdentity,
            addresses: [
              {
                role: 'full-unified',
                value: zcashIdentity,
                scheme: 'zcash-full-unified',
                purpose: 'identity' as const,
                derivation: {
                  scheme: 'zip32-unified',
                  path: `m/32'/${coinType}'/${input.accountIndex}'`
                },
                rotatable: false,
                preferredForReceive: false,
                privacy: 'mixed' as const,
                walletCompatibility: 'limited' as const
              },
              {
                role: 'shielded',
                value: input.zcashAddresses.shielded,
                scheme: 'zcash-shielded-unified',
                purpose: 'receive' as const,
                rotatable: true,
                preferredForReceive: true,
                privacy: 'shielded' as const,
                walletCompatibility: 'limited' as const
              },
              {
                role: 'transparent',
                value: input.zcashAddresses.transparent,
                scheme: 'zcash-transparent-p2pkh',
                purpose: 'receive' as const,
                rotatable: false,
                preferredForReceive: false,
                privacy: 'transparent' as const,
                walletCompatibility: 'broad' as const
              }
            ]
          },
          {
            chainId: input.bitcoin.chainId,
            role: `bitcoin:${input.bitcoin.chainId}`,
            derivation: {
              scheme: input.bitcoin.derivationScheme,
              path: input.bitcoin.derivationPath
            },
            identity: input.bitcoin.address,
            addresses: [
              {
                role: 'receive-0',
                value: input.bitcoin.address,
                scheme: input.bitcoin.addressScheme,
                purpose: 'receive' as const,
                derivation: {
                  scheme: input.bitcoin.derivationScheme,
                  path: input.bitcoin.derivationPath
                },
                rotatable: true,
                preferredForReceive: true,
                privacy: 'transparent' as const,
                walletCompatibility: 'broad' as const
              }
            ]
          },
          ...(input.dash === undefined
            ? []
            : [
                {
                  chainId: input.dash.chainId,
                  role: `dash:${input.dash.chainId}`,
                  derivation: {
                    scheme: input.dash.derivationScheme,
                    path: input.dash.derivationPath
                  },
                  identity: input.dash.address,
                  addresses: [
                    {
                      role: 'receive-0',
                      value: input.dash.address,
                      scheme: input.dash.addressScheme,
                      purpose: 'receive' as const,
                      derivation: {
                        scheme: input.dash.derivationScheme,
                        path: input.dash.derivationPath
                      },
                      rotatable: true,
                      preferredForReceive: true,
                      privacy: 'transparent' as const,
                      walletCompatibility: 'broad' as const
                    }
                  ]
                }
              ]),
          ...(input.pearl === undefined
            ? []
            : [
                {
                  chainId: input.pearl.chainId,
                  role: `pearl:${input.pearl.chainId}`,
                  derivation: {
                    scheme: input.pearl.derivationScheme,
                    path: input.pearl.derivationPath
                  },
                  identity: input.pearl.address,
                  addresses: [
                    {
                      role: 'receive-0',
                      value: input.pearl.address,
                      scheme: input.pearl.addressScheme,
                      purpose: 'receive' as const,
                      derivation: {
                        scheme: input.pearl.derivationScheme,
                        path: input.pearl.derivationPath
                      },
                      rotatable: true,
                      preferredForReceive: true,
                      privacy: 'transparent' as const,
                      walletCompatibility: 'broad' as const
                    }
                  ]
                }
              ]),
          ...(input.quantus === undefined
            ? []
            : [
                {
                  chainId: input.quantus.chainId,
                  role: `quantus:${input.quantus.chainId}`,
                  derivation: {
                    scheme: input.quantus.scheme,
                    path: input.quantus.derivationPath
                  },
                  identity: input.quantus.address,
                  addresses: [
                    {
                      role: 'receive-0',
                      value: input.quantus.address,
                      scheme: 'quantus_ss58',
                      purpose: 'receive' as const,
                      derivation: {
                        scheme: input.quantus.scheme,
                        path: input.quantus.derivationPath
                      },
                      rotatable: false,
                      preferredForReceive: true,
                      privacy: 'transparent' as const,
                      walletCompatibility: 'broad' as const
                    }
                  ]
                }
              ]),
          ...(input.solana === undefined
            ? []
            : [
                {
                  chainId: input.solana.chainId,
                  role: `solana:${input.solana.chainId}`,
                  derivation: { scheme: 'slip10', path: input.solana.derivationPath },
                  identity: input.solana.address,
                  addresses: [
                    {
                      role: 'receive-0',
                      value: input.solana.address,
                      scheme: 'solana',
                      purpose: 'receive' as const,
                      derivation: { scheme: 'slip10', path: input.solana.derivationPath },
                      rotatable: false,
                      preferredForReceive: true,
                      privacy: 'transparent' as const,
                      walletCompatibility: 'broad' as const
                    }
                  ]
                }
              ]),
          ...(input.near === undefined
            ? []
            : [
                {
                  chainId: input.near.chainId,
                  role: `near:${input.near.chainId}`,
                  derivation: { scheme: 'slip10', path: input.near.derivationPath },
                  identity: input.near.address,
                  addresses: (input.near.accountIds ?? [input.near.address]).map(address => ({
                    role: `account:${address}`,
                    value: address,
                    scheme: 'near' as const,
                    purpose: 'receive' as const,
                    ...(address === input.near?.implicitAddress
                      ? {
                          derivation: {
                            scheme: 'slip10' as const,
                            path: input.near.derivationPath
                          }
                        }
                      : {}),
                    rotatable: false,
                    preferredForReceive: address === input.near?.address,
                    privacy: 'transparent' as const,
                    walletCompatibility: 'broad' as const
                  })),
                  reconcileExisting: true
                }
              ]),
          ...(input.starknet === undefined
            ? []
            : [
                {
                  chainId: input.starknet.chainId,
                  role: `starknet:${input.starknet.chainId}`,
                  derivation: { scheme: 'bip44' as const, path: input.starknet.derivationPath },
                  identity: input.starknet.address,
                  addresses: [
                    {
                      role: 'receive-0',
                      value: input.starknet.address,
                      scheme: 'starknet' as const,
                      purpose: 'identity' as const,
                      derivation: {
                        scheme: 'bip44' as const,
                        path: input.starknet.derivationPath
                      },
                      rotatable: false,
                      preferredForReceive: true,
                      privacy: 'transparent' as const,
                      walletCompatibility: 'broad' as const
                    }
                  ]
                }
              ])
        ]

        for (const definition of definitions) {
          const scopeKey = `${scope}:${definition.chainId}`
          const existing = existingScopes.get(scopeKey)
          if (existing) {
            if (
              existing.identity.kind !== 'account-identifier' ||
              existing.derivation.scheme !== definition.derivation.scheme ||
              existing.derivation.path !== definition.derivation.path
            ) {
              throw new Error('Existing network ChainAccount does not match derived metadata')
            }
            if (existing.identity.value !== definition.identity && !definition.reconcileExisting) {
              throw new Error('Existing network ChainAccount does not match derived metadata')
            }
            if (definition.reconcileExisting) {
              const nextChainAccount = Object.freeze({
                ...existing,
                identity: Object.freeze({
                  kind: 'account-identifier' as const,
                  value: definition.identity
                })
              })
              const nextAddresses = definition.addresses.map(address =>
                Object.freeze({
                  id: parseAddressId(
                    stableEntityId('address', scope, `${definition.role}:${address.role}`)
                  ),
                  chainAccountId: existing.id,
                  value: address.value,
                  scheme: address.scheme,
                  purpose: address.purpose,
                  ...(address.derivation === undefined
                    ? {}
                    : { derivation: Object.freeze(address.derivation) }),
                  rotatable: address.rotatable,
                  preferredForReceive: address.preferredForReceive,
                  privacy: address.privacy,
                  walletCompatibility: address.walletCompatibility
                })
              )
              const currentAddresses = source.addresses.filter(
                address => address.chainAccountId === existing.id
              )
              if (JSON.stringify(nextChainAccount) !== JSON.stringify(existing)) {
                updatedChainAccounts.set(existing.id, nextChainAccount)
              }
              if (JSON.stringify(nextAddresses) !== JSON.stringify(currentAddresses)) {
                replacementAddresses.set(existing.id, Object.freeze(nextAddresses))
              }
            }
            continue
          }
          const chainAccountId = parseChainAccountId(
            stableEntityId('chain-account', scope, definition.role)
          )
          newChainAccounts.push(
            Object.freeze({
              id: chainAccountId,
              scope: Object.freeze({
                keyDomainId: input.keyDomainId,
                accountId: input.accountId,
                chainId: parseChainId(definition.chainId).id
              }),
              derivation: Object.freeze(definition.derivation),
              identity: Object.freeze({
                kind: 'account-identifier' as const,
                value: definition.identity
              }),
              createdAt: account.createdAt
            })
          )
          newAddresses.push(
            ...definition.addresses.map(address =>
              Object.freeze({
                id: parseAddressId(
                  stableEntityId('address', scope, `${definition.role}:${address.role}`)
                ),
                chainAccountId,
                value: address.value,
                scheme: address.scheme,
                purpose: address.purpose,
                ...('derivation' in address && address.derivation !== undefined
                  ? { derivation: Object.freeze(address.derivation) }
                  : {}),
                rotatable: address.rotatable,
                preferredForReceive: address.preferredForReceive,
                privacy: address.privacy,
                walletCompatibility: address.walletCompatibility
              })
            )
          )
          existingScopes.set(scopeKey, newChainAccounts[newChainAccounts.length - 1])
        }
      }

      if (
        newChainAccounts.length === 0 &&
        updatedChainAccounts.size === 0 &&
        replacementAddresses.size === 0
      ) {
        return Object.freeze({
          status: 'already-synchronized' as const,
          generationId: pointer.generationId,
          addedChainAccounts: 0
        })
      }

      const sourceFingerprint = parseStorageV2SourceFingerprint(
        await sha256(
          JSON.stringify({
            schema: 'network-account-metadata-v2',
            sourceGenerationId: pointer.generationId,
            entities: [
              ...newChainAccounts.map(item => item.id),
              ...new Set([...updatedChainAccounts.keys(), ...replacementAddresses.keys()])
            ]
          })
        )
      )
      const generationId = parseStorageV2GenerationId(
        `storage-v2:network-accounts:${sourceFingerprint}`
      )
      const timestamp = Math.max(source.manifest.verifiedAt, pointer.committedAt, this.now())
      const nextChainAccounts = Object.freeze([
        ...source.chainAccounts.map(account => updatedChainAccounts.get(account.id) ?? account),
        ...newChainAccounts
      ])
      const replacedAddressIds = new Set(replacementAddresses.keys())
      const nextAddresses = Object.freeze([
        ...source.addresses.filter(address => !replacedAddressIds.has(address.chainAccountId)),
        ...[...replacementAddresses.values()].flat(),
        ...newAddresses
      ])
      const target = parseStorageV2Snapshot({
        manifest: {
          ...source.manifest,
          generationId,
          sourceFingerprint,
          counts: {
            keyDomains: source.keyDomains.length,
            accounts: source.accounts.length,
            chainAccounts: nextChainAccounts.length,
            addresses: nextAddresses.length
          },
          createdAt: timestamp,
          verifiedAt: timestamp
        },
        keyDomains: source.keyDomains,
        accounts: source.accounts,
        chainAccounts: nextChainAccounts,
        addresses: nextAddresses
      })
      await this.options.storageRepository.stage(target)
      let status
      try {
        status = await this.commitPointer(
          this.options.storageRepository,
          this.options.credentialRepository,
          {
            schemaVersion: STORAGE_V2_SCHEMA_VERSION,
            generationId,
            sourceFingerprint,
            committedAt: timestamp
          },
          pointer.generationId
        )
      } catch (error) {
        if (
          (await this.options.storageRepository.getActivePointer())?.generationId === generationId
        ) {
          return Object.freeze({
            status: 'synchronized' as const,
            generationId,
            addedChainAccounts: newChainAccounts.length
          })
        }
        await this.options.storageRepository.discardUncommittedGeneration(generationId)
        throw error
      }
      if (status === 'committed') {
        return Object.freeze({
          status: 'synchronized' as const,
          generationId,
          addedChainAccounts: newChainAccounts.length
        })
      }
      if (status !== 'active-generation-changed') {
        await this.options.storageRepository.discardUncommittedGeneration(generationId)
        throw new Error(`Network Account metadata commit failed: ${status}`)
      }
      const active = await this.options.storageRepository.getActivePointer()
      if (active?.generationId === generationId) {
        return Object.freeze({
          status: 'synchronized' as const,
          generationId,
          addedChainAccounts: newChainAccounts.length
        })
      }
      await this.options.storageRepository.discardUncommittedGeneration(generationId)
    }
    throw new Error('Network Account metadata changed concurrently too many times')
  }
}
