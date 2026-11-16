/**
 * Analytics logic tests:
 *   pnpm test
 *
 * Runs under Node against the TS sources without contacting the collector.
 * The opt-in collector check lives in tests/live/services/analytics.spec.mjs.
 */
import { test as it } from 'node:test'
import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'

import { encryptAnalyticsPayload } from '../../../src/lib/analytics/crypto.ts'
import {
  ANALYTICS_CHAIN,
  ANALYTICS_EVENTS,
  ANALYTICS_PROJECT_ID,
  PAGE_IDS,
  resolvePageId
} from '../../../src/lib/analytics/constants.ts'
import { buildPayload, sanitizeAnalyticsMetadata } from '../../../src/lib/analytics/payload.ts'
import { sanitizeAnalyticsEvent } from '../../../src/lib/analytics/policy.ts'
import { toGaClientId } from '../../../src/lib/analytics/ga.ts'
import { CUSTOM_ANALYTICS_CONFIG } from '../../../src/config/analytics.ts'
import { shouldEnableAnalyticsReporting } from '../../../scripts/lib/extension-build-config.ts'

const PASSWORD = 'analytics-test-password'
globalThis.__CUSTOM_ANALYTICS_PASSWORD__ = PASSWORD
const describe = it.describe

it('enables distributed mainnet reporting but isolates local and browser-test builds', () => {
  for (const channel of ['beta', 'production']) {
    assert.equal(shouldEnableAnalyticsReporting(channel, 'mainnet', false), true)
    assert.equal(shouldEnableAnalyticsReporting(channel, 'mainnet', true), false)
    assert.equal(shouldEnableAnalyticsReporting(channel, 'testnet', false), false)
  }
  assert.equal(shouldEnableAnalyticsReporting('development', 'mainnet', false), false)
})

/** Mirrors the backend Go DecryptStringFast: AES-128-CBC, key=iv=password[0:16] */
function decryptLikeGoBackend(encryptedBase64, password) {
  const ciphertext = Buffer.from(encryptedBase64, 'base64')
  assert.ok(ciphertext.length > 0 && ciphertext.length % 16 === 0, 'ciphertext must be 16-aligned')
  const keyIv = Buffer.alloc(16)
  Buffer.from(password).copy(keyIv, 0, 0, 16)
  const decipher = createDecipheriv('aes-128-cbc', keyIv, keyIv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
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
  it('project and chain identifiers are stable', () => {
    assert.equal(ANALYTICS_PROJECT_ID, 'noir_wallet')
    assert.equal(ANALYTICS_CHAIN, 'zcash')
  })

  it('all page_ids are unique and noir_-prefixed', () => {
    const values = Object.values(PAGE_IDS)
    assert.equal(new Set(values).size, values.length)
    for (const value of values) {
      assert.match(value, /^noir_[a-z0-9_]+$/)
    }
  })

  it('all event names are unique snake_case', () => {
    const values = Object.values(ANALYTICS_EVENTS)
    assert.equal(new Set(values).size, values.length)
    for (const value of values) {
      assert.match(value, /^[a-z0-9]+(_[a-z0-9]+)*$/)
    }
  })

  it('resolvePageId maps known routes and strips query params', () => {
    assert.equal(resolvePageId('/'), PAGE_IDS.HOME)
    assert.equal(resolvePageId('/send'), PAGE_IDS.SEND)
    assert.equal(resolvePageId('/send?amount=1'), PAGE_IDS.SEND)
    assert.equal(
      resolvePageId('/onboarding/import-word-count'),
      PAGE_IDS.ONBOARDING_IMPORT_WORD_COUNT
    )
    assert.equal(resolvePageId('/onboarding/import'), PAGE_IDS.ONBOARDING_IMPORT)
    assert.equal(
      resolvePageId('/onboarding/import-zcash-history'),
      PAGE_IDS.ONBOARDING_IMPORT_ZCASH_HISTORY
    )
    assert.equal(resolvePageId('/security-privacy'), PAGE_IDS.SETTINGS_SECURITY_PRIVACY)
    assert.equal(resolvePageId('/zcash-settings'), PAGE_IDS.ZCASH_SETTINGS)
    assert.equal(resolvePageId('/approval'), PAGE_IDS.DAPP_APPROVAL)
  })

  it('resolves unknown routes to a fixed non-identifying page', () => {
    assert.equal(resolvePageId('/future-page/detail'), PAGE_IDS.BACKGROUND)
    assert.equal(resolvePageId('/u1-private-address?amount=1'), PAGE_IDS.BACKGROUND)
    assert.equal(resolvePageId(''), PAGE_IDS.BACKGROUND)
  })
})

