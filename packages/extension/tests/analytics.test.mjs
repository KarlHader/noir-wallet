import { test as it, describe } from 'node:test'
import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'

import { encryptAnalyticsPayload } from '../src/lib/analytics/crypto.ts'
import { PAGE_IDS, resolvePageId } from '../src/lib/analytics/constants.ts'
import { buildPayload, sanitizeAnalyticsMetadata } from '../src/lib/analytics/payload.ts'
import { calculateSwapUsdAmount } from '../src/lib/analytics/swap.ts'
import { CUSTOM_ANALYTICS_CONFIG } from '../src/config/analytics.ts'
import { shouldEnableAnalyticsReporting } from '../analytics-build-policy.ts'
import { getAnalyticsDeviceMetadata } from '../src/lib/analytics/device.ts'
import { ForegroundEngagementTracker } from '../src/lib/analytics/engagement.ts'
import { buildOutboundClickMetadata } from '../src/lib/analytics/outbound.ts'
import {
  ANALYTICS_SESSION_TIMEOUT_MS,
  decideAnalyticsSession
} from '../src/lib/analytics/session.ts'

const PASSWORD = 'test-analytics-password'

/** Mirrors the backend Go DecryptStringFast: AES-128-CBC, key=iv=password[0:16] */
function decryptLikeGoBackend(encryptedBase64, password) {
  const ciphertext = Buffer.from(encryptedBase64, 'base64')
  assert.ok(ciphertext.length > 0 && ciphertext.length % 16 === 0, 'ciphertext must be 16-aligned')
  const keyIv = Buffer.alloc(16)
  Buffer.from(password).copy(keyIv, 0, 0, 16)
  const decipher = createDecipheriv('aes-128-cbc', keyIv, keyIv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function waitFor(condition, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const check = () => {
      if (condition()) return resolve()
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('waitFor timed out'))
      setImmediate(check)
    }
    check()
  })
}

describe('crypto: AES-128-CBC compatible with the Go backend', () => {
  const samples = [
    ['typical event batch', JSON.stringify([{ event_name: 'show_page', page_id: 'noir_home' }])],
    ['exactly one block (16 bytes)', '0123456789abcdef'],
    ['tiny payload', 'a'],
    ['multibyte UTF-8', '\u4e2d\u6587\u5185\u5bb9\u6d4b\u8bd5🔒']
  ]

  for (const [label, plaintext] of samples) {
    it(`round-trips: ${label}`, async () => {
      const encrypted = await encryptAnalyticsPayload(plaintext, PASSWORD)
      assert.equal(decryptLikeGoBackend(encrypted, PASSWORD), plaintext)
    })
  }

  it('zero-pads passwords shorter than 16 bytes like Go copy()', async () => {
    const encrypted = await encryptAnalyticsPayload('short-pw', 'abc')
    assert.equal(decryptLikeGoBackend(encrypted, 'abc'), 'short-pw')
  })

  it('uses only the first 16 bytes of long passwords', async () => {
    const encrypted = await encryptAnalyticsPayload('hello', PASSWORD)
    const sameKeyPrefix = PASSWORD.slice(0, 16) + '-DIFFERENT-TAIL'
    assert.equal(decryptLikeGoBackend(encrypted, sameKeyPrefix), 'hello')
  })
})

describe('constants: identifiers and route mapping', () => {
  it('resolvePageId maps known routes and strips query params', () => {
    assert.equal(resolvePageId('/'), PAGE_IDS.HOME)
    assert.equal(resolvePageId('/send'), PAGE_IDS.SEND)
    assert.equal(resolvePageId('/send?amount=1'), PAGE_IDS.SEND)
    assert.equal(resolvePageId('/onboarding/import'), PAGE_IDS.ONBOARDING_IMPORT)
    assert.equal(resolvePageId('/security-privacy'), PAGE_IDS.SETTINGS_SECURITY_PRIVACY)
    assert.equal(resolvePageId('/approval'), PAGE_IDS.DAPP_APPROVAL)
  })

  it('resolvePageId degrades gracefully for unknown routes', () => {
    assert.equal(resolvePageId('/future-page/detail'), 'noir_future_page_detail')
    assert.equal(resolvePageId(''), PAGE_IDS.HOME)
  })
})

