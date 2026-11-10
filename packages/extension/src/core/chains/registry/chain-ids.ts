import type { Network } from '@/types'

export const BITCOIN_CHAIN_IDS = Object.freeze({
  mainnet: 'bip122:000000000019d6689c085ae165831e93',
  testnet: 'bip122:000000000933ea01ad0ee984209779ba'
} as const satisfies Record<Network, string>)

export const ZCASH_CHAIN_IDS = Object.freeze({
  mainnet: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  testnet: 'bip122:05a60a92d99d85997cce3b87616c089f'
} as const satisfies Record<Network, string>)

export const DASH_CHAIN_IDS = Object.freeze({
  mainnet: 'bip122:00000ffd590b1485b3caadc19b22e637',
  testnet: 'bip122:00000bafbc94add76cb75e2ec9289483'
} as const satisfies Record<Network, string>)

export const PEARL_CHAIN_IDS = Object.freeze({
  mainnet: 'bip122:a18d3093b7ff618f0cdd073fa3d10374',
  testnet: 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
} as const satisfies Record<Network, string>)

/** Global Network Mode maps testnet → Planck (`quantus:planck`). */
export const QUANTUS_CHAIN_IDS = Object.freeze({
  mainnet: 'quantus:mainnet',
  testnet: 'quantus:planck'
} as const satisfies Record<Network, string>)

export function isBitcoinChainId(chainId: string): boolean {
  return chainId === BITCOIN_CHAIN_IDS.mainnet || chainId === BITCOIN_CHAIN_IDS.testnet
}

export function isZcashChainId(chainId: string): boolean {
  return chainId === ZCASH_CHAIN_IDS.mainnet || chainId === ZCASH_CHAIN_IDS.testnet
}

export function isDashChainId(chainId: string): boolean {
  return chainId === DASH_CHAIN_IDS.mainnet || chainId === DASH_CHAIN_IDS.testnet
}

export function isPearlChainId(chainId: string): boolean {
  return chainId === PEARL_CHAIN_IDS.mainnet || chainId === PEARL_CHAIN_IDS.testnet
}

export function isQuantusChainId(chainId: string): boolean {
  return chainId === QUANTUS_CHAIN_IDS.mainnet || chainId === QUANTUS_CHAIN_IDS.testnet
}
