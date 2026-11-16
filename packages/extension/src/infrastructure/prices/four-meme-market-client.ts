import { readBoundedResponseText } from '@/lib/fetch-utils'
import { DedupPromise } from '@/lib/async-utils'

const ORIGIN = 'https://four.meme'
const ICON_ORIGIN = 'https://static.four.meme'
const WRAPPED_BNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
const BSC_ASSET = /^eip155:56\/erc20:(0x[0-9a-fA-F]{40})$/
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const PRICE = /^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/
const CACHE_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 5_000
const MAXIMUM_CACHE_ENTRIES = 512
const MAXIMUM_DETAIL_BYTES = 256 * 1024
const MAXIMUM_CONFIG_BYTES = 1024 * 1024
const MAXIMUM_FUTURE_SKEW_MS = 5 * 60_000

export interface FourMemeToken {
  readonly assetId: string
  readonly iconUrl?: string
  readonly phase: 'curve' | 'dex'
  readonly market?: Readonly<{
    price: string
    quoteAssetId: string
    quoteDecimals: number
    sourceUpdatedAt: number
  }>
}

interface QuoteAsset {
  readonly assetId: string
  readonly decimals: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readEnvelope(value: unknown): unknown {
  return isRecord(value) && (value.code === 0 || value.code === '0') ? value.data : null
}

function readIcon(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return undefined
  if (!value.startsWith('/market/') && !value.startsWith(`${ICON_ORIGIN}/market/`)) {
    return undefined
  }
  let url: URL
  try {
    url = new URL(value, ICON_ORIGIN)
  } catch {
    return undefined
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== ICON_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/market\/.+\.(?:avif|jpe?g|png|svg|webp)$/i.test(url.pathname)
  ) {
    return undefined
  }
  return url.toString()
}

function readPrice(value: unknown): string | null {
  return typeof value === 'string' && PRICE.test(value) && /[1-9]/.test(value) ? value : null
}

function readTimestamp(value: unknown, now: number): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return null
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    timestamp <= now + MAXIMUM_FUTURE_SKEW_MS
    ? timestamp
    : null
}

function readQuoteAsset(value: unknown, symbol: string): QuoteAsset | null {
  const data = readEnvelope(value)
  if (!Array.isArray(data) || data.length > 512) return null
  const matches = data.filter(
    item => isRecord(item) && item.networkCode === 'BSC' && item.symbol === symbol
  )
  if (matches.length !== 1) return null
  const item = matches[0] as Record<string, unknown>
  if (
    typeof item.symbolAddress !== 'string' ||
    !EVM_ADDRESS.test(item.symbolAddress) ||
    (symbol === 'BNB' && item.symbolAddress.toLowerCase() !== WRAPPED_BNB) ||
    !Number.isSafeInteger(item.decimals) ||
    (item.decimals as number) < 0 ||
    (item.decimals as number) > 255 ||
    (symbol === 'BNB' && item.decimals !== 18)
  ) {
    return null
  }
  return {
    assetId:
      symbol === 'BNB'
        ? 'eip155:56/slip44:714'
        : `eip155:56/erc20:${item.symbolAddress.toLowerCase()}`,
    decimals: item.decimals as number
  }
}

