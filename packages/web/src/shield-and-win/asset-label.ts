const TOKEN_CATALOG_URL = 'https://1click.chaindefuser.com/v0/tokens'
const RHEA_TOKEN_ICONS_API = 'https://api.rhea.finance/get_multichain_lending_tokens_data'
const CHAIN_ICON_BASE_URL = 'https://assets.zknoir.com/chain'

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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
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
