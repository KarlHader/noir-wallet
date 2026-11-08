import { DedupPromise } from '@/lib/async-utils'
import type { QuoteDepositMaximum } from './quote-deposit-transfer-client'

const MAXIMUM_ESTIMATE_TTL_MS = 30_000

/** Shares only fresh estimates for the currently active transfer context. */
export class TransferMaximumEstimateCache {
  private scope: string | null = null
  private revision = 0
  private value: QuoteDepositMaximum | null = null
  private pending = new DedupPromise<QuoteDepositMaximum>()

  constructor(private readonly now: () => number = Date.now) {}

  setScope(scope: string | null): void {
    if (this.scope === scope) return
    this.scope = scope
    this.revision += 1
    this.value = null
    this.pending = new DedupPromise<QuoteDepositMaximum>()
  }

  read(scope: string): QuoteDepositMaximum | null {
    return this.scope === scope && this.value && (this.value.expiresAt ?? 0) > this.now()
      ? this.value
      : null
  }

  update(scope: string, value: QuoteDepositMaximum): QuoteDepositMaximum {
    if (this.scope !== scope) throw new Error('The maximum estimate context has changed')
    this.revision += 1
    this.pending = new DedupPromise<QuoteDepositMaximum>()
    return this.store(value)
  }

  private store(value: QuoteDepositMaximum): QuoteDepositMaximum {
    const expiresAt = Math.min(value.expiresAt ?? Infinity, this.now() + MAXIMUM_ESTIMATE_TTL_MS)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now())
      throw new Error('The maximum estimate has expired. Try again.')
    const result = { ...value, expiresAt }
    this.value = result
    return result
  }

  async request(
    scope: string,
    estimate: () => Promise<QuoteDepositMaximum>
  ): Promise<QuoteDepositMaximum> {
    if (this.scope !== scope) throw new Error('The maximum estimate context has changed')
    const cached = this.read(scope)
    if (cached) return cached
    const revision = this.revision
    return this.pending.run(async () => {
      const value = await estimate()
      if (revision !== this.revision || this.scope !== scope) return value
      return this.store(value)
    })
  }
}
