/** Cloudflare Worker for bounded Ankr history JSON-RPC and wallet asset discovery. */

import { getAnkrClient, UpstreamError, type AnkrClient } from './ankr-client'
import { readBoundedBody } from './read-bounded-body'

interface Env {
  ANKR_API_KEYS: string
  ALLOWED_ORIGIN: string
  HISTORY_RATE_LIMITER: RateLimit
}

export const CHAIN_ID_TO_ANKR: Readonly<Record<string, string>> = Object.freeze({
  '1': 'eth',
  '56': 'bsc',
  '100': 'gnosis',
  '42161': 'arbitrum',
  '137': 'polygon',
  '196': 'xlayer',
  '10': 'optimism',
  '8453': 'base',
  '43114': 'avalanche',
  '11155111': 'eth_sepolia',
  '84532': 'base_sepolia',
  '11155420': 'optimism_sepolia',
  '80002': 'polygon_amoy',
  '43113': 'avalanche_fuji'
})
const ANKR_TO_CHAIN_ID = Object.freeze(
  Object.fromEntries(
    Object.entries(CHAIN_ID_TO_ANKR).map(([chainId, blockchain]) => [blockchain, chainId])
  )
) as Readonly<Record<string, string>>
const SUPPORTED_ANKR_BLOCKCHAINS = new Set(Object.values(CHAIN_ID_TO_ANKR))

const MAX_TRANSACTION_PAGE_SIZE = 200
const MAX_TOKEN_PAGE_SIZE = 2_000
const MAX_RPC_REQUEST_BYTES = 16 * 1024
const MAX_PAGE_TOKEN_LENGTH = 512
const MAX_REQUEST_CHAINS = 16
const MAX_DISCOVERED_TOKEN_COUNT = 512
const MAX_TOKEN_ICON_BYTES = 256 * 1024
const TOKEN_ICON_TIMEOUT_MS = 10_000
const TRUSTED_TOKEN_ICON_HOSTS = new Set(['assets.zknoir.com'])
function corsHeaders(allowedOrigin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  }
}

function jsonResponse(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }
  })
}

function upstreamErrorHeaders(
  error: unknown,
  cors: Record<string, string>
): Record<string, string> {
  return error instanceof UpstreamError && error.retryAfterSeconds !== undefined
    ? { ...cors, 'Retry-After': String(error.retryAfterSeconds) }
    : cors
}

async function rateLimitKey(request: Request): Promise<string> {
  // Cloudflare overwrites this header at the edge. Hash it before using it as a stable counter key.
  const clientIdentity = request.headers.get('CF-Connecting-IP')?.trim() || 'local-development'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientIdentity))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

type HistoryMethod = 'ankr_getTransactionsByAddress' | 'ankr_getTokenTransfers'
type RpcId = number | string | null

interface HistoryRpcRequest {
  readonly id: number | string
  readonly method: HistoryMethod
  readonly params: Record<string, unknown>
  readonly blockchains: ReadonlySet<string>
}

class RpcRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status: number,
    readonly id: RpcId = null
  ) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEvmAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function rpcErrorResponse(
  id: RpcId,
  code: number,
  message: string,
  status: number,
  cors: Record<string, string>,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...cors,
      ...extraHeaders
    }
  })
}

async function readRpcBody(request: Request): Promise<unknown> {
  if (!request.body) throw new RpcRequestError(-32600, 'Invalid request', 400)
  const bytes = await readBoundedBody(
    request,
    MAX_RPC_REQUEST_BYTES,
    () => new RpcRequestError(-32600, 'Request body is too large', 413)
  )
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    throw new RpcRequestError(-32700, 'Parse error', 400)
  }
}

