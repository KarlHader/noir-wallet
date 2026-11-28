/**
 * The site's one way into localStorage. Keys are namespaced and versioned, like
 * "shield-win.campaign.v1". Every call survives a missing or blocked storage (private windows, no
 * window at all, a full quota): reads return null and writes do nothing. Pass a storage of your
 * own in tests.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/** A stored JSON value, or null when it is missing, unreadable or rejected by `parse` */
export function readStored<T>(
  key: string,
  parse: (value: unknown) => T | null,
  storage: KeyValueStorage | null = browserStorage()
): T | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (raw === null) return null
    return parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeStored(
  key: string,
  value: unknown,
  storage: KeyValueStorage | null = browserStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}

export function removeStored(
  key: string,
  storage: KeyValueStorage | null = browserStorage()
): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    return
  }
}
