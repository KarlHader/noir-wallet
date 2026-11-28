const TOKEN_CATALOG_URL = 'https://1click.chaindefuser.com/v0/tokens'
const RHEA_TOKEN_ICONS_API = 'https://api.rhea.finance/get_multichain_lending_tokens_data'
const COINGECKO_MARKETS_API = 'https://api.coingecko.com/api/v3/coins/markets'
const CHAIN_ICON_BASE_URL = 'https://assets.zknoir.com/chain'
const MAX_COINGECKO_ICON_COUNT = 250

const NETWORK_NAMES: Readonly<Record<string, string>> = {
  near: 'NEAR',
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  op: 'Optimism',
  bsc: 'BNB Chain',
  pol: 'Polygon',
  sol: 'Solana',
  zec: 'Zcash',
  btc: 'Bitcoin',
  avax: 'Avalanche',
  gnosis: 'Gnosis',
  bera: 'Berachain',
  tron: 'Tron',
  sui: 'Sui',
  ton: 'TON'
}

// Same files as the wallet chain-icon map. The catalog uses these short chain ids.
const CHAIN_ICON_FILES: Readonly<Record<string, string>> = {
  aptos: 'aptos.svg',
  arb: 'arbitrum.svg',
  arbitrum: 'arbitrum.svg',
  avalanche: 'avalanche.svg',
  avax: 'avalanche.svg',
  base: 'base.svg',
  bera: 'berachain.svg',
  berachain: 'berachain.svg',
  bitcoin: 'bitcoin.svg',
  bsc: 'bsc.svg',
  btc: 'bitcoin.svg',
  eth: 'ethereum.svg',
  ethereum: 'ethereum.svg',
  evm: 'evm.svg',
  gnosis: 'gnosis.svg',
  monad: 'monad.svg',
  near: 'near.svg',
  network: 'network.svg',
  op: 'optimism.svg',
  optimism: 'optimism.svg',
  plasma: 'plasma.svg',
  pol: 'polygon.svg',
  polygon: 'polygon.svg',
  sol: 'solana.svg',
  solana: 'solana.svg',
  sui: 'sui.svg',
  tron: 'tron.svg',
  trx: 'tron.svg',
  xlayer: 'xlayer.svg',
  zcash: 'zcash.svg',
  zec: 'zcash.svg'
}

export interface ShieldWinAsset {
  readonly symbol: string
  readonly network: string
  readonly tokenIconUrl: string | null
  readonly chainIconUrl: string | null
}

export async function getAssetLabels(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  assetIds?: readonly string[]
): Promise<ReadonlyMap<string, ShieldWinAsset>> {
  const response = await fetcher(TOKEN_CATALOG_URL, { signal })
  if (!response.ok) throw new Error('The token catalog could not be loaded.')
  const data: unknown = await response.json()
  if (!Array.isArray(data)) throw new Error('The token catalog is invalid.')

  const labels = new Map<string, ShieldWinAsset>()
  const chains = new Map<string, string>()
  const coingeckoIds = new Map<string, string>()
  for (const token of data) {
    if (typeof token !== 'object' || token === null) continue
    const { assetId, blockchain, symbol } = token
    if (
      typeof assetId !== 'string' ||
      typeof blockchain !== 'string' ||
      typeof symbol !== 'string' ||
      !assetId ||
      !blockchain ||
      !symbol ||
      assetId.length > 256 ||
      blockchain.length > 64 ||
      symbol.length > 64
    )
      continue
    const chain = blockchain.trim().toLowerCase()
    const chainFile = CHAIN_ICON_FILES[chain]
    const coingeckoId = readCoingeckoId(token)
    if (coingeckoId) coingeckoIds.set(assetId, coingeckoId)
    labels.set(assetId, {
      symbol,
      network: NETWORK_NAMES[blockchain] ?? blockchain.toUpperCase(),
      tokenIconUrl: tokenIconUrl(token),
      chainIconUrl: chainFile ? `${CHAIN_ICON_BASE_URL}/${chainFile}` : null
    })
    chains.set(assetId, chain)
  }
  if (assetIds && assetIds.length > 0) {
    await backfillRheaIcons(labels, chains, assetIds, signal, fetcher)
    await backfillCoinGeckoIcons(labels, coingeckoIds, assetIds, signal, fetcher)
  }
  return labels
}

