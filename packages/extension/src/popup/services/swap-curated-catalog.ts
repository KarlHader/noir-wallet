import type { RheaSwapToken } from '@/core/services/rhea-swap'
import type { UserEvmAssetRecord } from '@/core/chains/user-assets'
import { EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID } from '@/config/asset-market-assets'
import { getEvmNetworkConfigs } from '@/config/networks'
import Big from '@/lib/big'

export interface CuratedSwapTokenRow {
  readonly chainId: number
  readonly address: string
  readonly order: number
}

const localRows = Object.freeze(
  getEvmNetworkConfigs('mainnet').flatMap(network => {
    const assetId = EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID[network.chainId]
    if (!assetId || !network.usdcContract) return []
    return [
      Object.freeze({ chainId: network.numericChainId, address: assetId, order: 0 }),
      Object.freeze({ chainId: network.numericChainId, address: network.usdcContract, order: 1 })
    ]
  })
)

export function getCuratedSwapChainIds(tokens: readonly RheaSwapToken[]): readonly number[] {
  return [...new Set(tokens.map(token => token.tokenListChainId))]
}

export function readCachedCuratedSwapTokens(
  chainIds: readonly number[]
): readonly CuratedSwapTokenRow[] {
  const enabled = new Set(chainIds)
  return localRows.filter(row => enabled.has(row.chainId))
}

export async function loadCuratedSwapTokens(
  chainIds: readonly number[],
  onRows?: (rows: readonly CuratedSwapTokenRow[]) => void
): Promise<readonly CuratedSwapTokenRow[]> {
  const rows = readCachedCuratedSwapTokens(chainIds)
  onRows?.(rows)
  return rows
}

function normalizedAddress(address: string, token: RheaSwapToken): string {
  const trimmed = address.trim().replace(/^nep141:/i, '')
  return /^[0-9]+$/.test(token.rheaChainId) || token.rheaChainId === 'near'
    ? trimmed.toLowerCase()
    : trimmed
}

function isNativeRow(address: string, token: RheaSwapToken): boolean {
  const normalized = normalizedAddress(address, token)
  if (normalized === normalizedAddress(token.rheaAddress, token)) return true
  if (normalized === 'native' || normalized.endsWith(':native')) return true
  if (!/^[0-9]+$/.test(token.rheaChainId)) return false
  return (
    normalized === '0x0000000000000000000000000000000000000000' ||
    normalized === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
    (token.rheaChainId === '137' && normalized === '0x0000000000000000000000000000000000001010')
  )
}

function curatedRanks(tokens: readonly RheaSwapToken[], rows: readonly CuratedSwapTokenRow[]) {
  const chainExamples = new Map(tokens.map(token => [token.tokenListChainId, token]))
  const nativeTokens = new Map(
    tokens.filter(token => token.isNative).map(token => [token.tokenListChainId, token])
  )
  const addresses = new Map<string, number>()
  const native = new Map<number, number>()
  for (const [index, row] of rows.entries()) {
    const example = chainExamples.get(row.chainId)
    if (!example) continue
    const nativeToken = nativeTokens.get(row.chainId)
    if (nativeToken && isNativeRow(row.address, nativeToken)) {
      if (!native.has(row.chainId)) native.set(row.chainId, index)
      continue
    }
    const key = `${row.chainId}:${normalizedAddress(row.address, example)}`
    if (!addresses.has(key)) addresses.set(key, index)
  }
  return { addresses, native }
}

function hasBalance(balance: string | undefined): boolean {
  if (balance === undefined) return false
  try {
    return new Big(balance).gt(0)
  } catch {
    return false
  }
}

const tokenKeys = new WeakMap<
  RheaSwapToken,
  { readonly addresses: readonly string[]; readonly custom: string }
>()

function getTokenKeys(token: RheaSwapToken) {
  const cached = tokenKeys.get(token)
  if (cached) return cached
  const keys = {
    addresses: [token.rheaAddress, token.contractAddress, token.assetId].flatMap(address =>
      typeof address === 'string'
        ? [`${token.tokenListChainId}:${normalizedAddress(address, token)}`]
        : []
    ),
    custom: `eip155:${token.rheaChainId}:${token.contractAddress?.toLowerCase() ?? ''}`
  }
  tokenKeys.set(token, keys)
  return keys
}

export function selectDefaultSwapTokens(
  tokens: readonly RheaSwapToken[],
  curatedRows: readonly CuratedSwapTokenRow[],
  options: {
    readonly balances?: ReadonlyMap<string, string>
    readonly customAssets?: readonly Pick<
      UserEvmAssetRecord,
      'chainId' | 'contractAddress' | 'source'
    >[]
  } = {}
): readonly RheaSwapToken[] {
  const ranks = curatedRanks(tokens, curatedRows)
  const custom = new Set(
    (options.customAssets ?? []).map(
      asset => `${asset.chainId.toLowerCase()}:${asset.contractAddress.toLowerCase()}`
    )
  )
  const ranked = tokens.flatMap((token, index) => {
    const keys = getTokenKeys(token)
    const curated = token.isNative
      ? (ranks.native.get(token.tokenListChainId) ?? Infinity)
      : keys.addresses.reduce((best, candidate) => {
          const rank = ranks.addresses.get(candidate)
          return rank === undefined ? best : Math.min(best, rank)
        }, Infinity)
    const held = hasBalance(options.balances?.get(token.assetId))
    const userAdded = !token.isNative && custom.has(keys.custom)
    if (!Number.isFinite(curated) && !token.isNative && !held && !userAdded) return []
    return [{ token, index, rank: Number.isFinite(curated) ? 0 : token.isNative ? 1 : 2, curated }]
  })
  ranked.sort(
    (left, right) =>
      left.rank - right.rank ||
      (left.rank === 0 ? left.curated - right.curated : left.index - right.index)
  )
  return ranked.map(item => item.token)
}
