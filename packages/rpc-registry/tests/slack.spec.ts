import { expect, test } from '@playwright/test'
import type { PlannedNotification } from '../src/alert-state'
import { formatSlackNotification, sendSlackNotification } from '../src/slack'

const NOTIFICATION: PlannedNotification = {
  kind: 'opened',
  items: [
    {
      key: 'zcash-mainnet:deltarpc:GetSubtreeRoots',
      chainId: 'zcash-mainnet',
      chain: 'zcash',
      network: 'mainnet',
      targetId: 'deltarpc',
      targetLabel: 'DeltaRPC',
      check: 'GetSubtreeRoots',
      attempts: 3,
      elapsedMs: 20_001,
      error: 'Timed out after 20000ms',
      lastHeight: 3_100_000
    }
  ]
}

test('formats a plain Slack alert with required RPC context', () => {
  const payload = formatSlackNotification(NOTIFICATION, Date.UTC(2026, 8, 4, 1, 2, 3))
  const encoded = JSON.stringify(payload)

  expect(encoded).toContain('DeltaRPC')
  expect(encoded).toContain('GetSubtreeRoots')
  expect(encoded).toContain('Timed out after 20000ms')
  expect(encoded).toContain('elapsed=20001ms')
  expect(encoded).toContain('3100000')
  expect(encoded).toContain('2026-09-04T01:02:03.000Z')
  expect(encoded).not.toContain('@channel')
  expect(payload.text).toBe(
    '2026-09-04T01:02:03.000Z level=ERROR state=open chain="zcash-mainnet" provider="DeltaRPC" method=GetSubtreeRoots attempts=3 elapsed=20001ms height=3100000 error="Timed out after 20000ms"'
  )
  expect(payload.blocks).toHaveLength(1)
})

test('posts the payload without exposing the webhook in its body', async () => {
  let requestBody = ''
  await sendSlackNotification(
    'https://hooks.slack.com/services/T000/B000/secret',
    NOTIFICATION,
    0,
    async (_input, init) => {
      requestBody = String(init?.body)
      return new Response('ok', { status: 200 })
    }
  )

  expect(requestBody).toContain('DeltaRPC')
  expect(requestBody).not.toContain('T000/B000/secret')
})

test('throws when Slack does not accept the notification', async () => {
  await expect(
    sendSlackNotification(
      'https://hooks.slack.com/services/T000/B000/secret',
      NOTIFICATION,
      0,
      async () => new Response('rate limited', { status: 429 })
    )
  ).rejects.toThrow('Slack webhook returned HTTP 429')
})
