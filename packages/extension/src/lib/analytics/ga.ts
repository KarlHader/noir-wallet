/**
 * Google Analytics 4 Measurement Protocol reporter.
 * Runs only in the background service worker.
 */

declare const __APP_VERSION__: string

import { GA_CONFIG } from '@/config/analytics'
import { DedupPromise } from '@/lib/async-utils'
import { sanitizeAnalyticsMetadata } from './payload'
import { getAnalyticsCountry, stopAnalyticsCountryLookup } from './geo'
import { isGoogleAnalyticsEnabled } from './preferences'
import {
  decideAnalyticsSession,
  parseAnalyticsSessionState,
  type AnalyticsSessionState
} from './session'

let cachedClientId: string | null = null
const clientIdLoad = new DedupPromise<string>()
let cachedSessionState: AnalyticsSessionState | null | undefined
let sessionQueue: Promise<unknown> = Promise.resolve()
const activeRequests = new Set<AbortController>()
const SESSION_STATE_STORAGE_KEY = 'ga_session_state'
const LEGACY_SESSION_STORAGE_KEY = 'ga_session_id'

interface GaEventContext {
  appVersion: string
  buildChannel: string
  foreground: boolean
  networkMode: string
  sessionId?: string
}

interface GaDeliveryContext {
  foreground: boolean
}

interface GaDevice {
  browser?: string
  browser_version?: string
  category?: string
  language?: string
  model?: string
  operating_system?: string
}

export function buildGaEventParams(
  name: string,
  params: Record<string, unknown> | undefined,
  context: GaEventContext
): Record<string, string | number | boolean> {
  const sanitized = sanitizeAnalyticsMetadata(params)
  delete sanitized.browser
  delete sanitized.device_category
  delete sanitized.language
  delete sanitized.operating_system
  if (!context.foreground) {
    delete sanitized.engagement_time_msec
  } else if (name === 'page_view') {
    const measured =
      typeof sanitized.engagement_time_msec === 'number' ? sanitized.engagement_time_msec : 0
    sanitized.engagement_time_msec = Math.max(100, measured)
  }

  const common = {
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
    extension_version: context.appVersion,
    build_channel: context.buildChannel,
    network_mode: context.networkMode
  }
  const details = Object.entries(sanitized).filter(([key]) => !(key in common))
  return {
    ...common,
    ...Object.fromEntries(details.slice(0, 25 - Object.keys(common).length))
  }
}

export function buildGaDevice(params: Record<string, unknown> | undefined): GaDevice {
  const sanitized = sanitizeAnalyticsMetadata(params)
  return {
    ...(typeof sanitized.browser === 'string' ? { browser: sanitized.browser } : {}),
    ...(typeof sanitized.browser_major_version === 'string'
      ? { browser_version: sanitized.browser_major_version }
      : {}),
    ...(typeof sanitized.device_category === 'string'
      ? { category: sanitized.device_category, model: 'Desktop' }
      : {}),
    ...(typeof sanitized.language === 'string' ? { language: sanitized.language } : {}),
    ...(typeof sanitized.operating_system === 'string'
      ? { operating_system: sanitized.operating_system }
      : {})
  }
}

/** Random per-install UUID, shared with the custom channel as anonymous id. */
export async function getClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId
  return await clientIdLoad.run(
    async () => {
      const result = await chrome.storage.local.get('ga_client_id')
      if (typeof result.ga_client_id === 'string' && result.ga_client_id.length > 0) {
        return result.ga_client_id
      }
      const id = crypto.randomUUID()
      await chrome.storage.local.set({ ga_client_id: id })
      return id
    },
    id => {
      cachedClientId = id
    }
  )
}

/** GA accepts dotted numeric client IDs; keep the persisted install ID unchanged. */
export async function toGaClientId(installId: string): Promise<string> {
  if (/^\d+\.\d+$/.test(installId)) return installId
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(installId))
  const words = new DataView(digest)
  return `${words.getUint32(0, false)}.${words.getUint32(4, false)}`
}

function runSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionQueue.then(operation, operation)
  sessionQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function loadSessionState(): Promise<AnalyticsSessionState | null> {
  if (cachedSessionState !== undefined) return cachedSessionState

  const stored = await chrome.storage.session.get([
    SESSION_STATE_STORAGE_KEY,
    LEGACY_SESSION_STORAGE_KEY
  ])
  cachedSessionState = parseAnalyticsSessionState(stored[SESSION_STATE_STORAGE_KEY])
  if (stored[LEGACY_SESSION_STORAGE_KEY] !== undefined) {
    await chrome.storage.session.remove(LEGACY_SESSION_STORAGE_KEY)
  }
  return cachedSessionState
}

export async function getGaSessionId(
  foreground: boolean,
  now = Date.now()
): Promise<string | undefined> {
  return await runSessionOperation(async () => {
    const current = await loadSessionState()
    const decision = decideAnalyticsSession(current, foreground, now)
    cachedSessionState = decision.state

    if (decision.shouldPersist) {
      if (decision.state) {
        await chrome.storage.session.set({ [SESSION_STATE_STORAGE_KEY]: decision.state })
      } else {
        await chrome.storage.session.remove(SESSION_STATE_STORAGE_KEY)
      }
    }
    return decision.sessionId
  })
}

export async function sendGaEvent(
  name: string,
  params?: Record<string, unknown>,
  delivery: GaDeliveryContext = { foreground: false }
): Promise<void> {
  let abortController: AbortController | null = null
  try {
    if (!__ANALYTICS_REPORTING_ENABLED__) return
    if (!GA_CONFIG.apiSecret) return
    if (!(await isGoogleAnalyticsEnabled())) return

    const clientId = await getClientId()
    const sid = await getGaSessionId(delivery.foreground)
    if (!(await isGoogleAnalyticsEnabled())) return

    const country = await getAnalyticsCountry()
    if (!(await isGoogleAnalyticsEnabled())) return

    const body = {
      client_id: await toGaClientId(clientId),
      device: buildGaDevice(params),
      ...(country ? { user_location: { country_id: country } } : {}),
      events: [
        {
          name,
          params: buildGaEventParams(name, params, {
            sessionId: sid,
            appVersion: __APP_VERSION__,
            buildChannel: __BUILD_CHANNEL__,
            foreground: delivery.foreground,
            networkMode: __NETWORK_MODE__
          })
        }
      ]
    }
    if (!(await isGoogleAnalyticsEnabled())) return

    abortController = new AbortController()
    activeRequests.add(abortController)
    await fetch(
      `${GA_CONFIG.endpoint}?measurement_id=${GA_CONFIG.measurementId}&api_secret=${GA_CONFIG.apiSecret}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortController.signal
      }
    )
  } catch {
    // Silently ignore analytics errors
  } finally {
    if (abortController) {
      activeRequests.delete(abortController)
    }
  }
}

/** Aborts active Google reports and clears their session after GA is disabled. */
export async function stopGoogleAnalyticsReporting(): Promise<void> {
  const countryCleanup = stopAnalyticsCountryLookup()
  for (const request of activeRequests) {
    request.abort()
  }
  activeRequests.clear()
  await runSessionOperation(async () => {
    cachedSessionState = null
    await chrome.storage.session.remove([SESSION_STATE_STORAGE_KEY, LEGACY_SESSION_STORAGE_KEY])
  })
  await countryCleanup
}