describe('payload: wire format construction', () => {
  it('calculates swap USD value from the quoted input or output token', () => {
    assert.equal(
      calculateSwapUsdAmount({ amountIn: '1.5', inputPrice: 48.8, amountOut: '42' }),
      '73.20'
    )
    assert.equal(calculateSwapUsdAmount({ amountOut: '0.25', outputPrice: 48.8 }), '12.20')
    assert.equal(calculateSwapUsdAmount({ amountIn: '1.5', inputPrice: 0 }), undefined)
  })

  it('fills collector defaults for an empty options object', () => {
    const before = Date.now()
    const payload = buildPayload('test_event', {})
    assert.equal(payload.chain, 'zcash')
    assert.equal(payload.project_id, 'noir_wallet')
    assert.equal(payload.event_name, 'test_event')
    assert.equal(payload.page_id, PAGE_IDS.BACKGROUND)
    assert.equal(payload.has_transaction, 0)
    assert.equal(payload.extra, '')
    assert.equal(payload.input_amount, '')
    assert.equal(payload.wallet_address, '')
    assert.ok(payload.timestamp >= before && payload.timestamp <= Date.now())
  })

  it('keeps allowlisted metadata and strips identifying or sensitive values', () => {
    const payload = buildPayload('test_event', {
      params: {
        origin: 'https://dapp.example',
        amount: '42',
        event_id: '9ec0e477-1744-4d28-b2a7-6bca5d266789',
        extension_version: '1.0.36',
        build_channel: 'production',
        network_mode: 'mainnet',
        method: 'hardware',
        funding_source: 'transparent',
        from_address: 't1-sensitive-address',
        utxo: 'sensitive-outpoint',
        previous_version: '1.0.27'
      },
      extra: {
        reason: 'manual',
        tx_hash: 'secret-transaction-hash',
        error: 'raw error containing user data',
        hardware: false
      }
    })
    assert.deepEqual(JSON.parse(payload.extra), {
      event_id: '9ec0e477-1744-4d28-b2a7-6bca5d266789',
      extension_version: '1.0.36',
      build_channel: 'production',
      network_mode: 'mainnet',
      method: 'hardware',
      funding_source: 'transparent',
      previous_version: '1.0.27',
      reason: 'manual',
      hardware: false
    })
  })

  it('reports valid transaction amounts while stripping wallet identifiers', () => {
    const payload = buildPayload(
      'swap_submitted',
      {
        pageId: PAGE_IDS.SWAP,
        hasTransaction: 1,
        inputAmount: '1.5',
        inputSymbol: 'ZEC',
        outputAmount: '42.1',
        outputSymbol: 'USDC',
        usdAmount: '73.20',
        walletAddress: 'u1abc'
      },
      1234567890
    )
    assert.equal(payload.page_id, 'noir_swap')
    assert.equal(payload.has_transaction, 1)
    assert.equal(payload.input_amount, '1.5')
    assert.equal(payload.input_symbol, 'ZEC')
    assert.equal(payload.output_amount, '42.1')
    assert.equal(payload.output_symbol, 'USDC')
    assert.equal(payload.usd_amount, '73.20')
    assert.equal(payload.wallet_address, '')
    assert.equal(payload.timestamp, 1234567890)
  })

  it('drops malformed or oversized transaction amounts', () => {
    const payload = buildPayload('swap_submitted', {
      inputAmount: '1e9',
      outputAmount: '-2',
      usdAmount: '1'.repeat(129)
    })

    assert.equal(payload.input_amount, '')
    assert.equal(payload.output_amount, '')
    assert.equal(payload.usd_amount, '')
  })

  it('applies the same metadata allowlist used by the GA reporter', () => {
    assert.deepEqual(
      sanitizeAnalyticsMetadata({
        method: 'u1-sensitive-address',
        page_location: 'https://noir-wallet.extension/send?address=u1-sensitive-address'
      }),
      {}
    )
    assert.deepEqual(
      sanitizeAnalyticsMetadata({
        browser: 'Chrome',
        browser_version: '140.0.0.0',
        device_category: 'desktop',
        engagement_time_msec: 1_250,
        language: 'en-US',
        link_domain: 'zknoir.com',
        link_id: 'lending',
        operating_system: 'macOS',
        page_id: 'noir_swap',
        page_location: 'https://noir-wallet.extension/security-privacy',
        page_title: '/security-privacy',
        origin: 'https://dapp.example',
        amount: '1.25',
        error: 'sensitive detail'
      }),
      {
        browser: 'Chrome',
        device_category: 'desktop',
        engagement_time_msec: 1_250,
        language: 'en-US',
        link_domain: 'zknoir.com',
        link_id: 'lending',
        operating_system: 'macOS',
        page_id: 'noir_swap',
        page_location: 'https://noir-wallet.extension/security-privacy',
        page_title: '/security-privacy'
      }
    )
  })
})

