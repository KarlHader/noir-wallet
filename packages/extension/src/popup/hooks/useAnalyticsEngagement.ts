import { useEffect } from 'react'
import {
  ANALYTICS_EVENTS,
  registerAnalyticsEngagementProvider,
  sendAnalyticsEvent
} from '@/lib/analytics'
import { ForegroundEngagementTracker } from '@/lib/analytics/engagement'

/** Measures only focused, visible extension time; background scans are not engagement. */
export function useAnalyticsEngagement(): void {
  useEffect(() => {
    const isActive = () => document.visibilityState === 'visible' && document.hasFocus()
    const tracker = new ForegroundEngagementTracker(isActive(), Date.now())
    const unregister = registerAnalyticsEngagementProvider(() => tracker.take(Date.now()))
    const flush = () => {
      if (tracker.pending(Date.now()) >= 1_000)
        sendAnalyticsEvent(ANALYTICS_EVENTS.EXTENSION_ENGAGEMENT)
    }
    const update = () => {
      tracker.setActive(isActive(), Date.now())
      if (!isActive()) flush()
    }
    const hide = () => {
      tracker.setActive(false, Date.now())
      flush()
    }
    const checkpoint = window.setInterval(() => {
      if (isActive() && tracker.pending(Date.now()) >= 60_000) flush()
    }, 60_000)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    window.addEventListener('pagehide', hide)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(checkpoint)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      window.removeEventListener('pagehide', hide)
      document.removeEventListener('visibilitychange', update)
      hide()
      unregister()
    }
  }, [])
}
