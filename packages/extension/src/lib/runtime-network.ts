import type { Network } from '@/types'
import { BUILD_DEFAULT_NETWORK, NETWORKS, type NetworkConfig } from '@/config/networks'
import { SETTINGS_STORAGE_KEY, resolvePersistedNetworkMode } from './wallet-settings-storage'
import { getActiveZcashRpcUrlForNetwork } from '@/infrastructure/chains/rpc-endpoints'
import {
  findChainEndpointOverride,
  getActiveChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import { getZcashChainId } from '@/core/chains/registry'

/** The active network is fixed for the lifetime of an extension context. */
export let DEFAULT_NETWORK: Network = BUILD_DEFAULT_NETWORK

let runtimeNetworkReady: Promise<Network> | null = null
let runtimeNetworkInitialized = false

export function initializeRuntimeNetwork(): Promise<Network> {
  if (runtimeNetworkReady) return runtimeNetworkReady
  runtimeNetworkReady = chrome.storage.local
    .get(SETTINGS_STORAGE_KEY)
    .then(settings => {
      DEFAULT_NETWORK = resolvePersistedNetworkMode(
        settings[SETTINGS_STORAGE_KEY],
        BUILD_DEFAULT_NETWORK
      )
      runtimeNetworkInitialized = true
      return DEFAULT_NETWORK
    })
    .catch(error => {
      runtimeNetworkReady = null
      throw error
    })
  return runtimeNetworkReady
}

export function isRuntimeNetworkInitialized(): boolean {
  return runtimeNetworkInitialized
}

export type MainnetProtocolFeature = 'Swap'

export function assertMainnetProtocolFeature(feature: MainnetProtocolFeature): void {
  if (DEFAULT_NETWORK !== 'mainnet') {
    throw new Error(`${feature} is only available in the mainnet build`)
  }
}

export const getNetworkConfig = (network: Network): NetworkConfig => {
  const config = NETWORKS[network] || NETWORKS[DEFAULT_NETWORK]
  const custom = findChainEndpointOverride(
    getActiveChainEndpointSettings(),
    getZcashChainId(config.id)
  )?.rpc
  return {
    ...config,
    rpcUrl:
      custom?.protocol === 'zcash-lightwalletd'
        ? custom.url
        : getActiveZcashRpcUrlForNetwork(config.id, config.rpcUrl),
    compactBlockCdn: custom?.protocol === 'zcash-lightwalletd' ? null : config.compactBlockCdn
  }
}