describe('payload: wire format construction', () => {
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
        method: 'hardware',
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
      method: 'hardware',
      previous_version: '1.0.27',
      hardware: false
    })
  })

  it('drops legacy unscoped amounts and wallet identifiers at the payload boundary', () => {
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
    assert.equal(payload.input_amount, '')
    assert.equal(payload.input_symbol, 'ZEC')
    assert.equal(payload.output_amount, '')
    assert.equal(payload.output_symbol, 'USDC')
    assert.equal(payload.usd_amount, '')
    assert.equal(payload.wallet_address, '')
    assert.equal(payload.timestamp, 1234567890)
  })

  it('drops malformed or oversized transaction amounts', () => {
    const payload = buildPayload('swap_submitted', {
      collector: { inputAmount: '1e9', outputAmount: '-2', usdAmount: '1'.repeat(129) }
    })

    assert.equal(payload.input_amount, '')
    assert.equal(payload.output_amount, '')
    assert.equal(payload.usd_amount, '')
  })

  it('preserves exact collector decimals while rejecting arbitrary financial metadata', () => {
    const collector = {
      inputAmount: '0.000000000000000001',
      outputAmount: '12345678901234567890.123456',
      usdAmount: '12.50',
      privacyFeeAmount: '0.0003',
      privacyFeeSymbol: 'ETH',
      sourceDomain: 'private',
      privacyRoute: 'direct',
      activityType: 'transfer',
      address: '0x-private-address',
      transactionHash: 'secret-hash',
      provider: 'https://private-origin.example',
      balance: 'sensitive-unreviewed-field'
    }
    const event = sanitizeAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUCCEEDED, { collector })
    const payload = buildPayload(event.name, event.options)
    assert.equal(payload.input_amount, '0.000000000000000001')
    assert.equal(payload.output_amount, '12345678901234567890.123456')
    assert.equal(payload.usd_amount, '12.50')
    assert.deepEqual(JSON.parse(payload.extra), {
      pmf_version: 1,
      input_amount_known: 1,
      output_amount_known: 1,
      usd_amount_known: 1,
      privacy_fee_amount: '0.0003',
      privacy_fee_symbol: 'ETH',
      source_domain: 'private',
      privacy_route: 'direct',
      activity_type: 'transfer'
    })
    assert.equal(
      sanitizeAnalyticsEvent(ANALYTICS_EVENTS.SHOW_PAGE, { collector }).options.collector,
      undefined
    )
    assert.equal(buildPayload(ANALYTICS_EVENTS.SHOW_PAGE, { collector }).input_amount, '')
    const zero = buildPayload(ANALYTICS_EVENTS.SEND_SUCCEEDED, {
      collector: { inputAmount: '0', usdAmount: 'invalid', privacyRoute: 'direct' }
    })
    const zeroMetadata = JSON.parse(zero.extra)
    assert.equal(zero.input_amount, '0')
    assert.equal(zeroMetadata.input_amount_known, 1)
    assert.equal(zeroMetadata.output_amount_known, 0)
    assert.equal(zeroMetadata.usd_amount_known, 0)
    for (const invalid of [
      NaN,
      Infinity,
      10,
      '-1',
      '0x123',
      '1e8',
      'Infinity',
      ' 1 ',
      '1'.repeat(129)
    ]) {
      assert.equal(
        buildPayload(ANALYTICS_EVENTS.SEND_SUCCEEDED, { collector: { inputAmount: invalid } })
          .input_amount,
        ''
      )
    }
  })

  it('applies the same metadata allowlist used by the GA reporter', () => {
    assert.deepEqual(
      sanitizeAnalyticsMetadata({
        page_location: 'https://noir-wallet.extension/noir_settings_security_privacy',
        page_title: PAGE_IDS.SETTINGS_SECURITY_PRIVACY,
        origin: 'https://dapp.example',
        amount: '1.25',
        error: 'sensitive detail'
      }),
      {
        page_location: 'https://noir-wallet.extension/noir_settings_security_privacy',
        page_title: PAGE_IDS.SETTINGS_SECURITY_PRIVACY
      }
    )
  })
})

