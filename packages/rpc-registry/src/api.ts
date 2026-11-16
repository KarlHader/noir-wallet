import { RPC_REGISTRY, ZCASH_RPC_REGISTRY } from './registry'
import { ZERO_INDEXER_REGISTRY } from './zero-indexer-registry'
import { DAPP_REGISTRY } from './dapp-registry'
import { TOKEN_REGISTRY } from './token-registry'

const REGISTRY_PATH = '/v1/rpc-endpoints'
const ZERO_INDEXER_PATH = '/v1/zero-indexer-endpoints'
const DAPP_PATH = '/v1/dapps'
const TOKEN_PATH = '/v1/token-registry'

export function handleRegistryRequest(request: Request): Response {
  const url = new URL(request.url)
  if (
    request.method === 'OPTIONS' &&
    (url.pathname === REGISTRY_PATH ||
      url.pathname === ZERO_INDEXER_PATH ||
      url.pathname === DAPP_PATH ||
      url.pathname === TOKEN_PATH)
  ) {
    return new Response(null, {
      status: 204,
      headers: registryHeaders()
    })
  }
  if (request.method !== 'GET') {
    return new Response('Not Found', { status: 404 })
  }

  if (url.pathname === ZERO_INDEXER_PATH) {
    return Response.json(ZERO_INDEXER_REGISTRY, { headers: registryHeaders() })
  }
  if (url.pathname === DAPP_PATH) {
    return Response.json(DAPP_REGISTRY, { headers: registryHeaders() })
  }
  if (url.pathname === TOKEN_PATH) {
    return Response.json(TOKEN_REGISTRY, { headers: registryHeaders() })
  }
  if (url.pathname !== REGISTRY_PATH) return new Response('Not Found', { status: 404 })

  const registry =
    url.searchParams.get('scope') === 'multichain' ? RPC_REGISTRY : ZCASH_RPC_REGISTRY
  return Response.json(registry, { headers: registryHeaders() })
}

function registryHeaders(): HeadersInit {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
    'cloudflare-cdn-cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
  }
}
