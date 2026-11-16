import { parseAssetId, type AssetRegistry, type ChainRegistry } from '@/core/chains/registry'
import type { AssetDisplayMetadata } from '@/core/chains/domain'
import {
  createUserEvmAssetCandidate,
  createUserEvmAssetRecord,
  normalizeUserEvmAssetIdentity,
  parseUserEvmAssetCandidate,
  parseUserEvmAssetRecord,
  type UserEvmAssetCandidate,
  type UserEvmAssetRecord
} from '@/core/chains/user-assets'
import type { UserAssetDexPoolCacheRepository } from '@/infrastructure/prices'
import { readErc20Metadata } from './evm-erc20-metadata-reader'
import type { EvmContractRpc } from './evm-rpc-client'
import type { UserEvmAssetCatalogRepository } from './chrome-user-evm-asset-catalog'

const PREVIEW_METADATA_TTL_MS = 5 * 60 * 1000
const MAX_PREVIEW_METADATA_ENTRIES = 128

export interface UserEvmAssetCoordinatorOptions {
  readonly chains: ChainRegistry
  readonly bundledAssets: AssetRegistry
  readonly repository: UserEvmAssetCatalogRepository
  readonly resolveRpc: (chainId: string) => EvmContractRpc
  readonly poolCache?: UserAssetDexPoolCacheRepository
  readonly resolveIconUrl?: (assetId: string) => Promise<string | undefined>
  readonly now?: () => number
}

function metadataMatches(left: UserEvmAssetCandidate, right: UserEvmAssetCandidate): boolean {
  return (
    left.assetId === right.assetId &&
    left.metadata.name === right.metadata.name &&
    left.metadata.symbol === right.metadata.symbol &&
    left.metadata.decimals === right.metadata.decimals &&
    left.metadata.iconUrl === right.metadata.iconUrl
  )
}

function assertIntentsCatalogDecimals(actual: number, expected?: number): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error('Token decimals do not match the Intents catalog')
  }
}

export class UserEvmAssetCoordinator {
  private readonly now: () => number
  private readonly previewMetadata = new Map<
    string,
    {
      readonly rpc: EvmContractRpc
      readonly metadata: AssetDisplayMetadata
      readonly readAt: number
    }
  >()
  private readonly pendingPreviewMetadata = new Map<
    string,
    { readonly rpc: EvmContractRpc; readonly promise: Promise<AssetDisplayMetadata> }
  >()

  constructor(private readonly options: UserEvmAssetCoordinatorOptions) {
    this.now = options.now ?? Date.now
  }