describe('Google Analytics preference: default-on and persisted opt-out', () => {
  it('defaults to enabled and immediately applies an explicit disable', async () => {
    const stored = {}
    const originalChrome = globalThis.chrome
    globalThis.chrome = {
      storage: {
        local: {
          get: async key => ({ [key]: stored[key] }),
          set: async values => Object.assign(stored, values)
        },
        onChanged: {
          addListener: () => {}
        }
      }
    }

    try {
      const { GOOGLE_ANALYTICS_STORAGE_KEY, isGoogleAnalyticsEnabled, setGoogleAnalyticsEnabled } =
        await import('../../../src/lib/analytics/preferences.ts')

      assert.equal(await isGoogleAnalyticsEnabled(), true)
      await setGoogleAnalyticsEnabled(false)
      assert.equal(stored[GOOGLE_ANALYTICS_STORAGE_KEY], false)
      assert.equal(await isGoogleAnalyticsEnabled(), false)

      await setGoogleAnalyticsEnabled(true)
      assert.equal(await isGoogleAnalyticsEnabled(), true)
    } finally {
      globalThis.chrome = originalChrome
    }
  })

  it('keeps a newer opt-out when the initial storage read resolves or fails later', async () => {
    const originalChrome = globalThis.chrome
    try {
      for (const outcome of ['resolve', 'reject']) {
        let resolveRead
        let rejectRead
        let storageChanged
        globalThis.chrome = {
          storage: {
            local: {
              get: () =>
                new Promise((resolve, reject) => {
                  resolveRead = resolve
                  rejectRead = reject
                })
            },
            onChanged: {
              addListener: listener => {
                storageChanged = listener
              }
            }
          }
        }
        const { isGoogleAnalyticsEnabled, onGoogleAnalyticsPreferenceChange } = await import(
          `../../../src/lib/analytics/preferences.ts?stale-read-${outcome}`
        )
        const observed = []
        onGoogleAnalyticsPreferenceChange(enabled => observed.push(enabled))
        const initialRead = isGoogleAnalyticsEnabled()
        storageChanged({ anonymous_analytics_enabled: { newValue: false } }, 'local')
        if (outcome === 'resolve') resolveRead({ anonymous_analytics_enabled: true })
        else rejectRead(new Error('stale read failed'))
        assert.equal(await initialRead, false)
        assert.equal(await isGoogleAnalyticsEnabled(), false)
        assert.deepEqual(observed, [false])
      }
    } finally {
      globalThis.chrome = originalChrome
    }
  })

  it('does not roll back a newer storage change when a local preference write fails', async () => {
    const originalChrome = globalThis.chrome
    let rejectWrite
    let storageChanged
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => ({ anonymous_analytics_enabled: true }),
          set: () =>
            new Promise((_, reject) => {
              rejectWrite = reject
            })
        },
        onChanged: {
          addListener: listener => {
            storageChanged = listener
          }
        }
      }
    }

    try {
      const { isGoogleAnalyticsEnabled, setGoogleAnalyticsEnabled } =
        await import('../../../src/lib/analytics/preferences.ts?stale-rollback')
      assert.equal(await isGoogleAnalyticsEnabled(), true)
      const pendingWrite = setGoogleAnalyticsEnabled(false)
      const rejected = assert.rejects(pendingWrite, /write failed/)
      storageChanged({ anonymous_analytics_enabled: { newValue: false } }, 'local')
      rejectWrite(new Error('write failed'))
      await rejected
      assert.equal(await isGoogleAnalyticsEnabled(), false)
    } finally {
      globalThis.chrome = originalChrome
    }
  })
})