function parseHistoryRpcRequest(value: unknown): HistoryRpcRequest {
  const id: RpcId =
    isRecord(value) &&
    (typeof value.id === 'string'
      ? value.id.length <= 128
      : typeof value.id === 'number' && Number.isSafeInteger(value.id))
      ? (value.id as number | string)
      : null
  if (
    !isRecord(value) ||
    value.jsonrpc !== '2.0' ||
    id === null ||
    typeof value.method !== 'string'
  ) {
    throw new RpcRequestError(-32600, 'Invalid request', 400, id)
  }
  if (
    value.method !== 'ankr_getTransactionsByAddress' &&
    value.method !== 'ankr_getTokenTransfers'
  ) {
    throw new RpcRequestError(-32601, 'Method not found', 400, id)
  }
  if (!isRecord(value.params)) throw new RpcRequestError(-32602, 'Invalid params', 400, id)
  const params = value.params
  const blockchains = params.blockchain
  const maxPageSize =
    value.method === 'ankr_getTransactionsByAddress'
      ? MAX_TRANSACTION_PAGE_SIZE
      : MAX_TOKEN_PAGE_SIZE
  if (
    !Array.isArray(blockchains) ||
    blockchains.length < 1 ||
    blockchains.length > MAX_REQUEST_CHAINS ||
    blockchains.some(
      chain => typeof chain !== 'string' || !SUPPORTED_ANKR_BLOCKCHAINS.has(chain)
    ) ||
    new Set(blockchains).size !== blockchains.length ||
    (value.method === 'ankr_getTransactionsByAddress'
      ? !isEvmAddress(params.address)
      : !Array.isArray(params.address) ||
        params.address.length < 1 ||
        params.address.length > 2 ||
        params.address.some(address => !isEvmAddress(address))) ||
    (params.pageSize !== undefined &&
      (!Number.isSafeInteger(params.pageSize) ||
        (params.pageSize as number) < 1 ||
        (params.pageSize as number) > maxPageSize)) ||
    (params.descOrder !== undefined && typeof params.descOrder !== 'boolean') ||
    (params.fromBlock !== undefined &&
      (!Number.isSafeInteger(params.fromBlock) || (params.fromBlock as number) < 0)) ||
    (params.pageToken !== undefined &&
      (typeof params.pageToken !== 'string' ||
        params.pageToken.length < 1 ||
        params.pageToken.length > MAX_PAGE_TOKEN_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(params.pageToken))) ||
    Object.keys(params).some(
      key =>
        !['blockchain', 'address', 'pageSize', 'descOrder', 'fromBlock', 'pageToken'].includes(key)
    )
  ) {
    throw new RpcRequestError(-32602, 'Invalid params', 400, id)
  }
  return {
    id,
    method: value.method,
    params,
    blockchains: new Set(blockchains as string[])
  }
}

function validateHistoryResult(result: unknown, request: HistoryRpcRequest): void {
  const key = request.method === 'ankr_getTransactionsByAddress' ? 'transactions' : 'transfers'
  if (!isRecord(result) || !Array.isArray(result[key])) {
    throw new UpstreamError(502, 'Ankr returned invalid history data')
  }
  if (
    result[key].some(
      (item: unknown) => !isRecord(item) || !request.blockchains.has(item.blockchain as string)
    ) ||
    (result.nextPageToken !== undefined &&
      (typeof result.nextPageToken !== 'string' ||
        result.nextPageToken.length > MAX_PAGE_TOKEN_LENGTH))
  ) {
    throw new UpstreamError(502, 'Ankr returned invalid history data')
  }
}

interface AnkrAccountAsset {
  balanceRawInteger: string
  blockchain: string
  contractAddress?: string
  tokenDecimals: number
  tokenName: string
  tokenSymbol: string
  tokenType: string
  thumbnail?: string
}

function isAnkrAccountAsset(value: unknown): value is AnkrAccountAsset {
  return (
    isRecord(value) &&
    typeof value.balanceRawInteger === 'string' &&
    typeof value.blockchain === 'string' &&
    typeof value.tokenDecimals === 'number' &&
    typeof value.tokenName === 'string' &&
    typeof value.tokenSymbol === 'string' &&
    typeof value.tokenType === 'string' &&
    (value.contractAddress === undefined || typeof value.contractAddress === 'string') &&
    (value.thumbnail === undefined || typeof value.thumbnail === 'string')
  )
}

function parseTrustedTokenIconSource(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    !TRUSTED_TOKEN_ICON_HOSTS.has(url.hostname)
  ) {
    return null
  }
  return url
}

function proxiedTokenIconUrl(value: unknown, publicOrigin: string): string | undefined {
  const source = parseTrustedTokenIconSource(value)
  if (!source) return undefined
  const proxy = new URL('/token-icon', publicOrigin)
  proxy.searchParams.set('source', source.toString())
  return proxy.toString()
}

