import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { ActivityItem, ActivityScope } from '@/core/activity'
import type { PortfolioReadModel, PortfolioAssetView } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import type { Transaction } from '@/types'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { CUSTOM_ANALYTICS_CONFIG } from '@/config/analytics'
import { createAssetId, parseChainId } from '@/core/chains/registry'
import { getZcashChainId } from '@/core/chains/registry/product-chain-definitions'
import { ANALYTICS_EVENTS, PAGE_IDS, trackEvent } from './reporter'

const STORAGE_KEY = 'pmf_observations_v1'
const MAX_SCOPES = 64
const MAX_SEEN = 2_048
const MAX_AGE_MS = 90 * 24 * 60 * 60_000
const FRESH_BALANCE_MS = 30 * 60_000

type Domain = 'public' | 'private' | 'shield'

interface ScopeCheckpoint {
  baselineAt: number
  cutoffAt: number
  updatedAt: number
  seen: { key: string; timestamp: number }[]
  snapshotDays: Partial<Record<Domain, { day: string; quality: number }>>
}

type Checkpoints = Record<string, ScopeCheckpoint>
let tail: Promise<void> = Promise.resolve()
let cachedPriceReader: (() => Promise<AssetPriceReadModel>) | null = null

export function setObservationPriceReader(reader: () => Promise<AssetPriceReadModel>): void {
  cachedPriceReader = reader
}

function scopeKey(scope: { readonly keyDomainId: string; readonly accountId: string }): string {
  return `${DEFAULT_NETWORK}:${scope.keyDomainId}:${scope.accountId}`
}

function validCheckpoint(value: unknown): value is ScopeCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<ScopeCheckpoint>
  return (
    typeof entry.baselineAt === 'number' &&
    Number.isSafeInteger(entry.baselineAt) &&
    entry.baselineAt >= 0 &&
    typeof entry.cutoffAt === 'number' &&
    Number.isSafeInteger(entry.cutoffAt) &&
    entry.cutoffAt >= 0 &&
    typeof entry.updatedAt === 'number' &&
    Number.isSafeInteger(entry.updatedAt) &&
    entry.updatedAt >= 0 &&
    Array.isArray(entry.seen) &&
    entry.seen.length <= MAX_SEEN &&
    entry.seen.every(
      item =>
        !!item &&
        typeof item.key === 'string' &&
        item.key.length <= 256 &&
        Number.isSafeInteger(item.timestamp) &&
        item.timestamp >= 0
    ) &&
    !!entry.snapshotDays &&
    typeof entry.snapshotDays === 'object' &&
    Object.values(entry.snapshotDays).every(
      day =>
        !!day &&
        typeof day === 'object' &&
        typeof day.day === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(day.day) &&
        Number.isInteger(day.quality) &&
        day.quality >= 0 &&
        day.quality <= 2
    )
  )
}

async function withCheckpoint(
  scope: { readonly keyDomainId: string; readonly accountId: string },
  update: (checkpoint: ScopeCheckpoint | undefined, now: number) => ScopeCheckpoint | undefined
): Promise<void> {
  const work = tail
    .catch(() => {})
    .then(async () => {
      const now = Date.now()
      const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
      const raw =
        stored && typeof stored === 'object' && !Array.isArray(stored)
          ? (stored as Record<string, unknown>)
          : {}
      const checkpoints: Checkpoints = {}
      for (const [key, value] of Object.entries(raw)) {
        if (validCheckpoint(value) && now - value.updatedAt <= MAX_AGE_MS) checkpoints[key] = value
      }
      const key = scopeKey(scope)
      const next = update(checkpoints[key], now)
      if (!next) return
      checkpoints[key] = next
      const bounded = Object.fromEntries(
        Object.entries(checkpoints)
          .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
          .slice(0, MAX_SCOPES)
      )
      await chrome.storage.local.set({ [STORAGE_KEY]: bounded })
    })
  tail = work.catch(() => {})
  await work
}

interface Receipt {
  key: string
  timestamp: number
  assetId: string
  amountRaw: string
  decimals: number
  symbol?: string
  domain: Domain
  chain: 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'near'
  transferType: 'self' | 'unknown'
}