it('derives a stable numeric GA ID from the installation ID', async () => {
  const installId = '12345678-1234-1234-1234-123456789abc'
  const gaId = await toGaClientId(installId)
  assert.match(gaId, /^\d+\.\d+$/)
  assert.equal(await toGaClientId(installId), gaId)
  assert.equal(await toGaClientId('123.456'), '123.456')
})

it('bounds and caches country lookup, then cancels it on GA opt-out', async () => {
  const previousChrome = globalThis.chrome
  const previousFetch = globalThis.fetch
  const previousSecret = globalThis.__GA_API_SECRET__
  const local = {}
  const session = {}
  let requests = 0
  let resolvePending
  let pendingSignal
  let stopLookup
  globalThis.__GA_API_SECRET__ = 'local-test-secret'
  globalThis.chrome = {
    storage: {
      local: {
        get: async key => ({ [key]: local[key] }),
        set: async values => Object.assign(local, values)
      },
      session: {
        get: async key => ({ [key]: session[key] }),
        set: async values => Object.assign(session, values),
        remove: async key => {
          delete session[key]
        }
      },
      onChanged: { addListener: () => {} }
    }
  }

  try {
    const { setGoogleAnalyticsEnabled } = await import('../../../src/lib/analytics/preferences.ts')
    const { getAnalyticsCountry, stopAnalyticsCountryLookup } =
      await import('../../../src/lib/analytics/geo.ts')
    stopLookup = stopAnalyticsCountryLookup
    await setGoogleAnalyticsEnabled(true)
    globalThis.fetch = async (url, options) => {
      requests++
      assert.equal(url, 'https://rpc.zknoir.com/cdn-cgi/trace')
      assert.equal(options.credentials, 'omit')
      assert.equal(options.referrerPolicy, 'no-referrer')
      return new Response('loc=CA\n')
    }
    assert.equal(await getAnalyticsCountry(), 'CA')
    assert.equal(await getAnalyticsCountry(), 'CA')
    assert.equal(requests, 1)

    session.ga_country_cache.expiresAt = 0
    globalThis.fetch = async () => {
      requests++
      return new Response('loc=UNKNOWN\n')
    }
    const failureStart = Date.now()
    assert.equal(await getAnalyticsCountry(), undefined)
    assert.ok(session.ga_country_cache.expiresAt - failureStart <= 61_000)
    assert.ok(session.ga_country_cache.expiresAt - failureStart >= 59_000)

    session.ga_country_cache.expiresAt = 0
    globalThis.fetch = (_url, options) => {
      requests++
      pendingSignal = options.signal
      return new Promise(resolve => {
        resolvePending = resolve
      })
    }
    const pending = getAnalyticsCountry()
    await new Promise(resolve => setImmediate(resolve))
    await setGoogleAnalyticsEnabled(false)
    await stopAnalyticsCountryLookup()
    assert.equal(pendingSignal.aborted, true)
    resolvePending(new Response('loc=US\n'))
    assert.equal(await pending, undefined)
    assert.equal(session.ga_country_cache, undefined)
    assert.equal(await getAnalyticsCountry(), undefined)
    assert.equal(requests, 3)
  } finally {
    await stopLookup?.()
    globalThis.chrome = previousChrome
    globalThis.fetch = previousFetch
    if (previousSecret === undefined) delete globalThis.__GA_API_SECRET__
    else globalThis.__GA_API_SECRET__ = previousSecret
  }
})