export function assetInfo(
  assetId: string,
  assets: ReadonlyMap<string, ShieldWinAsset>
): ShieldWinAsset {
  return (
    assets.get(assetId) ?? {
      symbol: assetId,
      network: '',
      tokenIconUrl: null,
      chainIconUrl: null
    }
  )
}

export function assetLabel(assetId: string, assets: ReadonlyMap<string, ShieldWinAsset>): string {
  const asset = assets.get(assetId)
  return asset ? `${asset.network} · ${asset.symbol}` : assetId
}

async function backfillRheaIcons(
  labels: Map<string, ShieldWinAsset>,
  chains: ReadonlyMap<string, string>,
  assetIds: readonly string[],
  signal: AbortSignal | undefined,
  fetcher: typeof fetch
): Promise<void> {
  const needed = new Set<string>()
  for (const assetId of assetIds) {
    const asset = labels.get(assetId)
    const chain = chains.get(assetId)
    if (!asset || asset.tokenIconUrl || !chain) continue
    needed.add(chain)
  }
  await Promise.all(
    [...needed].map(async chain => {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      try {
        const url = new URL(RHEA_TOKEN_ICONS_API)
        url.searchParams.set('chains', chain)
        const response = await fetcher(url.toString(), { signal })
        if (!response.ok) return
        const data: unknown = await response.json()
        if (!Array.isArray(data)) return
        for (const token of data) {
          if (typeof token !== 'object' || token === null) continue
          const assetId = 'assetId' in token ? token.assetId : null
          const icon = tokenIconUrl(token)
          if (typeof assetId !== 'string' || !icon) continue
          const current = labels.get(assetId)
          if (!current || current.tokenIconUrl) continue
          labels.set(assetId, { ...current, tokenIconUrl: icon })
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error
      }
    })
  )
}

async function backfillCoinGeckoIcons(
  labels: Map<string, ShieldWinAsset>,
  coingeckoIds: ReadonlyMap<string, string>,
  assetIds: readonly string[],
  signal: AbortSignal | undefined,
  fetcher: typeof fetch
): Promise<void> {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const assetId of assetIds) {
    const asset = labels.get(assetId)
    const id = coingeckoIds.get(assetId)
    if (!asset || asset.tokenIconUrl || !id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= MAX_COINGECKO_ICON_COUNT) break
  }
  if (ids.length === 0) return
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  try {
    const url = new URL(COINGECKO_MARKETS_API)
    url.searchParams.set('vs_currency', 'usd')
    url.searchParams.set('ids', ids.join(','))
    url.searchParams.set('per_page', String(MAX_COINGECKO_ICON_COUNT))
    url.searchParams.set('page', '1')
    url.searchParams.set('sparkline', 'false')
    const response = await fetcher(url.toString(), { signal })
    if (!response.ok) return
    const data: unknown = await response.json()
    if (!Array.isArray(data)) return
    const images = new Map<string, string>()
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = 'id' in entry ? entry.id : null
      const image = 'image' in entry ? entry.image : null
      if (typeof id !== 'string' || images.has(id) || !isCoinGeckoImageUrl(image)) continue
      images.set(id, image)
    }
    for (const assetId of assetIds) {
      const current = labels.get(assetId)
      const id = coingeckoIds.get(assetId)
      if (!current || current.tokenIconUrl || !id) continue
      const icon = images.get(id)
      if (!icon) continue
      labels.set(assetId, { ...current, tokenIconUrl: icon })
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function readCoingeckoId(token: object): string | null {
  const value = 'coingeckoId' in token ? token.coingeckoId : null
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!id || id.length > 128 || id.startsWith('custom:') || !/^[A-Za-z0-9._-]+$/.test(id)) {
    return null
  }
  return id
}

function isCoinGeckoImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'coin-images.coingecko.com' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname.startsWith('/coins/images/')
    )
  } catch {
    return false
  }
}

function tokenIconUrl(token: object): string | null {
  const record = token as { icon?: unknown; coingeckoIcon?: unknown }
  return httpsUrl(record.icon) ?? httpsUrl(record.coingeckoIcon)
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}
