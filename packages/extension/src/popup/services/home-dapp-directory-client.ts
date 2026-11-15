import {
  DAPP_DIRECTORY_CACHE_TTL_MS,
  DAPP_DIRECTORY_FETCH_TIMEOUT_MS,
  DAPP_DIRECTORY_URL
} from '@/config/dapp-directory'
import { DedupPromise } from '@/lib/async-utils'

const STORAGE_KEY = 'home_dapp_directory_v1'
const MAX_DAPPS = 20

export interface HomeDApp {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly url: string
  readonly iconUrl: string
  readonly origin: string
}

interface CachedDirectory {
  readonly fetchedAt: number
  readonly dapps: readonly HomeDApp[]
}

let cachedDirectory: CachedDirectory | null = null
let cacheHydrated = false
let lastFailedAt = 0
const cacheRead = new DedupPromise<void>()
const remoteRead = new DedupPromise<readonly HomeDApp[]>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2_048 || !/^https:\/\//i.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

function parseDirectory(value: unknown): readonly HomeDApp[] | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.dapps)) return null
  if (value.dapps.length === 0 || value.dapps.length > MAX_DAPPS) return null

  const ids = new Set<string>()
  const dapps: HomeDApp[] = []
  for (const item of value.dapps) {
    if (!isRecord(item)) return null
    const url = httpsUrl(item.url)
    const iconUrl = httpsUrl(item.iconUrl)
    if (
      !nonEmptyText(item.id, 80) ||
      !nonEmptyText(item.name, 80) ||
      !nonEmptyText(item.category, 40) ||
      !url ||
      !iconUrl ||
      ids.has(item.id.trim())
    ) {
      return null
    }
    const id = item.id.trim()
    ids.add(id)
    dapps.push({
      id,
      name: item.name.trim(),
      category: item.category.trim(),
      url: url.href,
      iconUrl: iconUrl.href,
      origin: url.origin
    })
  }
  return dapps
}

export function getCachedHomeDApps(): readonly HomeDApp[] | null {
  return cachedDirectory?.dapps ?? null
}

export async function loadCachedHomeDApps(): Promise<readonly HomeDApp[] | null> {
  if (cacheHydrated) return getCachedHomeDApps()
  await cacheRead.run(async () => {
    if (cacheHydrated) return
    try {
      const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
      if (
        isRecord(stored) &&
        Number.isSafeInteger(stored.fetchedAt) &&
        (stored.fetchedAt as number) > 0 &&
        (stored.fetchedAt as number) <= Date.now()
      ) {
        const dapps = parseDirectory(stored)
        if (
          dapps &&
          (!cachedDirectory || cachedDirectory.fetchedAt < (stored.fetchedAt as number))
        ) {
          cachedDirectory = { fetchedAt: stored.fetchedAt as number, dapps }
        }
      }
    } catch {
      // A storage failure should not prevent a fresh directory read.
    } finally {
      cacheHydrated = true
    }
  })
  return getCachedHomeDApps()
}

export async function refreshHomeDApps(force = false): Promise<readonly HomeDApp[]> {
  await loadCachedHomeDApps()
  const now = Date.now()
  if (!force && cachedDirectory && now - cachedDirectory.fetchedAt < DAPP_DIRECTORY_CACHE_TTL_MS) {
    return cachedDirectory.dapps
  }
  if (!force && lastFailedAt && now - lastFailedAt < DAPP_DIRECTORY_CACHE_TTL_MS) {
    throw new Error('DApp directory is temporarily unavailable')
  }

  return remoteRead.run(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DAPP_DIRECTORY_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(DAPP_DIRECTORY_URL, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`DApp directory returned HTTP ${response.status}`)
      const dapps = parseDirectory(await response.json())
      if (!dapps) throw new Error('DApp directory returned an invalid document')
      const fetchedAt = Date.now()
      cachedDirectory = { fetchedAt, dapps }
      lastFailedAt = 0
      void chrome.storage.local
        .set({
          [STORAGE_KEY]: {
            version: 1,
            fetchedAt,
            dapps: dapps.map(({ id, name, category, url, iconUrl }) => ({
              id,
              name,
              category,
              url,
              iconUrl
            }))
          }
        })
        .catch(() => {})
      return dapps
    } catch (error) {
      lastFailedAt = Date.now()
      throw error
    } finally {
      clearTimeout(timer)
    }
  })
}
