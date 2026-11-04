import { DedupPromise } from '@/lib/async-utils'
import { createChromeStorageAdapter } from '@/lib/chrome-storage-adapter'
import { fetchBlobWithTimeout, fetchJsonWithTimeout } from '@/lib/fetch-utils'

const AD_API_URL = 'https://api.zknoir.com/v1/ad'

export interface HomeAd {
  title: string
  text: string
  imageUrl: string
  jumpUrl: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null

  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function parseHomeAd(value: unknown): HomeAd | null {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.text !== 'string') {
    return null
  }

  const title = value.title.trim()
  const text = value.text.trim()
  const imageUrl = readHttpsUrl(value.image_url)
  const jumpUrl = readHttpsUrl(value.jump_url)

  if (!title || !text || !imageUrl || !jumpUrl) return null

  return { title, text, imageUrl, jumpUrl }
}

export function parseHomeAdResponse(value: unknown): HomeAd | null {
  if (!isRecord(value) || value.code !== 0 || !Array.isArray(value.data)) return null

  for (const item of value.data) {
    const ad = parseHomeAd(item)
    if (ad) return ad
  }

  return null
}

export async function fetchHomeAd(): Promise<HomeAd | null> {
  const response = await fetchJsonWithTimeout(AD_API_URL, {
    timeoutMs: 10_000,
    maxBytes: 256 * 1024
  })
  if (!isRecord(response) || response.code !== 0 || !Array.isArray(response.data)) {
    throw new Error('Invalid advertisement response')
  }
  const ad = parseHomeAdResponse(response)
  if (!ad && response.data.length > 0) throw new Error('Invalid advertisement data')
  return ad
}

export interface LoadedHomeAd extends HomeAd {
  imageSrc: string
}

const CACHE_KEY = 'home_ad_cache_v1'
const cacheStorage = createChromeStorageAdapter('local')
const refreshDedup = new DedupPromise<LoadedHomeAd | null>()
let cachedAd: LoadedHomeAd | null = null

// Read locally as soon as the ad module loads, without delaying wallet initialization.
const homeAdCacheReady = cacheStorage
  .getItem(CACHE_KEY)
  .then(value => {
    cachedAd = parseCachedAd(value)
  })
  .catch(() => {})

export function readCachedHomeAd(): LoadedHomeAd | null {
  return cachedAd
}

function parseCachedAd(cached: unknown): LoadedHomeAd | null {
  if (
    !isRecord(cached) ||
    typeof cached.imageSrc !== 'string' ||
    !cached.imageSrc.startsWith('data:image/')
  ) {
    return null
  }
  const ad = parseHomeAd({
    title: cached.title,
    text: cached.text,
    image_url: cached.imageUrl,
    jump_url: cached.jumpUrl
  })
  return ad ? { ...ad, imageSrc: cached.imageSrc } : null
}

async function cacheAd(ad: LoadedHomeAd | null): Promise<void> {
  cachedAd = ad
  try {
    if (ad) await cacheStorage.setItem(CACHE_KEY, ad)
    else await cacheStorage.removeItem(CACHE_KEY)
  } catch {
    // Storage availability must not prevent displaying a downloaded advertisement.
  }
}

export async function loadHomeAd(onUpdate: (ad: LoadedHomeAd | null) => void): Promise<void> {
  await homeAdCacheReady
  onUpdate(cachedAd)
  const nextAd = await refreshDedup.run(async () => {
    const ad = await fetchHomeAd()
    if (!ad) {
      await cacheAd(null)
      return null
    }

    const image = await fetchBlobWithTimeout(ad.imageUrl, {
      timeoutMs: 10_000,
      maxBytes: 5 * 1024 * 1024
    })
    if (!image.type.startsWith('image/')) throw new Error('Invalid advertisement image type')

    // Persist the image too: an object URL cannot survive closing the popup.
    const imageSrc = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(image)
    })
    const decodedImage = new Image()
    decodedImage.src = imageSrc
    await decodedImage.decode()

    const loadedAd = { ...ad, imageSrc }
    await cacheAd(loadedAd)
    return loadedAd
  })
  onUpdate(nextAd)
}
