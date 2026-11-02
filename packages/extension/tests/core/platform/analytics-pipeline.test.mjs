import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ANALYTICS_EVENTS,
  PAGE_IDS,
  buildAnalyticsPageMetadata,
  resolveAnalyticsChain,
  resolvePageId
} from '../../../src/lib/analytics/constants.ts'
import { sanitizeAnalyticsEvent } from '../../../src/lib/analytics/policy.ts'
import { buildPayload, sanitizeAnalyticsMetadata } from '../../../src/lib/analytics/payload.ts'
import { buildGaEventParams } from '../../../src/lib/analytics/ga.ts'
import {
  MAX_OUTBOX_ATTEMPTS,
  MAX_OUTBOX_EVENTS,
  OUTBOX_RETENTION_MS,
  addAnalyticsOutboxEntry,
  emptyAnalyticsOutbox,
  parseAnalyticsOutbox,
  pruneAnalyticsOutbox,
  settleAnalyticsOutboxBatch
} from '../../../src/lib/analytics/outbox.ts'

test('V2 pages and chain families resolve to bounded analytics values', () => {
  const routes = [
    '/onboarding/create-word-count',
    '/asset-detail',
    '/import-private-key',
    '/export-private-key',
    '/hardware/keystone-connect',
    '/hardware/bitcoin-sign',
    '/hardware/evm-sign',
    '/zero-indexer-nodes',
    '/developer-settings',
    '/address-book',
    '/help',
    '/send/cross-chain',
    '/send/zcash',
    '/voting',
    '/voting/round',
    '/hardware/ledger-connect',
    '/hardware/ledger-sign',
    '/manage-tokens'
  ]
  for (const route of routes) {
    assert.ok(Object.values(PAGE_IDS).includes(resolvePageId(route)), route)
  }
  for (const chain of ['zcash', 'evm', 'bitcoin', 'solana', 'near']) {
    assert.equal(resolveAnalyticsChain(chain), chain)
  }
  assert.equal(resolveAnalyticsChain('tron'), undefined)
  assert.deepEqual(sanitizeAnalyticsMetadata({ chain: 'tron', sourceFamily: 'tron' }), {})
  assert.equal(buildPayload('test_event', { chain: 'tron' }).chain, 'zcash')
  assert.equal(sanitizeAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, { chain: 'tron' }), null)
  assert.equal(
    sanitizeAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, { idempotencyKey: '' }),
    null
  )
  assert.deepEqual(buildAnalyticsPageMetadata('/send?to=u1-private-address#memo'), {
    pageId: PAGE_IDS.SEND,
    pageLocation: 'https://noir-wallet.extension/noir_send',
    pageTitle: PAGE_IDS.SEND
  })
  assert.deepEqual(buildAnalyticsPageMetadata('/u1-private-address?amount=42'), {
    pageId: PAGE_IDS.BACKGROUND,
    pageLocation: 'https://noir-wallet.extension/noir_background',
    pageTitle: PAGE_IDS.BACKGROUND
  })
  const canonicalPage = buildAnalyticsPageMetadata(
    '/onboarding/import-zcash-history?address=secret'
  )
  assert.deepEqual(
    sanitizeAnalyticsMetadata({
      page_id: canonicalPage.pageId,
      page_location: canonicalPage.pageLocation,
      page_title: canonicalPage.pageTitle,
      chain: 'zcash'
    }),
    {
      page_id: PAGE_IDS.ONBOARDING_IMPORT_ZCASH_HISTORY,
      page_location: 'https://noir-wallet.extension/noir_onboarding_import_zcash_history',
      page_title: PAGE_IDS.ONBOARDING_IMPORT_ZCASH_HISTORY,
      chain: 'zcash'
    }
  )
  assert.deepEqual(
    sanitizeAnalyticsMetadata({
      page_location:
        'https://noir-wallet.extension/noir_onboarding_import_zcash_history?address=secret',
      page_title: '/onboarding/import-zcash-history?address=secret'
    }),
    {}
  )
  const pageParams = buildGaEventParams(
    'page_view',
    {
      page_id: canonicalPage.pageId,
      page_location: canonicalPage.pageLocation,
      page_title: canonicalPage.pageTitle,
      chain: 'zcash'
    },
    { appVersion: '2.0.0', buildChannel: 'production', foreground: true, networkMode: 'mainnet' }
  )
  assert.equal(pageParams.chain, 'zcash')
  assert.equal(pageParams.page_location, canonicalPage.pageLocation)
})

