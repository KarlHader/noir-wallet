import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import Big from 'big.js'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import type { UserAssetDexPoolDiscoveryPolicy } from '@/config/user-asset-market-policy'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import { DedupPromise } from '@/lib/async-utils'

export const DEX_SCREENER_TOKEN_PAIRS_URL = 'https://api.dexscreener.com/token-pairs/v1'

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 512 * 1024
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024
const MAXIMUM_PAIR_COUNT = 100
const MAXIMUM_CLOCK_SKEW_MS = 5 * 60 * 1000
const UNAVAILABLE_RETRY_INTERVAL_MS = 60_000
const MAXIMUM_UNAVAILABLE_CACHE_ENTRIES = 512
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const REMOTE_ID_PATTERN = /^[-a-z0-9]{1,64}$/
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/

export interface DiscoveredDexPoolMapping {
  readonly assetId: string
  readonly dexScreenerChainId: string
  readonly dexId: string
  readonly pairAddress: string
  readonly baseTokenAddress: string
  readonly quoteTokenAddress: string
  readonly discoveredAt: number
  readonly expiresAt: number
}

export interface UserAssetDexPoolCacheRepository {
  readonly get: (assetId: string) => Promise<DiscoveredDexPoolMapping | null>
  readonly put: (mapping: DiscoveredDexPoolMapping) => Promise<void>
  readonly delete: (assetId: string) => Promise<void>
}

export type DexPoolDiscoveryResult =
  | {
      readonly status: 'available'
      readonly source: 'cache'
      readonly pool: DiscoveredDexPoolMapping
    }
  | {
      readonly status: 'available'
      readonly source: 'network'
      readonly pool: DiscoveredDexPoolMapping
      readonly observedPriceUsd: string
    }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' }

