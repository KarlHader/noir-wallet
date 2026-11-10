import { getPearlNetworkConfig } from '@/config/networks'
import type { Network } from '@/types'
import { resolvePearlRpcEndpointOptions } from '../managed-rpc-endpoints'
import {
  createPearlBlockbookClient,
  type PearlActivityHistoryRpc,
  type PearlConflictRpc,
  type PearlDiscoveryRpc,
  type PearlTransactionRpc
} from './pearl-blockbook-client'

type ConfiguredPearlBlockbookClient = PearlDiscoveryRpc &
  PearlTransactionRpc &
  PearlActivityHistoryRpc &
  PearlConflictRpc

const bundledPearlClients = new Map<string, ConfiguredPearlBlockbookClient>()
const customPearlClients = new Map<string, ConfiguredPearlBlockbookClient>()

interface ConfiguredPearlBlockbookEndpoint {
  readonly id: string
  readonly baseUrl: string
}

function normalizePearlBlockbookBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).toString().replace(/\/+$/, '')
}

export function resolveConfiguredPearlBlockbookEndpoints(
  network: Network,
  customBaseUrl?: string
): readonly ConfiguredPearlBlockbookEndpoint[] {
  const bundledEndpoints = resolvePearlRpcEndpointOptions(network)
  if (customBaseUrl === undefined) return bundledEndpoints

  const normalizedCustomUrl = normalizePearlBlockbookBaseUrl(customBaseUrl)
  const matchingBundledEndpoint = bundledEndpoints.find(
    endpoint => normalizePearlBlockbookBaseUrl(endpoint.baseUrl) === normalizedCustomUrl
  )
  return [matchingBundledEndpoint ?? { id: 'custom', baseUrl: normalizedCustomUrl }]
}

export function createConfiguredPearlBlockbookClient(
  network: Network,
  customBaseUrl?: string
): ConfiguredPearlBlockbookClient {
  const config = getPearlNetworkConfig(network)
  if (customBaseUrl !== undefined) {
    const normalizedCustomUrl = normalizePearlBlockbookBaseUrl(customBaseUrl)
    const cacheKey = `${network}:${normalizedCustomUrl}`
    const existing = customPearlClients.get(cacheKey)
    if (existing) return existing
    const client = createPearlBlockbookClient({
      chainId: config.chainId,
      baseUrl: normalizedCustomUrl,
      timeoutMs: 5_000
    })
    customPearlClients.set(cacheKey, client)
    return client
  }

  const endpoints = resolveConfiguredPearlBlockbookEndpoints(network)
  const cacheKey = `${network}:${JSON.stringify(endpoints)}`
  const existing = bundledPearlClients.get(cacheKey)
  if (existing) return existing

  // Pearl currently ships one managed Blockbook endpoint per network; failover can wrap later.
  const client = createPearlBlockbookClient({
    chainId: config.chainId,
    baseUrl: endpoints[0].baseUrl,
    timeoutMs: 5_000
  })
  bundledPearlClients.set(cacheKey, client)
  return client
}

export async function attestPearlBlockbookEndpoint(
  chainId: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<void> {
  await createPearlBlockbookClient({ chainId, baseUrl }).assertExpectedChain(signal)
}