test('every catalog event preserves its permitted fields in both channels', () => {
  const options = {
    pageId: PAGE_IDS.SWAP,
    chain: 'evm',
    idempotencyKey: 'local-transaction-reference',
    inputAmount: '123.45',
    walletAddress: 'private-address',
    params: {
      previous_version: '1.0.30',
      method: 'import',
      hardware: true,
      from_token: 'ZEC',
      to_token: 'ETH'
    },
    extra: {
      has_birthday_height: true,
      from_dapp: true,
      fee_tier: 'normal',
      hardware: true,
      funding_source: 'shielded',
      kind: 'send',
      phase: 'broadcast',
      direction: 'zec_to_other',
      sourceFamily: 'evm',
      status: 'SUCCESS',
      action: 'Swap',
      is_existing_wallet: false,
      account_count: 2,
      source: 'session',
      signing_mode: 'software',
      method: 'session'
    }
  }
  for (const name of Object.values(ANALYTICS_EVENTS)) {
    const event = sanitizeAnalyticsEvent(name, options)
    assert.ok(event, name)
    const payload = buildPayload(name, event.options, 1000)
    const collector = payload.extra ? JSON.parse(payload.extra) : {}
    const ga = buildGaEventParams(
      name,
      {
        ...event.options.params,
        ...event.options.extra,
        page_id: event.options.pageId,
        chain: event.options.chain
      },
      { appVersion: '2.0.0', buildChannel: 'production', foreground: true, networkMode: 'mainnet' }
    )
    assert.equal(payload.chain, 'evm')
    assert.equal(payload.page_id, PAGE_IDS.SWAP)
    for (const [key, value] of Object.entries({
      ...event.options.params,
      ...event.options.extra
    })) {
      assert.equal(collector[key], value, `${name}: collector ${key}`)
      assert.equal(ga[key], value, `${name}: GA ${key}`)
    }
    assert.equal(ga.page_id, PAGE_IDS.SWAP)
    assert.equal(ga.chain, 'evm')
    assert.equal(payload.input_amount, '')
    assert.ok(!JSON.stringify(payload).includes('private-address'))
    assert.ok(!JSON.stringify(payload).includes('local-transaction-reference'))
  }
})

test('V2 event enums accept intended values and reject arbitrary strings', () => {
  const completed = sanitizeAnalyticsEvent(ANALYTICS_EVENTS.SWAP_COMPLETED, {
    extra: {
      action: 'Withdraw',
      direction: 'other_to_zec',
      sourceFamily: 'near',
      status: 'SUCCESS'
    }
  })
  assert.deepEqual(completed.options.extra, {
    action: 'Withdraw',
    direction: 'other_to_zec',
    sourceFamily: 'near',
    status: 'SUCCESS'
  })
  const rejected = sanitizeAnalyticsEvent(ANALYTICS_EVENTS.SWAP_COMPLETED, {
    extra: { action: 'secret memo', direction: 'arbitrary', sourceFamily: 'tron' }
  })
  assert.equal(rejected.options.extra, undefined)
  const created = sanitizeAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, {
    params: { method: 'private_key' },
    extra: { hardware: 'ledger' }
  })
  assert.deepEqual(created.options.params, { method: 'private_key' })
  assert.deepEqual(created.options.extra, { hardware: 'ledger' })
  const submitted = sanitizeAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, {
    extra: { kind: 'private-transfer', funding_source: 'shielded' }
  })
  assert.deepEqual(submitted.options.extra, {
    kind: 'private-transfer',
    funding_source: 'shielded'
  })
  for (const fundingSource of ['main', 'private']) {
    const sent = sanitizeAnalyticsEvent(ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT, {
      extra: { funding_source: fundingSource }
    })
    assert.equal(sent.options.extra.funding_source, fundingSource)
    assert.equal(
      JSON.parse(buildPayload(sent.name, sent.options).extra).funding_source,
      fundingSource
    )
  }
})

