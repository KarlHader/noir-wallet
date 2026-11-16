import { ANALYTICS_COUNTRY_ENDPOINT, GA_CONFIG } from '../../config/analytics'
import { isGoogleAnalyticsEnabled } from './preferences'

const COUNTRY_CACHE_MS = 45 * 60 * 1000
const COUNTRY_FAILURE_CACHE_MS = 60 * 1000
const COUNTRY_TIMEOUT_MS = 2500
const COUNTRY_CACHE_KEY = 'ga_country_cache'

let cacheWrite: Promise<void> = Promise.resolve()
let inFlight: Promise<string | undefined> | undefined
let controller: AbortController | undefined
let generation = 0

function parseCountry(country: unknown): string | undefined {
  return typeof country === 'string' &&
    /^[A-Z]{2}$/.test(country) &&
    country !== 'XX' &&
    country !== 'ZZ'
    ? country
    : undefined
}

export async function getAnalyticsCountry(): Promise<string | undefined> {
  const requestedGeneration = generation
  if (!GA_CONFIG.apiSecret || !(await isGoogleAnalyticsEnabled())) return undefined
  if (requestedGeneration !== generation) return undefined
  if (inFlight) return inFlight

  const currentGeneration = generation
  const lookup = (async (): Promise<string | undefined> => {
    await cacheWrite
    const stored = await chrome.storage.session
      .get(COUNTRY_CACHE_KEY)
      .catch((): Record<string, unknown> => ({}))
    if (!(await isGoogleAnalyticsEnabled()) || currentGeneration !== generation) return undefined

    const cached = stored[COUNTRY_CACHE_KEY] as
      | { country_id?: unknown; expiresAt?: unknown }
      | undefined
    if (
      typeof cached?.expiresAt === 'number' &&
      Number.isFinite(cached.expiresAt) &&
      Date.now() < cached.expiresAt
    ) {
      return parseCountry(cached.country_id)
    }

    const abortController = new AbortController()
    controller = abortController
    let country: string | undefined
    let cacheDuration = COUNTRY_CACHE_MS
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const trace = await Promise.race([
        (async () => {
          const response = await fetch(ANALYTICS_COUNTRY_ENDPOINT, {
            method: 'GET',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
            redirect: 'error',
            signal: abortController.signal
          })
          if (!response.ok) throw new Error('Analytics country lookup failed')
          return response.text()
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            abortController.abort()
            reject(new Error('Analytics country lookup timed out'))
          }, COUNTRY_TIMEOUT_MS)
        })
      ])
      if (trace.length > 4096) throw new Error('Analytics country response is too large')
      country = parseCountry(trace.match(/^loc=([A-Z]{2})\r?$/m)?.[1])
      if (!country) cacheDuration = COUNTRY_FAILURE_CACHE_MS
    } catch {
      cacheDuration = COUNTRY_FAILURE_CACHE_MS
    } finally {
      if (timeout) clearTimeout(timeout)
      if (controller === abortController) controller = undefined
    }
    if (!(await isGoogleAnalyticsEnabled()) || currentGeneration !== generation) return undefined

    cacheWrite = chrome.storage.session
      .set({
        [COUNTRY_CACHE_KEY]: { country_id: country ?? null, expiresAt: Date.now() + cacheDuration }
      })
      .catch(() => {})
    await cacheWrite
    return (await isGoogleAnalyticsEnabled()) && currentGeneration === generation
      ? country
      : undefined
  })()

  inFlight = lookup
  void lookup.then(
    () => {
      if (inFlight === lookup) inFlight = undefined
    },
    () => {
      if (inFlight === lookup) inFlight = undefined
    }
  )
  return lookup
}

export function stopAnalyticsCountryLookup(): Promise<void> {
  generation++
  controller?.abort()
  controller = undefined
  inFlight = undefined
  cacheWrite = cacheWrite
    .then(() => chrome.storage.session.remove(COUNTRY_CACHE_KEY))
    .catch(() => {})
  return cacheWrite
}