describe('Google Analytics preference: default-on and persisted opt-out', () => {
  it('defaults to enabled and cancels country lookup on opt-out', async () => {
    const stored = {}
    const sessionStored = { ga_country_cache: { country_id: 'CA', expiresAt: 0 } }
    const originalChrome = globalThis.chrome
    const originalFetch = globalThis.fetch
    const originalReportingEnabled = globalThis.__ANALYTICS_REPORTING_ENABLED__
    let stopCountryLookup = () => {}
    globalThis.chrome = {
      storage: {
        local: {
          get: async key => ({ [key]: stored[key] }),
          set: async values => Object.assign(stored, values)
        },
        session: {
          get: async key => ({ [key]: sessionStored[key] }),
          set: async values => Object.assign(sessionStored, values),
          remove: async key => {
            delete sessionStored[key]
          }
        },
        onChanged: {
          addListener: () => {}
        }
      }
    }

    try {
      const { GOOGLE_ANALYTICS_STORAGE_KEY, isGoogleAnalyticsEnabled, setGoogleAnalyticsEnabled } =
        await import('../src/lib/analytics/preferences.ts')
      const { getAnalyticsCountry, stopAnalyticsCountryLookup } =
        await import('../src/lib/analytics/geo.ts')
      stopCountryLookup = stopAnalyticsCountryLookup
      globalThis.__ANALYTICS_REPORTING_ENABLED__ = true

      assert.equal(await isGoogleAnalyticsEnabled(), true)
      await setGoogleAnalyticsEnabled(false)
      assert.equal(stored[GOOGLE_ANALYTICS_STORAGE_KEY], false)
      assert.equal(await isGoogleAnalyticsEnabled(), false)

      await setGoogleAnalyticsEnabled(true)
      assert.equal(await isGoogleAnalyticsEnabled(), true)

      let resolveLookup
      let requestSignal
      globalThis.fetch = (_url, options) => {
        requestSignal = options.signal
        return new Promise(resolve => {
          resolveLookup = resolve
        })
      }
      const pending = getAnalyticsCountry()
      await new Promise(resolve => setImmediate(resolve))
      await setGoogleAnalyticsEnabled(false)
      await stopCountryLookup()
      assert.equal(requestSignal.aborted, true)
      resolveLookup(new Response('loc=US\n'))
      assert.equal(await pending, undefined)
      assert.deepEqual(sessionStored, {})
      await setGoogleAnalyticsEnabled(true)
    } finally {
      await stopCountryLookup()
      globalThis.chrome = originalChrome
      globalThis.fetch = originalFetch
      if (originalReportingEnabled === undefined) delete globalThis.__ANALYTICS_REPORTING_ENABLED__
      else globalThis.__ANALYTICS_REPORTING_ENABLED__ = originalReportingEnabled
    }
  })
})

