/** UI analytics API. Reporting and delivery run in the background service worker. */

import {
  ANALYTICS_EVENTS,
  PAGE_IDS,
  resolveAnalyticsChain,
  resolvePageId,
  type AnalyticsEventName
} from './constants'
import { sanitizeAnalyticsEvent } from './policy'
import type { AnalyticsMessage, TrackOptions } from './types'

export { ANALYTICS_EVENTS, PAGE_IDS, resolveAnalyticsChain, resolvePageId }
export type { AnalyticsChain, AnalyticsEventName } from './constants'
export type { AnalyticsMessage, TrackOptions }

/** Last page seen by this UI context; default for events without a pageId. */
let currentPageId: string | null = null
let takeUiEngagement: (() => number) | null = null

export function registerAnalyticsEngagementProvider(provider: () => number): () => void {
  takeUiEngagement = provider
  return () => {
    if (takeUiEngagement === provider) takeUiEngagement = null
  }
}

function takeBoundedUiEngagement(): number {
  return Math.min(3_600_000, Math.max(0, Math.floor(takeUiEngagement?.() ?? 0)))
}

/** Tracks an event from popup/approval/tab contexts. */
export function sendAnalyticsEvent(name: AnalyticsEventName, options: TrackOptions = {}): void {
  try {
    const event = sanitizeAnalyticsEvent(name, {
      ...options,
      pageId: options.pageId ?? currentPageId ?? PAGE_IDS.HOME
    })
    if (!event) return
    const message: AnalyticsMessage = {
      type: 'ANALYTICS_EVENT',
      name: event.name,
      engagementTimeMsec: takeBoundedUiEngagement(),
      options: event.options,
      timestamp: Date.now()
    }
    void chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    // Analytics messaging must not affect the caller.
  }
}

/** Tracks a page view from popup/approval/tab contexts. */
export function sendAnalyticsPageView(page: string): void {
  try {
    currentPageId = resolvePageId(page)
    const message: AnalyticsMessage = {
      type: 'ANALYTICS_PAGE_VIEW',
      engagementTimeMsec: takeBoundedUiEngagement(),
      page,
      timestamp: Date.now()
    }
    void chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    // Analytics messaging must not affect the caller.
  }
}