async function proxyTokenIcon(
  source: URL,
  cors: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TOKEN_ICON_TIMEOUT_MS)
  try {
    const response = await fetch(source, {
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/svg+xml' },
      redirect: 'manual',
      signal: AbortSignal.any([signal, controller.signal])
    })
    if (!response.ok) throw new UpstreamError(502, 'Token icon upstream unavailable')
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim() ?? ''
    if (
      !['image/avif', 'image/webp', 'image/png', 'image/jpeg', 'image/svg+xml'].includes(
        contentType
      )
    ) {
      throw new UpstreamError(502, 'Invalid token icon content type')
    }
    const bytes = await readBoundedBody(
      response,
      MAX_TOKEN_ICON_BYTES,
      () => new UpstreamError(502, 'Token icon is too large')
    )
    if (bytes.byteLength === 0) throw new UpstreamError(502, 'Token icon is empty')
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        ...cors
      }
    })
  } finally {
    clearTimeout(timeout)
  }
}

function mapDetectedToken(asset: AnkrAccountAsset, publicOrigin: string) {
  const chainId = ANKR_TO_CHAIN_ID[asset.blockchain]
  const contractAddress = asset.contractAddress?.toLowerCase()
  if (
    !chainId ||
    !contractAddress ||
    !/^0x[0-9a-f]{40}$/.test(contractAddress) ||
    /^0x0{40}$/.test(contractAddress) ||
    !/^(0|[1-9][0-9]{0,127})$/.test(asset.balanceRawInteger) ||
    asset.balanceRawInteger === '0' ||
    !Number.isSafeInteger(asset.tokenDecimals) ||
    asset.tokenDecimals < 0 ||
    asset.tokenDecimals > 255 ||
    asset.tokenType.toUpperCase() !== 'ERC20'
  ) {
    return null
  }
  const iconUrl = proxiedTokenIconUrl(asset.thumbnail, publicOrigin)
  return {
    chainId: `eip155:${chainId}`,
    contractAddress,
    balanceRawInteger: asset.balanceRawInteger,
    metadata: {
      name: asset.tokenName,
      symbol: asset.tokenSymbol,
      decimals: asset.tokenDecimals,
      ...(iconUrl ? { iconUrl } : {})
    }
  }
}

async function handleAccountBalances(
  blockchains: readonly string[],
  address: string,
  client: AnkrClient,
  publicOrigin: string,
  signal: AbortSignal
): Promise<unknown> {
  const result = await client.request(
    'ankr_getAccountBalance',
    {
      blockchain: blockchains,
      walletAddress: address,
      onlyWhitelisted: false,
      pageSize: MAX_DISCOVERED_TOKEN_COUNT
    },
    signal
  )
  if (
    !isRecord(result) ||
    !Array.isArray(result.assets) ||
    !result.assets.every(isAnkrAccountAsset) ||
    (result.nextPageToken !== undefined &&
      (typeof result.nextPageToken !== 'string' ||
        result.nextPageToken.length > MAX_PAGE_TOKEN_LENGTH))
  ) {
    throw new UpstreamError(502, 'Ankr returned invalid balance data')
  }
  const assets = result.assets
  const expected = new Set(blockchains)
  if (assets.some(asset => !expected.has(asset.blockchain))) {
    throw new UpstreamError(502, 'Ankr returned balances for another blockchain')
  }
  const detected = assets
    .map(asset => mapDetectedToken(asset, publicOrigin))
    .filter((asset): asset is NonNullable<ReturnType<typeof mapDetectedToken>> => asset !== null)
  if (
    new Set(detected.map(asset => `${asset.chainId}/${asset.contractAddress}`)).size !==
    detected.length
  ) {
    throw new UpstreamError(502, 'Ankr returned duplicate token balances')
  }
  return {
    version: 1,
    assets: detected.slice(0, MAX_DISCOVERED_TOKEN_COUNT),
    partial:
      detected.length > MAX_DISCOVERED_TOKEN_COUNT ||
      (typeof result.nextPageToken === 'string' && result.nextPageToken.length > 0)
  }
}

