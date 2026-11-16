import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import type { ChainRegistry } from '@/core/chains/registry'
import { parseAssetDisplayMetadata } from '@/core/chains/registry'
import { normalizeUserEvmAssetIdentity } from '@/core/chains/user-assets'

const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024
const MAXIMUM_DISCOVERED_TOKEN_COUNT = 512

export interface DetectedEvmTokenCandidate {
  readonly assetId: string
  readonly chainId: string
  readonly contractAddress: `0x${string}`
  readonly iconUrl?: string
}

export interface EvmTokenDiscoveryClientOptions {
  readonly chains: ChainRegistry
  readonly origin?: string
  readonly fetch?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export class EvmTokenDiscoveryClient {
  private readonly origin: string
  private readonly fetcher: typeof fetch

  constructor(private readonly options: EvmTokenDiscoveryClientOptions) {
    this.origin = options.origin ?? __EVM_HISTORY_API_ORIGIN__
    this.fetcher = options.fetch ?? fetch
  }

  get available(): boolean {
    return this.origin.length > 0
  }

  async discover(
    address: string,
    chainIds: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly DetectedEvmTokenCandidate[]> {
    if (!this.available) return Object.freeze([])
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid EVM discovery address')
    const numericChainIds = chainIds.map(chainId => {
      const chain = this.options.chains.resolve(chainId)
      if (chain.family !== 'evm' || !chain.id.startsWith('eip155:')) {
        throw new Error('Token discovery requires EVM chains')
      }
      return chain.id.slice('eip155:'.length)
    })
    if (numericChainIds.length === 0 || new Set(numericChainIds).size !== numericChainIds.length) {
      throw new Error('Invalid EVM discovery chain inventory')
    }
    const url = new URL('/balances', `${this.origin}/`)
    url.searchParams.set('address', address.toLowerCase())
    url.searchParams.set('chainIds', numericChainIds.join(','))
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`Token discovery request failed (${response.status})`)
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      if (Number.isFinite(contentLength) && contentLength > MAXIMUM_RESPONSE_BYTES) {
        throw new Error('Token discovery response is too large')
      }
      const text = await response.text()
      if (new TextEncoder().encode(text).byteLength > MAXIMUM_RESPONSE_BYTES) {
        throw new Error('Token discovery response is too large')
      }
      const value: unknown = JSON.parse(text)
      if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.assets)) {
        throw new Error('Invalid token discovery response')
      }
      if (value.partial === true) {
        throw new Error('Token discovery result exceeds the supported inventory')
      }
      if (value.partial !== false || value.assets.length > MAXIMUM_DISCOVERED_TOKEN_COUNT) {
        throw new Error('Invalid token discovery response')
      }
      const allowedChains = new Set(chainIds)
      const assets = value.assets.map(item => {
        if (
          !isRecord(item) ||
          Object.keys(item).length !== 4 ||
          typeof item.chainId !== 'string' ||
          typeof item.contractAddress !== 'string' ||
          typeof item.balanceRawInteger !== 'string' ||
          !isRecord(item.metadata)
        ) {
          throw new Error('Invalid detected EVM Token')
        }
        if (
          !allowedChains.has(item.chainId) ||
          !/^[1-9][0-9]{0,127}$/.test(item.balanceRawInteger)
        ) {
          throw new Error('Detected EVM Token does not match the request')
        }
        const identity = normalizeUserEvmAssetIdentity(this.options.chains, {
          chainId: item.chainId,
          contractAddress: item.contractAddress
        })
        const metadata = parseAssetDisplayMetadata(item.metadata)
        if (metadata.iconUrl) {
          const iconUrl = new URL(metadata.iconUrl)
          const expectedOrigin = new URL(this.origin).origin
          if (iconUrl.origin !== expectedOrigin || iconUrl.pathname !== '/token-icon') {
            throw new Error('Detected EVM Token icon does not match the discovery service')
          }
        }
        return Object.freeze({
          ...identity,
          ...(metadata.iconUrl ? { iconUrl: metadata.iconUrl } : {})
        })
      })
      if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) {
        throw new Error('Duplicate detected EVM Token')
      }
      return Object.freeze(assets)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
}
