import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTrustedExtensionRuntimeMessage } from '../../../src/lib/runtime-message-security.ts'

test('wallet locking uses the canonical command without analytics context', () => {
  const message = { type: 'WALLET_LOCKED' }
  assert.deepEqual(parseTrustedExtensionRuntimeMessage(message), message)
  for (const message of [
    { type: 'WALLET_LOCKED', reason: 'manual' },
    { type: 'WALLET_LOCKED', reason: 'auto' },
    { type: 'WALLET_LOCKED', reason: 'other' },
    { type: 'WALLET_LOCKED', reason: null },
    { type: 'WALLET_LOCKED', reason: 'manual', walletId: 'another-wallet' }
  ]) {
    assert.throws(() => parseTrustedExtensionRuntimeMessage(message))
  }
})

test('UI analytics import and forwarding use runtime messaging without storage or network', async () => {
  const previousChrome = globalThis.chrome
  const previousFetch = globalThis.fetch
  const messages = []
  globalThis.chrome = {
    runtime: {
      sendMessage: message => {
        messages.push(message)
        return new Promise(() => {})
      }
    },
    get storage() {
      throw new Error('UI analytics must not access storage')
    }
  }
  globalThis.fetch = async () => {
    throw new Error('UI analytics must not access network')
  }

  try {
    const {
      ANALYTICS_EVENTS,
      sendAnalyticsEvent,
      sendAnalyticsPageView,
      registerAnalyticsEngagementProvider
    } = await import('../../../src/lib/analytics/index.ts')
    assert.equal(sendAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, { chain: 'evm' }), undefined)
    sendAnalyticsPageView('/send?recipient=private-address')
    assert.equal(messages[0].type, 'ANALYTICS_EVENT')
    assert.equal(messages[1].type, 'ANALYTICS_PAGE_VIEW')
    const dispose = registerAnalyticsEngagementProvider(() => {
      throw new Error('engagement unavailable')
    })
    try {
      assert.doesNotThrow(() => sendAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUBMITTED))
      assert.doesNotThrow(() => sendAnalyticsPageView('/send'))
    } finally {
      dispose()
    }
  } finally {
    globalThis.chrome = previousChrome
    globalThis.fetch = previousFetch
  }
})

test('trackEvent returns immediately while the collector queues and deduplicates', async t => {
  const previousChrome = globalThis.chrome
  const previousFetch = globalThis.fetch
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const storage = {}
  let preferenceListeners = 0
  let alarmCreates = 0
  let networkRequests = 0
  let countryRequests = 0
  let gaRequests = 0
  const gaBodies = []
  let hangOutboxWrites = false
  globalThis.__APP_VERSION__ = '2.0.0'
  globalThis.__BUILD_CHANNEL__ = 'production'
  globalThis.__NETWORK_MODE__ = 'mainnet'
  globalThis.__CUSTOM_ANALYTICS_PASSWORD__ = 'local-test-password'
  globalThis.__GA_API_SECRET__ = 'local-test-secret'
  storage.anonymous_analytics_enabled = false
  globalThis.chrome = {
    storage: {
      local: {
        get: async key => ({ [key]: storage[key] }),
        set: async values => {
          if (hangOutboxWrites && 'analytics_collector_outbox_v1' in values) {
            return new Promise(() => {})
          }
          Object.assign(storage, values)
        }
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => preferenceListeners++ }
    },
    alarms: {
      create: async () => {
        alarmCreates++
      },
      clear: async () => {}
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language: 'en-US', userAgent: 'Chrome/150.0 Macintosh' }
  })
  globalThis.fetch = async (url, init) => {
    networkRequests++
    if (url === 'https://rpc.zknoir.com/cdn-cgi/trace') countryRequests++
    if (String(url).startsWith('https://www.google-analytics.com/mp/collect')) {
      gaRequests++
      gaBodies.push(init.body)
    }
    throw new Error('network must not be called by this test')
  }

  try {
    const { ANALYTICS_EVENTS } = await import('../../../src/lib/analytics/constants.ts')
    const { buildPayload } = await import('../../../src/lib/analytics/payload.ts')
    storage.analytics_collector_outbox_v1 = {
      version: 1,
      entries: [
        {
          id: 'recovered-event',
          payload: {
            ...buildPayload(ANALYTICS_EVENTS.SHOW_PAGE, {}, Date.now()),
            wallet_address: 'anon_test'
          },
          attempts: 0,
          createdAt: Date.now()
        }
      ]
    }
    const { initializeAnalyticsReporting, trackEvent } =
      await import('../../../src/background/analytics/reporter.ts')
    const { clearAnalyticsQueue } = await import('../../../src/lib/analytics/client.ts')
    assert.equal(preferenceListeners, 0)
    await Promise.all([initializeAnalyticsReporting(), initializeAnalyticsReporting()])
    assert.equal(preferenceListeners, 1)
    assert.equal(alarmCreates, 1)
    await clearAnalyticsQueue()
    const options = {
      chain: 'evm',
      idempotencyKey: 'local-transaction-id',
      collector: {
        inputAmount: '8.000000000000001',
        privacyFeeAmount: '0.00042',
        privacyRoute: 'confidential',
        address: 'private-address'
      },
      extra: { kind: 'private-transfer', origin: 'private-address', amount: '123.45' }
    }
    assert.equal(trackEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, options), undefined)
    assert.equal(trackEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, options), undefined)
    await t.waitFor(() => assert.equal(storage.analytics_collector_outbox_v1.entries.length, 1), {
      timeout: 5_000
    })
    assert.equal(networkRequests, 0)
    assert.equal(storage.analytics_collector_outbox_v1.entries.length, 1)
    assert.equal(storage.analytics_collector_outbox_v1.entries[0].payload.chain, 'evm')
    assert.equal(
      storage.analytics_collector_outbox_v1.entries[0].payload.input_amount,
      '8.000000000000001'
    )
    assert.equal(
      JSON.parse(storage.analytics_collector_outbox_v1.entries[0].payload.extra).privacy_fee_amount,
      '0.00042'
    )
    assert.ok(
      !JSON.stringify(storage.analytics_collector_outbox_v1).includes('local-transaction-id')
    )
    assert.ok(!JSON.stringify(storage.analytics_collector_outbox_v1).includes('private-address'))
    assert.ok(!JSON.stringify(storage.analytics_collector_outbox_v1).includes('123.45'))
    assert.equal(trackEvent('unreviewed_event', options), undefined)
    assert.equal(storage.analytics_collector_outbox_v1.entries.length, 1)
    await clearAnalyticsQueue()

    const { setGoogleAnalyticsEnabled } = await import('../../../src/lib/analytics/preferences.ts')
    await setGoogleAnalyticsEnabled(true)
    hangOutboxWrites = true
    const blockedOptions = { ...options, idempotencyKey: 'blocked-collector-write' }
    trackEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, blockedOptions)
    trackEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, blockedOptions)
    await t.waitFor(() => assert.equal(gaRequests, 1), { timeout: 5_000 })
    assert.equal(countryRequests, 1)
    assert.equal(gaRequests, 1)
    assert.ok(!JSON.stringify(gaBodies).includes('8.000000000000001'))
    assert.ok(!JSON.stringify(gaBodies).includes('0.00042'))
    assert.ok(!JSON.stringify(gaBodies).includes('privacy_fee_amount'))
  } finally {
    globalThis.chrome = previousChrome
    globalThis.fetch = previousFetch
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else delete globalThis.navigator
  }
})
