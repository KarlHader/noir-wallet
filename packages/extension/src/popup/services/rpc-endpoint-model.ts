import {
  findChainEndpointOverride,
  withChainRpcEndpoint,
  withSavedChainRpcEndpoint,
  type ChainEndpointSettings,
  type CustomChainRpcEndpoint
} from '@/core/chains/chain-endpoint-settings'
import type { RpcChainOption } from './chain-settings-options'

export function isSameRpcUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return left.trim() === right.trim()
  }
}

export function getRpcAutoFirstEndpoint(option: RpcChainOption): {
  readonly label: string
  readonly url: string
} {
  const preset = option.presets?.find(candidate => isSameRpcUrl(candidate.url, option.defaultUrl))
  return { label: preset?.label ?? 'Default', url: option.defaultUrl }
}

export function getSavedRpcEndpoints(
  settings: ChainEndpointSettings,
  option: RpcChainOption
): readonly CustomChainRpcEndpoint[] {
  const saved = (settings.savedRpcEndpoints ?? [])
    .filter(endpoint => endpoint.chainId === option.chainId)
    .map(endpoint => endpoint.rpc)
    .filter(endpoint => !option.presets?.some(preset => isSameRpcUrl(preset.url, endpoint.url)))
  const selected = findChainEndpointOverride(settings, option.chainId)?.rpc
  if (
    selected &&
    !option.presets?.some(preset => isSameRpcUrl(preset.url, selected.url)) &&
    !saved.some(endpoint => isSameRpcUrl(endpoint.url, selected.url))
  ) {
    return [...saved, selected]
  }
  return saved
}

export function buildRpcSelectionSettings(
  settings: ChainEndpointSettings,
  option: RpcChainOption,
  url?: string,
  name = '',
  saveCustom = false
): ChainEndpointSettings {
  if (url === undefined) return withChainRpcEndpoint(settings, option.chainId)
  const normalized = url.trim()
  const preset = option.presets?.find(candidate => isSameRpcUrl(candidate.url, normalized))
  const saved = getSavedRpcEndpoints(settings, option).find(endpoint =>
    isSameRpcUrl(endpoint.url, normalized)
  )
  const rpc = {
    protocol: option.protocol,
    label: saveCustom
      ? name.trim() || saved?.label || `Custom ${option.label} RPC`
      : (saved?.label ?? preset?.label ?? (name.trim() || `Custom ${option.label} RPC`)),
    url: normalized
  }
  return preset && !saveCustom && !saved
    ? withChainRpcEndpoint(settings, option.chainId, rpc)
    : withSavedChainRpcEndpoint(settings, option.chainId, rpc)
}
