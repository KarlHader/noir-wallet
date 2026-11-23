import type { EvmNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import {
  detectedEvmAssetToDefinition,
  userEvmAssetToDefinition,
  type DetectedEvmAssetRecord,
  type UserEvmAssetRecord
} from '@/core/chains/user-assets'
import {
  ChromeDetectedEvmAssetCatalogRepository,
  ChromeUserEvmAssetCatalogRepository,
  DetectedEvmAssetCoordinator,
  EvmTokenDiscoveryClient,
  UserEvmAssetCoordinator,
  createConfiguredEvmRpcClient
} from '@/infrastructure/chains/evm'
import { EvmTokenDiscoverySchedule } from '@/infrastructure/chains/evm/evm-token-discovery-schedule'
import { ChromeTokenVisibilityRepository } from '@/infrastructure/portfolio/chrome-token-visibility'
import { getCachedBackgroundRheaSwapTokens } from './rhea-swap'
import { resolveSwapTokenAssetIds } from '@/core/services/intents-managed-assets'
import { ChromeUserAssetDexPoolCacheRepository } from '@/infrastructure/prices'
import { FourMemeMarketClient } from '@/infrastructure/prices/four-meme-market-client'

const tokenDiscoverySchedule = new EvmTokenDiscoverySchedule(DEFAULT_NETWORK)

export interface BackgroundUserEvmAssetRuntime {
  readonly coordinator: UserEvmAssetCoordinator
  readonly detectedCoordinator: DetectedEvmAssetCoordinator
  readonly visibility: ChromeTokenVisibilityRepository
  readonly records: readonly UserEvmAssetRecord[]
  readonly detectedRecords: readonly DetectedEvmAssetRecord[]
  readonly definitions: readonly AssetDefinitionInput[]
  readonly catalogStatus: 'ready' | 'error'
}

export async function createBackgroundUserEvmAssetRuntime(
  evmNetworks: readonly EvmNetworkConfig[],
  customEvmNetworks: readonly EvmNetworkConfig[] = []
): Promise<BackgroundUserEvmAssetRuntime> {
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK, customEvmNetworks)
  const bundledAssets = createAssetRegistry(
    chains,
    getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK, customEvmNetworks)
  )
  const repository = new ChromeUserEvmAssetCatalogRepository(DEFAULT_NETWORK, chains)
  const detectedRepository = new ChromeDetectedEvmAssetCatalogRepository(DEFAULT_NETWORK, chains)
  const fourMeme = new FourMemeMarketClient()
  const rpcByChainId = new Map<string, ReturnType<typeof createConfiguredEvmRpcClient>>(
    evmNetworks.map(network => [
      network.chainId,
      createConfiguredEvmRpcClient(DEFAULT_NETWORK, network)
    ])
  )
  const coordinator = new UserEvmAssetCoordinator({
    chains,
    bundledAssets,
    repository,
    poolCache: new ChromeUserAssetDexPoolCacheRepository(),
    resolveIconUrl: async assetId =>
      (await detectedRepository.list().catch(() => [])).find(asset => asset.assetId === assetId)
        ?.metadata.iconUrl ?? (await fourMeme.getToken(assetId))?.iconUrl,
    resolveRpc: chainId => {
      const rpc = rpcByChainId.get(chainId)
      if (!rpc) throw new Error('The selected EVM network is unavailable')
      return rpc
    }
  })
  let swapTokens = getCachedBackgroundRheaSwapTokens()
  let swapAssetIds = resolveSwapTokenAssetIds(swapTokens, DEFAULT_NETWORK, evmNetworks)
  const detectedCoordinator = new DetectedEvmAssetCoordinator({
    chains,
    repository: detectedRepository,
    discovery: new EvmTokenDiscoveryClient({ chains }),
    schedule: tokenDiscoverySchedule,
    isExcluded: assetId => {
      if (bundledAssets.inspect(assetId)) return true
      if (DEFAULT_NETWORK !== 'mainnet') return false
      const current = getCachedBackgroundRheaSwapTokens()
      if (current !== swapTokens) {
        swapTokens = current
        swapAssetIds = resolveSwapTokenAssetIds(current, DEFAULT_NETWORK, evmNetworks)
      }
      return !swapAssetIds.has(assetId)
    },
    resolveIconUrl: async assetId => (await fourMeme.getToken(assetId))?.iconUrl,
    resolveRpc: chainId => {
      const rpc = rpcByChainId.get(chainId)
      if (!rpc) throw new Error('The selected EVM network is unavailable')
      return rpc
    }
  })
  let records: readonly UserEvmAssetRecord[] = Object.freeze([])
  let catalogStatus: BackgroundUserEvmAssetRuntime['catalogStatus'] = 'ready'
  let detectedRecords: readonly DetectedEvmAssetRecord[] = Object.freeze([])
  try {
    records = await coordinator.list()
  } catch {
    catalogStatus = 'error'
  }
  try {
    detectedRecords = await detectedCoordinator.list()
  } catch {
    catalogStatus = 'error'
  }
  if (catalogStatus === 'ready') {
    try {
      records = await coordinator.backfillIcons(
        new Map(
          detectedRecords.flatMap(record =>
            record.metadata.iconUrl ? [[record.assetId, record.metadata.iconUrl]] : []
          )
        )
      )
    } catch {
      catalogStatus = 'error'
    }
  }
  const manualAssetIds = new Set(records.map(record => record.assetId))
  detectedRecords = Object.freeze(
    detectedRecords.filter(
      record => !manualAssetIds.has(record.assetId) && !bundledAssets.inspect(record.assetId)
    )
  )
  return Object.freeze({
    coordinator,
    detectedCoordinator,
    visibility: new ChromeTokenVisibilityRepository(DEFAULT_NETWORK),
    records,
    detectedRecords,
    definitions: Object.freeze([
      ...records.map(userEvmAssetToDefinition),
      ...detectedRecords.map(detectedEvmAssetToDefinition)
    ]),
    catalogStatus
  })
}