export class FourMemeMarketClient {
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly cache = new Map<string, { value: FourMemeToken | null; expiresAt: number }>()
  private readonly pending = new Map<string, DedupPromise<FourMemeToken | null>>()
  private configCache: { value: unknown; expiresAt: number } | null = null
  private readonly configGate = new DedupPromise<unknown>()

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? Date.now
  }

  async getToken(assetId: string): Promise<FourMemeToken | null> {
    const match = BSC_ASSET.exec(assetId)
    if (!match) return null
    const address = match[1].toLowerCase()
    const canonicalId = `eip155:56/erc20:${address}`
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) return null
    const cached = this.cache.get(canonicalId)
    if (cached && cached.expiresAt > now) return cached.value
    let gate = this.pending.get(canonicalId)
    if (!gate) {
      gate = new DedupPromise<FourMemeToken | null>()
      this.pending.set(canonicalId, gate)
    }
    try {
      return await gate.run(async () => {
        try {
          const { value, cacheable } = await this.readToken(canonicalId, address, now)
          if (cacheable) {
            this.cache.delete(canonicalId)
            this.cache.set(canonicalId, { value, expiresAt: now + CACHE_TTL_MS })
            if (this.cache.size > MAXIMUM_CACHE_ENTRIES) {
              const oldest = this.cache.keys().next().value
              if (oldest !== undefined) this.cache.delete(oldest)
            }
          }
          return value
        } catch {
          return null
        }
      })
    } finally {
      if (!gate.isPending && this.pending.get(canonicalId) === gate) {
        this.pending.delete(canonicalId)
      }
    }
  }

  private async readJson(path: string, maximumBytes: number): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetcher(new URL(path, ORIGIN), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal: controller.signal
      })
      if (!response.ok) throw new Error('Four.Meme endpoint unavailable')
      const body = await readBoundedResponseText(
        response,
        maximumBytes,
        () => new Error('Four.Meme response exceeds the allowed size')
      )
      return JSON.parse(body) as unknown
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readConfig(): Promise<unknown> {
    if (this.configCache && this.configCache.expiresAt > this.now()) return this.configCache.value
    return this.configGate.run(async () => {
      const value = await this.readJson('/meme-api/v1/public/config', MAXIMUM_CONFIG_BYTES)
      const data = readEnvelope(value)
      if (Array.isArray(data) && data.length <= 512) {
        this.configCache = { value, expiresAt: this.now() + CACHE_TTL_MS }
      }
      return value
    })
  }

  private async readToken(
    assetId: string,
    address: string,
    now: number
  ): Promise<{ value: FourMemeToken | null; cacheable: boolean }> {
    const response = await this.readJson(
      `/meme-api/v1/private/token/get/v2?address=${address}`,
      MAXIMUM_DETAIL_BYTES
    )
    if (
      isRecord(response) &&
      (typeof response.code === 'number' || typeof response.code === 'string') &&
      response.code !== 0 &&
      response.code !== '0'
    ) {
      return { value: null, cacheable: true }
    }
    const data = readEnvelope(response)
    if (
      !isRecord(data) ||
      typeof data.address !== 'string' ||
      data.address.toLowerCase() !== address ||
      data.networkCode !== 'BSC' ||
      (data.status !== 'PUBLISH' && data.status !== 'TRADE')
    ) {
      return { value: null, cacheable: false }
    }
    const iconUrl = readIcon(data.image)
    const phase = data.status === 'PUBLISH' ? 'curve' : 'dex'
    const token: FourMemeToken = Object.freeze({
      assetId,
      phase,
      ...(iconUrl ? { iconUrl } : {})
    })
    if (phase === 'dex' || !isRecord(data.tokenPrice) || typeof data.symbol !== 'string') {
      return { value: token, cacheable: true }
    }
    const price = readPrice(data.tokenPrice.price)
    const sourceUpdatedAt = readTimestamp(data.tokenPrice.modifyDate, now)
    if (!price || sourceUpdatedAt === null) return { value: token, cacheable: true }
    let quoteAsset: QuoteAsset | null = null
    try {
      quoteAsset = readQuoteAsset(await this.readConfig(), data.symbol)
    } catch {
      // The token remains usable for its icon when quote configuration is unavailable.
    }
    return {
      value: quoteAsset
        ? Object.freeze({
            ...token,
            market: Object.freeze({
              price,
              quoteAssetId: quoteAsset.assetId,
              quoteDecimals: quoteAsset.decimals,
              sourceUpdatedAt
            })
          })
        : token,
      cacheable: quoteAsset !== null
    }
  }
}