function amount(raw: string, decimals: number): string | null {
  if (
    !/^(0|[1-9]\d{0,127})$/.test(raw) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    return null
  }
  try {
    const display = formatBaseUnitDecimalAmount(raw, decimals)
    return display.length <= 128 ? display : null
  } catch {
    return null
  }
}

function activityReceipt(
  item: ActivityItem,
  assets: readonly PortfolioAssetView[]
): Receipt | null {
  if (
    item.status !== 'final' ||
    item.kind !== 'transfer' ||
    item.snapshot?.direction !== 'incoming' ||
    item.reconfirming ||
    !item.snapshot.primaryAmount ||
    item.snapshot.primaryAmount.amountRaw === '0'
  )
    return null
  const primary = item.snapshot.primaryAmount
  const metadata =
    primary.metadata ?? assets.find(asset => asset.asset.id === primary.assetId)?.metadata
  const chainId = primary.assetId.split('/')[0]
  const chain =
    chainId === getZcashChainId(DEFAULT_NETWORK)
      ? 'zcash'
      : chainId.startsWith('eip155:')
        ? 'evm'
        : chainId.startsWith('bip122:')
          ? 'bitcoin'
          : chainId.startsWith('solana:')
            ? 'solana'
            : chainId.startsWith('near:')
              ? 'near'
              : 'zcash'
  const domain: Domain =
    item.source === 'zcash-v1'
      ? item.assetDomains?.[0] === 'public'
        ? 'public'
        : 'shield'
      : item.accountMode === 'private'
        ? 'private'
        : 'public'
  const sender = item.snapshot.sender?.address.toLowerCase()
  const recipient = item.snapshot.recipient?.address.toLowerCase()
  const self = !!sender && !!recipient && sender === recipient
  const decimals = metadata?.decimals ?? (chain === 'zcash' ? 8 : -1)
  if (amount(primary.amountRaw, decimals) === null) return null
  return {
    key: `${item.source}:${item.id}`,
    timestamp: item.createdAt,
    assetId: primary.assetId,
    amountRaw: primary.amountRaw,
    decimals,
    symbol: metadata?.symbol ?? (chain === 'zcash' ? 'ZEC' : undefined),
    domain,
    chain,
    transferType: self ? 'self' : 'unknown'
  }
}

async function observeReceipts(
  scope: { readonly keyDomainId: string; readonly accountId: string },
  receipts: readonly Receipt[],
  prices?: AssetPriceReadModel
): Promise<void> {
  const freshQuotes = new Map(
    (prices?.quotes ?? [])
      .filter(quote => quote.freshness === 'fresh')
      .map(quote => [quote.assetId, quote.priceUsd])
  )
  const emitted: Receipt[] = []
  await withCheckpoint(scope, (previous, now) => {
    const keys = new Map((previous?.seen ?? []).map(item => [item.key, item.timestamp]))
    for (const receipt of receipts) {
      if (receipt.key.length > 256) continue
      if (
        previous &&
        !keys.has(receipt.key) &&
        receipt.timestamp > previous.baselineAt &&
        receipt.timestamp > previous.cutoffAt &&
        receipt.timestamp <= now + 60_000
      ) {
        emitted.push(receipt)
      }
      if (receipt.timestamp > (previous?.cutoffAt ?? 0)) keys.set(receipt.key, receipt.timestamp)
    }
    const sorted = [...keys]
      .map(([key, timestamp]) => ({ key, timestamp }))
      .sort((a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key))
    const seen = sorted.slice(-MAX_SEEN)
    if (
      previous &&
      emitted.length === 0 &&
      sorted.length <= MAX_SEEN &&
      seen.length === previous.seen.length &&
      seen.every(
        (item, index) =>
          item.key === previous.seen[index].key && item.timestamp === previous.seen[index].timestamp
      )
    )
      return undefined
    return {
      baselineAt: previous?.baselineAt ?? now,
      cutoffAt: Math.max(
        previous?.cutoffAt ?? 0,
        sorted.length > MAX_SEEN ? (seen[0]?.timestamp ?? 0) : 0
      ),
      updatedAt: now,
      seen,
      snapshotDays: previous?.snapshotDays ?? {}
    }
  })
  for (const receipt of emitted) {
    const outputAmount = amount(receipt.amountRaw, receipt.decimals)
    if (!outputAmount) continue
    const price = freshQuotes.get(receipt.assetId)
    const usdAmount = price ? new Big(outputAmount).times(price).toFixed() : undefined
    trackEvent(ANALYTICS_EVENTS.ASSET_RECEIVED, {
      pageId: PAGE_IDS.BACKGROUND,
      chain: receipt.chain,
      hasTransaction: 1,
      ...(receipt.symbol ? { outputSymbol: receipt.symbol } : {}),
      collector: {
        outputAmount,
        ...(usdAmount ? { usdAmount } : {}),
        destinationDomain: receipt.domain,
        transferType: receipt.transferType,
        activityType: 'receive',
        settlement: 'confirmed',
        valuation: usdAmount ? 'complete' : 'unavailable'
      }
    })
  }
}

