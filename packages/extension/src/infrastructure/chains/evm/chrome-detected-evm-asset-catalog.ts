import type { ChainRegistry } from '@/core/chains/registry'
import { parseDetectedEvmAssetRecord, type DetectedEvmAssetRecord } from '@/core/chains/user-assets'
import type { Network } from '@/types'
import { createStoredEvmAssetValidationRegistry } from './stored-evm-asset-validation'

const CATALOG_VERSION = 1
const MAXIMUM_ASSET_COUNT = 512

export function getDetectedEvmAssetCatalogStorageKey(network: Network): string {
  return `detected_evm_asset_catalog_${network}_v1`
}

interface DetectedEvmAssetCatalogSnapshot {
  readonly version: typeof CATALOG_VERSION
  readonly assets: readonly DetectedEvmAssetRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function emptySnapshot(): DetectedEvmAssetCatalogSnapshot {
  return Object.freeze({ version: CATALOG_VERSION, assets: Object.freeze([]) })
}

export function parseDetectedEvmAssetCatalogSnapshot(
  chains: ChainRegistry,
  value: unknown
): DetectedEvmAssetCatalogSnapshot {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== CATALOG_VERSION ||
    !Array.isArray(value.assets) ||
    value.assets.length > MAXIMUM_ASSET_COUNT
  ) {
    throw new Error('Invalid detected EVM Token catalog')
  }
  const validationChains = createStoredEvmAssetValidationRegistry(chains, value.assets)
  const assets = value.assets.map(item => parseDetectedEvmAssetRecord(validationChains, item))
  if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) {
    throw new Error('Duplicate detected EVM Token catalog entry')
  }
  return Object.freeze({ version: CATALOG_VERSION, assets: Object.freeze(assets) })
}

export class ChromeDetectedEvmAssetCatalogRepository {
  private readonly storageKey: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    network: Network,
    private readonly chains: ChainRegistry
  ) {
    this.storageKey = getDetectedEvmAssetCatalogStorageKey(network)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private async readSnapshot(): Promise<DetectedEvmAssetCatalogSnapshot> {
    const stored = await chrome.storage.local.get(this.storageKey)
    const value = stored[this.storageKey]
    return value === undefined
      ? emptySnapshot()
      : parseDetectedEvmAssetCatalogSnapshot(this.chains, value)
  }

  async list(): Promise<readonly DetectedEvmAssetRecord[]> {
    await this.mutationQueue
    const activeChainIds: ReadonlySet<string> = new Set(this.chains.list().map(chain => chain.id))
    return Object.freeze(
      (await this.readSnapshot()).assets.filter(asset => activeChainIds.has(asset.chainId))
    )
  }

  upsert(records: readonly DetectedEvmAssetRecord[]): Promise<boolean> {
    const parsed = records.map(record => parseDetectedEvmAssetRecord(this.chains, record))
    if (new Set(parsed.map(record => record.assetId)).size !== parsed.length) {
      throw new Error('Duplicate detected EVM Token update')
    }
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot()
      const byId = new Map(snapshot.assets.map(asset => [asset.assetId, asset]))
      let runtimeChanged = false
      let shouldWrite = false
      for (const record of parsed) {
        const previous = byId.get(record.assetId)
        if (
          !previous ||
          previous.metadata.name !== record.metadata.name ||
          previous.metadata.symbol !== record.metadata.symbol ||
          previous.metadata.decimals !== record.metadata.decimals ||
          previous.metadata.iconUrl !== record.metadata.iconUrl
        ) {
          runtimeChanged = true
        }
        shouldWrite ||= !previous || previous.lastSeenAt !== record.lastSeenAt || runtimeChanged
        byId.set(record.assetId, record)
      }
      if (!shouldWrite) return false
      const assets = [...byId.values()]
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(0, MAXIMUM_ASSET_COUNT)
      await chrome.storage.local.set({
        [this.storageKey]: { version: CATALOG_VERSION, assets }
      })
      return runtimeChanged
    })
  }
}
