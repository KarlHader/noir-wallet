import { readBoundedResponseText } from '@/lib/fetch-utils'

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

interface RpcEndpoint {
  readonly url: string
}

async function isRetryableJsonRpcResponse(
  response: Response,
  requestId: unknown
): Promise<boolean> {
  if (!response.ok) {
    return (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 429 ||
      response.status >= 500
    )
  }
  try {
    const body = await readBoundedResponseText(
      response.clone(),
      4 * 1024 * 1024,
      () => new Error('RPC response is too large')
    )
    const decoded: unknown = JSON.parse(body)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return true
    const envelope = decoded as Record<string, unknown>
    if (envelope.jsonrpc !== '2.0' || envelope.id !== requestId) return true
    const error = envelope.error
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const code = (error as Record<string, unknown>).code
      return code === 429 || code === -32_005
    }
    return !Object.prototype.hasOwnProperty.call(envelope, 'result')
  } catch {
    return true
  }
}

export function createJsonRpcFailoverFetch(
  endpoints: readonly RpcEndpoint[],
  attest: (url: string, signal?: AbortSignal) => Promise<void>,
  fetchImplementation: FetchImplementation = fetch
): FetchImplementation {
  if (endpoints.length === 0) throw new Error('No RPC endpoints configured')
  const verified = new Set<string>()
  let activeIndex = 0

  return async (_input, init) => {
    const signal = init.signal ?? undefined
    const request =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as { method?: unknown; id?: unknown })
        : undefined
    const method = request?.method
    const mayRetry =
      method !== 'sendTransaction' &&
      method !== 'broadcast_tx_async' &&
      method !== 'broadcast_tx_commit'
    let lastError: unknown
    for (let offset = 0; offset < endpoints.length; offset += 1) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const index = (activeIndex + offset) % endpoints.length
      const url = endpoints[index].url
      try {
        if (!verified.has(url)) {
          await attest(url, signal)
          verified.add(url)
        }
      } catch (error) {
        verified.delete(url)
        lastError = error
        continue
      }
      try {
        const response = await fetchImplementation(url, init)
        if (mayRetry && (await isRetryableJsonRpcResponse(response, request?.id))) {
          lastError = new Error('RPC endpoint returned an invalid or unavailable response')
          verified.delete(url)
          continue
        }
        activeIndex = index
        return response
      } catch (error) {
        if (signal?.aborted) throw error
        verified.delete(url)
        lastError = error
        if (!mayRetry) throw error
      }
    }
    throw lastError ?? new Error('All RPC endpoints are unavailable')
  }
}
