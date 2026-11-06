import type { Network } from '@/types'

export interface PendingRequest {
  id: string
  origin: string
  action: string
  data: any
  walletId: string
  accountId: string
  network: Network
  authorizationRevision: number
  timestamp: number
}

interface PendingRequestEntry {
  readonly request: PendingRequest
  readonly expiryTimer: ReturnType<typeof setTimeout>
  cancelListener?: () => void
}

export const EVM_GAS_FUNDING_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000

export class PendingRequestsManager {
  private requests = new Map<string, PendingRequestEntry>()

  /**
   * Create a pending request and return its ID.
   * Captures walletId/accountId at creation time so the correct wallet
   * is used even if the user switches accounts before approval.
   */
  create(
    origin: string,
    action: string,
    data: any,
    walletId: string,
    accountId: string,
    network: Network,
    authorizationRevision: number
  ): string {
    const id = crypto.randomUUID()

    const request = {
      id,
      origin,
      action,
      data,
      walletId,
      accountId,
      network,
      authorizationRevision,
      timestamp: Date.now()
    }

    const expiryTimer = setTimeout(
      () => this.cancel(id),
      action === 'evmGasFunding' ? EVM_GAS_FUNDING_APPROVAL_TIMEOUT_MS : 5 * 60 * 1000
    )
    this.requests.set(id, { request, expiryTimer })

    return id
  }

  /**
   * Get a pending request without removing it
   */
  get(id: string): PendingRequest | null {
    return this.requests.get(id)?.request ?? null
  }

  updateData(id: string, data: unknown): boolean {
    const entry = this.requests.get(id)
    if (!entry) return false
    entry.request.data = data
    return true
  }

  /**
   * Get and remove a pending request
   */
  consume(id: string): PendingRequest | null {
    const entry = this.take(id)
    return entry?.request ?? null
  }

  complete(id: string): void {
    this.take(id)
  }

  onCancel(id: string, listener: () => void): () => void {
    const entry = this.requests.get(id)
    if (!entry) {
      listener()
      return () => {}
    }
    entry.cancelListener = listener
    return () => {
      const current = this.requests.get(id)
      if (current?.cancelListener === listener) current.cancelListener = undefined
    }
  }

  /**
   * Cancel a pending request
   */
  cancel(id: string): void {
    const entry = this.take(id)
    entry?.cancelListener?.()
  }

  cancelExceptContext(walletId: string, accountId: string): number {
    let cancelled = 0
    for (const entry of [...this.requests.values()]) {
      if (entry.request.walletId === walletId && entry.request.accountId === accountId) continue
      this.cancel(entry.request.id)
      cancelled += 1
    }
    return cancelled
  }

  cancelContext(walletId: string, accountId?: string): number {
    let cancelled = 0
    for (const entry of [...this.requests.values()]) {
      if (
        entry.request.walletId === walletId &&
        (accountId === undefined || entry.request.accountId === accountId)
      ) {
        this.cancel(entry.request.id)
        cancelled += 1
      }
    }
    return cancelled
  }

  countContext(
    walletId: string,
    accountId: string,
    matchesAction: (action: string) => boolean = () => true
  ): number {
    let count = 0
    for (const entry of this.requests.values()) {
      if (
        entry.request.walletId === walletId &&
        entry.request.accountId === accountId &&
        matchesAction(entry.request.action)
      ) {
        count += 1
      }
    }
    return count
  }

  cancelContextMatching(
    walletId: string,
    accountId: string,
    matchesAction: (action: string) => boolean
  ): number {
    let cancelled = 0
    for (const entry of [...this.requests.values()]) {
      if (
        entry.request.walletId !== walletId ||
        entry.request.accountId !== accountId ||
        !matchesAction(entry.request.action)
      ) {
        continue
      }
      this.cancel(entry.request.id)
      cancelled += 1
    }
    return cancelled
  }

  cancelOrigin(origin: string, matchesAction: (action: string) => boolean = () => true): number {
    let cancelled = 0
    for (const entry of [...this.requests.values()]) {
      if (entry.request.origin !== origin || !matchesAction(entry.request.action)) continue
      this.cancel(entry.request.id)
      cancelled += 1
    }
    return cancelled
  }

  cancelAll(): number {
    const ids = [...this.requests.keys()]
    ids.forEach(id => this.cancel(id))
    return ids.length
  }

  private take(id: string): PendingRequestEntry | null {
    const entry = this.requests.get(id)
    if (!entry) return null
    this.requests.delete(id)
    clearTimeout(entry.expiryTimer)
    return entry
  }
}

export const pendingRequestsManager = new PendingRequestsManager()