describe('Google Analytics identity', () => {
  it('shares one persisted client id across concurrent first-use callers', async () => {
    const originalChrome = globalThis.chrome
    let storedClientId
    let getCalls = 0
    let setCalls = 0
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => {
            getCalls++
            await new Promise(resolve => setImmediate(resolve))
            return { ga_client_id: storedClientId }
          },
          set: async values => {
            setCalls++
            storedClientId = values.ga_client_id
          }
        }
      }
    }

    try {
      const { getClientId, toGaClientId } = await import(
        `../src/lib/analytics/ga.ts?identity-concurrency=${Date.now()}`
      )
      const ids = await Promise.all(Array.from({ length: 20 }, () => getClientId()))

      assert.equal(new Set(ids).size, 1)
      assert.equal(ids[0], storedClientId)
      assert.equal(getCalls, 1)
      assert.equal(setCalls, 1)
      const gaId = await toGaClientId(ids[0])
      assert.match(gaId, /^\d+\.\d+$/)
      assert.equal(await toGaClientId(ids[0]), gaId)
      assert.equal(await toGaClientId('123.456'), '123.456')
    } finally {
      globalThis.chrome = originalChrome
    }
  })

  it('counts page views as engagement but excludes lifecycle events', async () => {
    const { buildGaDevice, buildGaEventParams } = await import(
      `../src/lib/analytics/ga.ts?engagement-policy=${Date.now()}`
    )
    const buildContext = {
      appVersion: '1.0.36',
      buildChannel: 'production',
      foreground: false,
      networkMode: 'mainnet'
    }

    assert.deepEqual(buildGaEventParams('extension_installed', undefined, buildContext), {
      extension_version: '1.0.36',
      build_channel: 'production',
      network_mode: 'mainnet'
    })
    assert.deepEqual(
      buildGaEventParams('extension_updated', { engagement_time_msec: 2_000 }, buildContext),
      {
        extension_version: '1.0.36',
        build_channel: 'production',
        network_mode: 'mainnet'
      }
    )

    const foregroundContext = { ...buildContext, foreground: true, sessionId: 'session-1' }
    assert.deepEqual(buildGaEventParams('page_view', undefined, foregroundContext), {
      session_id: 'session-1',
      extension_version: '1.0.36',
      build_channel: 'production',
      network_mode: 'mainnet',
      engagement_time_msec: 100
    })
    const clickParams = buildGaEventParams(
      'click',
      {
        browser: 'Chrome',
        device_category: 'desktop',
        engagement_time_msec: 1_250,
        language: 'en-US',
        operating_system: 'macOS',
        page_id: 'noir_home'
      },
      foregroundContext
    )
    assert.equal(clickParams.engagement_time_msec, 1_250)
    assert.equal(clickParams.page_id, 'noir_home')
    assert.deepEqual(
      buildGaDevice({
        browser: 'Chrome',
        browser_major_version: '140',
        device_category: 'desktop',
        language: 'en-US',
        operating_system: 'macOS',
        browser_version: 'sensitive-granularity'
      }),
      {
        browser: 'Chrome',
        browser_version: '140',
        category: 'desktop',
        model: 'Desktop',
        language: 'en-US',
        operating_system: 'macOS'
      }
    )
  })
})