test('retired interaction events are rejected and removed from recovered pending delivery', () => {
  const now = 1_000_000
  const retired = ['address_copied', 'account_switched', 'wallet_locked']
  const names = [...retired, ANALYTICS_EVENTS.SEND_SUCCEEDED]
  const state = {
    version: 1,
    entries: names.map((name, index) => ({
      id: `event-${index}`,
      payload: buildPayload(name, {}),
      attempts: 0,
      createdAt: now
    }))
  }
  for (const name of retired) {
    assert.equal(sanitizeAnalyticsEvent(name), null)
  }
  const expected = [state.entries.at(-1)]
  assert.deepEqual(parseAnalyticsOutbox(state, now).entries, expected)
  assert.deepEqual(pruneAnalyticsOutbox(state, now).entries, expected)
  assert.deepEqual(
    sanitizeAnalyticsMetadata({ address_type: 'public', cross_wallet: false, reason: 'manual' }),
    {}
  )
})

test('outbox survives serialization and rejects queued duplicate keys', () => {
  const now = 1_000_000
  const entry = {
    id: 'event-1',
    payload: buildPayload(ANALYTICS_EVENTS.SEND_SUCCEEDED, {}),
    idempotencyKey: 'hashed-key',
    attempts: 0,
    createdAt: now
  }
  const first = addAnalyticsOutboxEntry(emptyAnalyticsOutbox(), entry, now)
  assert.equal(first.result, 'added')
  const reloaded = parseAnalyticsOutbox(JSON.parse(JSON.stringify(first.state)), now + 1)
  assert.equal(
    addAnalyticsOutboxEntry(reloaded, { ...entry, id: 'event-2' }, now + 1).result,
    'duplicate'
  )
  const acknowledged = settleAnalyticsOutboxBatch(reloaded, ['event-1'], true, now + 2)
  assert.equal(acknowledged.entries.length, 0)
  assert.equal(
    addAnalyticsOutboxEntry(acknowledged, { ...entry, id: 'event-3' }, now + 3).result,
    'added'
  )
  assert.equal(
    addAnalyticsOutboxEntry(
      acknowledged,
      { ...entry, id: 'event-4', createdAt: now + OUTBOX_RETENTION_MS + 2 },
      now + OUTBOX_RETENTION_MS + 2
    ).result,
    'added'
  )
})

test('outbox bounds retries and pending entries', () => {
  const now = 1_000_000
  const payload = buildPayload(ANALYTICS_EVENTS.SWAP_COMPLETED, {})
  let state = emptyAnalyticsOutbox()
  for (let index = 0; index < MAX_OUTBOX_EVENTS + 5; index++) {
    state = addAnalyticsOutboxEntry(
      state,
      {
        id: `event-${index}`,
        payload,
        attempts: 0,
        createdAt: now
      },
      now
    ).state
  }
  assert.equal(state.entries.length, MAX_OUTBOX_EVENTS)
  assert.equal(state.entries[0].id, 'event-0')
  assert.equal(state.entries.at(-1).id, `event-${MAX_OUTBOX_EVENTS - 1}`)
  assert.equal(
    addAnalyticsOutboxEntry(
      state,
      { id: 'over-capacity', payload, attempts: 0, createdAt: now },
      now
    ).result,
    'full'
  )
  for (let attempt = 1; attempt <= MAX_OUTBOX_ATTEMPTS; attempt++) {
    state = settleAnalyticsOutboxBatch(state, ['event-0'], false, now + attempt)
  }
  assert.ok(!state.entries.some(entry => entry.id === 'event-0'))
})
