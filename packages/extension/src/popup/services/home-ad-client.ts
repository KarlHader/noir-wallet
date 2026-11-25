import { DedupPromise } from '@/lib/async-utils'
import { fetchJsonWithTimeout, fetchWithTimeout } from '@/lib/fetch-utils'

const HOME_AD_URL = 'https://api.zknoir.com/v1/ad'
const CACHE_KEY = 'home_ad_cache_v1'
const REQUEST_OPTIONS = { timeoutMs: 10_000, credentials: 'omit' } as const

interface HomeAd {
  title: string
  text: string
  imageUrl: string
  jumpUrl: string
}

export interface LoadedHomeAd extends HomeAd {
  imageSrc: string
}

const refresh = new DedupPromise<LoadedHomeAd | null>()
let cacheReady: Promise<void> | undefined
let cachedAd: LoadedHomeAd | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href
  } catch {
    return undefined
  }
}

function readAd(
  value: Record<string, unknown>,
  imageUrl: unknown,
  jumpUrl: unknown
): HomeAd | null {
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  const image = readHttpsUrl(imageUrl)
  const jump = readHttpsUrl(jumpUrl)
  return title && text && image && jump ? { title, text, imageUrl: image, jumpUrl: jump } : null
}

function readCachedAd(value: unknown): LoadedHomeAd | null {
  if (
    !isRecord(value) ||
    typeof value.imageSrc !== 'string' ||
    !value.imageSrc.startsWith('data:image/')
  ) {
    return null
  }
  const ad = readAd(value, value.imageUrl, value.jumpUrl)
  return ad ? { ...ad, imageSrc: value.imageSrc } : null
}

async function fetchHomeAd(): Promise<HomeAd | null> {
  const response = await fetchJsonWithTimeout(HOME_AD_URL, {
    ...REQUEST_OPTIONS,
    maxBytes: 256 * 1024
  })
  if (!isRecord(response) || response.code !== 0 || !Array.isArray(response.data)) {
    throw new Error('Invalid home banner response')
  }
  for (const entry of response.data) {
    if (!isRecord(entry)) continue
    const ad = readAd(entry, entry.image_url, entry.jump_url)
    if (ad) return ad
  }
  if (response.data.length) throw new Error('Invalid home banner data')
  return null
}

async function loadImage(url: string): Promise<string> {
  const response = await fetchWithTimeout(url, { ...REQUEST_OPTIONS, maxBytes: 5 * 1024 * 1024 })
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error('Invalid home banner image type')

  const imageSrc = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  const image = new Image()
  image.src = imageSrc
  await image.decode()
  return imageSrc
}

async function restoreCache(): Promise<void> {
  try {
    const values = await chrome.storage.local.get(CACHE_KEY)
    cachedAd = readCachedAd(values[CACHE_KEY])
  } catch {
    cachedAd = null
  }
}

async function storeCache(ad: LoadedHomeAd | null): Promise<void> {
  cachedAd = ad
  try {
    if (ad) await chrome.storage.local.set({ [CACHE_KEY]: ad })
    else await chrome.storage.local.remove(CACHE_KEY)
  } catch {
    return
  }
}

export function readCachedHomeAd(): LoadedHomeAd | null {
  return cachedAd
}

export async function loadHomeAd(onUpdate: (ad: LoadedHomeAd | null) => void): Promise<void> {
  await (cacheReady ??= restoreCache())
  onUpdate(cachedAd)

  const nextAd = await refresh.run(async () => {
    const ad = await fetchHomeAd()
    const next = ad ? { ...ad, imageSrc: await loadImage(ad.imageUrl) } : null
    await storeCache(next)
    return next
  })
  onUpdate(nextAd)
}
