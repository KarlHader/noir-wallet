const REQUEST_TIMEOUT_MS = 15_000
const MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_KEYS = 8
const RATE_LIMIT_COOLDOWN_MS = 60_000
const AUTH_COOLDOWN_MS = 5 * 60_000
const RATE_LIMIT_CODES = new Set([-32090, -32077, -32070, -32069, -32068, -32067])
const KEY_ACCESS_CODES = new Set([
  -32049, -32050, -32051, -32060, -32052, -32053, -32054, -32079, -32080
])

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

class KeyUnavailableError extends UpstreamError {
  constructor(
    readonly cooldownMs: number,
    readonly rateLimited: boolean
  ) {
    super(rateLimited ? 429 : 503, 'Ankr API key unavailable')
  }
}

interface KeyState {
  readonly value: string
  cooldownUntil: number
  rateLimited: boolean
}

function parseKeys(secret: unknown): readonly string[] {
  if (typeof secret !== 'string' || secret.length > MAX_KEYS * 1_024) {
    throw new UpstreamError(503, 'Invalid Ankr API key configuration')
  }
  const value = secret.split(',')
  if (value.length > MAX_KEYS) {
    throw new UpstreamError(503, 'Invalid Ankr API key configuration')
  }
  const keys: string[] = []
  for (const key of value) {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(key.trim())) {
      throw new UpstreamError(503, 'Invalid Ankr API key configuration')
    }
    keys.push(key.trim())
  }
  return Object.freeze([...new Set(keys)])
}

function retryAfterMs(value: string | null): number {
  if (!value || value.length > 128) return RATE_LIMIT_COOLDOWN_MS
  const trimmed = value.trim()
  const milliseconds = /^\d+$/.test(trimmed)
    ? Number(trimmed) * 1_000
    : Date.parse(trimmed) - Date.now()
  return Number.isSafeInteger(milliseconds) &&
    milliseconds >= 0 &&
    Number.isSafeInteger(Date.now() + milliseconds)
    ? Math.max(RATE_LIMIT_COOLDOWN_MS, milliseconds)
    : RATE_LIMIT_COOLDOWN_MS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readResult(response: Response): Promise<unknown> {
  const bytes = await readBoundedBody(
    response,
    MAXIMUM_RESPONSE_BYTES,
    () => new UpstreamError(502, 'Ankr response exceeds the allowed size')
  )
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new UpstreamError(502, 'Ankr returned invalid JSON')
  }
  if (!isRecord(data) || data.jsonrpc !== '2.0' || data.id !== 1) {
    throw new UpstreamError(502, 'Ankr returned an invalid response')
  }
  if ('error' in data) {
    if (
      'result' in data ||
      !isRecord(data.error) ||
      typeof data.error.code !== 'number' ||
      !Number.isSafeInteger(data.error.code)
    ) {
      throw new UpstreamError(502, 'Ankr returned an invalid response')
    }
    const code = data.error.code
    if (RATE_LIMIT_CODES.has(code)) {
      throw new KeyUnavailableError(retryAfterMs(response.headers.get('retry-after')), true)
    }
    if (KEY_ACCESS_CODES.has(code)) {
      throw new KeyUnavailableError(AUTH_COOLDOWN_MS, false)
    }
    throw new UpstreamError(502, `Ankr RPC request failed (code=${code})`)
  }
  if (!('result' in data)) throw new UpstreamError(502, 'Ankr returned an invalid response')
  return data.result
}

export class AnkrClient {
  private readonly keys: KeyState[]
  private preferredIndex = 0

  constructor(keys: readonly string[]) {
    this.keys = keys.map(value => ({ value, cooldownUntil: 0, rateLimited: false }))
  }

  matches(keys: readonly string[]): boolean {
    return keys.length === this.keys.length && keys.every((key, i) => key === this.keys[i].value)
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) controller.abort()
    // One deadline covers the entire failover, including response-body reads.
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const deadline = Date.now() + REQUEST_TIMEOUT_MS
    const attempted = new Set<number>()
    try {
      while (attempted.size < this.keys.length) {
        this.assertActive(controller.signal, signal, deadline)
        const index = this.selectKey(attempted)
        if (index === null) break
        const key = this.keys[index]
        attempted.add(index)
        try {
          const response = await fetch(`https://rpc.ankr.com/multichain/${key.value}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
            // Workers only supports follow/manual. Reject 3xx below instead of forwarding keys.
            redirect: 'manual'
          })
          this.assertActive(controller.signal, signal, deadline)
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            if (response.status === 429) {
              throw new KeyUnavailableError(retryAfterMs(response.headers.get('retry-after')), true)
            }
            if (response.status === 401 || response.status === 403) {
              throw new KeyUnavailableError(AUTH_COOLDOWN_MS, false)
            }
            throw new UpstreamError(502, `Ankr HTTP request failed (status=${response.status})`)
          }
          const result = await readResult(response)
          this.assertActive(controller.signal, signal, deadline)
          // A late success must not undo a newer concurrent request's cooldown.
          if (key.cooldownUntil <= Date.now()) this.preferredIndex = index
          return result
        } catch (error) {
          this.assertActive(controller.signal, signal, deadline)
          if (!(error instanceof KeyUnavailableError)) {
            if (error instanceof UpstreamError) throw error
            // Fetch errors can contain the URL and its secret key.
            throw new UpstreamError(502, 'Ankr upstream unavailable')
          }
          key.cooldownUntil = Math.max(key.cooldownUntil, Date.now() + error.cooldownMs)
          key.rateLimited = error.rateLimited
          if (this.preferredIndex === index) this.preferredIndex = (index + 1) % this.keys.length
        }
      }
      const now = Date.now()
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((Math.min(...this.keys.map(key => key.cooldownUntil)) - now) / 1_000)
      )
      throw new UpstreamError(
        this.keys.some(key => key.rateLimited) ? 429 : 503,
        'Ankr API keys unavailable',
        retryAfterSeconds
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private selectKey(attempted: ReadonlySet<number>): number | null {
    const now = Date.now()
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (this.preferredIndex + offset) % this.keys.length
      if (!attempted.has(index) && this.keys[index].cooldownUntil <= now) return index
    }
    return null
  }

  private assertActive(
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    deadline: number
  ): void {
    if (callerSignal?.aborted) throw new UpstreamError(499, 'Request cancelled')
    if (signal.aborted || Date.now() >= deadline)
      throw new UpstreamError(504, 'Ankr request timed out')
  }
}

// Isolate-local state avoids retrying a failed key on every address refresh.
// Cloudflare isolates do not share cooldowns; this is not an account-wide quota coordinator.
let currentClient: AnkrClient | undefined

export function getAnkrClient(secret: unknown): AnkrClient {
  const keys = parseKeys(secret)
  if (!currentClient?.matches(keys)) currentClient = new AnkrClient(keys)
  return currentClient
}
import { readBoundedBody } from './read-bounded-body'
