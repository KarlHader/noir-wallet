import { DedupPromise } from '../../lib/async-utils'
import {
  FEE_QUOTE_TTL_MS,
  MARGINAL_FEE_ZATS,
  isValidMarginalFeeZats,
  marginalFeeForTier,
  type FeeQuote
} from '../../config/fee'

export interface FeeQuoteContext {
  walletId: string
  accountId: number
  network: string
  rpcUrl: string
}

interface QuoteEntry {
  context: FeeQuoteContext
  quote: FeeQuote
}

function contextKey(context: FeeQuoteContext): string {
  return JSON.stringify([context.network, context.walletId, context.accountId, context.rpcUrl])
}

/** Keeps approved rates in the worker so extension messages cannot invent a fee. */
export class FeeQuoteRegistry {
  private readonly entries = new Map<string, QuoteEntry>()
  private readonly pending = new Map<string, DedupPromise<FeeQuote>>()
  private readonly generations = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID()
  ) {}

  async get(context: FeeQuoteContext, recommend: () => Promise<number>): Promise<FeeQuote> {
    for (const [id, entry] of this.entries) {
      if (entry.quote.expiresAt <= this.now()) this.entries.delete(id)
    }
    const generation = this.generations.get(context.walletId) ?? 0
    const contextId = contextKey(context)
    const key = `${contextId}:${generation}`
    const existing = [...this.entries.values()].find(
      entry => contextKey(entry.context) === contextId
    )
    if (existing) return { ...existing.quote }

    let dedup = this.pending.get(key)
    if (!dedup) {
      dedup = new DedupPromise<FeeQuote>()
      this.pending.set(key, dedup)
    }
    try {
      return await dedup.run(async () => {
        let standardMarginalFeeZats = MARGINAL_FEE_ZATS.standard
        try {
          const recommended = await recommend()
          if (isValidMarginalFeeZats(recommended)) standardMarginalFeeZats = recommended
        } catch {
          // Old lightwalletd servers do not implement GetStandardFee.
        }
        if ((this.generations.get(context.walletId) ?? 0) !== generation) {
          throw new Error('Wallet changed. Review the network fee again.')
        }
        const quote: FeeQuote = {
          id: this.createId(),
          standardMarginalFeeZats,
          expiresAt: this.now() + FEE_QUOTE_TTL_MS
        }
        this.entries.set(quote.id, { context: { ...context }, quote })
        return { ...quote }
      })
    } finally {
      if (!dedup.isPending && this.pending.get(key) === dedup) this.pending.delete(key)
    }
  }

  validate(context: FeeQuoteContext, id: string | undefined, marginalFeeZats: unknown): FeeQuote {
    const entry = typeof id === 'string' ? this.entries.get(id) : undefined
    if (
      !entry ||
      entry.quote.expiresAt <= this.now() ||
      contextKey(entry.context) !== contextKey(context)
    ) {
      throw new Error('Network fee expired or changed. Review the updated fee before confirming.')
    }
    if (
      marginalFeeZats !== marginalFeeForTier('standard', entry.quote.standardMarginalFeeZats) &&
      marginalFeeZats !== marginalFeeForTier('fast', entry.quote.standardMarginalFeeZats)
    ) {
      throw new Error('Network fee does not match the approved quote')
    }
    return { ...entry.quote }
  }

  invalidateWallet(walletId: string): void {
    this.generations.set(walletId, (this.generations.get(walletId) ?? 0) + 1)
    for (const [id, entry] of this.entries) {
      if (entry.context.walletId === walletId) this.entries.delete(id)
    }
  }
}
