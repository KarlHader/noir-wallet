import { parseAddressId, parseChainAccountId } from '@/core/accounts/domain'
import { bytesToHex } from '@/lib/bytes'
import { commitCredentialBoundStorageV2Pointer } from '@/core/keyring/application'
import { keySourceSupportsAddressFamily } from '@/core/accounts/application'
import { parseChainId } from '@/core/chains/registry'
import {
  parseStorageV2GenerationId,
  parseStorageV2Snapshot,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import {
  STORAGE_V2_SCHEMA_VERSION,
  type CredentialRepository,
  type StorageV2GenerationId,
  type StorageV2Repository
} from '@/ports/repositories'

export interface EvmNetworkMetadataCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly commitPointer?: typeof commitCredentialBoundStorageV2Pointer
  readonly now?: () => number
}

export interface SynchronizeEvmNetworkMetadataResult {
  readonly status: 'synchronized' | 'already-synchronized' | 'storage-v2-inactive'
  readonly generationId?: StorageV2GenerationId
  readonly addedChainAccounts: number
}

const MAX_COMMIT_ATTEMPTS = 3
const TEXT_ENCODER = new TextEncoder()

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

function stableEntityId(kind: 'chain-account' | 'address', scope: string, chainId: string): string {
  return `${kind}:evm-network-v1:${encodeURIComponent(scope)}:${encodeURIComponent(chainId)}`
}

export class EvmNetworkMetadataCoordinator {
  private readonly commitPointer: typeof commitCredentialBoundStorageV2Pointer
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: EvmNetworkMetadataCoordinatorOptions) {
    this.commitPointer = options.commitPointer ?? commitCredentialBoundStorageV2Pointer
    this.now = options.now ?? Date.now
  }

  synchronize(chainIdValues: readonly string[]): Promise<SynchronizeEvmNetworkMetadataResult> {
    const result = this.queue.catch(() => {}).then(() => this.run(chainIdValues))
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async run(
    chainIdValues: readonly string[]
  ): Promise<SynchronizeEvmNetworkMetadataResult> {
    const chainIds = [...new Set(chainIdValues.map(value => parseChainId(value).id))].sort()
    if (chainIds.length === 0 || chainIds.some(chainId => !chainId.startsWith('eip155:'))) {
      throw new Error('EVM metadata synchronization requires at least one EVM chain ID')
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

      const keyDomainById = new Map(source.keyDomains.map(keyDomain => [keyDomain.id, keyDomain]))
      const existingScopes = new Set(
        source.chainAccounts.map(chainAccount =>
          JSON.stringify([
            chainAccount.scope.keyDomainId,
            chainAccount.scope.accountId,
            chainAccount.scope.chainId
          ])
        )
      )
      const newChainAccounts: (typeof source.chainAccounts)[number][] = []
      const newAddresses: (typeof source.addresses)[number][] = []

      for (const account of source.accounts) {
        const keyDomain = keyDomainById.get(account.keyDomainId)
        if (!keyDomain || !keySourceSupportsAddressFamily(keyDomain.source, 'evm')) continue
        const evmAccounts = source.chainAccounts.filter(
          chainAccount =>
            chainAccount.scope.keyDomainId === account.keyDomainId &&
            chainAccount.scope.accountId === account.id &&
            chainAccount.scope.chainId.startsWith('eip155:')
        )
        if (evmAccounts.length === 0) continue
        const identities = new Set(
          evmAccounts.map(chainAccount =>
            JSON.stringify([
              chainAccount.derivation.scheme,
              chainAccount.derivation.path,
              chainAccount.identity.kind,
              chainAccount.identity.value.toLowerCase()
            ])
          )
        )
        if (identities.size !== 1) {
          throw new Error('Existing EVM ChainAccount identities are inconsistent')
        }
        const template = evmAccounts[0]
        const templateAddress = source.addresses.find(
          address =>
            address.chainAccountId === template.id &&
            address.scheme === 'evm' &&
            address.preferredForReceive
        )
        if (!templateAddress) throw new Error('Existing EVM ChainAccount has no receive address')
        const scopeKey = `${account.keyDomainId}:${account.id}`

        for (const chainId of chainIds) {
          const scopeIdentity = JSON.stringify([account.keyDomainId, account.id, chainId])
          if (existingScopes.has(scopeIdentity)) continue
          existingScopes.add(scopeIdentity)
          const chainAccountId = parseChainAccountId(
            stableEntityId('chain-account', scopeKey, chainId)
          )
          newChainAccounts.push(
            Object.freeze({
              id: chainAccountId,
              scope: Object.freeze({
                keyDomainId: account.keyDomainId,
                accountId: account.id,
                chainId
              }),
              derivation: template.derivation,
              identity: template.identity,
              createdAt: account.createdAt
            })
          )
          newAddresses.push(
            Object.freeze({
              id: parseAddressId(stableEntityId('address', scopeKey, chainId)),
              chainAccountId,
              value: templateAddress.value,
              scheme: 'evm',
              purpose: 'identity' as const,
              ...(templateAddress.derivation === undefined
                ? {}
                : { derivation: templateAddress.derivation }),
              rotatable: false,
              preferredForReceive: true,
              privacy: 'transparent' as const,
              walletCompatibility: 'broad' as const
            })
          )
        }
      }

      if (newChainAccounts.length === 0) {
        return Object.freeze({
          status: 'already-synchronized' as const,
          generationId: pointer.generationId,
          addedChainAccounts: 0
        })
      }

      const sourceFingerprint = parseStorageV2SourceFingerprint(
        await sha256(
          JSON.stringify({
            schema: 'evm-network-metadata-v1',
            sourceGenerationId: pointer.generationId,
            chainIds,
            entities: newChainAccounts.map(chainAccount => chainAccount.id)
          })
        )
      )
      const generationId = parseStorageV2GenerationId(
        `storage-v2:evm-networks:${sourceFingerprint}`
      )
      const timestamp = Math.max(source.manifest.verifiedAt, pointer.committedAt, this.now())
      const target = parseStorageV2Snapshot({
        manifest: {
          schemaVersion: STORAGE_V2_SCHEMA_VERSION,
          generationId,
          status: 'verified',
          sourceFingerprint,
          ...(source.manifest.mainKeyDomainId === undefined
            ? {}
            : { mainKeyDomainId: source.manifest.mainKeyDomainId }),
          ...(source.manifest.activeAccount === undefined
            ? {}
            : { activeAccount: source.manifest.activeAccount }),
          counts: {
            keyDomains: source.keyDomains.length,
            accounts: source.accounts.length,
            chainAccounts: source.chainAccounts.length + newChainAccounts.length,
            addresses: source.addresses.length + newAddresses.length
          },
          createdAt: timestamp,
          verifiedAt: timestamp
        },
        keyDomains: source.keyDomains,
        accounts: source.accounts,
        chainAccounts: [...source.chainAccounts, ...newChainAccounts],
        addresses: [...source.addresses, ...newAddresses]
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
        throw new Error(`EVM network metadata commit failed: ${status}`)
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
    throw new Error('EVM network metadata changed concurrently too many times')
  }
}
