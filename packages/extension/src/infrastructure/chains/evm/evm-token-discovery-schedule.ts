import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import type { Network } from '@/types'
import type { DetectedEvmTokenCandidate } from './evm-token-discovery-client'

const DISCOVERY_INTERVAL_MS = 5 * 60_000
const MAX_FAILURE_DELAY_MS = 30 * 60_000
const MAX_FAILURE_COUNT = 3
const MAX_TIMING_ENTRIES = 256

interface DiscoveryTiming {
  readonly attemptedAt: number
  readonly failures: number
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
    private readonly storage?: SessionStorage
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
            const interval = Math.min(
              DISCOVERY_INTERVAL_MS * 2 ** current.failures,
              MAX_FAILURE_DELAY_MS
            )
            if (now - current.attemptedAt < interval) return undefined
          }
          const timing = { attemptedAt: now, failures: current?.failures ?? 0 }
          await this.save(key, timing)
          return timing
        })
        if (!attempt) return undefined

        let failures = 0
        let candidates: DiscoveryCandidates = []
        try {
          candidates = await discover(canonicalAddress, canonicalChains)
        } catch {
          failures = Math.min(attempt.failures + 1, MAX_FAILURE_COUNT)
        }
        if (attempt.failures !== failures) {
          await this.queue.run(() => this.save(key, { attemptedAt: now, failures }))
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
        Number.isInteger(failures) &&
        failures >= 0 &&
        failures <= MAX_FAILURE_COUNT
      ) {
        this.timing.set(key, { attemptedAt, failures })
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
          timing.failures
        ])
      })
      .catch(() => {})
  }
}
