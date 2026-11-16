import type { ChainRegistry } from '@/core/chains/registry'
import { parseUserEvmAssetRecord, type UserEvmAssetRecord } from '@/core/chains/user-assets'
import type { Network } from '@/types'
import { createStoredEvmAssetValidationRegistry } from './stored-evm-asset-validation'

const CATALOG_VERSION = 1
const MAXIMUM_ASSET_COUNT = 64

export function getUserEvmAssetCatalogStorageKey(network: Network): string {
  return `user_evm_asset_catalog_${network}_v1`
}

export interface UserEvmAssetCatalogRepository {
  readonly list: () => Promise<readonly UserEvmAssetRecord[]>
  readonly get: (assetId: string) => Promise<UserEvmAssetRecord | null>
  readonly insert: (asset: UserEvmAssetRecord) => Promise<void>
  readonly update: (asset: UserEvmAssetRecord) => Promise<void>
  readonly remove: (assetId: string) => Promise<boolean>
}

interface UserEvmAssetCatalogSnapshot {
  readonly version: typeof CATALOG_VERSION
  readonly assets: readonly UserEvmAssetRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function emptySnapshot(): UserEvmAssetCatalogSnapshot {
  return Object.freeze({ version: CATALOG_VERSION, assets: Object.freeze([]) })
}

export function parseUserEvmAssetCatalogSnapshot(
  chains: ChainRegistry,
  value: unknown
): UserEvmAssetCatalogSnapshot {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== CATALOG_VERSION ||
    !Array.isArray(value.assets) ||
    value.assets.length > MAXIMUM_ASSET_COUNT
  ) {
    throw new Error('Invalid user EVM Token catalog')
  }
  const validationChains = createStoredEvmAssetValidationRegistry(chains, value.assets)
  const assets = value.assets.map(item => parseUserEvmAssetRecord(validationChains, item))
  if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) {
    throw new Error('Duplicate user EVM Token catalog entry')
  }
  return Object.freeze({ version: CATALOG_VERSION, assets: Object.freeze(assets) })
}

export class ChromeUserEvmAssetCatalogRepository implements UserEvmAssetCatalogRepository {
  private readonly storageKey: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    network: Network,
    private readonly chains: ChainRegistry
  ) {
    this.storageKey = getUserEvmAssetCatalogStorageKey(network)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private async readSnapshot(): Promise<UserEvmAssetCatalogSnapshot> {
    const stored = await chrome.storage.local.get(this.storageKey)
    const value = stored[this.storageKey]
    return value === undefined
      ? emptySnapshot()
      : parseUserEvmAssetCatalogSnapshot(this.chains, value)
  }

  async list(): Promise<readonly UserEvmAssetRecord[]> {
    await this.mutationQueue
    const activeChainIds: ReadonlySet<string> = new Set(this.chains.list().map(chain => chain.id))
    return Object.freeze(
      (await this.readSnapshot()).assets.filter(asset => activeChainIds.has(asset.chainId))
    )
  }

  async get(assetId: string): Promise<UserEvmAssetRecord | null> {
    const assets = await this.list()
    return assets.find(asset => asset.assetId === assetId) ?? null
  }

  insert(asset: UserEvmAssetRecord): Promise<void> {
    const parsed = parseUserEvmAssetRecord(this.chains, asset)
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot()
      if (snapshot.assets.some(item => item.assetId === parsed.assetId)) {
        throw new Error('This Token is already added')
      }
      if (snapshot.assets.length >= MAXIMUM_ASSET_COUNT) {
        throw new Error('The user EVM Token catalog is full')
      }
      await chrome.storage.local.set({
        [this.storageKey]: {
          version: CATALOG_VERSION,
          assets: [...snapshot.assets, parsed]
        }
      })
    })
  }

  update(asset: UserEvmAssetRecord): Promise<void> {
    const parsed = parseUserEvmAssetRecord(this.chains, asset)
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot()
      const index = snapshot.assets.findIndex(item => item.assetId === parsed.assetId)
      if (index === -1) throw new Error('This Token is not in the user catalog')
      const assets = [...snapshot.assets]
      assets[index] = parsed
      await chrome.storage.local.set({
        [this.storageKey]: { version: CATALOG_VERSION, assets }
      })
    })
  }

  remove(assetId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot()
      const assets = snapshot.assets.filter(asset => asset.assetId !== assetId)
      if (assets.length === snapshot.assets.length) return false
      if (assets.length === 0) {
        await chrome.storage.local.remove(this.storageKey)
      } else {
        await chrome.storage.local.set({
          [this.storageKey]: { version: CATALOG_VERSION, assets }
        })
      }
      return true
    })
  }
}
