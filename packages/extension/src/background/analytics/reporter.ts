/** Background-owned analytics reporting, persistence and delivery lifecycle. */
import {
  ANALYTICS_CHAIN,
  ANALYTICS_EVENTS,
  PAGE_IDS,
  buildAnalyticsPageMetadata,
  type AnalyticsEventName
} from '../../lib/analytics/constants'
import {
  ANALYTICS_OUTBOX_ALARM,
  enqueueAnalyticsEvent,
  handleAnalyticsOutboxAlarm,
  initializeAnalyticsOutbox
} from '../../lib/analytics/client'
import { getAnalyticsDeviceMetadata } from '../../lib/analytics/device'
import { getClientId, sendGaEvent, stopGoogleAnalyticsReporting } from '../../lib/analytics/ga'
import { buildPayload } from '../../lib/analytics/payload'
import {
  isGoogleAnalyticsEnabled,
  onGoogleAnalyticsPreferenceChange
} from '../../lib/analytics/preferences'
import { sanitizeAnalyticsEvent } from '../../lib/analytics/policy'
import type {
  AnalyticsEventPayload,
  AnalyticsMessage,
  TrackOptions
} from '../../lib/analytics/types'

export { ANALYTICS_OUTBOX_ALARM, ANALYTICS_EVENTS, PAGE_IDS }

let initialized = false
let initialization: Promise<void> | null = null
const recentGaEvents = new Set<string>()
const MAX_RECENT_GA_EVENTS = 500

async function reportGaEvent(
  name: string,
  params: Record<string, unknown>,
  foreground: boolean,
  idempotencyKey?: string
): Promise<void> {
  try {
    if (!(await isGoogleAnalyticsEnabled())) return
    if (idempotencyKey) {
      const key = `${name}:${idempotencyKey}`
      if (recentGaEvents.has(key)) return
      recentGaEvents.add(key)
      if (recentGaEvents.size > MAX_RECENT_GA_EVENTS) {
        const oldest = recentGaEvents.values().next().value
        if (oldest) recentGaEvents.delete(oldest)
      }
    }
    await sendGaEvent(name, params, { foreground })
  } catch {
    // GA failures never affect a wallet operation.
  }
}

export function initializeAnalyticsReporting(): Promise<void> {
  if (initialization) return initialization
  if (!initialized) {
    initialized = true
    onGoogleAnalyticsPreferenceChange(enabled => {
      if (!enabled) {
        recentGaEvents.clear()
        void stopGoogleAnalyticsReporting().catch(() => {})
      }
    })
  }
  initialization = (async () => {
    const enabled = await isGoogleAnalyticsEnabled()
    if (!enabled) await stopGoogleAnalyticsReporting()
    await initializeAnalyticsOutbox()
  })().catch(error => {
    initialization = null
    throw error
  })
  return initialization
}

export function handleAnalyticsAlarm(alarmName: string): Promise<boolean> {
  return handleAnalyticsOutboxAlarm(alarmName)
}

function withRuntimeMetadata(params?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...params,
    ...getAnalyticsDeviceMetadata(),
    event_id: crypto.randomUUID(),
    extension_version: __APP_VERSION__,
    build_channel: __BUILD_CHANNEL__,
    network_mode: __NETWORK_MODE__
  }
}

async function finalizeAndEnqueue(
  payload: AnalyticsEventPayload,
  idempotencyKey?: string
): Promise<void> {
  try {
    payload.wallet_address = `anon_${await getClientId()}`
    await enqueueAnalyticsEvent(payload, idempotencyKey)
  } catch {
    // Collector failures never affect a wallet operation.
  }
}

export function trackEvent(
  name: AnalyticsEventName,
  options: TrackOptions = {},
  timestamp?: number
): void {
  reportEvent(name, options, timestamp, false)
}

function reportEvent(
  name: string,
  options: TrackOptions,
  timestamp: number | undefined,
  foreground: boolean,
  engagementTimeMsec?: number
): void {
  try {
    const event = sanitizeAnalyticsEvent(name, options)
    if (!event) return
    const params = withRuntimeMetadata({
      ...event.options.params,
      ...event.options.extra,
      page_id: event.options.pageId,
      chain: event.options.chain ?? ANALYTICS_CHAIN,
      ...(foreground && engagementTimeMsec ? { engagement_time_msec: engagementTimeMsec } : {})
    })
    const payload = buildPayload(event.name, { ...event.options, params }, timestamp)
    void reportGaEvent(event.name, params, foreground, event.options.idempotencyKey)
    void finalizeAndEnqueue(payload, event.options.idempotencyKey)
  } catch {
    // Invalid analytics context must not affect the caller.
  }
}

/** Reports a canonical page view to GA and a show_page event to the collector. */
export function trackPageView(page: string, timestamp?: number, engagementTimeMsec?: number): void {
  try {
    const { pageId, pageLocation, pageTitle } = buildAnalyticsPageMetadata(page)
    const params = withRuntimeMetadata({
      ...(engagementTimeMsec ? { engagement_time_msec: engagementTimeMsec } : {}),
      page_id: pageId,
      page_location: pageLocation,
      page_title: pageTitle,
      chain: ANALYTICS_CHAIN
    })
    void reportGaEvent('page_view', params, true)
    void finalizeAndEnqueue(buildPayload(ANALYTICS_EVENTS.SHOW_PAGE, { pageId, params }, timestamp))
  } catch {
    // Invalid analytics context must not affect the caller.
  }
}

export function handleAnalyticsMessage(message: AnalyticsMessage): void {
  if (message.type === 'ANALYTICS_EVENT') {
    reportEvent(
      message.name,
      message.options ?? {},
      message.timestamp,
      true,
      message.engagementTimeMsec
    )
  }
  if (message.type === 'ANALYTICS_PAGE_VIEW') {
    trackPageView(message.page, message.timestamp, message.engagementTimeMsec)
  }
}