export interface DexScreenerPoolDiscoveryServiceOptions {
  readonly resolvePolicy: (chainId: string) => UserAssetDexPoolDiscoveryPolicy | null
  readonly cache: UserAssetDexPoolCacheRepository
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

interface CandidatePool {
  readonly dexId: string
  readonly pairAddress: string
  readonly baseTokenAddress: string
  readonly quoteTokenAddress: string
  readonly priceUsd: string
  readonly liquidityUsd: number
  readonly volume24hUsd: number
  readonly pairCreatedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeAddress(value: string, label: string): string {
  if (!EVM_ADDRESS_PATTERN.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value.toLowerCase()
}

function normalizeRemoteId(value: string, label: string): string {
  if (!REMOTE_ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function positiveDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  const canonical = new Big(value).toFixed()
  if (!DECIMAL_PATTERN.test(canonical) || new Big(canonical).lte(0)) {
    throw new Error(`Invalid ${label}`)
  }
  return canonical
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parsePolicy(policy: UserAssetDexPoolDiscoveryPolicy): UserAssetDexPoolDiscoveryPolicy {
  const chain = parseChainId(policy.chainId)
  if (chain.namespace !== 'eip155') throw new Error('Pool discovery requires an EVM chain')
  const dexIds = policy.allowedDexIds.map(value => normalizeRemoteId(value, 'allowed DEX ID'))
  const quoteAddresses = policy.allowedQuoteTokenAddresses.map(value =>
    normalizeAddress(value, 'allowed quote token address')
  )
  if (
    dexIds.length === 0 ||
    new Set(dexIds).size !== dexIds.length ||
    quoteAddresses.length === 0 ||
    new Set(quoteAddresses).size !== quoteAddresses.length
  ) {
    throw new Error('Invalid Pool discovery allowlist')
  }
  const positiveThresholds = [
    policy.minimumLiquidityUsd,
    policy.minimumVolume24hUsd,
    policy.minimumPairAgeMs,
    policy.singlePoolMinimumLiquidityUsd,
    policy.singlePoolMinimumVolume24hUsd,
    policy.singlePoolMinimumPairAgeMs,
    policy.mappingTtlMs
  ]
  if (
    positiveThresholds.some(value => !Number.isSafeInteger(value) || value <= 0) ||
    policy.singlePoolMinimumLiquidityUsd < policy.minimumLiquidityUsd ||
    policy.singlePoolMinimumVolume24hUsd < policy.minimumVolume24hUsd ||
    policy.singlePoolMinimumPairAgeMs < policy.minimumPairAgeMs ||
    !Number.isSafeInteger(policy.maximumPriceDivergenceBps) ||
    policy.maximumPriceDivergenceBps <= 0 ||
    policy.maximumPriceDivergenceBps > 5_000
  ) {
    throw new Error('Invalid Pool discovery thresholds')
  }
  return Object.freeze({
    ...policy,
    chainId: chain.id as `eip155:${string}`,
    dexScreenerChainId: normalizeRemoteId(policy.dexScreenerChainId, 'DEX Screener chain ID'),
    allowedDexIds: Object.freeze(dexIds),
    allowedQuoteTokenAddresses: Object.freeze(quoteAddresses.map(value => value as `0x${string}`))
  })
}

export function parseDiscoveredDexPoolMapping(value: unknown): DiscoveredDexPoolMapping {
  if (!isRecord(value)) throw new Error('Invalid discovered DEX Pool mapping')
  const expectedKeys = [
    'assetId',
    'dexScreenerChainId',
    'dexId',
    'pairAddress',
    'baseTokenAddress',
    'quoteTokenAddress',
    'discoveredAt',
    'expiresAt'
  ]
  if (
    Object.keys(value).length !== expectedKeys.length ||
    !expectedKeys.every(key => Object.prototype.hasOwnProperty.call(value, key)) ||
    typeof value.assetId !== 'string' ||
    typeof value.dexScreenerChainId !== 'string' ||
    typeof value.dexId !== 'string' ||
    typeof value.pairAddress !== 'string' ||
    typeof value.baseTokenAddress !== 'string' ||
    typeof value.quoteTokenAddress !== 'string'
  ) {
    throw new Error('Invalid discovered DEX Pool mapping')
  }
  const asset = parseAssetId(value.assetId)
  if (asset.namespace !== 'erc20' || !asset.chainId.startsWith('eip155:')) {
    throw new Error('Discovered DEX Pool must belong to an ERC-20 asset')
  }
  const assetReference = normalizeAddress(asset.reference, 'ERC-20 token address')
  const assetId = `${asset.chainId}/erc20:${assetReference}`
  const baseTokenAddress = normalizeAddress(value.baseTokenAddress, 'DEX base token address')
  if (baseTokenAddress !== assetReference) {
    throw new Error('Discovered DEX Pool base token does not match its AssetId')
  }
  const discoveredAt = readTimestamp(value.discoveredAt, 'Pool discovery timestamp')
  const expiresAt = readTimestamp(value.expiresAt, 'Pool discovery expiry')
  if (expiresAt <= discoveredAt) throw new Error('Invalid Pool discovery expiry')
  return Object.freeze({
    assetId,
    dexScreenerChainId: normalizeRemoteId(value.dexScreenerChainId, 'DEX Screener chain ID'),
    dexId: normalizeRemoteId(value.dexId, 'DEX ID'),
    pairAddress: normalizeAddress(value.pairAddress, 'DEX pair address'),
    baseTokenAddress,
    quoteTokenAddress: normalizeAddress(value.quoteTokenAddress, 'DEX quote token address'),
    discoveredAt,
    expiresAt
  })
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new Error('Pool discovery response exceeds the allowed size')
  )
}

function parseCandidate(
  value: unknown,
  tokenAddress: string,
  policy: UserAssetDexPoolDiscoveryPolicy,
  now: number
): CandidatePool | null {
  if (!isRecord(value) || value.chainId !== policy.dexScreenerChainId) return null
  if (typeof value.dexId !== 'string' || !policy.allowedDexIds.includes(value.dexId)) return null
  if (!isRecord(value.baseToken) || !isRecord(value.quoteToken)) return null
  if (
    typeof value.baseToken.address !== 'string' ||
    typeof value.quoteToken.address !== 'string' ||
    normalizeAddress(value.baseToken.address, 'Pool base token') !== tokenAddress
  ) {
    return null
  }
  const quoteTokenAddress = normalizeAddress(value.quoteToken.address, 'Pool quote token')
  if (!policy.allowedQuoteTokenAddresses.includes(quoteTokenAddress as `0x${string}`)) return null
  if (
    typeof value.pairAddress !== 'string' ||
    !isRecord(value.liquidity) ||
    !isRecord(value.volume)
  ) {
    return null
  }
  const pairCreatedAt = readTimestamp(value.pairCreatedAt, 'DEX pair creation timestamp')
  if (
    pairCreatedAt > now + MAXIMUM_CLOCK_SKEW_MS ||
    now - pairCreatedAt < policy.minimumPairAgeMs
  ) {
    return null
  }
  const candidate = Object.freeze({
    dexId: value.dexId,
    pairAddress: normalizeAddress(value.pairAddress, 'DEX pair address'),
    baseTokenAddress: tokenAddress,
    quoteTokenAddress,
    priceUsd: positiveDecimal(value.priceUsd, 'Pool USD price'),
    liquidityUsd: finiteNonNegative(value.liquidity.usd, 'Pool USD liquidity'),
    volume24hUsd: finiteNonNegative(value.volume.h24, 'Pool 24-hour volume'),
    pairCreatedAt
  })
  return candidate.liquidityUsd >= policy.minimumLiquidityUsd &&
    candidate.volume24hUsd >= policy.minimumVolume24hUsd
    ? candidate
    : null
}

function pricesAgree(left: string, right: string, maximumDivergenceBps: number): boolean {
  const leftPrice = new Big(left)
  const rightPrice = new Big(right)
  const lower = leftPrice.lt(rightPrice) ? leftPrice : rightPrice
  return leftPrice.minus(rightPrice).abs().times(10_000).lte(lower.times(maximumDivergenceBps))
}

function selectCandidate(
  candidates: readonly CandidatePool[],
  policy: UserAssetDexPoolDiscoveryPolicy,
  now: number
): CandidatePool | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) {
    const candidate = candidates[0]
    return candidate.liquidityUsd >= policy.singlePoolMinimumLiquidityUsd &&
      candidate.volume24hUsd >= policy.singlePoolMinimumVolume24hUsd &&
      now - candidate.pairCreatedAt >= policy.singlePoolMinimumPairAgeMs
      ? candidate
      : null
  }

  const cohorts = candidates
    .map(candidate => {
      const members = candidates.filter(other =>
        pricesAgree(candidate.priceUsd, other.priceUsd, policy.maximumPriceDivergenceBps)
      )
      return Object.freeze({
        members,
        liquidityUsd: members.reduce((total, member) => total + member.liquidityUsd, 0)
      })
    })
    .filter(cohort => cohort.members.length >= 2)
    .sort(
      (left, right) =>
        right.members.length - left.members.length || right.liquidityUsd - left.liquidityUsd
    )
  const cohort = cohorts[0]
  if (!cohort) return null
  return [...cohort.members].sort(
    (left, right) =>
      right.liquidityUsd - left.liquidityUsd || left.pairAddress.localeCompare(right.pairAddress)
  )[0]
}

function cachedMappingMatches(
  mapping: DiscoveredDexPoolMapping,
  assetId: string,
  tokenAddress: string,
  policy: UserAssetDexPoolDiscoveryPolicy,
  now: number
): boolean {
  return (
    mapping.assetId === assetId &&
    mapping.dexScreenerChainId === policy.dexScreenerChainId &&
    policy.allowedDexIds.includes(mapping.dexId) &&
    mapping.baseTokenAddress === tokenAddress &&
    policy.allowedQuoteTokenAddresses.includes(mapping.quoteTokenAddress as `0x${string}`) &&
    mapping.discoveredAt <= now + MAXIMUM_CLOCK_SKEW_MS &&
    mapping.expiresAt === mapping.discoveredAt + policy.mappingTtlMs &&
    mapping.expiresAt > now
  )
}

export class DexScreenerPoolDiscoveryService {
  private readonly fetchImplementation: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly maximumResponseBytes: number
  private readonly operations = new Map<string, DedupPromise<DexPoolDiscoveryResult>>()
  private readonly unavailableUntil = new Map<string, { observedAt: number; expiresAt: number }>()