  private readNow(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid user EVM Token clock')
    }
    return value
  }

  async list(): Promise<readonly UserEvmAssetRecord[]> {
    const records = await this.options.repository.list()
    // A release can bundle a previously user-added Token. Keep its stored record,
    // but use the bundled definition throughout the active runtime.
    return Object.freeze(
      records.filter(record => !this.options.bundledAssets.inspect(record.assetId))
    )
  }

  async backfillIcons(
    iconUrls: ReadonlyMap<string, string>
  ): Promise<readonly UserEvmAssetRecord[]> {
    const records = await this.list()
    const updated = await Promise.all(
      records.map(async record => {
        if (record.metadata.iconUrl) return record
        const iconUrl = iconUrls.get(record.assetId)
        if (!iconUrl) return record
        const next = parseUserEvmAssetRecord(this.options.chains, {
          ...record,
          metadata: { ...record.metadata, iconUrl }
        })
        await this.options.repository.update(next)
        return next
      })
    )
    return Object.freeze(updated)
  }

  async inspect(input: {
    readonly chainId: string
    readonly contractAddress: string
  }): Promise<UserEvmAssetCandidate> {
    return this.inspectInternal(input, true)
  }

  private async readPreviewMetadata(
    assetId: string,
    rpc: EvmContractRpc,
    contractAddress: string
  ): Promise<AssetDisplayMetadata> {
    const cached = this.previewMetadata.get(assetId)
    const now = this.readNow()
    if (
      cached?.rpc === rpc &&
      now >= cached.readAt &&
      now - cached.readAt < PREVIEW_METADATA_TTL_MS
    ) {
      return cached.metadata
    }
    const pending = this.pendingPreviewMetadata.get(assetId)
    if (pending?.rpc === rpc) return pending.promise

    const promise = readErc20Metadata(rpc, contractAddress)
      .then(metadata => {
        if (this.pendingPreviewMetadata.get(assetId)?.promise === promise) {
          this.previewMetadata.delete(assetId)
          if (this.previewMetadata.size >= MAX_PREVIEW_METADATA_ENTRIES) {
            this.previewMetadata.delete(this.previewMetadata.keys().next().value!)
          }
          this.previewMetadata.set(assetId, { rpc, metadata, readAt: this.readNow() })
        }
        return metadata
      })
      .finally(() => {
        if (this.pendingPreviewMetadata.get(assetId)?.promise === promise) {
          this.pendingPreviewMetadata.delete(assetId)
        }
      })
    this.pendingPreviewMetadata.set(assetId, { rpc, promise })
    return promise
  }

  private async inspectInternal(
    input: { readonly chainId: string; readonly contractAddress: string },
    preview: boolean
  ): Promise<UserEvmAssetCandidate> {
    const identity = normalizeUserEvmAssetIdentity(this.options.chains, input)
    if (this.options.bundledAssets.inspect(identity.assetId)) {
      throw new Error('This Token is already built into the wallet')
    }
    const rpc = this.options.resolveRpc(identity.chainId)
    if (!preview) {
      this.previewMetadata.delete(identity.assetId)
      this.pendingPreviewMetadata.delete(identity.assetId)
    }
    const metadata = preview
      ? await this.readPreviewMetadata(identity.assetId, rpc, identity.contractAddress)
      : await readErc20Metadata(rpc, identity.contractAddress)
    const iconUrl = await this.options.resolveIconUrl?.(identity.assetId).catch(() => undefined)
    return createUserEvmAssetCandidate(this.options.chains, {
      ...identity,
      metadata: { ...metadata, ...(iconUrl ? { iconUrl } : {}) },
      inspectedAt: this.readNow()
    })
  }

  async add(expectedCandidate: UserEvmAssetCandidate): Promise<UserEvmAssetRecord> {
    const expected = parseUserEvmAssetCandidate(this.options.chains, expectedCandidate)
    const current = await this.inspectInternal(
      { chainId: expected.chainId, contractAddress: expected.contractAddress },
      false
    )
    if (!metadataMatches(expected, current)) {
      throw new Error('Token metadata changed before confirmation. Review it again.')
    }
    const record = createUserEvmAssetRecord(this.options.chains, current, this.readNow())
    await this.options.repository.insert(record)
    return record
  }

  async ensure(input: {
    readonly chainId: string
    readonly contractAddress: string
    readonly iconUrl?: string
    readonly expectedDecimals?: number
  }): Promise<UserEvmAssetRecord> {
    const identity = normalizeUserEvmAssetIdentity(this.options.chains, input)
    if (this.options.bundledAssets.inspect(identity.assetId)) {
      throw new Error('This Token is already built into the wallet')
    }
    const existing = await this.options.repository.get(identity.assetId)
    if (existing) {
      assertIntentsCatalogDecimals(existing.metadata.decimals, input.expectedDecimals)
      if (existing.source === 'intents-catalog') return existing
      const catalogRecord = Object.freeze({ ...existing, source: 'intents-catalog' as const })
      await this.options.repository.update(catalogRecord)
      return catalogRecord
    }

    const inspected = await this.inspectInternal(identity, false)
    assertIntentsCatalogDecimals(inspected.metadata.decimals, input.expectedDecimals)
    const candidate = input.iconUrl
      ? createUserEvmAssetCandidate(this.options.chains, {
          ...identity,
          metadata: { ...inspected.metadata, iconUrl: input.iconUrl },
          inspectedAt: inspected.inspectedAt
        })
      : inspected
    const record = createUserEvmAssetRecord(
      this.options.chains,
      candidate,
      this.readNow(),
      'intents-catalog'
    )
    try {
      await this.options.repository.insert(record)
      return record
    } catch (error) {
      const concurrent = await this.options.repository.get(identity.assetId)
      if (concurrent) {
        assertIntentsCatalogDecimals(concurrent.metadata.decimals, input.expectedDecimals)
        if (concurrent.source === 'intents-catalog') return concurrent
        const catalogRecord = Object.freeze({ ...concurrent, source: 'intents-catalog' as const })
        await this.options.repository.update(catalogRecord)
        return catalogRecord
      }
      throw error
    }
  }

  async remove(assetId: string): Promise<boolean> {
    const asset = parseAssetId(assetId)
    if (asset.namespace !== 'erc20') throw new Error('Invalid user EVM Token AssetId')
    const parsed = normalizeUserEvmAssetIdentity(this.options.chains, {
      chainId: asset.chainId,
      contractAddress: asset.reference
    })
    if (parsed.assetId !== assetId) throw new Error('Invalid user EVM Token AssetId')
    const removed = await this.options.repository.remove(assetId)
    if (removed) await this.options.poolCache?.delete(assetId).catch(() => {})
    return removed
  }
}
