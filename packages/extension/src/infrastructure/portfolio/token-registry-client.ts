import { getEvmNetworkConfigs, getSolanaNetworkConfigs } from '@/config/networks'
import { parseNearAccountId } from '@/core/chains/near/identifiers'
import { parseAssetId } from '@/core/chains/registry/asset-id'
import { parseSolanaPublicKey } from '@/core/chains/solana/identifiers'
import { DedupPromise } from '@/lib/async-utils'
import type { Network } from '@/types'

export const TOKEN_REGISTRY_URL = 'https://rpc.zknoir.com/v1/token-registry'
export const TOKEN_REGISTRY_CACHE_KEY = 'token_registry_cache_v1'

const REFRESH_INTERVAL_MS = 5 * 60_000
const FAILURE_BACKOFF_MS = 60_000
const FETCH_TIMEOUT_MS = 3_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_ASSETS = 4096

export interface TokenRegistryEntry {
  readonly assetId: string
  readonly network: Network
  readonly defaultVisible: boolean
}

export interface TokenRegistryDocument {
  readonly version: 1
  readonly updatedAt: string
  readonly assets: readonly TokenRegistryEntry[]
}

interface TokenRegistryCache {
  readonly document: TokenRegistryDocument
  readonly successAt: number
  readonly attemptAt: number
}

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

interface TokenRegistryClientOptions {
  readonly fetch?: typeof fetch
  readonly storage?: StorageArea
  readonly now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function assertAssetNetwork(entry: TokenRegistryEntry): void {
  const asset = parseAssetId(entry.assetId)
  if (asset.id !== entry.assetId) throw new Error('Noncanonical Token asset ID')

  if (asset.chainId.startsWith('eip155:')) {
    if (
      asset.namespace !== 'erc20' ||
      !/^0x[0-9a-f]{40}$/.test(asset.reference) ||
      /^0x0{40}$/.test(asset.reference)
    ) {
      throw new Error('Invalid ERC-20 Token identity')
    }
    const known = (['mainnet', 'testnet'] as const)
      .flatMap(network => getEvmNetworkConfigs(network))
      .find(chain => chain.chainId === asset.chainId)
    if (known && known.networkMode !== entry.network) {
      throw new Error('Token network does not match its chain')
    }
    return
  }

  if (asset.chainId.startsWith('solana:')) {
    if (asset.namespace !== 'token') throw new Error('Invalid Solana Token namespace')
    parseSolanaPublicKey(asset.reference)
    const known = getSolanaNetworkConfigs().find(chain => chain.chainId === asset.chainId)
    if (known && (known.cluster === 'mainnet' ? 'mainnet' : 'testnet') !== entry.network) {
      throw new Error('Token network does not match its chain')
    }
    return
  }

  if (asset.chainId.startsWith('near:')) {
    if (asset.namespace !== 'nep141') throw new Error('Invalid NEAR Token namespace')
    const account = asset.reference.replace(/%5F/g, '_')
    parseNearAccountId(account)
    if (account.replace(/_/g, '%5F') !== asset.reference) {
      throw new Error('Noncanonical NEAR Token identity')
    }
    if (asset.chainId !== `near:${entry.network}`) {
      throw new Error('Token network does not match its chain')
    }
    return
  }

  throw new Error('Unsupported Token chain')
}

export function parseTokenRegistryDocument(value: unknown): TokenRegistryDocument {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'updatedAt', 'assets']) ||
    value.version !== 1 ||
    !isValidTimestamp(value.updatedAt) ||
    !Array.isArray(value.assets) ||
    value.assets.length > MAX_ASSETS
  ) {
    throw new Error('Invalid Token registry document')
  }

  const assets: TokenRegistryEntry[] = []
  const seen = new Set<string>()
  for (const valueEntry of value.assets) {
    if (
      !isRecord(valueEntry) ||
      !hasExactKeys(valueEntry, ['assetId', 'network', 'defaultVisible']) ||
      typeof valueEntry.assetId !== 'string' ||
      valueEntry.assetId.length > 256 ||
      (valueEntry.network !== 'mainnet' && valueEntry.network !== 'testnet') ||
      typeof valueEntry.defaultVisible !== 'boolean' ||
      seen.has(valueEntry.assetId)
    ) {
      throw new Error('Invalid Token registry entry')
    }
    const entry = Object.freeze({
      assetId: valueEntry.assetId,
      network: valueEntry.network,
      defaultVisible: valueEntry.defaultVisible
    })
    assertAssetNetwork(entry)
    seen.add(entry.assetId)
    assets.push(entry)
  }

  return Object.freeze({ version: 1, updatedAt: value.updatedAt, assets: Object.freeze(assets) })
}

