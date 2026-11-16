type Host = { chrome?: unknown }

const keysOf = (keys: string | string[]): string[] => (Array.isArray(keys) ? keys : [keys])

// Node 22 has a `navigator` without `locks`; this stand-in queues requests per lock name like the
// real Web Locks API, so read-modify-write races surface in tests instead of passing by luck.
export function installLockEnv(): () => void {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'locks')
  const tails = new Map<string, Promise<unknown>>()
  const locks = {
    request<T>(name: string, operation: () => Promise<T>): Promise<T> {
      const run = (tails.get(name) ?? Promise.resolve()).then(operation, operation)
      tails.set(
        name,
        run.catch(() => undefined)
      )
      return run
    }
  }
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
  return () => {
    if (previous) Object.defineProperty(navigator, 'locks', previous)
    else delete (navigator as { locks?: unknown }).locks
  }
}

// In-memory `chrome.storage.local` plus the lock stand-in. Values are structured-cloned on the way
// in and out, like the real storage area.
export function installStorageEnv(): { store: Map<string, unknown>; restore(): void } {
  const host = globalThis as Host
  const originalChrome = host.chrome
  const store = new Map<string, unknown>()
  host.chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            keysOf(keys)
              .filter(key => store.has(key))
              .map(key => [key, structuredClone(store.get(key))])
          ),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value))
        },
        remove: async (keys: string | string[]) => {
          for (const key of keysOf(keys)) store.delete(key)
        }
      }
    }
  }
  const restoreLocks = installLockEnv()
  return {
    store,
    restore() {
      restoreLocks()
      if (originalChrome === undefined) delete host.chrome
      else host.chrome = originalChrome
    }
  }
}
