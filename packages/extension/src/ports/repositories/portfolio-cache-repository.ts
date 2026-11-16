import type { ChainAccountId } from '@/core/accounts/domain'
import type { PortfolioScope, PortfolioSourceSnapshot } from '@/core/portfolio'
import type { StorageV2GenerationId } from './storage-v2-types'

export interface PortfolioCacheRecord {
  readonly generationId: StorageV2GenerationId
  readonly cachedAt: number
  readonly source: PortfolioSourceSnapshot
}

export interface PortfolioCacheRepository {
  get(
    generationId: StorageV2GenerationId,
    chainAccountId: ChainAccountId
  ): Promise<PortfolioCacheRecord | null>
  list(
    generationId: StorageV2GenerationId,
    scope: PortfolioScope
  ): Promise<readonly PortfolioCacheRecord[]>
  put(record: PortfolioCacheRecord): Promise<void>
  deleteByAccountScope(scope: PortfolioScope): Promise<number>
  deleteGeneration(generationId: StorageV2GenerationId): Promise<number>
}
