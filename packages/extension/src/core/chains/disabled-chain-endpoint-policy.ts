import type { ChainEndpointSettings } from './chain-endpoint-settings'

export function assertDisabledChainEndpointsUnchanged(
  current: ChainEndpointSettings,
  next: ChainEndpointSettings,
  disabledChainIds: readonly string[]
): void {
  for (const chainId of disabledChainIds) {
    const entries = (settings: ChainEndpointSettings) =>
      JSON.stringify({
        overrides: settings.overrides.filter(override => override.chainId === chainId),
        savedRpcEndpoints: (settings.savedRpcEndpoints ?? []).filter(
          endpoint => endpoint.chainId === chainId
        )
      })
    if (entries(current) !== entries(next)) {
      throw new Error('This chain does not have an active endpoint adapter in this build')
    }
  }
}
