export type McaCacheStatus = {
  mcaId: string | null
  publicKey: string | null
  signingMode: 'derived' | 'legacy' | 'legacy_index0'
}

const mcaStatusCache = new Map<string, McaCacheStatus>()
const mcaCheckInFlight = new Map<string, Promise<McaCacheStatus>>()

export function getMcaCacheKey(
  walletId: string,
  accountId: string,
  executionMode: 'main' | 'private' = 'main'
): string {
  return `${walletId}:${accountId}:${executionMode}`
}

export function clearZcashMcaCache(walletId?: string, accountId?: string): void {
  if (walletId && accountId) {
    for (const key of mcaStatusCache.keys()) {
      if (key.startsWith(`${walletId}:${accountId}:`)) mcaStatusCache.delete(key)
    }
    for (const key of mcaCheckInFlight.keys()) {
      if (key.startsWith(`${walletId}:${accountId}:`)) mcaCheckInFlight.delete(key)
    }
    return
  }
  if (walletId) {
    for (const key of mcaStatusCache.keys()) {
      if (key.startsWith(`${walletId}:`)) {
        mcaStatusCache.delete(key)
      }
    }
    return
  }
  mcaStatusCache.clear()
  mcaCheckInFlight.clear()
}

export function runMcaCheckDeduped(
  cacheKey: string,
  operation: () => Promise<McaCacheStatus>
): Promise<McaCacheStatus> {
  const cached = mcaStatusCache.get(cacheKey)
  if (cached) {
    return Promise.resolve(cached)
  }

  const pending = mcaCheckInFlight.get(cacheKey)
  if (pending) {
    return pending
  }

  const promise = operation()
    .then(result => {
      if (result.mcaId) {
        mcaStatusCache.set(cacheKey, result)
      } else {
        mcaStatusCache.delete(cacheKey)
      }
      return result
    })
    .finally(() => {
      if (mcaCheckInFlight.get(cacheKey) === promise) {
        mcaCheckInFlight.delete(cacheKey)
      }
    })

  mcaCheckInFlight.set(cacheKey, promise)
  return promise
}
