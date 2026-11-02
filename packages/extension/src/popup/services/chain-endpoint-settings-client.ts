import {
  parseChainEndpointSettings,
  type ChainEndpointSettings,
  type CustomEvmNetwork
} from '@/core/chains/chain-endpoint-settings'

type RuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

export class ChainEndpointSettingsClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainEndpointSettingsClientError'
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChainEndpointSettingsClientError(`Invalid ${label}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ChainEndpointSettingsClientError(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function parseResponse(value: unknown): ChainEndpointSettings {
  const response = readRecord(value, 'chain endpoint settings response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    if (Object.keys(response).length !== 1 || typeof response.error !== 'string') {
      throw new ChainEndpointSettingsClientError('Invalid chain endpoint settings error')
    }
    throw new ChainEndpointSettingsClientError(response.error)
  }
  if (
    Object.keys(response).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(response, 'result')
  ) {
    throw new ChainEndpointSettingsClientError('Invalid chain endpoint settings response')
  }
  try {
    return parseChainEndpointSettings(response.result)
  } catch {
    throw new ChainEndpointSettingsClientError('Invalid chain endpoint settings result')
  }
}

export function createChainEndpointSettingsClient(sendMessage: RuntimeMessenger) {
  return Object.freeze({
    read: async () => parseResponse(await sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })),
    apply: async (settings: ChainEndpointSettings, expectedSettings: ChainEndpointSettings) =>
      parseResponse(
        await sendMessage({
          type: 'APPLY_CHAIN_ENDPOINT_SETTINGS',
          settings: parseChainEndpointSettings(settings),
          expectedSettings: parseChainEndpointSettings(expectedSettings)
        })
      ),
    saveCustomEvmNetwork: async (network: CustomEvmNetwork, expectedNetwork?: CustomEvmNetwork) =>
      parseResponse(
        await sendMessage({ type: 'SAVE_CUSTOM_EVM_NETWORK', network, expectedNetwork })
      ),
    removeCustomEvmNetwork: async (network: CustomEvmNetwork) =>
      parseResponse(await sendMessage({ type: 'REMOVE_CUSTOM_EVM_NETWORK', network })),
    selectActiveEvmChain: async (chainId: string) =>
      parseResponse(await sendMessage({ type: 'SELECT_ACTIVE_EVM_CHAIN', chainId }))
  })
}

export const chainEndpointSettingsClient = createChainEndpointSettingsClient(message =>
  chrome.runtime.sendMessage(message)
)
