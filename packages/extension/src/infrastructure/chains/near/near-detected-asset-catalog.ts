import { getNearNetworkConfig } from '@/config/networks'
import { parseAssetDisplayMetadata } from '@/core/chains/registry'
import {
  isNearFungibleContractId,
  nearFungibleAssetId,
  NEAR_PORTFOLIO_TOKEN_LIMIT
} from '@/core/chains/near/near-portfolio-assets'
import type { Network } from '@/types'

const CATALOG_VERSION = 1

export interface DetectedNearAssetRecord {
  readonly assetId: string
  readonly chainId: string
  readonly contractId: string
  readonly metadata: Readonly<{
    readonly name: string
    readonly symbol: string
    readonly decimals: number
  }>
}

interface DetectedNearAssetCatalogSnapshot {
  readonly version: typeof CATALOG_VERSION
  readonly assets: readonly DetectedNearAssetRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function getDetectedNearAssetCatalogStorageKey(network: Network): string {
  return `detected_near_asset_catalog_${network}_v1`
}

function emptySnapshot(): DetectedNearAssetCatalogSnapshot {
  return Object.freeze({ version: CATALOG_VERSION, assets: Object.freeze([]) })
}

export function parseDetectedNearAssetRecord(
  network: Network,
  value: unknown
): DetectedNearAssetRecord {
  const chainId = getNearNetworkConfig(network).chainId
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    value.chainId !== chainId ||
    typeof value.contractId !== 'string' ||
    !isNearFungibleContractId(value.contractId) ||
    typeof value.assetId !== 'string'
  ) {
    throw new Error('Invalid detected NEAR Token')
  }
  const assetId = nearFungibleAssetId(chainId, value.contractId)
  if (value.assetId !== assetId) throw new Error('Invalid detected NEAR Token')
  const metadata = parseAssetDisplayMetadata(value.metadata)
  return Object.freeze({
    assetId,
    chainId,
    contractId: value.contractId,
    metadata: Object.freeze({
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals
    })
  })
}

export function parseDetectedNearAssetCatalogSnapshot(
  network: Network,
  value: unknown
): DetectedNearAssetCatalogSnapshot {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== CATALOG_VERSION ||
    !Array.isArray(value.assets) ||
    value.assets.length > NEAR_PORTFOLIO_TOKEN_LIMIT
  ) {
    throw new Error('Invalid detected NEAR Token catalog')
  }
  const assets = value.assets.map(item => parseDetectedNearAssetRecord(network, item))
  if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) {
    throw new Error('Duplicate detected NEAR Token catalog entry')
  }
  return Object.freeze({ version: CATALOG_VERSION, assets: Object.freeze(assets) })
}

export class ChromeDetectedNearAssetCatalogRepository {
  private readonly storageKey: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly network: Network) {
    this.storageKey = getDetectedNearAssetCatalogStorageKey(network)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async readSnapshot(): Promise<DetectedNearAssetCatalogSnapshot> {
    const stored = await chrome.storage.local.get(this.storageKey)
    const value = stored[this.storageKey]
    return value === undefined
      ? emptySnapshot()
      : parseDetectedNearAssetCatalogSnapshot(this.network, value)
  }

  async list(): Promise<readonly DetectedNearAssetRecord[]> {
    await this.mutationQueue
    return (await this.readSnapshot()).assets
  }

  async save(records: readonly DetectedNearAssetRecord[]): Promise<boolean> {
    return this.enqueue(async () => {
      const existing = await this.readSnapshot()
      const incoming = records.map(record => parseDetectedNearAssetRecord(this.network, record))
      const incomingIds = new Set(incoming.map(record => record.assetId))
      const merged = Object.freeze(
        [...existing.assets.filter(record => !incomingIds.has(record.assetId)), ...incoming].slice(
          -NEAR_PORTFOLIO_TOKEN_LIMIT
        )
      )
      const unchanged =
        merged.length === existing.assets.length &&
        merged.every((record, index) => record.assetId === existing.assets[index]?.assetId)
      if (unchanged) return false
      await chrome.storage.local.set({
        [this.storageKey]: { version: CATALOG_VERSION, assets: merged }
      })
      return true
    })
  }
}
