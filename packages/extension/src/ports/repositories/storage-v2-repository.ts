import type {
  Account,
  AccountId,
  Address,
  AddressId,
  ChainAccount,
  ChainAccountId
} from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import type { KeyDomain, KeyDomainId } from '@/core/keyring/domain'
import type {
  StorageV2ActivePointer,
  StorageV2GenerationId,
  StorageV2GenerationManifest,
  StorageV2Snapshot
} from './storage-v2-types'

export interface StorageV2ReadRepository {
  getActivePointer(): Promise<StorageV2ActivePointer | null>
  getManifest(generationId: StorageV2GenerationId): Promise<StorageV2GenerationManifest | null>
  getSnapshot(generationId: StorageV2GenerationId): Promise<StorageV2Snapshot | null>
  getKeyDomain(
    generationId: StorageV2GenerationId,
    keyDomainId: KeyDomainId
  ): Promise<KeyDomain | null>
  getAccount(generationId: StorageV2GenerationId, accountId: AccountId): Promise<Account | null>
  getChainAccount(
    generationId: StorageV2GenerationId,
    chainAccountId: ChainAccountId
  ): Promise<ChainAccount | null>
  getAddress(generationId: StorageV2GenerationId, addressId: AddressId): Promise<Address | null>
  listAccounts(
    generationId: StorageV2GenerationId,
    keyDomainId: KeyDomainId
  ): Promise<readonly Account[]>
  listChainAccounts(
    generationId: StorageV2GenerationId,
    scope: {
      readonly keyDomainId: KeyDomainId
      readonly accountId: AccountId
      readonly chainId?: ChainId
    }
  ): Promise<readonly ChainAccount[]>
  listAddresses(
    generationId: StorageV2GenerationId,
    chainAccountId: ChainAccountId
  ): Promise<readonly Address[]>
}

export interface StorageV2StageRepository {
  stage(snapshot: StorageV2Snapshot): Promise<void>
  discardUncommittedGeneration(generationId: StorageV2GenerationId): Promise<void>
}

export interface StorageV2CommitRepository {
  commit(
    pointer: StorageV2ActivePointer,
    expectedActiveGenerationId: StorageV2GenerationId | null
  ): Promise<'committed' | 'active-generation-changed'>
}

export interface StorageV2Repository
  extends StorageV2ReadRepository, StorageV2StageRepository, StorageV2CommitRepository {}
