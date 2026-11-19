/**
 * Text requests that must leave through the Nym tunnel (transaction status lookups by txid).
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