describe('automatic analytics context', () => {
  it('derives only coarse device fields', () => {
    assert.deepEqual(
      getAnalyticsDeviceMetadata({
        language: 'en-us',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
      }),
      {
        browser: 'Chrome',
        browser_major_version: '140',
        device_category: 'desktop',
        language: 'en-US',
        operating_system: 'macOS'
      }
    )
    assert.deepEqual(
      getAnalyticsDeviceMetadata({
        language: 'invalid language',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Edg/140.0.0.0'
      }),
      {
        browser: 'Edge',
        browser_major_version: '140',
        device_category: 'desktop',
        language: 'und',
        operating_system: 'Windows'
      }
    )
  })

  it('counts only active foreground intervals', () => {
    const tracker = new ForegroundEngagementTracker(true, 1_000)
    assert.equal(tracker.pending(1_750), 750)
    tracker.setActive(false, 2_000)
    assert.equal(tracker.pending(5_000), 1_000)
    assert.equal(tracker.take(5_000), 1_000)
    assert.equal(tracker.pending(8_000), 0)

    tracker.setActive(true, 10_000)
    assert.equal(tracker.take(10_450), 450)
    assert.equal(tracker.pending(10_700), 250)
  })

  it('reduces outbound targets to non-identifying metadata', () => {
    assert.deepEqual(
      buildOutboundClickMetadata(
        'intents_explorer',
        'https://explorer.near-intents.org/transactions/sensitive-id?referral=noir_swap'
      ),
      {
        link_domain: 'explorer.near-intents.org',
        link_id: 'intents_explorer'
      }
    )
    assert.deepEqual(buildOutboundClickMetadata(undefined, 'zknoir.com/private/path'), {
      link_domain: 'zknoir.com',
      link_id: 'external_link'
    })
    assert.equal(buildOutboundClickMetadata('unsafe label', 'mailto:sensitive@example.com'), null)
  })

  it('creates and refreshes sessions only for foreground activity', () => {
    const startedAt = 1_700_000_000_000
    assert.deepEqual(decideAnalyticsSession(null, false, startedAt), {
      state: null,
      shouldPersist: false
    })

    const created = decideAnalyticsSession(null, true, startedAt)
    assert.equal(created.sessionId, '1700000000')
    assert.equal(created.shouldPersist, true)

    const background = decideAnalyticsSession(created.state, false, startedAt + 10_000)
    assert.equal(background.sessionId, created.sessionId)
    assert.equal(background.state?.lastForegroundActivityAt, startedAt)
    assert.equal(background.shouldPersist, false)

    const refreshed = decideAnalyticsSession(created.state, true, startedAt + 20_000)
    assert.equal(refreshed.state?.lastForegroundActivityAt, startedAt + 20_000)
    assert.equal(refreshed.shouldPersist, true)

    assert.deepEqual(
      decideAnalyticsSession(
        refreshed.state,
        false,
        startedAt + 20_000 + ANALYTICS_SESSION_TIMEOUT_MS
      ),
      { state: null, shouldPersist: true }
    )
  })

  it('does not let background events create or extend persisted GA sessions', async () => {
    const originalChrome = globalThis.chrome
    const stored = {}
    let setCalls = 0
    globalThis.chrome = {
      storage: {
        session: {
          get: async keys =>
            Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])
            ),
          set: async values => {
            setCalls++
            Object.assign(stored, values)
          },
          remove: async keys => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]
          }
        }
      }
    }

    try {
      const { getGaSessionId } = await import(
        `../src/lib/analytics/ga.ts?session-lifecycle=${Date.now()}`
      )
      const startedAt = 1_700_000_000_000
      assert.equal(await getGaSessionId(false, startedAt), undefined)
      assert.equal(setCalls, 0)

      const sessionId = await getGaSessionId(true, startedAt)
      assert.equal(sessionId, '1700000000')
      assert.equal(setCalls, 1)

      assert.equal(await getGaSessionId(false, startedAt + 10_000), sessionId)
      assert.equal(setCalls, 1)
      assert.equal(stored.ga_session_state.lastForegroundActivityAt, startedAt)

      assert.equal(await getGaSessionId(false, startedAt + ANALYTICS_SESSION_TIMEOUT_MS), undefined)
      assert.equal(stored.ga_session_state, undefined)
    } finally {
      globalThis.chrome = originalChrome
    }
  })
})

describe('analytics build isolation', () => {
  it('reports only from production mainnet builds outside Playwright', () => {
    assert.equal(
      shouldEnableAnalyticsReporting({
        buildChannel: 'production',
        networkMode: 'mainnet',
        isPlaywrightBuild: false
      }),
      true
    )

    for (const context of [
      { buildChannel: 'beta', networkMode: 'mainnet', isPlaywrightBuild: false },
      { buildChannel: 'development', networkMode: 'mainnet', isPlaywrightBuild: false },
      { buildChannel: 'production', networkMode: 'testnet', isPlaywrightBuild: false },
      { buildChannel: 'production', networkMode: 'mainnet', isPlaywrightBuild: true }
    ]) {
      assert.equal(shouldEnableAnalyticsReporting(context), false)
    }
  })
})

