/** Message shapes and routing rules shared by the Zcash Worker, the offscreen host and the tunnel page. */

export const NYM_PRIVATE_BROADCAST_PORT_MESSAGE = 'NYM_PRIVATE_BROADCAST_PORT'
export const NYM_TUNNEL_PORT_MESSAGE = 'NYM_TUNNEL_PORT'

const LIGHTWALLETD_SERVICE_PATH = '/cash.z.wallet.sdk.rpc.CompactTxStreamer/'

// The two ways a Nym-routed request fails. The text survives the WASM's error wrapping, so
// the wallet can word its failure message accordingly.

/** The request never entered the tunnel. */
export const NYM_UNAVAILABLE_ERROR = 'Private broadcast network unavailable'
/** The request entered the tunnel and no answer came back; the destination may have it. */
export const NYM_INCOMPLETE_ERROR = 'Private broadcast did not complete'

export interface NymFetchRequest {
  url: string
  method: string
  headers: [string, string][]
  body: Uint8Array<ArrayBuffer> | null
}

export interface NymFetchResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: Uint8Array<ArrayBuffer>
}

/**
 * A Zcash Worker first asks whether the user routes broadcasts through Nym (`mode`), then
 * either sends the request directly or hands it to the tunnel (`fetch`). `cancel` withdraws
 * the `fetch` with the same id once the Worker stops waiting for it; it has no reply.
 */
export type NymWorkerRequest =
  | { id: number; kind: 'mode' }
  | { id: number; kind: 'fetch'; request: NymFetchRequest }
  | { id: number; kind: 'cancel' }

export type NymWorkerReply =
  | { id: number; ok: true; kind: 'mode'; enabled: boolean }
  | { id: number; ok: true; kind: 'fetch'; response: NymFetchResponse }
  | { id: number; ok: false; error: string }

export type NymTunnelCommand =
  | { id: number; kind: 'setup'; clientId: string }
  | { id: number; kind: 'fetch'; request: NymFetchRequest }

export type NymTunnelReply =
  | { id: number; ok: true; response?: NymFetchResponse }
  | { id: number; ok: false; error: string }

/** mix-tunnel keeps each client's keys and entry gateway in `wasm-client-storage-<clientId>`. */
const NYM_CLIENT_STORAGE_PREFIX = 'wasm-client-storage-'

export interface NymTunnelClientPlan {
  clientId: string
  /** Databases of tunnel clients that no tunnel will use again. */
  staleDatabases: string[]
}

/**
 * Chooses the client for the next tunnel from the extension's IndexedDB database names. A
 * client keeps its entry gateway, so tunnels reuse `current` (or, when the offscreen document
 * has none yet, a client an earlier document stored) until the host replaces it after a failed
 * setup. Registering a new client means selecting and registering with a gateway again.
 */
export function planNymTunnelClient(
  current: string | null,
  databaseNames: readonly (string | undefined)[],
  createClientId: () => string
): NymTunnelClientPlan {
  const stored = databaseNames.filter(
    (name): name is string => name !== undefined && name.startsWith(NYM_CLIENT_STORAGE_PREFIX)
  )
  const clientId =
    current ??
    stored.map(name => name.slice(NYM_CLIENT_STORAGE_PREFIX.length)).find(Boolean) ??
    createClientId()
  const kept = `${NYM_CLIENT_STORAGE_PREFIX}${clientId}`
  return { clientId, staleDatabases: stored.filter(name => name !== kept) }
}

/** Sent by the background so the offscreen document drops its tunnel. */
export const NYM_TUNNEL_CLOSE_OFFSCREEN_MESSAGE = 'NYM_TUNNEL_CLOSE_OFFSCREEN'

const MAX_PREWARM_ORIGINS = 8

/**
 * Destinations worth proving before a broadcast, reduced to distinct HTTPS origins so
 * endpoint paths and access tokens stay out of messages between extension contexts.
 */
export function nymPrewarmOrigins(urls: readonly unknown[]): string[] {
  const origins = new Set<string>()
  for (const value of urls) {
    if (origins.size === MAX_PREWARM_ORIGINS) break
    if (typeof value !== 'string') continue
    try {
      const url = new URL(value)
      if (url.protocol === 'https:') origins.add(url.origin)
    } catch {
      // Not a destination.
    }
  }
  return [...origins]
}

function lightwalletdMethod(url: URL): string | null {
  const index = url.pathname.lastIndexOf(LIGHTWALLETD_SERVICE_PATH)
  if (index < 0) return null
  return url.pathname.slice(index + LIGHTWALLETD_SERVICE_PATH.length)
}

/** A destination's host for logs, without the path or query that may carry an access token. */
export function nymDestinationHost(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return 'unknown host'
  }
}

/** A log-safe name for a tunnel request: the lightwalletd method and the destination host. */
export function nymRequestLabel(value: string): string {
  let method: string | null = null
  try {
    method = lightwalletdMethod(new URL(value))
  } catch {
    // Named by host alone.
  }
  return `${method || 'request'} @ ${nymDestinationHost(value)}`
}

/** Requests besides the broadcast that follow the routing choice while their switch is on. */
export interface NymRouteSwitches {
  /** lightwalletd GetStandardFee, asked only while a send is being prepared. */
  readonly feeQuote: boolean
}

/**
 * Requests that tie a transaction to the sender's network address. Every broadcast is
 * routed, including the ordinary-RPC fallback after ZeroIndexer fails, so that a Nym
 * failure blocks the broadcast instead of sending it directly. The fee quote precedes a
 * broadcast by seconds and is routed while its switch is on.
 */
export function requiresNymRoute(
  url: URL,
  zeroIndexerOrigins: ReadonlySet<string>,
  routes: NymRouteSwitches
): boolean {
  const method = lightwalletdMethod(url)
  if (method === 'SendTransaction') return true
  if (method === 'GetStandardFee') return routes.feeQuote
  return method === 'GetTransaction' && zeroIndexerOrigins.has(url.origin)
}

/**
 * Proves a freshly built tunnel reaches the destination through its exit. Destinations
 * include lightwalletd and zcashd JSON-RPC nodes, so any HTTP response counts.
 */
export function reachabilityCheckRequest(origin: string): NymFetchRequest {
  return { url: `${origin}/`, method: 'GET', headers: [['accept', '*/*']], body: null }
}

export function isReachableResponse(response: NymFetchResponse): boolean {
  return response.status >= 100 && response.status <= 599
}
