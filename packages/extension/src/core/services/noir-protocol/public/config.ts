import type { Network } from '@/types'

export interface NoirPublicAssetConfig {
  readonly tokenId: string
  readonly symbol: string
  readonly name: string
  readonly decimals: number
}

const PUBLIC_ASSETS: readonly NoirPublicAssetConfig[] = Object.freeze([
  Object.freeze({ tokenId: 'zec.omft.near', symbol: 'ZEC', name: 'Zcash', decimals: 8 }),
  Object.freeze({ tokenId: 'wrap.near', symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24 })
])

export interface NoirPublicNetworkConfig {
  readonly network: 'mainnet'
  readonly parentContractId: 'ma.private-mainnet.ref-dev-team.near'
  readonly submitBaseUrl: string
  readonly queryBaseUrl: string
  readonly transactionIndexBaseUrl: string
  readonly oneClickBaseUrl: string
  readonly zecTokenId: 'zec.omft.near'
  readonly zecOriginAsset: 'nep141:zec.omft.near'
  readonly zecDestinationAsset: '1cs_v1:near:nep141:zec.omft.near'
  readonly assets: readonly NoirPublicAssetConfig[]
  readonly tokenIds: readonly string[]
}

export const PUBLIC_MAINNET_CONFIG: NoirPublicNetworkConfig = Object.freeze({
  network: 'mainnet',
  parentContractId: 'ma.private-mainnet.ref-dev-team.near',
  submitBaseUrl: 'https://apinoir.refburrow.top/receive/v1',
  queryBaseUrl: 'https://apinoir.refburrow.top/v1',
  transactionIndexBaseUrl: 'https://tx.main.fastnear.com/v0',
  oneClickBaseUrl: 'https://privateindexer.refburrow.top/api/1click',
  zecTokenId: 'zec.omft.near',
  zecOriginAsset: 'nep141:zec.omft.near',
  zecDestinationAsset: '1cs_v1:near:nep141:zec.omft.near',
  assets: PUBLIC_ASSETS,
  tokenIds: Object.freeze(PUBLIC_ASSETS.map(asset => asset.tokenId))
})

export type NoirPublicConfigStatus =
  | Readonly<{ enabled: true; config: NoirPublicNetworkConfig }>
  | Readonly<{ enabled: false; reason: string }>

export function getPublicConfigStatus(network: Network): NoirPublicConfigStatus {
  if (network !== 'mainnet') {
    return Object.freeze({ enabled: false, reason: 'Public MCA is unavailable on this network' })
  }
  return Object.freeze({ enabled: true, config: PUBLIC_MAINNET_CONFIG })
}

export function requirePublicConfig(network: Network): NoirPublicNetworkConfig {
  const status = getPublicConfigStatus(network)
  if (!status.enabled) throw new Error(status.reason)
  return status.config
}
