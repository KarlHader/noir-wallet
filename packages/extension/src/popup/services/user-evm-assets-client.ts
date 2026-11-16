import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { createInitialProductChainRegistry, parseAssetId } from '@/core/chains/registry'
import {
  parseDetectedEvmAssetRecord,
  parseUserEvmAssetCandidate,
  parseUserEvmAssetRecord,
  type DetectedEvmAssetRecord,
  type UserEvmAssetCandidate,
  type UserEvmAssetRecord
} from '@/core/chains/user-assets'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'

type RuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

export class UserEvmAssetsClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserEvmAssetsClientError'
  }
}

function resolveChains() {
  const catalog = resolveEvmNetworkCatalog(DEFAULT_NETWORK, getActiveChainEndpointSettings())
  return createInitialProductChainRegistry(
    DEFAULT_NETWORK,
    catalog.filter(network => network.source === 'custom')
  )
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UserEvmAssetsClientError(`Invalid ${label}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UserEvmAssetsClientError(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function unwrap(value: unknown): unknown {
  const response = readRecord(value, 'user EVM Token response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    if (Object.keys(response).length !== 1 || typeof response.error !== 'string') {
      throw new UserEvmAssetsClientError('Invalid user EVM Token error')
    }
    throw new UserEvmAssetsClientError(response.error)
  }
  if (
    Object.keys(response).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(response, 'result')
  ) {
    throw new UserEvmAssetsClientError('Invalid user EVM Token response')
  }
  return response.result
}

export function createUserEvmAssetsClient(sendMessage: RuntimeMessenger) {
  return Object.freeze({
    list: async (): Promise<readonly UserEvmAssetRecord[]> => {
      const result = unwrap(await sendMessage({ type: 'GET_USER_EVM_ASSETS' }))
      if (!Array.isArray(result) || result.length > 64) {
        throw new UserEvmAssetsClientError('Invalid user EVM Token list')
      }
      const chains = resolveChains()
      return Object.freeze(result.map(item => parseUserEvmAssetRecord(chains, item)))
    },
    listManaged: async (): Promise<
      Readonly<{
        userAssets: readonly UserEvmAssetRecord[]
        detectedAssets: readonly DetectedEvmAssetRecord[]
        hiddenAssetIds: readonly string[]
        protocolAssetIds: readonly string[]
      }>
    > => {
      const result = readRecord(
        unwrap(await sendMessage({ type: 'GET_MANAGED_TOKEN_ASSETS' })),
        'managed Token result'
      )
      if (
        Object.keys(result).length !== 4 ||
        !Array.isArray(result.userAssets) ||
        result.userAssets.length > 64 ||
        !Array.isArray(result.detectedAssets) ||
        result.detectedAssets.length > 512 ||
        !Array.isArray(result.hiddenAssetIds) ||
        result.hiddenAssetIds.length > 512 ||
        !Array.isArray(result.protocolAssetIds) ||
        result.protocolAssetIds.length > 1_024
      ) {
        throw new UserEvmAssetsClientError('Invalid managed Token result')
      }
      const chains = resolveChains()
      const userAssets = result.userAssets.map(item => parseUserEvmAssetRecord(chains, item))
      const detectedAssets = result.detectedAssets.map(item =>
        parseDetectedEvmAssetRecord(chains, item)
      )
      const hiddenAssetIds = result.hiddenAssetIds.map(item => {
        if (typeof item !== 'string' || item.length > 256) {
          throw new UserEvmAssetsClientError('Invalid hidden Token')
        }
        return item
      })
      const protocolAssetIds = result.protocolAssetIds.map(item => {
        if (typeof item !== 'string' || item.length > 256) {
          throw new UserEvmAssetsClientError('Invalid protocol Token')
        }
        return parseAssetId(item).id
      })
      return Object.freeze({
        userAssets: Object.freeze(userAssets),
        detectedAssets: Object.freeze(detectedAssets),
        hiddenAssetIds: Object.freeze(hiddenAssetIds),
        protocolAssetIds: Object.freeze(protocolAssetIds)
      })
    },
    inspect: async (input: {
      readonly chainId: string
      readonly contractAddress: string
    }): Promise<UserEvmAssetCandidate> =>
      parseUserEvmAssetCandidate(
        resolveChains(),
        unwrap(
          await sendMessage({
            type: 'INSPECT_USER_EVM_ASSET',
            chainId: input.chainId,
            contractAddress: input.contractAddress
          })
        )
      ),
    add: async (candidate: UserEvmAssetCandidate): Promise<UserEvmAssetRecord> => {
      const chains = resolveChains()
      const parsed = parseUserEvmAssetCandidate(chains, candidate)
      return parseUserEvmAssetRecord(
        chains,
        unwrap(await sendMessage({ type: 'ADD_USER_EVM_ASSET', candidate: parsed }))
      )
    },
    remove: async (assetId: string): Promise<void> => {
      const result = readRecord(
        unwrap(await sendMessage({ type: 'REMOVE_USER_EVM_ASSET', assetId })),
        'user EVM Token removal result'
      )
      if (Object.keys(result).length !== 1 || result.removed !== true) {
        throw new UserEvmAssetsClientError('Invalid user EVM Token removal result')
      }
    },
    setHidden: async (assetId: string, hidden: boolean): Promise<void> => {
      const result = readRecord(
        unwrap(await sendMessage({ type: 'SET_TOKEN_HIDDEN', assetId, hidden })),
        'Token visibility result'
      )
      if (Object.keys(result).length !== 1 || result.hidden !== hidden) {
        throw new UserEvmAssetsClientError('Invalid Token visibility result')
      }
    }
  })
}

export const userEvmAssetsClient = createUserEvmAssetsClient(message =>
  chrome.runtime.sendMessage(message)
)