  constructor(private readonly options: DexScreenerPoolDiscoveryServiceOptions) {
    const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.fetchImplementation = (input, init) => fetchImplementation(input, init)
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) {
      throw new Error('Invalid Pool discovery timeout')
    }
    if (
      !Number.isSafeInteger(this.maximumResponseBytes) ||
      this.maximumResponseBytes < 1_024 ||
      this.maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
    ) {
      throw new Error('Invalid Pool discovery response limit')
    }
  }

  discover(assetId: string, forceRefresh = false): Promise<DexPoolDiscoveryResult> {
    const parsed = parseAssetId(assetId)
    if (parsed.namespace !== 'erc20' || !parsed.chainId.startsWith('eip155:')) {
      throw new Error('Pool discovery requires an ERC-20 AssetId')
    }
    const tokenAddress = normalizeAddress(parsed.reference, 'ERC-20 token address')
    const canonicalAssetId = `${parsed.chainId}/erc20:${tokenAddress}`
    const gate = this.operations.get(canonicalAssetId) ?? new DedupPromise<DexPoolDiscoveryResult>()
    this.operations.set(canonicalAssetId, gate)
    return gate
      .run(() => this.discoverOnce(canonicalAssetId, tokenAddress, forceRefresh))
      .finally(() => {
        if (!gate.isPending) this.operations.delete(canonicalAssetId)
      })
  }