export const evmHistoryWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env.ALLOWED_ORIGIN)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, cors)
    }

    const url = new URL(request.url)
    const isHistoryRpc = request.method === 'POST' && url.pathname === '/'

    if (!env.ALLOWED_ORIGIN || typeof env.HISTORY_RATE_LIMITER?.limit !== 'function') {
      return isHistoryRpc
        ? rpcErrorResponse(null, -32000, 'Service unavailable', 503, cors)
        : jsonResponse({ error: 'Service unavailable' }, 503, cors)
    }

    let client: AnkrClient
    try {
      client = getAnkrClient(env.ANKR_API_KEYS)
    } catch {
      return isHistoryRpc
        ? rpcErrorResponse(null, -32000, 'Service unavailable', 503, cors)
        : jsonResponse({ error: 'Service unavailable' }, 503, cors)
    }

    if (url.pathname === '/health') {
      if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, cors)
      return jsonResponse({ ok: true }, 200, cors)
    }

    if (url.pathname === '/token-icon') {
      if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, cors)
      const source = parseTrustedTokenIconSource(url.searchParams.get('source'))
      if (!source) return jsonResponse({ error: 'Invalid token icon source' }, 400, cors)
      try {
        return await proxyTokenIcon(source, cors, request.signal)
      } catch (error) {
        return jsonResponse(
          { error: 'Token icon unavailable' },
          error instanceof UpstreamError ? error.status : 502,
          cors
        )
      }
    }

    if (url.pathname === '/balances') {
      if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, cors)
      const address = url.searchParams.get('address')
      const chainIds = (url.searchParams.get('chainIds') ?? '').split(',').filter(Boolean)
      if (!isEvmAddress(address)) {
        return jsonResponse({ error: 'Invalid address' }, 400, cors)
      }
      if (
        chainIds.length === 0 ||
        chainIds.length > MAX_REQUEST_CHAINS ||
        new Set(chainIds).size !== chainIds.length ||
        chainIds.some(chainId => !/^\d+$/.test(chainId))
      ) {
        return jsonResponse({ error: 'Invalid chain IDs' }, 400, cors)
      }
      try {
        const { success } = await env.HISTORY_RATE_LIMITER.limit({
          key: await rateLimitKey(request)
        })
        if (!success) {
          return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'Retry-After': '60',
              ...cors
            }
          })
        }
        const blockchains = chainIds.flatMap(chainId => {
          const blockchain = CHAIN_ID_TO_ANKR[chainId]
          return blockchain ? [blockchain] : []
        })
        if (blockchains.length === 0) {
          return jsonResponse({ version: 1, assets: [], partial: false }, 200, cors)
        }
        return jsonResponse(
          await handleAccountBalances(
            blockchains,
            address.toLowerCase(),
            client,
            url.origin,
            request.signal
          ),
          200,
          cors
        )
      } catch (error) {
        console.error(
          `[evm-history-proxy] balances status=${error instanceof UpstreamError ? error.status : 502} reason=${error instanceof UpstreamError ? error.message : 'internal-error'}`
        )
        return jsonResponse(
          { error: 'Upstream unavailable' },
          error instanceof UpstreamError ? error.status : 502,
          upstreamErrorHeaders(error, cors)
        )
      }
    }

    if (url.pathname !== '/') return jsonResponse({ error: 'Not found' }, 404, cors)
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors)

    let rpcRequest: HistoryRpcRequest
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
        throw new RpcRequestError(-32600, 'Content-Type must be application/json', 415)
      }
      rpcRequest = parseHistoryRpcRequest(await readRpcBody(request))
    } catch (error) {
      if (error instanceof RpcRequestError) {
        return rpcErrorResponse(error.id, error.code, error.message, error.status, cors)
      }
      return rpcErrorResponse(null, -32600, 'Invalid request', 400, cors)
    }

    try {
      const { success } = await env.HISTORY_RATE_LIMITER.limit({
        key: await rateLimitKey(request)
      })
      if (!success) {
        return rpcErrorResponse(rpcRequest.id, -32001, 'Rate limit exceeded', 429, cors, {
          'Retry-After': '60'
        })
      }
      const result = await client.request(rpcRequest.method, rpcRequest.params, request.signal)
      validateHistoryResult(result, rpcRequest)
      return jsonResponse({ jsonrpc: '2.0', id: rpcRequest.id, result }, 200, cors)
    } catch (error) {
      console.error(
        `[evm-history-proxy] ${rpcRequest.method} status=${error instanceof UpstreamError ? error.status : 502} reason=${error instanceof UpstreamError ? error.message : 'internal-error'}`
      )
      return rpcErrorResponse(
        rpcRequest.id,
        -32000,
        'Upstream unavailable',
        error instanceof UpstreamError ? error.status : 502,
        upstreamErrorHeaders(error, cors)
      )
    }
  }
} satisfies ExportedHandler<Env>

export default evmHistoryWorker
