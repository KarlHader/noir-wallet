import { buildActiveAccountSelectionSnapshot } from '@/core/accounts/application'
import { bytesToHex } from '@/lib/bytes'
import type { AccountId } from '@/core/accounts/domain'
import {
  commitCredentialBoundStorageV2Pointer,
  type CredentialBoundCommitStatus
} from '@/core/keyring/application'
import type { KeyDomainId } from '@/core/keyring/domain'
import {
  parseStorageV2GenerationId,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import {
  STORAGE_V2_SCHEMA_VERSION,
  type CredentialRepository,
  type StorageV2ActivePointer,
  type StorageV2GenerationId,
  type StorageV2Repository
} from '@/ports/repositories'

export interface ActiveAccountSelectionCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly commitPointer?: typeof commitCredentialBoundStorageV2Pointer
}

export interface SelectActiveAccountInput {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
}

export interface SelectActiveAccountResult {
  readonly status: 'selected' | 'already-selected' | 'storage-v2-inactive'
  readonly generationId?: StorageV2GenerationId
}

const TEXT_ENCODER = new TextEncoder()
const MAX_COMMIT_ATTEMPTS = 3

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

async function deriveGeneration(
  source: StorageV2ActivePointer,
  input: SelectActiveAccountInput
): Promise<{
  readonly generationId: StorageV2GenerationId
  readonly sourceFingerprint: ReturnType<typeof parseStorageV2SourceFingerprint>
}> {
  const fingerprint = parseStorageV2SourceFingerprint(
    await sha256(
      JSON.stringify([
        'active-account-selection-v1',
        source.generationId,
        source.sourceFingerprint,
        input.keyDomainId,
        input.accountId
      ])
    )
  )
  return Object.freeze({
    generationId: parseStorageV2GenerationId(`storage-v2:active-account:${fingerprint}`),
    sourceFingerprint: fingerprint
  })
}

export class ActiveAccountSelectionCoordinator {
  private readonly credentialRepository: CredentialRepository
  private readonly storageRepository: StorageV2Repository
  private readonly commitPointer: typeof commitCredentialBoundStorageV2Pointer
  private queue: Promise<void> = Promise.resolve()

  constructor(options: ActiveAccountSelectionCoordinatorOptions) {
    this.credentialRepository = options.credentialRepository
    this.storageRepository = options.storageRepository
    this.commitPointer = options.commitPointer ?? commitCredentialBoundStorageV2Pointer
  }

  select(input: SelectActiveAccountInput): Promise<SelectActiveAccountResult> {
    const result = this.queue.catch(() => {}).then(() => this.run(input))
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async run(input: SelectActiveAccountInput): Promise<SelectActiveAccountResult> {
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const pointer = await this.storageRepository.getActivePointer()
      if (!pointer) return Object.freeze({ status: 'storage-v2-inactive' })
      const source = await this.storageRepository.getSnapshot(pointer.generationId)
      if (!source) throw new Error('Active Storage V2 generation is missing')
      if (
        source.manifest.status !== 'verified' ||
        source.manifest.generationId !== pointer.generationId ||
        source.manifest.sourceFingerprint !== pointer.sourceFingerprint ||
        source.manifest.verifiedAt === undefined
      ) {
        throw new Error('Active Storage V2 generation does not match its pointer')
      }
      if (
        source.manifest.activeAccount?.keyDomainId === input.keyDomainId &&
        source.manifest.activeAccount.accountId === input.accountId
      ) {
        return Object.freeze({
          status: 'already-selected',
          generationId: pointer.generationId
        })
      }

      const target = await deriveGeneration(pointer, input)
      const createdAt = Math.max(source.manifest.verifiedAt, pointer.committedAt)
      const snapshot = buildActiveAccountSelectionSnapshot({
        source,
        selection: input,
        ...target,
        createdAt
      })
      await this.storageRepository.stage(snapshot)
      let commitStatus: CredentialBoundCommitStatus
      try {
        commitStatus = await this.commitPointer(
          this.storageRepository,
          this.credentialRepository,
          {
            schemaVersion: STORAGE_V2_SCHEMA_VERSION,
            generationId: target.generationId,
            sourceFingerprint: target.sourceFingerprint,
            committedAt: createdAt
          },
          pointer.generationId
        )
      } catch (error) {
        if (await this.resolveOrDiscardTarget(target.generationId)) {
          return Object.freeze({ status: 'selected', generationId: target.generationId })
        }
        throw error
      }
      if (commitStatus === 'committed') {
        return Object.freeze({ status: 'selected', generationId: target.generationId })
      }
      if (commitStatus !== 'active-generation-changed') {
        await this.resolveOrDiscardTarget(target.generationId)
        throw new Error(`Active Account selection commit failed: ${commitStatus}`)
      }

      if (await this.resolveOrDiscardTarget(target.generationId)) {
        return Object.freeze({ status: 'selected', generationId: target.generationId })
      }
    }
    throw new Error('Active Account selection changed concurrently too many times')
  }

  private async resolveOrDiscardTarget(generationId: StorageV2GenerationId): Promise<boolean> {
    const active = await this.storageRepository.getActivePointer()
    if (active?.generationId === generationId) return true
    await this.storageRepository.discardUncommittedGeneration(generationId)
    return false
  }
}
