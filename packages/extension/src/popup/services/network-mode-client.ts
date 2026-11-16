import type { Network } from '@/types'

type RuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

export class NetworkModeClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkModeClientError'
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NetworkModeClientError(`Invalid ${label}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NetworkModeClientError(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function parseResponse(
  value: unknown
): Readonly<{ networkMode: Network; restartRequired: boolean }> {
  const response = readRecord(value, 'network mode response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    if (Object.keys(response).length !== 1 || typeof response.error !== 'string') {
      throw new NetworkModeClientError('Invalid network mode error')
    }
    throw new NetworkModeClientError(response.error)
  }
  if (Object.keys(response).length !== 1) {
    throw new NetworkModeClientError('Invalid network mode response')
  }
  const result = readRecord(response.result, 'network mode result')
  if (
    Object.keys(result).some(key => key !== 'networkMode' && key !== 'restartRequired') ||
    (result.networkMode !== 'mainnet' && result.networkMode !== 'testnet') ||
    typeof result.restartRequired !== 'boolean'
  ) {
    throw new NetworkModeClientError('Invalid network mode result')
  }
  return Object.freeze({
    networkMode: result.networkMode,
    restartRequired: result.restartRequired
  })
}

function parseSwitchResponse(value: unknown): Readonly<{ restartRequired: true }> {
  const response = readRecord(value, 'network switch response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    if (Object.keys(response).length !== 1 || typeof response.error !== 'string') {
      throw new NetworkModeClientError('Invalid network switch error')
    }
    throw new NetworkModeClientError(response.error)
  }
  if (Object.keys(response).length !== 1) {
    throw new NetworkModeClientError('Invalid network switch response')
  }
  const result = readRecord(response.result, 'network switch result')
  if (Object.keys(result).length !== 1 || result.restartRequired !== true) {
    throw new NetworkModeClientError('Invalid network switch result')
  }
  return Object.freeze({ restartRequired: true as const })
}

export function createNetworkModeClient(sendMessage: RuntimeMessenger) {
  return Object.freeze({
    read: async () => parseResponse(await sendMessage({ type: 'GET_NETWORK_MODE' })),
    switch: async (networkMode: Network) =>
      parseSwitchResponse(await sendMessage({ type: 'SWITCH_NETWORK_MODE', networkMode }))
  })
}

export const networkModeClient = createNetworkModeClient(message =>
  chrome.runtime.sendMessage(message)
)
