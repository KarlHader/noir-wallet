import type { Network } from '@/types'

export const BITCOIN_CHAIN_IDS = Object.freeze({
  mainnet: 'bip122:000000000019d6689c085ae165831e93',
  testnet: 'bip122:000000000933ea01ad0ee984209779ba'
} as const satisfies Record<Network, string>)

export const ZCASH_CHAIN_IDS = Object.freeze({
  mainnet: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  testnet: 'bip122:05a60a92d99d85997cce3b87616c089f'
} as const satisfies Record<Network, string>)

export const PEARL_CHAIN_IDS = Object.freeze({
  mainnet: 'bip122:a18d3093b7ff618f0cdd073fa3d10374',
  testnet: 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
} as const satisfies Record<Network, string>)
