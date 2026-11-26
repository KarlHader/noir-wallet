const TOKEN_CATALOG_URL = 'https://1click.chaindefuser.com/v0/tokens'

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

export async function getAssetLabels(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<ReadonlyMap<string, string>> {
  const response = await fetcher(TOKEN_CATALOG_URL, { signal })
  if (!response.ok) throw new Error('The token catalog could not be loaded.')
  const data: unknown = await response.json()
  if (!Array.isArray(data)) throw new Error('The token catalog is invalid.')

  const labels = new Map<string, string>()
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
    labels.set(assetId, `${NETWORK_NAMES[blockchain] ?? blockchain.toUpperCase()} · ${symbol}`)
  }
  return labels
}

export function assetLabel(assetId: string, labels: ReadonlyMap<string, string>): string {
  return labels.get(assetId) ?? assetId
}
