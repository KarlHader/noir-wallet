const FAILED_ICON_TTL_MS = 5 * 60 * 1000
const MAX_FAILED_ICON_URLS = 2_048

const failedIconUrls = new Map<string, number>()

export function hasTokenIconUrlFailed(url: string, now = Date.now()): boolean {
  const expiresAt = failedIconUrls.get(url)
  if (expiresAt === undefined) return false
  if (expiresAt > now) return true
  failedIconUrls.delete(url)
  return false
}

export function recordTokenIconUrlFailure(url: string, now = Date.now()): void {
  failedIconUrls.delete(url)
  failedIconUrls.set(url, now + FAILED_ICON_TTL_MS)
  if (failedIconUrls.size <= MAX_FAILED_ICON_URLS) return
  const oldestUrl = failedIconUrls.keys().next().value
  if (typeof oldestUrl === 'string') failedIconUrls.delete(oldestUrl)
}

export function clearTokenIconUrlFailure(url: string): void {
  failedIconUrls.delete(url)
}
