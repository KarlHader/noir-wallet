import {
  createWalletSetCatalog,
  renameAccount as renameCatalogAccount,
  renameWalletSet
} from '@/core/accounts/application'
import { bytesToHex } from '@/lib/bytes'
import { parseAccountId } from '@/core/accounts/domain'
import { commitCredentialBoundStorageV2Pointer } from '@/core/keyring/application'
import { parseKeyDomainId } from '@/core/keyring/domain'
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

export interface WalletMetadataCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly commitPointer?: typeof commitCredentialBoundStorageV2Pointer
  readonly now?: () => number
}

export interface RenameWalletMetadataInput {
  readonly keyDomainId: string
  readonly displayName: string
}

export interface RenameAccountMetadataInput extends RenameWalletMetadataInput {
  readonly accountId: string
}

export interface RenameWalletMetadataResult {
  readonly status: 'renamed' | 'already-renamed' | 'storage-v2-inactive'
  readonly generationId?: StorageV2GenerationId
}

const TEXT_ENCODER = new TextEncoder()
const MAX_COMMIT_ATTEMPTS = 3

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

export class WalletMetadataCoordinator {
  private readonly commitPointer: typeof commitCredentialBoundStorageV2Pointer
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: WalletMetadataCoordinatorOptions) {
    this.commitPointer = options.commitPointer ?? commitCredentialBoundStorageV2Pointer
    this.now = options.now ?? Date.now
  }

  renameWallet(input: RenameWalletMetadataInput): Promise<RenameWalletMetadataResult> {
    const result = this.queue.catch(() => {}).then(() => this.runRenameMetadata('wallet', input))
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  renameAccount(input: RenameAccountMetadataInput): Promise<RenameWalletMetadataResult> {
    const result = this.queue.catch(() => {}).then(() => this.runRenameMetadata('account', input))
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async runRenameMetadata(
    targetKind: 'wallet' | 'account',
    input: RenameWalletMetadataInput | RenameAccountMetadataInput
  ): Promise<RenameWalletMetadataResult> {
    const keyDomainId = parseKeyDomainId(input.keyDomainId)
    const accountId =
      targetKind === 'account'
        ? parseAccountId((input as RenameAccountMetadataInput).accountId)
        : null
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const pointer = await this.options.storageRepository.getActivePointer()
      if (!pointer) return Object.freeze({ status: 'storage-v2-inactive' })
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
      const current =
        targetKind === 'wallet'
          ? source.keyDomains.find(keyDomain => keyDomain.id === keyDomainId)
          : source.accounts.find(
              account => account.id === accountId && account.keyDomainId === keyDomainId
            )
      if (!current) {
        throw new Error(targetKind === 'wallet' ? 'Wallet not found' : 'Account not found')
      }
      if (current.displayName === input.displayName) {
        return Object.freeze({
          status: 'already-renamed',
          generationId: pointer.generationId
        })
      }

      const sourceCatalog = createWalletSetCatalog({
        keyDomains: source.keyDomains,
        accounts: source.accounts,
        mainKeyDomainId: source.manifest.mainKeyDomainId ?? null,
        activeAccount: source.manifest.activeAccount ?? null
      })
      const catalog =
        accountId === null
          ? renameWalletSet(sourceCatalog, keyDomainId, input.displayName)
          : renameCatalogAccount(sourceCatalog, accountId, input.displayName)
      const sourceFingerprint = parseStorageV2SourceFingerprint(
        await sha256(
          JSON.stringify(
            targetKind === 'wallet'
              ? {
                  schema: 'wallet-metadata-rename-v1',
                  sourceGenerationId: source.manifest.generationId,
                  keyDomainId,
                  displayName: catalog.keyDomains.find(keyDomain => keyDomain.id === keyDomainId)
                    ?.displayName
                }
              : {
                  schema: 'account-metadata-rename-v1',
                  sourceGenerationId: source.manifest.generationId,
                  keyDomainId,
                  accountId,
                  displayName: catalog.accounts.find(account => account.id === accountId)
                    ?.displayName
                }
          )
        )
      )
      const generationId = parseStorageV2GenerationId(
        `storage-v2:wallet-metadata:${sourceFingerprint}`
      )
      const timestamp = Math.max(source.manifest.verifiedAt, pointer.committedAt, this.now())
      const target = parseStorageV2Snapshot({
        manifest: {
          schemaVersion: STORAGE_V2_SCHEMA_VERSION,
          generationId,
          status: 'verified',
          sourceFingerprint,
          ...(catalog.mainKeyDomainId ? { mainKeyDomainId: catalog.mainKeyDomainId } : {}),
          ...(catalog.activeAccount ? { activeAccount: catalog.activeAccount } : {}),
          counts: source.manifest.counts,
          createdAt: timestamp,
          verifiedAt: timestamp
        },
        keyDomains: catalog.keyDomains,
        accounts: catalog.accounts,
        chainAccounts: source.chainAccounts,
        addresses: source.addresses
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
          return Object.freeze({ status: 'renamed', generationId })
        }
        await this.options.storageRepository.discardUncommittedGeneration(generationId)
        throw error
      }
      if (status === 'committed') {
        return Object.freeze({ status: 'renamed', generationId })
      }
      if (status !== 'active-generation-changed') {
        await this.options.storageRepository.discardUncommittedGeneration(generationId)
        throw new Error(`Wallet metadata commit failed: ${status}`)
      }
      const active = await this.options.storageRepository.getActivePointer()
      if (active?.generationId === generationId) {
        return Object.freeze({ status: 'renamed', generationId })
      }
      await this.options.storageRepository.discardUncommittedGeneration(generationId)
    }
    throw new Error('Wallet metadata changed concurrently too many times')
  }
}
