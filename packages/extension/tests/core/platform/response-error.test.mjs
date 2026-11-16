import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyError, getResponseErrorMessage } from '../../../src/lib/errors.ts'
import { fetchWithTimeout } from '../../../src/lib/fetch-utils.ts'

test('response errors preserve strings and use caller fallbacks for malformed values', () => {
  assert.equal(getResponseErrorMessage({ error: 'Request failed' }), 'Request failed')
  assert.equal(getResponseErrorMessage({ error: '' }) ?? 'fallback', '')
  assert.equal(getResponseErrorMessage({ error: '' }) || 'fallback', 'fallback')
  for (const response of [
    null,
    undefined,
    false,
    1,
    'failure',
    [],
    {},
    { error: 500 },
    { error: { message: 'failure' } }
  ]) {
    assert.equal(getResponseErrorMessage(response) ?? 'fallback', 'fallback')
  }
})

test('classifies HTTP rate limits without displaying the response body', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('<html><body>proxy diagnostic</body></html>', {
      status: 429,
      headers: { 'content-type': 'text/html' }
    })
  try {
    const error = await fetchWithTimeout('https://rpc.example').catch(cause => cause)
    assert.deepEqual(classifyError(error), {
      userMessage: 'Server is busy. Please wait a moment and try again.',
      technicalMessage: 'HTTP 429: Request failed',
      retryable: true
    })
    assert.equal(
      classifyError(new Error('unrecognized upstream details')).userMessage,
      'An unexpected error occurred. Please try again.'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
