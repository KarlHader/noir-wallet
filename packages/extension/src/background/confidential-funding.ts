import { getConfidentialFundingNetworkConfig } from '@/config/intents'
import { getAssetProtocolSourceMappings } from '@/core/prices/asset-market-mappings'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import type { EvmNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { buildAccountKey } from '@/core/wallet/account-scope'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  parseAssetDisplayMetadata,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import { getCachedTokens, type SwapToken } from '@/core/services/intents-api'
import { resolveIntentsEvmAssets } from '@/core/services/intents-evm-assets'
import { loadActiveEvmPortfolioContext } from '@/infrastructure/chains/evm'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { credentialSession } from './credential-session'
import { accountContextTransition } from './account-context-transition'
import { ConfidentialFundingApi } from './confidential-funding-api'
import {
  CONFIDENTIAL_FUNDING_MONITOR_ALARM,
  ConfidentialFundingCoordinator
} from './confidential-funding-coordinator'
import { ConfidentialFundingSigner } from './confidential-funding-signer'
import { ChromeConfidentialFundingStore } from './confidential-funding-store'

export function createBackgroundConfidentialFundingCoordinator(
  evmNetworks: readonly EvmNetworkConfig[],
  customEvmNetworks: readonly EvmNetworkConfig[],
  userEvmAssets: readonly AssetDefinitionInput[],
  protocolAssets: readonly AssetDefinitionInput[],
  protocolTokens: readonly SwapToken[],
  endpointSettings: ChainEndpointSettings,
  refreshPortfolio: () => Promise<void>,
  store: ChromeConfidentialFundingStore = new ChromeConfidentialFundingStore()
): ConfidentialFundingCoordinator | null {
  const config = getConfidentialFundingNetworkConfig(DEFAULT_NETWORK)
  if (!config) return null
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK, customEvmNetworks)
  const existingDefinitions = [
    ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK, customEvmNetworks),
    ...userEvmAssets,
    ...protocolAssets
  ]
  const existingIds = new Set(
    existingDefinitions.map(
      asset =>
        `${asset.chainId}/${asset.namespace}:${asset.namespace === 'erc20' ? asset.reference.toLowerCase() : asset.reference}`
    )
  )
  const confidentialEvmAssets = resolveIntentsEvmAssets(protocolTokens, evmNetworks)
  const confidentialEvmDefinitions = confidentialEvmAssets
    .filter(asset => !existingIds.has(asset.assetId))
    .flatMap(asset => {
      try {
        const metadata = parseAssetDisplayMetadata({
          name: asset.symbol,
          symbol: asset.symbol,
          decimals: asset.decimals,
          ...(asset.iconUrl ? { iconUrl: asset.iconUrl } : {})
        })
        return [
          Object.freeze({
            chainId: asset.chainId,
            namespace: 'erc20',
            reference: asset.contractAddress,
            kind: 'token' as const,
            metadata,
            source: 'protocol' as const,
            verification: 'trusted' as const
          })
        ]
      } catch {
        return []
      }
    })
  const assets = createAssetRegistry(chains, [
    ...existingDefinitions,
    ...confidentialEvmDefinitions
  ])
  const storage = new IndexedDbStorageV2Repository()
  const signerClient = new EvmMultichainSigningClient({ credentials: credentialSession })
  const near = resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const mappings = new Map(
    [
      ...getAssetProtocolSourceMappings(DEFAULT_NETWORK, assets),
      ...confidentialEvmAssets.map(asset => ({
        assetId: asset.assetId,
        protocolAssetId: asset.protocolAssetId
      }))
    ].map(mapping => [mapping.assetId, Object.freeze(mapping)])
  )
  return new ConfidentialFundingCoordinator({
    network: DEFAULT_NETWORK,
    api: new ConfidentialFundingApi(config, near.rpcUrl, __RHEA_SWAP_ACCESS_TOKEN__),
    store,
    signer: new ConfidentialFundingSigner(
      signerClient,
      chainId => loadActiveEvmPortfolioContext(storage, chainId),
      operation => accountContextTransition.runActiveOperation(operation)
    ),
    repository: new IndexedDbTransactionRepository(),
    assets,
    evmNetworks,
    protocolTokens,
    getProtocolTokens: () => {
      const cached = getCachedTokens()
      return cached.length > 0 ? cached : protocolTokens
    },
    assetMappings: Object.freeze([...mappings.values()]),
    scheduleMonitoring: () =>
      chrome.alarms.create(CONFIDENTIAL_FUNDING_MONITOR_ALARM, { delayInMinutes: 0.1 }),
    onActivityChanged: async scope => {
      await chrome.runtime.sendMessage({
        type: 'TRANSACTION_UPDATED',
        accountKey: buildAccountKey(scope.network, scope.keyDomainId, scope.accountId)
      })
    },
    refreshPortfolio
  })
}

export {
  CONFIDENTIAL_FUNDING_MONITOR_ALARM,
  type PrepareConfidentialFundingInput
} from './confidential-funding-coordinator'
