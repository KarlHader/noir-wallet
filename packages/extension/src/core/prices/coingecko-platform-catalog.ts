export const COIN_GECKO_ASSET_PLATFORMS_URL = 'https://api.coingecko.com/api/v3/asset_platforms'

const MAXIMUM_ASSET_PLATFORMS = 2_048
const PLATFORM_CATALOG_FRESH_MS = 24 * 60 * 60 * 1_000
const MISSING_PLATFORM_RECHECK_MS = 5 * 60 * 1_000
const CATALOG_FAILURE_BACKOFF_MS = 60_000
const ASSET_PLATFORM_ID_PATTERN = /^[-._:a-zA-Z0-9 ]{1,256}$/
const EVM_CHAIN_ID_PATTERN = /^eip155:([1-9][0-9]*)$/

interface AssetPlatformCatalog {
  readonly fetchedAt: number
  readonly platformByChainId: ReadonlyMap<string, string | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAssetPlatformCatalog(value: unknown, fetchedAt: number): AssetPlatformCatalog {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_ASSET_PLATFORMS) {
    throw new Error('Invalid CoinGecko asset platform catalog')
  }
  const platformByChainId = new Map<string, string | null>()
  for (const platform of value) {
    if (
      !isRecord(platform) ||
      (platform.chain_identifier !== null &&
        (typeof platform.chain_identifier !== 'number' ||
          !Number.isSafeInteger(platform.chain_identifier) ||
          platform.chain_identifier <= 0))
    ) {
      throw new Error('Invalid CoinGecko asset platform catalog')
    }
    if (platform.chain_identifier === null) continue
    if (
      typeof platform.id !== 'string' ||
      !ASSET_PLATFORM_ID_PATTERN.test(platform.id) ||
      platform.id.trim() !== platform.id ||
      platform.id.length === 0
    ) {
      throw new Error('Invalid CoinGecko asset platform catalog')
    }
    const chainId = String(platform.chain_identifier)
    platformByChainId.set(chainId, platformByChainId.has(chainId) ? null : platform.id)
  }
  return Object.freeze({ fetchedAt, platformByChainId })
}

export class CoinGeckoCatalogUnavailable extends Error {
  constructor(readonly retryAfterMs = CATALOG_FAILURE_BACKOFF_MS) {
    super('CoinGecko asset platforms unavailable')
  }
}

export class CoinGeckoPlatformResolver {
  private catalog: AssetPlatformCatalog | null = null
  private request: Promise<AssetPlatformCatalog> | null = null
  private retryAt = 0

  constructor(
    private readonly fetchCatalog: () => Promise<unknown>,
    private readonly now: () => number = Date.now
  ) {}

  async resolve(chainId: string): Promise<string | null> {
    const match = EVM_CHAIN_ID_PATTERN.exec(chainId)
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      throw new Error('Invalid CoinGecko contract chain')
    }
    const numericChainId = String(Number(match[1]))
    const now = this.now()
    const catalog = this.catalog
    const cachedPlatform = catalog?.platformByChainId.get(numericChainId)
    const age = catalog ? now - catalog.fetchedAt : Infinity
    const fresh = age >= 0 && age <= PLATFORM_CATALOG_FRESH_MS
    const missingRecentlyChecked = age >= 0 && age <= MISSING_PLATFORM_RECHECK_MS
    const current =
      catalog && fresh && (cachedPlatform !== undefined || missingRecentlyChecked)
        ? catalog
        : await this.load()
    const platform = current.platformByChainId.get(numericChainId)
    if (platform === null) throw new Error('Ambiguous CoinGecko asset platform')
    return platform ?? null
  }

  private load(): Promise<AssetPlatformCatalog> {
    if (this.request) return this.request
    if (this.now() < this.retryAt) return Promise.reject(new CoinGeckoCatalogUnavailable())
    const request = this.fetchCatalog()
      .then(value => {
        const catalog = parseAssetPlatformCatalog(value, this.now())
        this.catalog = catalog
        this.retryAt = 0
        return catalog
      })
      .catch(error => {
        const delay =
          error instanceof CoinGeckoCatalogUnavailable
            ? error.retryAfterMs
            : CATALOG_FAILURE_BACKOFF_MS
        this.retryAt = this.now() + Math.min(3_600_000, Math.max(CATALOG_FAILURE_BACKOFF_MS, delay))
        throw error
      })
    this.request = request
    void request
      .finally(() => {
        if (this.request === request) this.request = null
      })
      .catch(() => {})
    return request
  }
}
