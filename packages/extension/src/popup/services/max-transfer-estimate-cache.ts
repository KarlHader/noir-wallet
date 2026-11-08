import { DedupPromise } from '@/lib/async-utils'
import { marginalFeeForTier } from '@/core/zcash/fee-policy'
import type { FeeQuote, FeeTier } from '@/config/fee'
import type { FundingSource } from '@/types'
import { zcashWalletRuntimeClient, type MaxTransferEstimate } from './zcash-wallet-runtime-client'

export interface MaxTransferContext {
  readonly memo?: string
  readonly fundingSource: FundingSource
  readonly enabled: boolean
  readonly walletId: string | null
  readonly accountId: string | null
  readonly network: string
  readonly available: string
  readonly pending: string
  readonly rpcPreference: unknown
  readonly rpcScope: string
}

type Client = Pick<typeof zcashWalletRuntimeClient, 'getFeeQuote' | 'estimateMaxTransfer'>

function entryKey(to: string, tier: FeeTier): string {
  return JSON.stringify([to, tier])
}

function contextKey(context: MaxTransferContext): string {
  return JSON.stringify([
    context.memo,
    context.fundingSource,
    context.enabled,
    context.walletId,
    context.accountId,
    context.network,
    context.available,
    context.pending,
    context.rpcPreference,
    context.rpcScope
  ])
}

function validEstimate(
  estimate: MaxTransferEstimate,
  tier: FeeTier,
  now: number,
  quoteId?: string
): boolean {
  return (
    !!estimate.feeQuote &&
    (quoteId === undefined || estimate.feeQuote.id === quoteId) &&
    estimate.feeQuote.expiresAt > now &&
    Number(estimate.marginalFeeZats) ===
      marginalFeeForTier(tier, estimate.feeQuote.standardMarginalFeeZats) &&
    /^(0|[1-9]\d*)$/.test(estimate.maxAmountZats) &&
    /^[1-9]\d*$/.test(estimate.feeZats)
  )
}

export class MaxTransferEstimateCache {
  private context: MaxTransferContext
  private scope: string
  private generation = 0
  private quote: FeeQuote | null = null
  private quoteRequest = new DedupPromise<FeeQuote>()
  private estimates = new Map<string, MaxTransferEstimate>()
  private pending = new Map<string, Promise<MaxTransferEstimate | null>>()
  private errors = new Set<string>()
  private revisions = new Map<string, number>()

  constructor(
    context: MaxTransferContext,
    private readonly onChange: () => void = () => {},
    private readonly client: Client = zcashWalletRuntimeClient,
    private readonly now: () => number = Date.now
  ) {
    this.context = context
    this.scope = contextKey(context)
  }

  get scopeKey(): string {
    return this.scope
  }

  setContext(context: MaxTransferContext): void {
    const nextScope = contextKey(context)
    if (nextScope === this.scope) return
    this.context = context
    this.scope = nextScope
    this.generation += 1
    this.quote = null
    this.quoteRequest = new DedupPromise<FeeQuote>()
    this.estimates.clear()
    this.pending.clear()
    this.errors.clear()
    this.revisions.clear()
  }

  peek(
    to: string,
    tier: FeeTier
  ): {
    estimate: MaxTransferEstimate | null
    pending: boolean
    error: boolean
  } {
    const key = entryKey(to, tier)
    const estimate = this.estimates.get(key)
    return {
      estimate:
        this.context.enabled &&
        estimate &&
        validEstimate(estimate, tier, this.now(), this.quote?.id)
          ? estimate
          : null,
      pending: this.pending.has(key),
      error: this.errors.has(key)
    }
  }

  async get(
    to: string,
    tier: FeeTier,
    retry = false,
    refresh = false
  ): Promise<MaxTransferEstimate | null> {
    if (!this.context.enabled || !to) return null
    if (refresh) this.refresh()
    const key = entryKey(to, tier)
    const current = this.peek(to, tier).estimate
    if (current) return current
    const pending = this.pending.get(key)
    if (pending) return pending
    if (this.errors.has(key) && !retry) return null

    this.errors.delete(key)
    const generation = this.generation
    const revision = this.revisions.get(key) ?? 0
    const { memo, fundingSource } = this.context
    const promise = (async () => {
      try {
        const quote = await this.getQuote(generation)
        if (!quote || generation !== this.generation) return null
        const estimate = await this.client.estimateMaxTransfer({
          to,
          memo,
          fundingSource,
          marginalFeeZats: marginalFeeForTier(tier, quote.standardMarginalFeeZats),
          feeQuoteId: quote.id
        })
        if (generation !== this.generation) return null
        if ((this.revisions.get(key) ?? 0) !== revision) return this.peek(to, tier).estimate
        if (!validEstimate(estimate, tier, this.now(), quote.id) || this.quote?.id !== quote.id)
          throw new Error('Invalid maximum transfer fee estimate')
        this.estimates.set(key, estimate)
        this.onChange()
        return estimate
      } catch {
        if (generation === this.generation && (this.revisions.get(key) ?? 0) === revision) {
          this.errors.add(key)
          this.onChange()
        }
        return null
      } finally {
        if (generation === this.generation) {
          this.pending.delete(key)
          this.onChange()
        }
      }
    })()
    this.pending.set(key, promise)
    this.onChange()
    return promise
  }

  update(to: string, tier: FeeTier, estimate: MaxTransferEstimate): void {
    if (!this.context.enabled || !to) return
    const key = entryKey(to, tier)
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    if (!validEstimate(estimate, tier, this.now())) {
      this.estimates.delete(key)
      this.errors.add(key)
    } else {
      if (this.quote?.id !== estimate.feeQuote.id) {
        this.estimates.clear()
        this.errors.clear()
      }
      this.quote = estimate.feeQuote
      this.estimates.set(key, estimate)
      this.errors.delete(key)
    }
    this.onChange()
  }

  private refresh(): void {
    this.generation += 1
    this.quote = null
    this.quoteRequest = new DedupPromise<FeeQuote>()
    this.estimates.clear()
    this.pending.clear()
    this.errors.clear()
    this.revisions.clear()
    this.onChange()
  }

  private async getQuote(generation: number): Promise<FeeQuote | null> {
    if (this.quote && this.quote.expiresAt > this.now()) return this.quote
    const quote = await this.quoteRequest.run(() => this.client.getFeeQuote())
    if (generation !== this.generation) return null
    if (this.quote && this.quote.expiresAt > this.now()) return this.quote
    if (quote.expiresAt <= this.now()) throw new Error('Expired maximum transfer fee quote')
    this.quote = quote
    this.estimates.clear()
    return quote
  }
}
