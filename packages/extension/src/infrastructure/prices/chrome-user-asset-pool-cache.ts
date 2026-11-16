import {
  parseDiscoveredDexPoolMapping,
  type DiscoveredDexPoolMapping,
  type UserAssetDexPoolCacheRepository
} from './dex-screener-pool-discovery-service'

export const USER_ASSET_DEX_POOL_CACHE_STORAGE_KEY = 'user_asset_dex_pool_cache_v1'

const CACHE_VERSION = 1
const MAXIMUM_MAPPING_COUNT = 128

interface UserAssetDexPoolCacheSnapshot {
  readonly version: typeof CACHE_VERSION
  readonly mappings: readonly DiscoveredDexPoolMapping[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parseUserAssetDexPoolCacheSnapshot(value: unknown): UserAssetDexPoolCacheSnapshot {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== CACHE_VERSION ||
    !Array.isArray(value.mappings) ||
    value.mappings.length > MAXIMUM_MAPPING_COUNT
  ) {
    throw new Error('Invalid user asset DEX Pool cache')
  }
  const mappings = value.mappings.map(parseDiscoveredDexPoolMapping)
  if (new Set(mappings.map(mapping => mapping.assetId)).size !== mappings.length) {
    throw new Error('Duplicate user asset DEX Pool cache mapping')
  }
  return Object.freeze({ version: CACHE_VERSION, mappings: Object.freeze(mappings) })
}

function emptySnapshot(): UserAssetDexPoolCacheSnapshot {
  return Object.freeze({ version: CACHE_VERSION, mappings: Object.freeze([]) })
}

export class ChromeUserAssetDexPoolCacheRepository implements UserAssetDexPoolCacheRepository {
  private mutationQueue: Promise<void> = Promise.resolve()

  private async readSnapshot(): Promise<UserAssetDexPoolCacheSnapshot> {
    const result = await chrome.storage.local.get(USER_ASSET_DEX_POOL_CACHE_STORAGE_KEY)
    const stored = result[USER_ASSET_DEX_POOL_CACHE_STORAGE_KEY]
    return stored === undefined ? emptySnapshot() : parseUserAssetDexPoolCacheSnapshot(stored)
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.catch(() => {})
    return result
  }

  async get(assetId: string): Promise<DiscoveredDexPoolMapping | null> {
    await this.mutationQueue
    const snapshot = await this.readSnapshot()
    return snapshot.mappings.find(mapping => mapping.assetId === assetId) ?? null
  }

  put(mapping: DiscoveredDexPoolMapping): Promise<void> {
    const parsed = parseDiscoveredDexPoolMapping(mapping)
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot()
      const mappings = [
        parsed,
        ...snapshot.mappings.filter(item => item.assetId !== parsed.assetId)
      ]
      if (mappings.length > MAXIMUM_MAPPING_COUNT) {
        mappings.length = MAXIMUM_MAPPING_COUNT
      }
      await chrome.storage.local.set({
        [USER_ASSET_DEX_POOL_CACHE_STORAGE_KEY]: {
          version: CACHE_VERSION,
          mappings
        }
      })
    })
  }

  delete(assetId: string): Promise<void> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot()
      const mappings = snapshot.mappings.filter(mapping => mapping.assetId !== assetId)
      if (mappings.length === snapshot.mappings.length) return
      if (mappings.length === 0) {
        await chrome.storage.local.remove(USER_ASSET_DEX_POOL_CACHE_STORAGE_KEY)
        return
      }
      await chrome.storage.local.set({
        [USER_ASSET_DEX_POOL_CACHE_STORAGE_KEY]: {
          version: CACHE_VERSION,
          mappings
        }
      })
    })
  }
}