it('sends coarse GA location and device data without replacing the collector ID', async () => {
  const previousChrome = globalThis.chrome
  const previousFetch = globalThis.fetch
  const previousSecret = globalThis.__GA_API_SECRET__
  const previousVersion = globalThis.__APP_VERSION__
  const previousChannel = globalThis.__BUILD_CHANNEL__
  const previousNetwork = globalThis.__NETWORK_MODE__
  const local = {}
  const session = {}
  let gaBody
  let stopReporting
  globalThis.__GA_API_SECRET__ = 'local-test-secret'
  globalThis.__APP_VERSION__ = '2.0.0-beta.2'
  globalThis.__BUILD_CHANNEL__ = 'production'
  globalThis.__NETWORK_MODE__ = 'mainnet'
  globalThis.chrome = {
    storage: {
      local: {
        get: async key => ({ [key]: local[key] }),
        set: async values => Object.assign(local, values)
      },
      session: {
        get: async key => ({ [key]: session[key] }),
        set: async values => Object.assign(session, values),
        remove: async keys => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key]
        }
      },
      onChanged: { addListener: () => {} }
    }
  }

  try {
    const { setGoogleAnalyticsEnabled } = await import('../../../src/lib/analytics/preferences.ts')
    const { sendGaEvent, stopGoogleAnalyticsReporting } =
      await import('../../../src/lib/analytics/ga.ts')
    stopReporting = stopGoogleAnalyticsReporting
    await setGoogleAnalyticsEnabled(true)
    globalThis.fetch = async (url, options) => {
      if (url === 'https://rpc.zknoir.com/cdn-cgi/trace') return new Response('loc=US\n')
      gaBody = JSON.parse(options.body)
      return new Response('', { status: 204 })
    }
    await sendGaEvent(
      'page_view',
      {
        browser: 'Chrome',
        browser_major_version: '150',
        device_category: 'desktop',
        language: 'en-US',
        operating_system: 'macOS',
        page_id: PAGE_IDS.HOME,
        page_location: 'https://noir-wallet.extension/noir_home',
        page_title: PAGE_IDS.HOME
      },
      { foreground: true }
    )
    assert.equal(gaBody.user_location.country_id, 'US')
    assert.match(gaBody.client_id, /^\d+\.\d+$/)
    assert.equal(gaBody.device.browser_version, '150')
    assert.equal(gaBody.device.model, 'Desktop')
    assert.equal(gaBody.events[0].params.browser, undefined)
    assert.equal(gaBody.events[0].params.page_id, PAGE_IDS.HOME)
    assert.equal(gaBody.events[0].params.extension_version, '2.0.0-beta.2')
    assert.match(local.ga_client_id, /^[0-9a-f-]{36}$/)
    assert.notEqual(local.ga_client_id, gaBody.client_id)
  } finally {
    await stopReporting?.()
    globalThis.chrome = previousChrome
    globalThis.fetch = previousFetch
    if (previousSecret === undefined) delete globalThis.__GA_API_SECRET__
    else globalThis.__GA_API_SECRET__ = previousSecret
    if (previousVersion === undefined) delete globalThis.__APP_VERSION__
    else globalThis.__APP_VERSION__ = previousVersion
    if (previousChannel === undefined) delete globalThis.__BUILD_CHANNEL__
    else globalThis.__BUILD_CHANNEL__ = previousChannel
    if (previousNetwork === undefined) delete globalThis.__NETWORK_MODE__
    else globalThis.__NETWORK_MODE__ = previousNetwork
  }
})

