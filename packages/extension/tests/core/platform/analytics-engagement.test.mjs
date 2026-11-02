import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decideAnalyticsSession,
  ANALYTICS_SESSION_TIMEOUT_MS
} from '../../../src/lib/analytics/session.ts'
import { ForegroundEngagementTracker } from '../../../src/lib/analytics/engagement.ts'
import { getAnalyticsDeviceMetadata } from '../../../src/lib/analytics/device.ts'
import { sanitizeAnalyticsEvent } from '../../../src/lib/analytics/policy.ts'
import { ANALYTICS_EVENTS } from '../../../src/lib/analytics/constants.ts'

test('background work cannot create or keep an analytics session alive', () => {
  const now = 1_000_000
  assert.equal(decideAnalyticsSession(null, false, now).sessionId, undefined)
  const created = decideAnalyticsSession(null, true, now)
  assert.equal(created.sessionId, '1000')
  const background = decideAnalyticsSession(created.state, false, now + 1000)
  assert.equal(background.state.lastForegroundActivityAt, now)
  assert.equal(background.shouldPersist, false)
  assert.equal(
    decideAnalyticsSession(created.state, false, now + ANALYTICS_SESSION_TIMEOUT_MS).sessionId,
    undefined
  )
  assert.notEqual(
    decideAnalyticsSession(created.state, true, now + ANALYTICS_SESSION_TIMEOUT_MS).sessionId,
    created.sessionId
  )
})

test('engagement counts visible focused time once, excluding hidden time', () => {
  const tracker = new ForegroundEngagementTracker(true, 100)
  tracker.setActive(false, 1100)
  assert.equal(tracker.take(10_000), 1000)
  assert.equal(tracker.take(11_000), 0)
  tracker.setActive(true, 12_000)
  assert.equal(tracker.take(12_400), 400)
  assert.equal(tracker.take(12_900), 500)
})

test('runtime metadata is coarse and event policy still drops exact amounts and identifiers', () => {
  assert.deepEqual(
    getAnalyticsDeviceMetadata({ language: 'zh-cn', userAgent: 'Macintosh Chrome/150.1' }),
    {
      browser: 'Chrome',
      operating_system: 'macOS',
      language: 'zh-CN',
      device_category: 'desktop'
    }
  )
  const event = sanitizeAnalyticsEvent(ANALYTICS_EVENTS.EXTENSION_ENGAGEMENT, {
    walletAddress: 'secret-address',
    inputAmount: '123.456',
    params: { address: 'secret-address', user_agent: 'raw user agent' }
  })
  assert.ok(event)
  assert.ok(!JSON.stringify(event).includes('secret-address'))
  assert.ok(!JSON.stringify(event).includes('123.456'))
  assert.ok(!JSON.stringify(event).includes('raw user agent'))
})
