import type { NearNetworkConfig } from '@/config/networks'
import { createAssetId, getZcashChainId, parseChainId } from '@/core/chains/registry'
import { createConfiguredNearRpcClient } from '@/infrastructure/chains/near/near-configured-rpc-client'
import { isRecord } from '@/infrastructure/chains/near/near-rpc-codecs'
import { DedupPromise } from '@/lib/async-utils'
import Big from '@/lib/big'

interface LendingMarket {
  readonly tokenId: string
  readonly url: string
}

const markets = new Map<string, LendingMarket>([
  [
    createAssetId(parseChainId(getZcashChainId('mainnet')).id, 'slip44', '133'),
    { tokenId: 'zec.omft.near', url: 'https://app.zknoir.com/lending' }
  ]
])
const rateCache = new Map<string, { rpcUrl: string; apr: string; expiresAt: number }>()
const requests = new Map<string, DedupPromise<string>>()
const RATE_TTL_MS = 5 * 60_000
const RATE_REQUEST_TIMEOUT_MS = 10_000
const MAX_MARKET_RESULT_BYTES = 128 * 1024

export function getLendingMarket(assetId: string): LendingMarket | undefined {
  return markets.get(assetId)
}

export function readCachedLendingApr(market: LendingMarket, rpcUrl: string): string | undefined {
  const cached = rateCache.get(market.tokenId)
  return cached && cached.rpcUrl === rpcUrl && cached.expiresAt > Date.now()
    ? cached.apr
    : undefined
}

export async function loadLendingApr(
  market: LendingMarket,
  network: NearNetworkConfig
): Promise<string> {
  const { rpcUrl } = network
  const cached = readCachedLendingApr(market, rpcUrl)
  if (cached !== undefined) return cached

  const key = JSON.stringify([market.tokenId, rpcUrl])
  const request = requests.get(key) ?? new DedupPromise<string>()
  requests.set(key, request)
  try {
    return await request.run(
      () => fetchLendingApr(market, network),
      apr => rateCache.set(market.tokenId, { rpcUrl, apr, expiresAt: Date.now() + RATE_TTL_MS })
    )
  } finally {
    requests.delete(key)
  }
}

async function fetchLendingApr(market: LendingMarket, network: NearNetworkConfig): Promise<string> {
  const result = await createConfiguredNearRpcClient(network).viewFunction(
    'contract.main.burrow.near',
    'get_assets_paged_detailed',
    {},
    {
      signal: AbortSignal.timeout(RATE_REQUEST_TIMEOUT_MS),
      maximumResultBytes: MAX_MARKET_RESULT_BYTES
    }
  )
  if (!Array.isArray(result)) throw new Error('Invalid lending market list')
  const entry: unknown = result.find(
    (asset: unknown) => isRecord(asset) && asset.token_id === market.tokenId
  )
  if (!isRecord(entry)) throw new Error('Lending market unavailable')
  const { supply_apr: apr, config } = entry
  if (
    !isRecord(config) ||
    config.can_deposit !== true ||
    typeof apr !== 'string' ||
    !/^\d+(?:\.\d+)?$/.test(apr)
  ) {
    throw new Error('Lending supply APR unavailable')
  }

  return `${new Big(apr).times(100).toFixed(2)}%`
}
