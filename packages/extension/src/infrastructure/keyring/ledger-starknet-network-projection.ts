import {
  parseAddressId,
  parseChainAccountId,
  type Address,
  type ChainAccount
} from '@/core/accounts/domain'
import { STARKNET_CHAIN_IDS } from '@/core/chains/starknet/identifiers'
import { parseChainId } from '@/core/chains/registry'
import { commitCredentialBoundStorageV2Pointer } from '@/core/keyring/application'
import { bytesToHex } from '@/lib/bytes'
import {
  parseStorageV2GenerationId,
  parseStorageV2Snapshot,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import {
  STORAGE_V2_SCHEMA_VERSION,
  type CredentialRepository,
  type StorageV2Repository,
  type StorageV2Snapshot
} from '@/ports/repositories'
import type { Network } from '@/types'

const encoder = new TextEncoder()
const MAX_COMMIT_ATTEMPTS = 3

export function ledgerStarknetProjectionAdditions(
  snapshot: Pick<StorageV2Snapshot, 'keyDomains' | 'chainAccounts' | 'addresses'>,
  network: Network
): { readonly chainAccounts: readonly ChainAccount[]; readonly addresses: readonly Address[] } {
  const targetChainId = parseChainId(
    network === 'mainnet' ? STARKNET_CHAIN_IDS.mainnet : STARKNET_CHAIN_IDS.testnet
  ).id
  const sourceChainId = parseChainId(
    network === 'mainnet' ? STARKNET_CHAIN_IDS.testnet : STARKNET_CHAIN_IDS.mainnet
  ).id
  const ledgerDomains = new Set(
    snapshot.keyDomains
      .filter(domain => domain.source.kind === 'hardware' && domain.source.vendor === 'ledger')
      .map(domain => domain.id)
  )
  const chainAccounts: ChainAccount[] = []
  const addresses: Address[] = []
  for (const source of snapshot.chainAccounts) {
    if (!ledgerDomains.has(source.scope.keyDomainId) || source.scope.chainId !== sourceChainId) {
      continue
    }
    if (
      snapshot.chainAccounts.some(
        item =>
          item.scope.keyDomainId === source.scope.keyDomainId &&
          item.scope.accountId === source.scope.accountId &&
          item.scope.chainId === targetChainId
      ) ||
      chainAccounts.some(
        item =>
          item.scope.keyDomainId === source.scope.keyDomainId &&
          item.scope.accountId === source.scope.accountId
      )
    ) {
      continue
    }
    const chainAccountId = parseChainAccountId(
      `chain-account:ledger-starknet-mode:${source.scope.keyDomainId}:${source.scope.accountId}:${targetChainId}`
    )
    chainAccounts.push({
      id: chainAccountId,
      scope: { ...source.scope, chainId: targetChainId },
      derivation: source.derivation,
      identity: source.identity,
      createdAt: source.createdAt
    })
    snapshot.addresses
      .filter(address => address.chainAccountId === source.id)
      .forEach((address, index) => {
        addresses.push({
          id: parseAddressId(
            `address:ledger-starknet-mode:${address.id}:${targetChainId}:${index}`
          ),
          chainAccountId,
          value: address.value,
          scheme: address.scheme,
          purpose: address.purpose,
          ...(address.derivation === undefined ? {} : { derivation: address.derivation }),
          rotatable: address.rotatable,
          preferredForReceive: address.preferredForReceive,
          privacy: address.privacy,
          walletCompatibility: address.walletCompatibility
        })
      })
  }
  return { chainAccounts, addresses }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

export class LedgerStarknetNetworkProjectionCoordinator {
  constructor(
    private readonly options: {
      readonly credentialRepository: CredentialRepository
      readonly storageRepository: StorageV2Repository
      readonly now?: () => number
    }
  ) {}

  async synchronize(
    network: Network
  ): Promise<'synchronized' | 'already-synchronized' | 'storage-v2-inactive'> {
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const pointer = await this.options.storageRepository.getActivePointer()
      if (!pointer) return 'storage-v2-inactive'
      const source = await this.options.storageRepository.getSnapshot(pointer.generationId)
      if (
        !source ||
        source.manifest.status !== 'verified' ||
        source.manifest.generationId !== pointer.generationId ||
        source.manifest.sourceFingerprint !== pointer.sourceFingerprint ||
        source.manifest.verifiedAt === undefined
      ) {
        throw new Error('Active Storage V2 generation does not match its pointer')
      }
      const additions = ledgerStarknetProjectionAdditions(source, network)
      if (additions.chainAccounts.length === 0) return 'already-synchronized'
      const sourceFingerprint = parseStorageV2SourceFingerprint(
        await sha256(
          JSON.stringify({
            schema: 'ledger-starknet-network-v1',
            sourceGenerationId: pointer.generationId,
            network,
            chainAccounts: additions.chainAccounts.map(item => item.id)
          })
        )
      )
      const generationId = parseStorageV2GenerationId(
        `storage-v2:ledger-starknet-network:${sourceFingerprint}`
      )
      const timestamp = Math.max(
        source.manifest.verifiedAt,
        pointer.committedAt,
        this.options.now?.() ?? Date.now()
      )
      const chainAccounts = [...source.chainAccounts, ...additions.chainAccounts]
      const addresses = [...source.addresses, ...additions.addresses]
      const target = parseStorageV2Snapshot({
        manifest: {
          ...source.manifest,
          generationId,
          sourceFingerprint,
          counts: {
            keyDomains: source.keyDomains.length,
            accounts: source.accounts.length,
            chainAccounts: chainAccounts.length,
            addresses: addresses.length
          },
          createdAt: timestamp,
          verifiedAt: timestamp
        },
        keyDomains: source.keyDomains,
        accounts: source.accounts,
        chainAccounts,
        addresses
      })
      await this.options.storageRepository.stage(target)
      try {
        const status = await commitCredentialBoundStorageV2Pointer(
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
        if (status === 'committed' || status === 'active-generation-changed') {
          const active = await this.options.storageRepository.getActivePointer()
          if (active?.generationId === generationId) return 'synchronized'
        }
        await this.options.storageRepository.discardUncommittedGeneration(generationId)
        if (status !== 'active-generation-changed') {
          throw new Error(`Ledger Starknet network projection failed: ${status}`)
        }
      } catch (error) {
        if (
          (await this.options.storageRepository.getActivePointer())?.generationId === generationId
        ) {
          return 'synchronized'
        }
        await this.options.storageRepository
          .discardUncommittedGeneration(generationId)
          .catch(() => {})
        throw error
      }
    }
    throw new Error('Ledger Starknet network projection changed concurrently too many times')
  }
}
