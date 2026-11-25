import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import type { Network } from '@/types'
import type { DetectedEvmTokenCandidate } from './evm-token-discovery-client'

const DISCOVERY_INTERVAL_MS = 60_000
const FAILURE_RETRY_INTERVAL_MS = 3 * 60_000
const MAX_TIMING_ENTRIES = 256

interface DiscoveryTiming {
  readonly attemptedAt: number
  readonly failed: boolean
}

type DiscoveryCandidates = readonly DetectedEvmTokenCandidate[]
type DiscoveryResult = DiscoveryCandidates | undefined
type SessionStorage = Pick<chrome.storage.SessionStorageArea, 'get' | 'set'>

export class EvmTokenDiscoverySchedule {
  private readonly storageKey: string
  private readonly timing = new Map<string, DiscoveryTiming>()
  private readonly queue = new SerialTaskQueue()
  private readonly inFlight = new Map<string, DedupPromise<DiscoveryResult>>()
  private loaded = false

  constructor(
    network: Network,
    private readonly storage?: SessionStorage,
    private readonly now: () => number = Date.now
  ) {
    this.storageKey = `evm_token_discovery_timing_${network}_v1`
  }

  async run(
    address: string,
    chainIds: readonly string[],
    now: number,
    force: boolean,
    discover: (address: string, chainIds: readonly string[]) => Promise<DiscoveryCandidates>
  ): Promise<DiscoveryCandidates> {
    const canonicalAddress = address.toLowerCase()
    const canonicalChains = [...new Set(chainIds)].sort()
    const targetKey = JSON.stringify([canonicalAddress, canonicalChains])
    const pending = this.inFlight.get(targetKey) ?? new DedupPromise<DiscoveryResult>()
    this.inFlight.set(targetKey, pending)
    let result: DiscoveryResult
    try {
      result = await pending.run(async () => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(targetKey))
        const key = Array.from(new Uint8Array(digest), byte =>
          byte.toString(16).padStart(2, '0')
        ).join('')
        const attempt = await this.queue.run(async () => {
          await this.load()
          const previous = this.timing.get(key)
          const current = previous && previous.attemptedAt <= now ? previous : undefined
          if (current && !force) {
            const interval = current.failed ? FAILURE_RETRY_INTERVAL_MS : DISCOVERY_INTERVAL_MS
            if (now - current.attemptedAt < interval) return undefined
          }
          const timing = { attemptedAt: now, failed: current?.failed ?? false }
          await this.save(key, timing)
          return timing
        })
        if (!attempt) return undefined

        let candidates: DiscoveryCandidates = []
        let failed = false
        try {
          candidates = await discover(canonicalAddress, canonicalChains)
        } catch {
          failed = true
        }
        if (failed || attempt.failed) {
          const attemptedAt = failed ? Math.max(now, this.now()) : now
          await this.queue.run(() => this.save(key, { attemptedAt, failed }))
        }
        return candidates
      })
    } finally {
      if (!pending.isPending && this.inFlight.get(targetKey) === pending) {
        this.inFlight.delete(targetKey)
      }
    }
    return result ?? (force ? this.run(canonicalAddress, canonicalChains, now, true, discover) : [])
  }

  private get session(): SessionStorage | undefined {
    return this.storage ?? globalThis.chrome?.storage?.session
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const snapshot: unknown = (await this.session?.get(this.storageKey).catch(() => undefined))?.[
      this.storageKey
    ]
    if (!Array.isArray(snapshot)) return
    for (const entry of snapshot.slice(-MAX_TIMING_ENTRIES)) {
      if (!Array.isArray(entry) || entry.length !== 3) continue
      const [key, attemptedAt, failures] = entry
      if (
        typeof key === 'string' &&
        /^[0-9a-f]{64}$/.test(key) &&
        Number.isSafeInteger(attemptedAt) &&
        attemptedAt >= 0 &&
        Number.isSafeInteger(failures) &&
        failures >= 0
      ) {
        this.timing.set(key, { attemptedAt, failed: failures > 0 })
      }
    }
  }

  private async save(key: string, timing: DiscoveryTiming): Promise<void> {
    this.timing.delete(key)
    this.timing.set(key, timing)
    if (this.timing.size > MAX_TIMING_ENTRIES) {
      const oldest = this.timing.keys().next()
      if (!oldest.done) this.timing.delete(oldest.value)
    }
    await this.session
      ?.set({
        [this.storageKey]: Array.from(this.timing, ([key, timing]) => [
          key,
          timing.attemptedAt,
          Number(timing.failed)
        ])
      })
      .catch(() => {})
  }
}
