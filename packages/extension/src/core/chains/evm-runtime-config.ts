import type { Network } from '@/types'
import { getEvmNetworkConfigs, type EvmNetworkConfig } from '@/config/networks'
import { resolveEvmChainIconAlias } from '@/config/icons'
import {
  findChainEndpointOverride,
  parseChainEndpointSettings,
  type ChainEndpointSettings,
  type CustomEvmNetwork
} from './chain-endpoint-settings'
import { resolvePersistedNetworkChainEndpointSettings } from '@/lib/wallet-settings-storage'

export const CUSTOM_EVM_NETWORKS_ENABLED = true

export interface EvmRuntimeNetworkConfig extends EvmNetworkConfig {
  readonly source: 'builtin' | 'custom'
}

function applyOverride(
  config: EvmRuntimeNetworkConfig,
  settings: ChainEndpointSettings
): EvmRuntimeNetworkConfig {
  const override = findChainEndpointOverride(settings, config.chainId)
  return Object.freeze({
    ...config,
    ...(override?.rpc === undefined ? {} : { rpcUrl: override.rpc.url }),
    ...(override?.explorer === undefined ? {} : { explorerUrl: override.explorer.baseUrl })
  })
}

function customNetworkConfig(
  networkMode: Network,
  network: CustomEvmNetwork
): EvmRuntimeNetworkConfig {
  return Object.freeze({
    networkMode,
    chainId: network.chainId,
    numericChainId: network.numericChainId,
    networkName: network.displayName,
    displayName: network.displayName,
    iconChain: resolveEvmChainIconAlias(network.chainId),
    nativeCurrency: Object.freeze({
      ...network.nativeCurrency,
      slip44Reference: '60'
    }),
    rpcUrl: network.rpc.url,
    explorerUrl: network.explorer?.baseUrl ?? '',
    source: 'custom' as const
  })
}

export function resolveConfiguredEvmNetworkCatalog(
  networkMode: Network,
  settingsValue: unknown
): readonly EvmRuntimeNetworkConfig[] {
  const settings = parseChainEndpointSettings(settingsValue)
  const builtin = getEvmNetworkConfigs(networkMode).map(config =>
    applyOverride(Object.freeze({ ...config, source: 'builtin' as const }), settings)
  )
  const builtinIds = new Set(
    [...getEvmNetworkConfigs('mainnet'), ...getEvmNetworkConfigs('testnet')].map(
      config => config.chainId
    )
  )
  const custom = settings.customEvmNetworks.map(network => {
    if (builtinIds.has(network.chainId)) {
      throw new Error('A custom EVM network cannot replace a built-in chain definition')
    }
    return applyOverride(customNetworkConfig(networkMode, network), settings)
  })
  return Object.freeze([...builtin, ...custom])
}

export function resolveEvmNetworkCatalog(
  networkMode: Network,
  settingsValue: unknown
): readonly EvmRuntimeNetworkConfig[] {
  if (CUSTOM_EVM_NETWORKS_ENABLED) {
    return resolveConfiguredEvmNetworkCatalog(networkMode, settingsValue)
  }
  const settings = parseChainEndpointSettings(settingsValue)
  return Object.freeze(
    getEvmNetworkConfigs(networkMode).map(config =>
      applyOverride(Object.freeze({ ...config, source: 'builtin' as const }), settings)
    )
  )
}

export function resolveReleasedChainEndpointSettings(
  networkMode: Network,
  settingsValue: unknown
): ChainEndpointSettings {
  const settings = parseChainEndpointSettings(settingsValue)
  if (CUSTOM_EVM_NETWORKS_ENABLED) return settings
  const builtinChainIds = new Set<string>(
    getEvmNetworkConfigs(networkMode).map(network => network.chainId)
  )
  return parseChainEndpointSettings({
    schemaVersion: settings.schemaVersion,
    ...(settings.activeEvmChainId !== undefined && builtinChainIds.has(settings.activeEvmChainId)
      ? { activeEvmChainId: settings.activeEvmChainId }
      : {}),
    customEvmNetworks: [],
    overrides: settings.overrides.filter(
      override => !override.chainId.startsWith('eip155:') || builtinChainIds.has(override.chainId)
    ),
    ...(settings.savedRpcEndpoints === undefined
      ? {}
      : {
          savedRpcEndpoints: settings.savedRpcEndpoints.filter(
            endpoint =>
              !endpoint.chainId.startsWith('eip155:') || builtinChainIds.has(endpoint.chainId)
          )
        })
  })
}

export function resolveActiveEvmNetworkConfig(
  networkMode: Network,
  settingsValue: unknown
): EvmRuntimeNetworkConfig {
  const settings = parseChainEndpointSettings(settingsValue)
  const catalog = resolveEvmNetworkCatalog(networkMode, settings)
  if (settings.activeEvmChainId !== undefined) {
    const selected = catalog.find(config => config.chainId === settings.activeEvmChainId)
    if (selected) return selected
  }
  const fallback = catalog[0]
  if (!fallback) throw new Error('EVM network catalog is empty')
  return fallback
}

export function resolvePersistedEvmNetworkChainIds(rawSettings: unknown): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        (['mainnet', 'testnet'] as const).flatMap(networkMode =>
          resolveEvmNetworkCatalog(
            networkMode,
            resolvePersistedNetworkChainEndpointSettings(rawSettings, networkMode)
          ).map(network => network.chainId)
        )
      )
    ].sort()
  )
}
