import { test as it } from '@playwright/test'
import assert from 'node:assert/strict'
import { encryptAnalyticsPayload } from '../../../src/lib/analytics/crypto.ts'
import { buildPayload } from '../../../src/lib/analytics/payload.ts'
import { ANALYTICS_EVENTS, PAGE_IDS } from '../../../src/lib/analytics/constants.ts'
import { CUSTOM_ANALYTICS_CONFIG } from '../../../src/config/analytics.ts'
const describe = it.describe

describe('collector E2E (opt-in: ANALYTICS_E2E=1)', () => {
  it.skip(
    process.env.ANALYTICS_E2E !== '1' || !process.env.CUSTOM_ANALYTICS_PASSWORD,
    'Set ANALYTICS_E2E=1 and CUSTOM_ANALYTICS_PASSWORD to send a live event'
  )

  it('accepts an encrypted integration_test event', async () => {
    const event = buildPayload(ANALYTICS_EVENTS.SEND_SUCCEEDED, {
      pageId: PAGE_IDS.BACKGROUND,
      collector: {
        inputAmount: '0.000000000000000001',
        usdAmount: '12.50',
        sourceDomain: 'private',
        privacyRoute: 'direct',
        activityType: 'transfer',
        settlement: 'broadcast'
      }
    })
    // Keep synthetic transport checks out of real product conversion counts.
    event.event_name = 'integration_test'
    event.wallet_address = 'anon_automated-test'
    const data = await encryptAnalyticsPayload(
      JSON.stringify([event]),
      process.env.CUSTOM_ANALYTICS_PASSWORD
    )
    const response = await fetch(CUSTOM_ANALYTICS_CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.code, 0, `collector rejected the event: ${JSON.stringify(body)}`)
  })
})