describe('client: batching, retry and drop behaviour', () => {
  it('sends no reports when the build has no analytics credentials', async () => {
    const realFetch = globalThis.fetch
    const previousPassword = globalThis.__CUSTOM_ANALYTICS_PASSWORD__
    const previousGaSecret = globalThis.__GA_API_SECRET__
    const previousReportingEnabled = globalThis.__ANALYTICS_REPORTING_ENABLED__
    globalThis.__CUSTOM_ANALYTICS_PASSWORD__ = ''
    globalThis.__GA_API_SECRET__ = ''
    globalThis.__ANALYTICS_REPORTING_ENABLED__ = true
    globalThis.fetch = mock.fn(async () => ({ ok: true }))
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { clearAnalyticsQueue, enqueueAnalyticsEvent } =
        await import('../src/lib/analytics/client.ts')
      const { sendGaEvent } = await import('../src/lib/analytics/ga.ts')
      clearAnalyticsQueue()
      for (let i = 0; i < 20; i++) enqueueAnalyticsEvent(buildPayload('test_event', {}))
      mock.timers.tick(2000)
      await sendGaEvent('test_event')
      assert.equal(globalThis.fetch.mock.callCount(), 0)
    } finally {
      globalThis.fetch = realFetch
      for (const [key, value] of [
        ['__CUSTOM_ANALYTICS_PASSWORD__', previousPassword],
        ['__GA_API_SECRET__', previousGaSecret],
        ['__ANALYTICS_REPORTING_ENABLED__', previousReportingEnabled]
      ]) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
      mock.timers.reset()
    }
  })

  it('batches, encrypts, retries on failure and drops after repeated failures', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const realFetch = globalThis.fetch
    const previousPassword = globalThis.__CUSTOM_ANALYTICS_PASSWORD__
    globalThis.__CUSTOM_ANALYTICS_PASSWORD__ = PASSWORD
    try {
      const fetchCalls = []
      let failuresToServe = 0
      globalThis.fetch = mock.fn(async (url, init) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) })
        if (failuresToServe > 0) {
          failuresToServe--
          return { ok: false, status: 500, json: async () => ({}) }
        }
        return { ok: true, status: 200, json: async () => ({ code: 0 }) }
      })

      const { clearAnalyticsQueue, enqueueAnalyticsEvent } =
        await import('../src/lib/analytics/client.ts')
      const makeEvent = i => buildPayload('test_event', {}, 1700000000000 + i)

      const batch = Array.from({ length: 20 }, (_, i) => makeEvent(i))
      for (const event of batch) enqueueAnalyticsEvent(event)
      await waitFor(() => fetchCalls.length === 1)

      assert.equal(fetchCalls[0].url, CUSTOM_ANALYTICS_CONFIG.endpoint)
      const decrypted = JSON.parse(decryptLikeGoBackend(fetchCalls[0].body.data, PASSWORD))
      assert.deepEqual(decrypted, batch)

      enqueueAnalyticsEvent(makeEvent(100))
      mock.timers.tick(2000)
      await waitFor(() => fetchCalls.length === 2)
      assert.equal(JSON.parse(decryptLikeGoBackend(fetchCalls[1].body.data, PASSWORD)).length, 1)

      failuresToServe = 1
      enqueueAnalyticsEvent(makeEvent(200))
      mock.timers.tick(2000)
      await waitFor(() => fetchCalls.length === 3)
      mock.timers.tick(15000)
      await waitFor(() => fetchCalls.length === 4)
      assert.deepEqual(fetchCalls[2].body, fetchCalls[3].body)

      failuresToServe = 3
      enqueueAnalyticsEvent(makeEvent(300))
      mock.timers.tick(2000)
      await waitFor(() => fetchCalls.length === 5)
      mock.timers.tick(15000)
      await waitFor(() => fetchCalls.length === 6)
      mock.timers.tick(15000)
      await waitFor(() => fetchCalls.length === 7)
      enqueueAnalyticsEvent(makeEvent(400))
      mock.timers.tick(2000)
      await waitFor(() => fetchCalls.length === 8)
      const lastBatch = JSON.parse(decryptLikeGoBackend(fetchCalls[7].body.data, PASSWORD))
      assert.equal(lastBatch.length, 1)
      assert.equal(lastBatch[0].wallet_address, '')

      enqueueAnalyticsEvent(makeEvent(500))
      clearAnalyticsQueue()
      mock.timers.tick(2000)
      assert.equal(fetchCalls.length, 8)
    } finally {
      globalThis.fetch = realFetch
      if (previousPassword === undefined) delete globalThis.__CUSTOM_ANALYTICS_PASSWORD__
      else globalThis.__CUSTOM_ANALYTICS_PASSWORD__ = previousPassword
      mock.timers.reset()
    }
  })
})