describe('privacy policy: outbound event minimization', () => {
  it('drops exact amounts, addresses, origins, hashes and raw errors', () => {
    const event = sanitizeAnalyticsEvent(ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED, {
      pageId: PAGE_IDS.DAPP,
      hasTransaction: 1,
      inputAmount: '12.345',
      inputSymbol: 'ZEC',
      usdAmount: '999.99',
      walletAddress: 'u1-wallet-address',
      params: {
        origin: 'https://private-dapp.example',
        amount: '12.345',
        hardware: true
      },
      extra: {
        origin: 'https://private-dapp.example',
        error: 'raw signer failure',
        tx_hash: 'transaction-hash',
        deposit_address: 'deposit-address',
        funding_source: 'shielded'
      }
    })

    assert.deepEqual(event, {
      name: ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED,
      options: {
        pageId: PAGE_IDS.DAPP,
        hasTransaction: 1,
        inputSymbol: 'ZEC',
        extra: { funding_source: 'shielded' }
      }
    })
  })

  it('uses a closed event catalog and per-event fields', () => {
    assert.equal(sanitizeAnalyticsEvent('unreviewed_event', {}), null)

    const created = sanitizeAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, {
      params: { method: 'import', seed_words: 'never-send' },
      extra: { has_birthday_height: true, mnemonic: 'never-send' }
    })
    assert.deepEqual(created, {
      name: ANALYTICS_EVENTS.WALLET_CREATED,
      options: {
        pageId: PAGE_IDS.BACKGROUND,
        params: { method: 'import' },
        extra: { has_birthday_height: true }
      }
    })
  })

  it('has an explicit policy entry for every catalog event', () => {
    for (const eventName of Object.values(ANALYTICS_EVENTS)) {
      assert.notEqual(sanitizeAnalyticsEvent(eventName, {}), null)
    }
  })
})

describe('client: durable delivery and bounded retry', () => {
  it('persists before upload, deduplicates recent deliveries and retries malformed responses', async () => {
    const realFetch = globalThis.fetch
    const realChrome = globalThis.chrome
    const storage = {}
    const requests = []
    const responses = [
      { ok: true, json: async () => ({ code: 1 }) },
      {
        ok: true,
        json: async () => {
          throw new SyntaxError('invalid JSON')
        }
      },
      { ok: true, json: async () => ({ code: 0 }) }
    ]
    globalThis.chrome = {
      storage: {
        local: {
          get: async key => ({ [key]: storage[key] }),
          set: async values => Object.assign(storage, values)
        }
      },
      alarms: { create: async () => {}, clear: async () => {} }
    }
    globalThis.fetch = mock.fn(async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return responses.shift()
    })

    try {
      const { clearAnalyticsQueue, enqueueAnalyticsEvent, flushAnalyticsOutbox } =
        await import('../../../src/lib/analytics/client.ts')
      const event = buildPayload('swap_completed', {}, 1700000000000)
      await enqueueAnalyticsEvent(event, 'transaction-local-id')
      await enqueueAnalyticsEvent(event, 'transaction-local-id')
      const persisted = storage.analytics_collector_outbox_v1
      assert.equal(persisted.entries.length, 1)
      assert.ok(!JSON.stringify(persisted).includes('transaction-local-id'))

      await flushAnalyticsOutbox()
      assert.equal(storage.analytics_collector_outbox_v1.entries[0].attempts, 1)
      await flushAnalyticsOutbox()
      assert.equal(storage.analytics_collector_outbox_v1.entries[0].attempts, 2)
      await flushAnalyticsOutbox()
      assert.equal(storage.analytics_collector_outbox_v1.entries.length, 0)
      await enqueueAnalyticsEvent(event, 'transaction-local-id')
      assert.equal(storage.analytics_collector_outbox_v1.entries.length, 0)
      assert.equal(requests.length, 3)
      assert.equal(requests[0].url, CUSTOM_ANALYTICS_CONFIG.endpoint)
      const decrypted = JSON.parse(decryptLikeGoBackend(requests[0].body.data, PASSWORD))
      assert.deepEqual(decrypted, [event])
      await clearAnalyticsQueue()
    } finally {
      globalThis.fetch = realFetch
      globalThis.chrome = realChrome
    }
  })
})
