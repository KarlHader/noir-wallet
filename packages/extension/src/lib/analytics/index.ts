/**
 * Unified analytics API — dual-channel reporting:
 * 1. Google Analytics 4 (Measurement Protocol) — event name + params
 * 2. Custom collector (encrypted) — full payload with page/amount context
 *
 * UI contexts (popup, approval window, tabs) call `sendAnalytics*`, which
 * forwards through chrome.runtime messaging; the background service worker
 * performs the actual network reporting via `track*`.
 */

import { ANALYTICS_EVENTS, PAGE_IDS, resolvePageId } from './constants'
import { buildPayload, sanitizeAnalyticsMetadata } from './payload'
import { enqueueAnalyticsEvent } from './client'
import { getClientId, sendGaEvent, stopGoogleAnalyticsReporting } from './ga'
import { getAnalyticsDeviceMetadata } from './device'
import { isGoogleAnalyticsEnabled, onGoogleAnalyticsPreferenceChange } from './preferences'
import type { AnalyticsEventPayload, AnalyticsMessage, TrackOptions } from './types'

export { ANALYTICS_EVENTS, PAGE_IDS, resolvePageId }
export type { AnalyticsMessage, TrackOptions }

/** Last page seen by this UI context; default for events without a pageId. */
let currentPageId: string | null = null
let takeUiEngagement: (() => number) | null = null

function withRuntimeMetadata(
  params: Record<string, unknown> | undefined,
  foreground: boolean
): Record<string, unknown> {
  const device = getAnalyticsDeviceMetadata()
  const normalizedParams = { ...params }
  if (!foreground) delete normalizedParams.engagement_time_msec

  return {
    ...normalizedParams,
    ...device,
    event_id: crypto.randomUUID(),
    extension_version: __APP_VERSION__,
    build_channel: __BUILD_CHANNEL__,
    network_mode: __NETWORK_MODE__
  }
}

function takeBoundedUiEngagement(): number {
  return Math.min(3_600_000, Math.max(0, Math.floor(takeUiEngagement?.() ?? 0)))
}

export function registerAnalyticsEngagementProvider(provider: () => number): () => void {
  takeUiEngagement = provider
  return () => {
    if (takeUiEngagement === provider) takeUiEngagement = null
  }
}

onGoogleAnalyticsPreferenceChange(enabled => {
  if (!enabled) {
    void stopGoogleAnalyticsReporting()
  }
})

void isGoogleAnalyticsEnabled().then(enabled => {
  if (!enabled) {
    void stopGoogleAnalyticsReporting()
  }
})

// ============================================================
// Background context: performs the actual reporting
// ============================================================

/**
 * The collector requires wallet_address, so use the random per-install
 * analytics identifier. A real wallet address must never cross this boundary.
 */
async function finalizeAndEnqueue(payload: AnalyticsEventPayload): Promise<void> {
  payload.wallet_address = `anon_${await getClientId()}`
  enqueueAnalyticsEvent(payload)
}

/** Reports an event to both channels. Background service worker only. */
export function trackEvent(name: string, options: TrackOptions = {}, timestamp?: number): void {
  reportEvent(name, options, timestamp, false)
}

function reportEvent(
  name: string,
  options: TrackOptions,
  timestamp: number | undefined,
  foreground: boolean
): void {
  try {
    if (!__ANALYTICS_REPORTING_ENABLED__) return
    const enrichedOptions = {
      ...options,
      params: withRuntimeMetadata(
        {
          ...sanitizeAnalyticsMetadata(options.params, options.extra),
          ...(options.inputSymbol ? { from_token: options.inputSymbol } : {}),
          ...(options.outputSymbol ? { to_token: options.outputSymbol } : {}),
          ...(foreground && options.pageId ? { page_id: options.pageId } : {})
        },
        foreground
      )
    }
    void sendGaEvent(name, enrichedOptions.params, { foreground })
    void finalizeAndEnqueue(buildPayload(name, enrichedOptions, timestamp)).catch(() => {})
  } catch {
    // Analytics must never break wallet flows
  }
}

/** Reports a page view: GA `page_view` + custom `show_page`. */
export function trackPageView(page: string, timestamp?: number, engagementTimeMsec?: number): void {
  try {
    if (!__ANALYTICS_REPORTING_ENABLED__) return
    const params = withRuntimeMetadata(
      {
        ...(engagementTimeMsec ? { engagement_time_msec: engagementTimeMsec } : {}),
        page_location: `https://noir-wallet.extension${page}`,
        page_title: page
      },
      true
    )
    void sendGaEvent('page_view', params, { foreground: true })
    void finalizeAndEnqueue(
      buildPayload(ANALYTICS_EVENTS.SHOW_PAGE, { pageId: resolvePageId(page), params }, timestamp)
    ).catch(() => {})
  } catch {
    // Analytics must never break wallet flows
  }
}

/** Routes ANALYTICS_* runtime messages to the reporters. Background only. */
export function handleAnalyticsMessage(message: AnalyticsMessage): void {
  if (message.type === 'ANALYTICS_EVENT') {
    reportEvent(message.name, message.options ?? {}, message.timestamp, true)
  } else if (message.type === 'ANALYTICS_PAGE_VIEW') {
    trackPageView(message.page, message.timestamp, message.engagementTimeMsec)
  }
}

// ============================================================
// UI contexts: forward to background via runtime messaging
// ============================================================

/** Tracks an event from popup/approval/tab contexts. */
export function sendAnalyticsEvent(name: string, options: TrackOptions = {}): void {
  const timestamp = Date.now()
  const engagementTimeMsec = takeBoundedUiEngagement()
  const message: AnalyticsMessage = {
    type: 'ANALYTICS_EVENT',
    name,
    options: {
      ...options,
      pageId: options.pageId ?? currentPageId ?? PAGE_IDS.HOME,
      params: {
        ...options.params,
        ...(engagementTimeMsec > 0 ? { engagement_time_msec: engagementTimeMsec } : {})
      }
    },
    timestamp
  }
  chrome.runtime.sendMessage(message).catch(() => {})
}

/** Tracks a page view from popup/approval/tab contexts. */
export function sendAnalyticsPageView(page: string): void {
  currentPageId = resolvePageId(page)
  const engagementTimeMsec = takeBoundedUiEngagement()
  const message: AnalyticsMessage = {
    type: 'ANALYTICS_PAGE_VIEW',
    ...(engagementTimeMsec > 0 ? { engagementTimeMsec } : {}),
    page,
    timestamp: Date.now()
  }
  chrome.runtime.sendMessage(message).catch(() => {})
}
