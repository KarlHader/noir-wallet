import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DedupPromise } from '../../../src/lib/async-utils'
import {
  FetchHttpError,
  FetchResponseTooLargeError,
  FetchTimeoutError,
  fetchJsonWithTimeout,
  fetchWithTimeout
} from '../../../src/lib/fetch-utils'
async function withFetch(mock, action) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await action()
  } finally {
    globalThis.fetch = originalFetch
  }
}
function hangingResponse(status = 200) {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'))
    },
    cancel() {
      cancelled = true
    }
  })
  return {
    response: new Response(body, { status }),
    wasCancelled: () => cancelled
  }
}
describe('bounded fetch response consumption', () => {
  test('times out after headers when the successful body stalls, and cancels its reader', async () => {
    const stalled = hangingResponse()
    await withFetch(
      async () => stalled.response,
      async () => {
        await assert.rejects(
          fetchJsonWithTimeout('https://example.test/data', { timeoutMs: 20 }),
          FetchTimeoutError
        )
        assert.equal(stalled.wasCancelled(), true)
      }
    )
  })
  test('honors external abort during body consumption', async () => {
    const stalled = hangingResponse()
    const controller = new AbortController()
    const reason = new Error('Caller cancelled')
    await withFetch(
      async () => stalled.response,
      async () => {
        const pending = fetchJsonWithTimeout('https://example.test/data', {
          signal: controller.signal,
          timeoutMs: 1000
        })
        await new Promise(resolve => setTimeout(resolve, 0))
        controller.abort(reason)
        await assert.rejects(pending, error => error === reason)
        assert.equal(stalled.wasCancelled(), true)
      }
    )
  })
  test('rejects an oversized Content-Length before reading', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        }
      }),
      { headers: { 'content-length': '100' } }
    )
    await withFetch(
      async () => response,
      async () => {
        await assert.rejects(
          fetchJsonWithTimeout('https://example.test/data', { maxBytes: 10 }),
          FetchResponseTooLargeError
        )
        assert.equal(cancelled, true)
      }
    )
  })
  test('rejects an oversized streamed body without Content-Length', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(12))
        },
        cancel() {
          cancelled = true
        }
      })
    )
    await withFetch(
      async () => response,
      async () => {
        await assert.rejects(
          fetchJsonWithTimeout('https://example.test/data', { maxBytes: 10 }),
          FetchResponseTooLargeError
        )
        assert.equal(cancelled, true)
      }
    )
  })
  test('preserves a bounded JSON error detail', async () => {
    await withFetch(
      async () =>
        new Response(JSON.stringify({ message: 'Try a smaller amount' }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        }),
      async () => {
        await assert.rejects(
          fetchJsonWithTimeout('https://example.test/data'),
          error => error instanceof FetchHttpError && error.detail === 'Try a smaller amount'
        )
      }
    )
  })
  test('bounds a large error body and cancels its stream', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('error'.repeat(4000)))
        },
        cancel() {
          cancelled = true
        }
      }),
      { status: 400, headers: { 'content-type': 'text/plain' } }
    )
    await withFetch(
      async () => response,
      async () => {
        await assert.rejects(
          fetchJsonWithTimeout('https://example.test/data'),
          error => error instanceof FetchHttpError && error.detail?.length === 300
        )
        assert.equal(cancelled, true)
      }
    )
  })
  test('times out when an error body stalls', async () => {
    const stalled = hangingResponse(503)
    await withFetch(
      async () => stalled.response,
      async () => {
        await assert.rejects(
          fetchJsonWithTimeout('https://example.test/data', { timeoutMs: 20 }),
          FetchTimeoutError
        )
        assert.equal(stalled.wasCancelled(), true)
      }
    )
  })
  test('parses normal JSON and preserves image content type', async () => {
    await withFetch(
      async () => new Response('{"ok":true}'),
      async () => {
        assert.deepEqual(await fetchJsonWithTimeout('https://example.test/data'), { ok: true })
      }
    )
    await withFetch(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' }
        }),
      async () => {
        const blob = await (await fetchWithTimeout('https://example.test/image')).blob()
        assert.equal(blob.type, 'image/png')
        assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3])
      }
    )
  })
  test('a failed deduplicated request settles and a later call retries', async () => {
    const dedup = new DedupPromise()
    let calls = 0
    await withFetch(
      async () => {
        calls++
        return calls === 1 ? hangingResponse().response : new Response('{"ok":true}')
      },
      async () => {
        const request = () =>
          dedup.run(() => fetchJsonWithTimeout('https://example.test/data', { timeoutMs: 20 }))
        await assert.rejects(request(), FetchTimeoutError)
        assert.deepEqual(await request(), { ok: true })
        assert.equal(calls, 2)
      }
    )
  })
})

test('Response clients receive a bounded body and preserve status and headers', async () => {
  await withFetch(
    async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
    async () => {
      const response = await fetchWithTimeout('https://example.test/data', { timeoutMs: 20 })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/json')
      assert.deepEqual(await response.json(), { ok: true })
    }
  )
  await withFetch(
    async () => new Response(null, { status: 204 }),
    async () => {
      const response = await fetchWithTimeout('https://example.test/empty')
      assert.equal(response.status, 204)
      assert.equal(await response.text(), '')
    }
  )
})

test('a stalled cancellation does not keep the caller pending after the deadline', async () => {
  const body = new ReadableStream({
    cancel() {
      return new Promise(() => {})
    }
  })
  await withFetch(
    async () => new Response(body),
    async () => {
      await assert.rejects(
        fetchWithTimeout('https://example.test/data', { timeoutMs: 20 }),
        FetchTimeoutError
      )
    }
  )
})
