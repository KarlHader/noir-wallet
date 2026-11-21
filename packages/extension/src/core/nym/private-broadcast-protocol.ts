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

/** A category and method label without addresses, transaction IDs, or request payloads. */
export function nymRequestLabel(request: NymFetchRequest): string {
  let method: string | null = null
  let category: keyof NymRouteSwitches | null = null
  try {
    const url = new URL(request.url)
    method = lightwalletdMethod(url)
    category = lightwalletdRouteCategory(method)
    if (!method) {
      method = intentsSwapMethod(url)
      if (method) category = 'zecSwap'
    }
    if (!method && request.body) {
      const body: unknown = JSON.parse(new TextDecoder().decode(request.body))
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const rpcMethod: unknown = (body as Record<string, unknown>).method
        if (typeof rpcMethod === 'string') {
          category = zcashNodeRpcRouteCategory(rpcMethod)
          // Only known RPC methods may appear in the log; all params remain private.
          if (category) method = rpcMethod
        }
      }
    }
  } catch {
    // An unreadable request still gets the existing host-only label.
  }
  const categories: Record<keyof NymRouteSwitches, string> = {
    broadcast: '交易广播',
    feeQuote: '手续费报价',
    transactionLookup: '交易查询',
    transparentHistory: '透明地址历史',
    transparentUtxos: '透明地址UTXO',
    zecSwap: 'ZEC兑换'
  }
  const prefix = category ? `【nym-${categories[category]}】 ` : ''
  return `${prefix}${method || 'request'} @ ${nymDestinationHost(request.url)}`
}

/** Only these Zcash request categories participate in Nym routing. */
export interface NymRouteSwitches {
  readonly broadcast: boolean
  /** lightwalletd GetStandardFee, asked only while a send is being prepared. */
  readonly feeQuote: boolean
  readonly transactionLookup: boolean
  readonly transparentHistory: boolean
  readonly transparentUtxos: boolean
  /** Intents quote and status reads for swaps that spend ZEC; callers classify them. */
  readonly zecSwap: boolean
}

/** Only ZEC swap requests reach the tunnel at an Intents quote or status path. */
function intentsSwapMethod(url: URL): string | null {
  const method = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
  return method === 'quote' || method === 'status' ? method : null
}

/** The node height read accompanies transaction monitoring. */
function zcashNodeRpcRouteCategory(method: string): keyof NymRouteSwitches | null {
  switch (method) {
    case 'getrawtransaction':
    case 'getblockcount':
      return 'transactionLookup'
    case 'getaddresstxids':
      return 'transparentHistory'
    default:
      return null
  }
}

function lightwalletdRouteCategory(method: string | null): keyof NymRouteSwitches | null {
  switch (method) {
    case 'SendTransaction':
      return 'broadcast'
    case 'GetStandardFee':
      return 'feeQuote'
    case 'GetTransaction':
      return 'transactionLookup'
    case 'GetTaddressTxids':
    case 'GetTaddressTransactions':
      return 'transparentHistory'
    case 'GetAddressUtxos':
    case 'GetAddressUtxosStream':
    case 'GetTaddressBalance':
    case 'GetTaddressBalanceStream':
      return 'transparentUtxos'
    default:
      return null
  }
}

/** Node RPC helpers are Zcash-only. */
export function requiresZcashNodeRpcNymRoute(method: string, routes: NymRouteSwitches): boolean {
  const category = zcashNodeRpcRouteCategory(method)
  return category !== null && routes[category]
}

/** The categories wallet sync itself requests; broadcasts and fee quotes belong to sends. */
const WALLET_SYNC_CATEGORIES: ReadonlySet<keyof NymRouteSwitches> = new Set([
  'transactionLookup',
  'transparentHistory',
  'transparentUtxos'
])

/**
 * Classify Zcash RPC methods independently of which configured endpoint serves them.
 * `walletSyncDirect` releases the categories wallet sync requests to the direct path.
 */
export function requiresNymRoute(
  url: URL,
  routes: NymRouteSwitches,
  walletSyncDirect = false
): boolean {
  const category = lightwalletdRouteCategory(lightwalletdMethod(url))
  if (category === null || !routes[category]) return false
  return !(walletSyncDirect && WALLET_SYNC_CATEGORIES.has(category))
}

/**
 * Proves a freshly built tunnel reaches the destination through its exit. Destinations
 * include lightwalletd and zcashd JSON-RPC nodes, so any HTTP response counts unless the
 * destination refused the exit.
 */
export function reachabilityCheckRequest(origin: string): NymFetchRequest {
  return { url: `${origin}/`, method: 'GET', headers: [['accept', '*/*']], body: null }
}

/**
 * Cloudflare challenges some exit addresses instead of forwarding to the destination. The
 * tunnel cannot pass a challenge, so every request through that exit gets the same answer.
 */
export function isRefusedExitResponse(response: NymFetchResponse): boolean {
  return response.headers.some(
    ([name, value]) =>
      name.toLowerCase() === 'cf-mitigated' && value.trim().toLowerCase() === 'challenge'
  )
}

export function isReachableResponse(response: NymFetchResponse): boolean {
  return response.status >= 100 && response.status <= 599 && !isRefusedExitResponse(response)
}