function parseCache(value: unknown): TokenRegistryCache | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['document', 'successAt', 'attemptAt']) ||
    !Number.isSafeInteger(value.successAt) ||
    (value.successAt as number) < 0 ||
    !Number.isSafeInteger(value.attemptAt) ||
    (value.attemptAt as number) < 0
  ) {
    return null
  }
  try {
    return {
      document: parseTokenRegistryDocument(value.document),
      successAt: value.successAt as number,
      attemptAt: value.attemptAt as number
    }
  } catch {
    return null
  }
}

function sameAssets(
  left: readonly TokenRegistryEntry[],
  right: readonly TokenRegistryEntry[]
): boolean {
  if (left.length !== right.length) return false
  const byId = new Map(left.map(entry => [entry.assetId, entry]))
  return right.every(entry => {
    const previous = byId.get(entry.assetId)
    return previous?.network === entry.network && previous.defaultVisible === entry.defaultVisible
  })
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Token registry response has no body')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw new Error('Token registry response is too large')
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

export class TokenRegistryClient {
  private readonly fetchFunction: typeof fetch
  private readonly storage: StorageArea
  private readonly now: () => number
  private readonly refreshDedup = new DedupPromise<boolean>()
  private document: TokenRegistryDocument | null = null
  private successAt = 0
  private attemptAt = 0
  private revision = 0

  constructor(options: TokenRegistryClientOptions = {}) {
    this.fetchFunction = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.storage = options.storage ?? {
      get: key => chrome.storage.local.get(key),
      set: items => chrome.storage.local.set(items)
    }
    this.now = options.now ?? Date.now
  }

  async loadCached(): Promise<void> {
    const revision = this.revision
    try {
      const stored = await this.storage.get(TOKEN_REGISTRY_CACHE_KEY)
      const cached = parseCache(stored[TOKEN_REGISTRY_CACHE_KEY])
      if (
        !cached ||
        revision !== this.revision ||
        (this.document !== null && cached.successAt <= this.successAt)
      )
        return
      this.document = cached.document
      this.successAt = cached.successAt
      this.attemptAt = cached.attemptAt
      this.revision += 1
    } catch {
      // Invalid or unavailable storage leaves the in-memory last good registry intact.
    }
  }

  async refresh(force = false): Promise<boolean> {
    return this.refreshDedup.run(async () => {
      const now = this.now()
      if (!force && now >= this.successAt && now - this.successAt < REFRESH_INTERVAL_MS) {
        return false
      }
      if (!force && now >= this.attemptAt && now - this.attemptAt < FAILURE_BACKOFF_MS) {
        return false
      }
      this.attemptAt = now
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const fetchFunction = this.fetchFunction
        const operation = (async () => {
          const response = await fetchFunction(TOKEN_REGISTRY_URL, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: controller.signal
          })
          if (!response.ok) throw new Error(`Token registry returned HTTP ${response.status}`)
          return parseTokenRegistryDocument(await readBoundedResponse(response))
        })()
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('Token registry request timed out'))
          }, FETCH_TIMEOUT_MS)
        })
        const document = await Promise.race([operation, timeout])
        const changed = !this.document || !sameAssets(this.document.assets, document.assets)
        this.document = document
        this.successAt = now
        this.revision += 1
        await this.saveCache()
        return changed
      } catch {
        await this.saveCache()
        return false
      } finally {
        if (timer) clearTimeout(timer)
        controller.abort()
      }
    })
  }

  getEntries(network: Network): readonly TokenRegistryEntry[] {
    return Object.freeze(this.document?.assets.filter(entry => entry.network === network) ?? [])
  }

  private async saveCache(): Promise<void> {
    if (!this.document) return
    try {
      await this.storage.set({
        [TOKEN_REGISTRY_CACHE_KEY]: {
          document: this.document,
          successAt: this.successAt,
          attemptAt: this.attemptAt
        }
      })
    } catch {
      // The fetched registry remains usable for this Background lifetime.
    }
  }
}

export const tokenRegistryClient = new TokenRegistryClient()
