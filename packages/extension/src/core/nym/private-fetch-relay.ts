/**
 * Text requests that must leave through the Nym tunnel (zcashd lookups, ZEC swap requests).
 * Extension pages ask the background, which forwards to the offscreen document that owns the
 * tunnel. A failure is returned to the caller; nothing falls back to a direct request.
 */

export const NYM_PRIVATE_FETCH_MESSAGE = 'NYM_PRIVATE_FETCH'
export const NYM_PRIVATE_FETCH_OFFSCREEN_MESSAGE = 'NYM_PRIVATE_FETCH_OFFSCREEN'

const MAX_REQUEST_BODY_CHARS = 64 * 1024
const MAX_HEADERS = 16

export interface NymTextRequest {
  url: string
  method: 'GET' | 'POST'
  headers: [string, string][]
  bodyText: string | null
}

export interface NymTextResponse {
  status: number
  statusText: string
  headers: [string, string][]
  bodyText: string
}

export type NymTextReply = { ok: true; response: NymTextResponse } | { ok: false; error: string }

function isStringPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  )
}

export function parseNymTextRequest(value: unknown): NymTextRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid private request')
  }
  const { url, method, headers, bodyText } = value as Record<string, unknown>
  if (typeof url !== 'string' || new URL(url).protocol !== 'https:') {
    throw new Error('Private requests must use HTTPS')
  }
  if (method !== 'GET' && method !== 'POST') throw new Error('Invalid private request method')
  if (!Array.isArray(headers) || headers.length > MAX_HEADERS || !headers.every(isStringPair)) {
    throw new Error('Invalid private request headers')
  }
  if (
    bodyText !== null &&
    (typeof bodyText !== 'string' || bodyText.length > MAX_REQUEST_BODY_CHARS)
  ) {
    throw new Error('Invalid private request body')
  }
  return { url, method, headers: headers.map(([name, v]) => [name, v]), bodyText }
}

export function parseNymTextReply(value: unknown): NymTextResponse {
  if (!value || typeof value !== 'object') throw new Error('Private network unavailable')
  const reply = value as Partial<NymTextReply> & { response?: Partial<NymTextResponse> }
  if (reply.ok !== true) {
    throw new Error(
      typeof (reply as { error?: unknown }).error === 'string'
        ? (reply as { error: string }).error
        : 'Private network unavailable'
    )
  }
  const response = reply.response
  if (
    !response ||
    !Number.isSafeInteger(response.status) ||
    typeof response.statusText !== 'string' ||
    !Array.isArray(response.headers) ||
    !response.headers.every(isStringPair) ||
    typeof response.bodyText !== 'string'
  ) {
    throw new Error('Invalid private network response')
  }
  return response as NymTextResponse
}

type Relay = (request: NymTextRequest) => Promise<NymTextResponse>

let relay: Relay = async request =>
  parseNymTextReply(await chrome.runtime.sendMessage({ type: NYM_PRIVATE_FETCH_MESSAGE, request }))

/** The background replaces the page relay with a direct hand-off to the offscreen document. */
export function setNymPrivateFetchRelay(next: Relay): void {
  relay = next
}

export function nymPrivateTextFetch(request: NymTextRequest): Promise<NymTextResponse> {
  return relay(request)
}

/**
 * Relays `request` and waits for its answer. The tunnel cannot withdraw a request it was
 * handed, so `signal` only stops the wait.
 */
export async function nymPrivateTextFetchUntil(
  request: NymTextRequest,
  signal?: AbortSignal
): Promise<NymTextResponse> {
  if (signal?.aborted) throw signal.reason
  const relayed = nymPrivateTextFetch(request)
  if (!signal) return relayed
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      relayed,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** The relay could not answer; nothing was retried on the direct path. */
export class NymPrivateFetchError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'NymPrivateFetchError'
  }
}

const NULL_BODY_STATUSES = new Set([204, 205, 304])

/**
 * A fetch for text GET and POST requests that must leave through the Nym tunnel, so callers
 * keep their own HTTP status, size, and timeout handling. Relay failures reject with
 * `NymPrivateFetchError`.
 */
export async function nymPrivateFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const signal = init.signal ?? undefined
  const method = (init.method ?? 'GET').toUpperCase()
  if ((method !== 'GET' && method !== 'POST') || input instanceof Request) {
    throw new NymPrivateFetchError('Private requests support GET and POST URLs only')
  }
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
    throw new NymPrivateFetchError('Private requests need a text body')
  }
  let response: NymTextResponse
  try {
    response = await nymPrivateTextFetchUntil(
      {
        url: input instanceof URL ? input.href : input,
        method,
        headers: [...new Headers(init.headers).entries()],
        bodyText: init.body ?? null
      },
      signal
    )
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw new NymPrivateFetchError(
      error instanceof Error ? error.message : 'Private network unavailable'
    )
  }
  if (response.status < 200 || response.status > 599) {
    throw new NymPrivateFetchError('Private network returned an invalid HTTP status')
  }
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : response.bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}
