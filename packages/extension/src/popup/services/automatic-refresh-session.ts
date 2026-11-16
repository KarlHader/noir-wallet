const STORAGE_KEY = 'popup_automatic_refresh_attempts_v1'
const STORAGE_LOCK = 'noir-popup-automatic-refresh-attempts'
const SCHEMA_VERSION = 1
const MAX_ENTRIES = 512
const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000

interface SessionStorageArea {
  readonly get: (keys: string | string[]) => Promise<Record<string, unknown>>
  readonly set: (items: Record<string, unknown>) => Promise<void>
}

interface RefreshAttemptRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly attempts: Readonly<Record<string, number>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAttempts(value: unknown, now: number): Map<string, number> {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !isRecord(value.attempts)) {
    return new Map()
  }

  const minimumTimestamp = Math.max(0, now - MAX_ENTRY_AGE_MS)
  return new Map(
    Object.entries(value.attempts)
      .filter(
        (entry): entry is [string, number] =>
          entry[0].length > 0 &&
          entry[0].length <= 768 &&
          typeof entry[1] === 'number' &&
          Number.isSafeInteger(entry[1]) &&
          entry[1] >= minimumTimestamp &&
          entry[1] <= now
      )
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_ENTRIES)
  )
}

function serializeAttempts(attempts: ReadonlyMap<string, number>): RefreshAttemptRecord {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    attempts: Object.freeze(Object.fromEntries(attempts))
  })
}

function stableScopeHash(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function attemptKey(scope: string, resource: string): string {
  if (
    scope.length === 0 ||
    scope.length > 16_384 ||
    resource.length === 0 ||
    resource.length > 256
  ) {
    throw new Error('Invalid automatic refresh scope')
  }
  return `${stableScopeHash(scope)}:${resource}`
}

async function withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) return operation()
  return await navigator.locks.request(STORAGE_LOCK, operation)
}

export class AutomaticRefreshSession {
  private readonly fallbackAttempts = new Map<string, number>()
  private storageWriteFailed = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly storage?: SessionStorageArea) {}

  claim(
    scope: string,
    resources: readonly string[],
    now = Date.now(),
    cooldownMs = 60_000
  ): Promise<readonly string[]> {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(cooldownMs) ||
      cooldownMs < 0
    ) {
      return Promise.reject(new Error('Invalid automatic refresh timing'))
    }
    if (new Set(resources).size !== resources.length) {
      return Promise.reject(new Error('Duplicate automatic refresh resource'))
    }
    if (resources.length === 0) return Promise.resolve(Object.freeze([]))

    const operation = this.queue.then(() =>
      withStorageLock(async () => {
        let attempts = new Map(this.fallbackAttempts)
        const storage =
          this.storage ?? (typeof chrome === 'undefined' ? undefined : chrome.storage.session)
        if (storage) {
          try {
            const stored = await storage.get(STORAGE_KEY)
            const persisted = parseAttempts(stored[STORAGE_KEY], now)
            if (this.storageWriteFailed) {
              for (const [key, attemptedAt] of persisted) {
                attempts.set(key, Math.max(attempts.get(key) ?? 0, attemptedAt))
              }
            } else {
              attempts = persisted
            }
          } catch {
            // Session storage can be unavailable during extension reload. The in-memory
            // fallback still prevents duplicate requests in the current Popup lifecycle.
          }
        }

        const claimed = resources.filter(resource => {
          const key = attemptKey(scope, resource)
          const lastAttemptAt = attempts.get(key)
          if (lastAttemptAt !== undefined && now - lastAttemptAt < cooldownMs) return false
          attempts.set(key, now)
          return true
        })

        this.fallbackAttempts.clear()
        for (const [key, attemptedAt] of [...attempts.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, MAX_ENTRIES)) {
          this.fallbackAttempts.set(key, attemptedAt)
        }

        if (claimed.length > 0 && storage) {
          try {
            await storage.set({ [STORAGE_KEY]: serializeAttempts(this.fallbackAttempts) })
            this.storageWriteFailed = false
          } catch {
            this.storageWriteFailed = true
            // The fallback map above remains authoritative until session storage recovers.
          }
        }
        return Object.freeze(claimed)
      })
    )

    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  release(scope: string, resources: readonly string[], now = Date.now()): Promise<void> {
    if (!Number.isSafeInteger(now) || now < 0) {
      return Promise.reject(new Error('Invalid automatic refresh timing'))
    }
    if (new Set(resources).size !== resources.length) {
      return Promise.reject(new Error('Duplicate automatic refresh resource'))
    }
    if (resources.length === 0) return Promise.resolve()

    const operation = this.queue.then(() =>
      withStorageLock(async () => {
        let attempts = new Map(this.fallbackAttempts)
        const storage =
          this.storage ?? (typeof chrome === 'undefined' ? undefined : chrome.storage.session)
        if (storage) {
          try {
            const stored = await storage.get(STORAGE_KEY)
            const persisted = parseAttempts(stored[STORAGE_KEY], now)
            if (this.storageWriteFailed) {
              for (const [key, attemptedAt] of persisted) {
                attempts.set(key, Math.max(attempts.get(key) ?? 0, attemptedAt))
              }
            } else {
              attempts = persisted
            }
          } catch {
            // The in-memory state remains sufficient to release the current Popup claim.
          }
        }

        for (const resource of resources) attempts.delete(attemptKey(scope, resource))
        this.fallbackAttempts.clear()
        for (const [key, attemptedAt] of attempts) this.fallbackAttempts.set(key, attemptedAt)

        if (storage) {
          try {
            await storage.set({ [STORAGE_KEY]: serializeAttempts(this.fallbackAttempts) })
            this.storageWriteFailed = false
          } catch {
            this.storageWriteFailed = true
            // The released in-memory claim still permits retry in the current lifecycle.
          }
        }
      })
    )

    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}

export const automaticRefreshSession = new AutomaticRefreshSession()