  private readNow(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Pool discovery clock')
    return value
  }

  private async discoverOnce(
    assetId: string,
    reference: string,
    forceRefresh: boolean
  ): Promise<DexPoolDiscoveryResult> {
    const parsed = parseAssetId(assetId)
    const resolved = this.options.resolvePolicy(parsed.chainId)
    if (!resolved) return Object.freeze({ status: 'unavailable' })
    const policy = parsePolicy(resolved)
    if (policy.chainId !== parsed.chainId) throw new Error('Pool discovery policy chain mismatch')
    const tokenAddress = normalizeAddress(reference, 'ERC-20 token address')
    const now = this.readNow()
    const unavailable = this.unavailableUntil.get(assetId)
    if (
      unavailable &&
      !forceRefresh &&
      now >= unavailable.observedAt &&
      now < unavailable.expiresAt
    ) {
      return Object.freeze({ status: 'unavailable' })
    }
    if (unavailable && (now < unavailable.observedAt || now >= unavailable.expiresAt)) {
      this.unavailableUntil.delete(assetId)
    }
    let cached: DiscoveredDexPoolMapping | null = null
    try {
      const value = await this.options.cache.get(assetId)
      cached = value === null ? null : parseDiscoveredDexPoolMapping(value)
    } catch {
      cached = null
    }
    if (cached && cachedMappingMatches(cached, assetId, tokenAddress, policy, now)) {
      if (!forceRefresh) {
        return Object.freeze({ status: 'available', source: 'cache', pool: cached })
      }
    } else if (cached) {
      await this.options.cache.delete(assetId).catch(() => {})
      cached = null
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImplementation(
        `${DEX_SCREENER_TOKEN_PAIRS_URL}/${encodeURIComponent(policy.dexScreenerChainId)}/${encodeURIComponent(tokenAddress)}`,
        {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal
        }
      )
      if (!response.ok) {
        this.unavailableUntil.delete(assetId)
        return Object.freeze({ status: 'failed' })
      }
      const text = await readBoundedResponse(response, this.maximumResponseBytes)
      const value = JSON.parse(text) as unknown
      if (!Array.isArray(value) || value.length > MAXIMUM_PAIR_COUNT) {
        throw new Error('Invalid Pool discovery response')
      }
      const candidates = value.flatMap(item => {
        try {
          const candidate = parseCandidate(item, tokenAddress, policy, now)
          return candidate ? [candidate] : []
        } catch {
          return []
        }
      })
      if (new Set(candidates.map(candidate => candidate.pairAddress)).size !== candidates.length) {
        throw new Error('Duplicate Pool discovery pair')
      }
      const selected = selectCandidate(candidates, policy, now)
      if (!selected) {
        await this.options.cache.delete(assetId).catch(() => {})
        this.unavailableUntil.delete(assetId)
        if (this.unavailableUntil.size >= MAXIMUM_UNAVAILABLE_CACHE_ENTRIES) {
          const oldestAssetId = this.unavailableUntil.keys().next().value
          if (oldestAssetId) this.unavailableUntil.delete(oldestAssetId)
        }
        this.unavailableUntil.set(assetId, {
          observedAt: now,
          expiresAt: Math.min(Number.MAX_SAFE_INTEGER, now + UNAVAILABLE_RETRY_INTERVAL_MS)
        })
        return Object.freeze({ status: 'unavailable' })
      }
      const pool = parseDiscoveredDexPoolMapping({
        assetId,
        dexScreenerChainId: policy.dexScreenerChainId,
        dexId: selected.dexId,
        pairAddress: selected.pairAddress,
        baseTokenAddress: selected.baseTokenAddress,
        quoteTokenAddress: selected.quoteTokenAddress,
        discoveredAt: now,
        expiresAt: now + policy.mappingTtlMs
      })
      await this.options.cache.put(pool).catch(() => {})
      this.unavailableUntil.delete(assetId)
      return Object.freeze({
        status: 'available',
        source: 'network',
        pool,
        observedPriceUsd: selected.priceUsd
      })
    } catch {
      this.unavailableUntil.delete(assetId)
      return Object.freeze({ status: 'failed' })
    } finally {
      clearTimeout(timeout)
    }
  }
}
