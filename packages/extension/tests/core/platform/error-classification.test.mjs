import { test } from 'node:test'
import { expect } from '@playwright/test'

import { classifyError, isRpcEndpointError, isWalletLockedError } from '../../../src/lib/errors.ts'
import { fetchWithTimeout } from '../../../src/lib/fetch-utils.ts'

test.describe('Error classification', () => {
  test('shows actionable backup failures while keeping unrelated errors private', () => {
    expect(
      classifyError(
        new Error('Backup words do not match this wallet. View your secret phrase and try again.')
      )
    ).toMatchObject({
      userMessage: 'Backup words do not match this wallet. View your secret phrase and try again.',
      retryable: false
    })
    expect(
      classifyError(
        new Error('Unable to verify this wallet backup. Unlock and view your secret phrase.')
      )
    ).toMatchObject({
      userMessage: "Unlock and view this wallet's secret phrase before verifying its backup.",
      retryable: false
    })
    expect(classifyError(new Error('Wallet changed or locked. Please try again.'))).toMatchObject({
      userMessage: 'Wallet state changed. Please retry the operation.',
      retryable: true
    })
    expect(classifyError(new Error('Unknown private backend details'))).toMatchObject({
      userMessage: 'An unexpected error occurred. Please try again.'
    })
  })
  test('identifies locked wallet failures for an unlock redirect', () => {
    expect(isWalletLockedError(new Error('Wallet is locked. Please unlock and try again.'))).toBe(
      true
    )
    expect(isWalletLockedError(new Error('Wallet is syncing. Please wait.'))).toBe(false)
  })

  test('maps the Zcash InsufficientFunds payload to an actionable balance error', () => {
    expect(
      classifyError(
        new Error(
          'Failed to propose transfer. Possibly insufficient permitted funds: InsufficientFunds { available: Zatoshis(0), required: Zatoshis(110000) }'
        )
      )
    ).toEqual({
      userMessage: 'Insufficient balance for this transaction.',
      technicalMessage:
        'Failed to propose transfer. Possibly insufficient permitted funds: InsufficientFunds { available: Zatoshis(0), required: Zatoshis(110000) }',
      retryable: false
    })
  })

  test('distinguishes actionable Swap route failures', () => {
    expect(classifyError(new Error('RHEA Swap quote expired'))).toMatchObject({
      userMessage: 'Swap quote expired. Get a new quote and review it again.',
      retryable: false
    })
    expect(classifyError(new Error('Token ABC not found on chain 1'))).toMatchObject({
      userMessage: 'This asset is not supported for this Swap route.',
      retryable: false
    })
    expect(classifyError(new Error('No liquidity for this route'))).toMatchObject({
      userMessage: 'No Swap route is available for this asset pair.',
      retryable: false
    })
    expect(classifyError(new Error('Minimum swap amount is $1,000'))).toMatchObject({
      userMessage: 'Amount is below the current minimum for this Swap route.',
      retryable: false
    })
    expect(classifyError(new Error('pre-swap 1Click upstream error'))).toMatchObject({
      userMessage: 'The Swap provider is temporarily unavailable. Please try again later.',
      retryable: true
    })
  })

  test('classifies upstream HTTP failures without exposing an HTML error page', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response('<html><body>proxy diagnostic</body></html>', {
        status: 503,
        headers: { 'content-type': 'text/html' }
      })
    try {
      const error = await fetchWithTimeout('https://rpc.example').catch(cause => cause)
      expect(error.message).toBe('HTTP 503: Request failed')
      expect(isRpcEndpointError(error)).toBe(true)
      expect(classifyError(error)).toMatchObject({
        userMessage: 'Service is temporarily unavailable. Please try again shortly.',
        retryable: true
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