export async function observeActivityReceipts(
  scope: ActivityScope,
  items: readonly ActivityItem[],
  prices?: AssetPriceReadModel,
  assets: readonly PortfolioAssetView[] = []
): Promise<void> {
  if (!CUSTOM_ANALYTICS_CONFIG.cryptoPassword) return
  await observeReceipts(
    scope,
    items.flatMap(item => {
      if (item.source === 'zcash-v1') return []
      const receipt = activityReceipt(item, assets)
      return receipt ? [receipt] : []
    }),
    prices
  )
}

export async function observeZcashReceipts(
  scope: { readonly keyDomainId: string; readonly accountId: string },
  transactions: readonly Transaction[],
  excludedTxHashes: ReadonlySet<string>,
  prices?: AssetPriceReadModel
): Promise<void> {
  if (!CUSTOM_ANALYTICS_CONFIG.cryptoPassword) return
  const currentPrices = prices ?? (await cachedPriceReader?.().catch(() => undefined))
  const receipts: Receipt[] = transactions.flatMap(transaction => {
    if (
      transaction.type !== 'receive' ||
      transaction.status !== 'success' ||
      transaction.network !== DEFAULT_NETWORK ||
      excludedTxHashes.has(transaction.txHash.toLowerCase())
    )
      return []
    const raw = amountFromZec(transaction.amount)
    if (!raw) return []
    return [
      {
        key: `zcash-v1:${transaction.id}`,
        timestamp: transaction.timestamp,
        assetId: createAssetId(parseChainId(getZcashChainId(DEFAULT_NETWORK)).id, 'slip44', '133'),
        amountRaw: raw,
        decimals: 8,
        symbol: 'ZEC',
        domain: transaction.fromType === 'transparent' ? ('public' as const) : ('shield' as const),
        chain: 'zcash' as const,
        transferType: 'unknown' as const
      }
    ]
  })
  await observeReceipts(scope, receipts, currentPrices)
}

function amountFromZec(value: string): string | null {
  if (!/^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) return null
  try {
    return new Big(value).times('100000000').toFixed(0)
  } catch {
    return null
  }
}

function assetDomainAmounts(
  asset: PortfolioAssetView,
  confidentialReady: boolean
): Partial<Record<Domain, string>> {
  if (asset.asset.chainId === getZcashChainId(DEFAULT_NETWORK)) {
    return { public: asset.balance.transparentRaw, shield: asset.balance.shieldedRaw }
  }
  if (asset.asset.chainId.startsWith('eip155:')) {
    return {
      public: asset.balance.mainRaw,
      private: asset.balance.privateOnchainRaw,
      shield: confidentialReady ? asset.balance.confidentialRaw : undefined
    }
  }
  return { public: asset.balance.totalRaw }
}

export async function observePortfolioBalances(
  model: PortfolioReadModel,
  prices: AssetPriceReadModel
): Promise<void> {
  if (!CUSTOM_ANALYTICS_CONFIG.cryptoPassword) return
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  const freshQuotes = new Map(
    prices.quotes
      .filter(quote => quote.freshness === 'fresh')
      .map(quote => [quote.assetId, quote.priceUsd])
  )
  const totals = new Map<
    Domain,
    {
      usd: Big
      observed: number
      pricedPositive: number
      missingPositive: number
      stale: boolean
    }
  >()
  for (const asset of model.assets) {
    const fresh =
      asset.freshness === 'fresh' &&
      asset.updatedAt > 0 &&
      now - asset.updatedAt <= FRESH_BALANCE_MS
    if (
      asset.asset.chainId.startsWith('eip155:') &&
      asset.balance.privateRaw !== undefined &&
      asset.balance.privateOnchainRaw === undefined
    ) {
      const privateEntry = totals.get('private') ?? {
        usd: new Big(0),
        observed: 0,
        pricedPositive: 0,
        missingPositive: 0,
        stale: false
      }
      privateEntry.stale = true
      totals.set('private', privateEntry)
    }
    for (const [domain, raw] of Object.entries(
      assetDomainAmounts(asset, model.confidential?.status === 'ready')
    ) as [Domain, string | undefined][]) {
      if (raw === undefined) continue
      const entry = totals.get(domain) ?? {
        usd: new Big(0),
        observed: 0,
        pricedPositive: 0,
        missingPositive: 0,
        stale: false
      }
      if (!fresh) {
        entry.stale = true
        totals.set(domain, entry)
        continue
      }
      entry.observed += 1
      if (raw === '0') {
        totals.set(domain, entry)
        continue
      }
      const display = amount(raw, asset.metadata.decimals)
      const price = freshQuotes.get(asset.asset.id)
      if (display !== null && price) {
        entry.usd = entry.usd.plus(new Big(display).times(price))
        entry.pricedPositive += 1
      } else entry.missingPositive += 1
      totals.set(domain, entry)
    }
  }
  if (model.confidential?.status === 'ready') {
    const represented = new Set<string>(
      model.assets.flatMap(asset =>
        asset.balance.confidentialRaw === undefined ? [] : [asset.asset.id]
      )
    )
    for (const holding of model.confidential.assets) {
      if (holding.assetId && represented.has(holding.assetId)) continue
      const entry = totals.get('shield') ?? {
        usd: new Big(0),
        observed: 0,
        pricedPositive: 0,
        missingPositive: 0,
        stale: false
      }
      entry.observed += 1
      if (holding.availableRaw !== '0') {
        const display =
          holding.decimals === undefined ? null : amount(holding.availableRaw, holding.decimals)
        const price = holding.assetId ? freshQuotes.get(holding.assetId) : undefined
        if (display !== null && price) {
          entry.usd = entry.usd.plus(new Big(display).times(price))
          entry.pricedPositive += 1
        } else entry.missingPositive += 1
      }
      totals.set('shield', entry)
    }
  } else if (
    model.confidential?.status === 'unavailable' &&
    model.assets.some(asset => asset.asset.chainId.startsWith('eip155:'))
  ) {
    const entry = totals.get('shield') ?? {
      usd: new Big(0),
      observed: 0,
      pricedPositive: 0,
      missingPositive: 0,
      stale: false
    }
    entry.stale = true
    totals.set('shield', entry)
  }
  const emitted: {
    domain: Domain
    usdAmount?: string
    valuation: 'complete' | 'partial' | 'unavailable'
  }[] = []
  await withCheckpoint(model.scope, (previous, time) => {
    const snapshotDays = { ...(previous?.snapshotDays ?? {}) }
    for (const [domain, entry] of totals) {
      if (!entry.observed) continue
      const valuation =
        (entry.missingPositive > 0 || entry.stale) && entry.pricedPositive === 0
          ? 'unavailable'
          : entry.missingPositive > 0 || entry.stale || model.status !== 'ready'
            ? 'partial'
            : 'complete'
      const quality = valuation === 'complete' ? 2 : valuation === 'partial' ? 1 : 0
      const last = snapshotDays[domain]
      if (last?.day === day && last.quality >= quality) continue
      emitted.push({
        domain,
        ...(valuation === 'unavailable' ? {} : { usdAmount: entry.usd.toFixed() }),
        valuation
      })
      snapshotDays[domain] = { day, quality }
    }
    if (previous && emitted.length === 0) return undefined
    return {
      baselineAt: previous?.baselineAt ?? time,
      cutoffAt: previous?.cutoffAt ?? 0,
      updatedAt: time,
      seen: previous?.seen ?? [],
      snapshotDays
    }
  })
  for (const item of emitted) {
    trackEvent(ANALYTICS_EVENTS.BALANCE_SNAPSHOT, {
      pageId: PAGE_IDS.BACKGROUND,
      collector: {
        ...(item.usdAmount === undefined ? {} : { usdAmount: item.usdAmount }),
        sourceDomain: item.domain,
        valuation: item.valuation,
        observationScope: 'active_account',
        chainScope: 'multichain'
      }
    })
  }
}
